package auth

import (
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/samumatic/tubeshelf/internal/db"
)

func testDB(t *testing.T) *sql.DB {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func TestLoginAndSessions(t *testing.T) {
	d := testDB(t)
	u, err := CreateUser(d, "A@Example.com", "A", "correct horse", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CreateUser(d, "a@example.com", "", "another password", false); !errors.Is(err, ErrEmailTaken) {
		t.Errorf("duplicate email (other case): err = %v", err)
	}
	if _, err := CreateUser(d, "b@example.com", "", "short", false); err == nil {
		t.Error("7-character password accepted")
	}
	if _, err := Login(d, "a@example.com", "wrong"); !errors.Is(err, ErrBadLogin) {
		t.Errorf("wrong password: err = %v", err)
	}
	if _, err := Login(d, "nobody@example.com", "x"); !errors.Is(err, ErrBadLogin) {
		t.Errorf("unknown email: err = %v", err)
	}
	got, err := Login(d, "a@example.com", "correct horse")
	if err != nil || got.ID != u.ID || !got.IsAdmin {
		t.Fatalf("login: %+v, %v", got, err)
	}

	tok, err := NewSession(d, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	var stored string
	d.QueryRow(`SELECT token_hash FROM sessions`).Scan(&stored)
	if stored == tok {
		t.Error("session token stored unhashed")
	}
	if su, renew, err := SessionUser(d, tok); err != nil || su.ID != u.ID || renew {
		t.Errorf("fresh session: %+v renew=%v err=%v", su, renew, err)
	}
	// Past half its life the session is extended.
	d.Exec(`UPDATE sessions SET expires_at = ?`, time.Now().Add(time.Hour).Unix())
	if _, renew, err := SessionUser(d, tok); err != nil || !renew {
		t.Errorf("old session: renew=%v err=%v", renew, err)
	}
	d.Exec(`UPDATE sessions SET expires_at = ?`, time.Now().Add(-time.Second).Unix())
	if _, _, err := SessionUser(d, tok); err == nil {
		t.Error("expired session accepted")
	}

	// Changing the password ends every session.
	tok, _ = NewSession(d, u.ID)
	if err := SetPassword(d, u.ID, "a new password"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := SessionUser(d, tok); err == nil {
		t.Error("session survived a password change")
	}
}

// Hashes written by v1 (bcryptjs, $2b$) must keep working after the import.
func TestV1PasswordHashStillWorks(t *testing.T) {
	d := testDB(t)
	h, _ := bcrypt.GenerateFromPassword([]byte("from-v1"), bcrypt.MinCost)
	v1 := "$2b$" + string(h)[4:]
	d.Exec(`INSERT INTO users (id, email, password_hash, created_at) VALUES ('u', 'v1@example.com', ?, 0)`, v1)
	if _, err := Login(d, "v1@example.com", "from-v1"); err != nil {
		t.Errorf("v1 hash rejected: %v", err)
	}
}

func TestAPIKeys(t *testing.T) {
	d := testDB(t)
	u, _ := CreateUser(d, "a@example.com", "", "correct horse", false)
	key, err := NewAPIKey(d, u.ID, "script")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := APIKeyUser(d, key); err != nil || got.ID != u.ID {
		t.Errorf("valid key: %+v, %v", got, err)
	}
	for _, bad := range []string{"", "tsk_wrong", key[4:]} {
		if _, err := APIKeyUser(d, bad); err == nil {
			t.Errorf("key %q accepted", bad)
		}
	}
}

func TestSecretSealOpen(t *testing.T) {
	t.Setenv("TUBESHELF_SECRET", "")
	t.Setenv("BETTER_AUTH_SECRET", "")
	dir := t.TempDir()
	s1, err := LoadSecret(dir)
	if err != nil {
		t.Fatal(err)
	}
	s2, _ := LoadSecret(dir)
	if s1 != s2 {
		t.Error("generated secret is not stable across restarts")
	}
	sealed := s1.Seal("client-secret")
	if got, err := s2.Open(sealed); err != nil || got != "client-secret" {
		t.Errorf("open = %q, %v", got, err)
	}
	t.Setenv("TUBESHELF_SECRET", "other")
	s3, _ := LoadSecret(dir)
	if _, err := s3.Open(sealed); err == nil {
		t.Error("opened with a different secret")
	}
	if _, err := s1.Open("garbage"); err == nil {
		t.Error("garbage opened")
	}
}

func TestHasGroup(t *testing.T) {
	if !hasGroup([]any{"users", "admin"}, "admin") || !hasGroup("admin", "admin") {
		t.Error("admin group not found")
	}
	if hasGroup([]any{"users"}, "admin") || hasGroup(nil, "admin") {
		t.Error("admin group found where there is none")
	}
}
