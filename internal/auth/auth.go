// Package auth handles users, password and OIDC login, sessions and API keys.
package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const (
	SessionTTL   = 90 * 24 * time.Hour
	APIKeyPrefix = "tsk_"
	bcryptCost   = 12
)

var (
	ErrBadLogin   = errors.New("wrong email or password")
	ErrEmailTaken = errors.New("that email is already registered")
)

type User struct {
	ID      string
	Email   string
	Name    string
	IsAdmin bool
	HasPass bool
}

// NewID returns 16 random bytes as hex.
func NewID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func newToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// hashToken is how session tokens and API keys are stored: only the hash is kept.
func hashToken(t string) string {
	sum := sha256.Sum256([]byte(t))
	return hex.EncodeToString(sum[:])
}

func HashPassword(pw string) (string, error) {
	if len(pw) < 8 {
		return "", errors.New("password must be at least 8 characters")
	}
	if len(pw) > 72 {
		return "", errors.New("password must be at most 72 characters")
	}
	h, err := bcrypt.GenerateFromPassword([]byte(pw), bcryptCost)
	return string(h), err
}

var dummyHash = sync.OnceValue(func() []byte {
	h, _ := bcrypt.GenerateFromPassword([]byte("tubeshelf"), bcryptCost)
	return h
})

const userCols = `id, email, name, is_admin, password_hash IS NOT NULL`

func scanUser(row interface{ Scan(...any) error }) (*User, error) {
	u := &User{}
	if err := row.Scan(&u.ID, &u.Email, &u.Name, &u.IsAdmin, &u.HasPass); err != nil {
		return nil, err
	}
	return u, nil
}

// UserCount is 0 until first-run setup has created the admin.
func UserCount(d *sql.DB) int {
	var n int
	d.QueryRow(`SELECT count(*) FROM users`).Scan(&n)
	return n
}

// CreateUser adds a local user. pw may be empty for OIDC-only users.
func CreateUser(d *sql.DB, email, name, pw string, admin bool) (*User, error) {
	email = strings.TrimSpace(email)
	if !strings.Contains(email, "@") {
		return nil, errors.New("enter a valid email address")
	}
	var hash any
	if pw != "" {
		h, err := HashPassword(pw)
		if err != nil {
			return nil, err
		}
		hash = h
	}
	u := &User{ID: NewID(), Email: email, Name: strings.TrimSpace(name), IsAdmin: admin, HasPass: pw != ""}
	_, err := d.Exec(`INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		u.ID, u.Email, u.Name, hash, admin, time.Now().Unix())
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return nil, ErrEmailTaken
		}
		return nil, err
	}
	return u, nil
}

// Login checks an email and password.
func Login(d *sql.DB, email, pw string) (*User, error) {
	var hash sql.NullString
	var id string
	err := d.QueryRow(`SELECT id, password_hash FROM users WHERE email = ?`, strings.TrimSpace(email)).Scan(&id, &hash)
	if err != nil || !hash.Valid {
		// Burn the same time as a real check so timing does not reveal which emails exist.
		bcrypt.CompareHashAndPassword(dummyHash(), []byte(pw))
		return nil, ErrBadLogin
	}
	if bcrypt.CompareHashAndPassword([]byte(hash.String), []byte(pw)) != nil {
		return nil, ErrBadLogin
	}
	return UserByID(d, id)
}

func UserByID(d *sql.DB, id string) (*User, error) {
	return scanUser(d.QueryRow(`SELECT `+userCols+` FROM users WHERE id = ?`, id))
}

// SetPassword replaces a user's password and signs out their other sessions.
func SetPassword(d *sql.DB, userID, pw string) error {
	h, err := HashPassword(pw)
	if err != nil {
		return err
	}
	if _, err := d.Exec(`UPDATE users SET password_hash = ? WHERE id = ?`, h, userID); err != nil {
		return err
	}
	_, err = d.Exec(`DELETE FROM sessions WHERE user_id = ?`, userID)
	return err
}

// NewSession creates a session and returns its cookie token.
func NewSession(d *sql.DB, userID string) (string, error) {
	tok := newToken()
	now := time.Now()
	_, err := d.Exec(`INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
		hashToken(tok), userID, now.Add(SessionTTL).Unix(), now.Unix())
	if err != nil {
		return "", err
	}
	d.Exec(`UPDATE users SET last_login_at = ? WHERE id = ?`, now.Unix(), userID)
	return tok, nil
}

// SessionUser returns the user of a session token. renew reports that the
// session passed half its lifetime and was extended, so the cookie should be reissued.
func SessionUser(d *sql.DB, tok string) (u *User, renew bool, err error) {
	if tok == "" {
		return nil, false, sql.ErrNoRows
	}
	h := hashToken(tok)
	now := time.Now()
	var exp int64
	u = &User{}
	err = d.QueryRow(`SELECT u.id, u.email, u.name, u.is_admin, u.password_hash IS NOT NULL, s.expires_at
		FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`,
		h, now.Unix()).Scan(&u.ID, &u.Email, &u.Name, &u.IsAdmin, &u.HasPass, &exp)
	if err != nil {
		return nil, false, err
	}
	if time.Unix(exp, 0).Sub(now) < SessionTTL/2 {
		d.Exec(`UPDATE sessions SET expires_at = ? WHERE token_hash = ?`, now.Add(SessionTTL).Unix(), h)
		renew = true
	}
	return u, renew, nil
}

func EndSession(d *sql.DB, tok string) {
	d.Exec(`DELETE FROM sessions WHERE token_hash = ?`, hashToken(tok))
}

// NewAPIKey creates a key and returns it once; only its hash is stored.
func NewAPIKey(d *sql.DB, userID, name string) (string, error) {
	key := APIKeyPrefix + newToken()
	_, err := d.Exec(`INSERT INTO api_keys (id, user_id, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
		NewID(), userID, strings.TrimSpace(name), hashToken(key), time.Now().Unix())
	return key, err
}

// APIKeyUser returns the owner of an API key.
func APIKeyUser(d *sql.DB, key string) (*User, error) {
	if !strings.HasPrefix(key, APIKeyPrefix) {
		return nil, sql.ErrNoRows
	}
	h := hashToken(key)
	u, err := scanUser(d.QueryRow(`SELECT u.id, u.email, u.name, u.is_admin, u.password_hash IS NOT NULL
		FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?`, h))
	if err != nil {
		return nil, err
	}
	d.Exec(`UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?`, time.Now().Unix(), h)
	return u, nil
}

// Secret is the instance key used to encrypt OIDC client secrets and sign the
// OIDC state cookie.
type Secret [32]byte

// LoadSecret derives the key from TUBESHELF_SECRET, or from a random value
// kept in dataDir/.secret when the variable is unset.
func LoadSecret(dataDir string) (Secret, error) {
	raw := os.Getenv("TUBESHELF_SECRET")
	if raw == "" {
		raw = os.Getenv("BETTER_AUTH_SECRET") // v1 name, so existing compose files keep working
	}
	if raw == "" {
		path := filepath.Join(dataDir, ".secret")
		b, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			b = []byte(newToken())
			err = os.WriteFile(path, b, 0o600)
		}
		if err != nil {
			return Secret{}, err
		}
		raw = strings.TrimSpace(string(b))
	}
	return sha256.Sum256([]byte("tubeshelf-v2:" + raw)), nil
}

func (s Secret) gcm() cipher.AEAD {
	block, _ := aes.NewCipher(s[:])
	g, _ := cipher.NewGCM(block)
	return g
}

// Seal encrypts and authenticates plain; the result is URL- and cookie-safe.
func (s Secret) Seal(plain string) string {
	g := s.gcm()
	nonce := make([]byte, g.NonceSize())
	rand.Read(nonce)
	return base64.RawURLEncoding.EncodeToString(g.Seal(nonce, nonce, []byte(plain), nil))
}

// Open reverses Seal.
func (s Secret) Open(sealed string) (string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(sealed)
	g := s.gcm()
	if err != nil || len(raw) < g.NonceSize() {
		return "", errors.New("auth: malformed sealed value")
	}
	plain, err := g.Open(nil, raw[:g.NonceSize()], raw[g.NonceSize():], nil)
	return string(plain), err
}
