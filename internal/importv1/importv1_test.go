package importv1

import (
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	"github.com/samumatic/tubeshelf/internal/auth"
	"github.com/samumatic/tubeshelf/internal/db"
)

// Produced by Node with v1's exact code path: scryptSync(secret,
// "tubeshelf-oidc-salt", 32), aes-256-gcm, 16-byte IV, "iv:tag:ciphertext".
const (
	v1Secret     = "test-secret-for-vector"
	v1Ciphertext = "BwcHBwcHBwcHBwcHBwcHBw==:ilxDrMpvu8ap34vlOIk1fg==:ACphjy4+WgS/i78AbyvuDw=="
)

func TestDecryptV1(t *testing.T) {
	got, err := decryptV1(v1Ciphertext, v1Secret)
	if err != nil || got != "my-client-secret" {
		t.Fatalf("decryptV1 = %q, %v", got, err)
	}
	if _, err := decryptV1(v1Ciphertext, "wrong"); err == nil {
		t.Error("decrypted with the wrong secret")
	}
}

// The subset of the v1 schema the importer reads.
const v1Schema = `
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, password_hash TEXT, oidc_provider TEXT, oidc_subject TEXT,
	created_at DATE, last_login_at DATE, is_admin INTEGER DEFAULT 0);
CREATE TABLE auth_accounts (id TEXT, account_id TEXT, provider_id TEXT, user_id TEXT, password TEXT, issuer TEXT);
CREATE TABLE oidc_providers (id TEXT, name TEXT, issuer TEXT, client_id TEXT, client_secret TEXT, scopes TEXT,
	auto_provision INTEGER, group_claim_name TEXT, admin_group_value TEXT, enabled INTEGER);
CREATE TABLE subscription_lists (id TEXT, name TEXT, user_id TEXT);
CREATE TABLE subscriptions (list_id TEXT, channel_id TEXT, title TEXT, thumbnail TEXT, added_at TEXT);
CREATE TABLE videos (video_id TEXT, channel_id TEXT, channel_title TEXT, title TEXT, published_at TEXT, duration_seconds INTEGER, is_member_only INTEGER);
CREATE TABLE playback_history (video_id TEXT, user_id TEXT, video_title TEXT, channel_id TEXT, channel_name TEXT, timestamp TEXT, progress REAL, completed INTEGER);
CREATE TABLE watched_videos (video_id TEXT, user_id TEXT, watched_at TEXT);
CREATE TABLE watch_later (video_id TEXT, user_id TEXT, title TEXT, channel TEXT, added_at TEXT);
CREATE TABLE settings (key TEXT, value TEXT);
CREATE TABLE user_config (user_id TEXT, key TEXT, value TEXT);
CREATE TABLE api_keys (id TEXT, user_id TEXT, name TEXT, key_hash TEXT, created_at TEXT);

INSERT INTO users VALUES ('u1', 'local@example.com', 'Local', NULL, NULL, NULL, '2026-01-12 14:13:30', '2026-02-01T10:00:00.000Z', 1);
INSERT INTO users VALUES ('u2', 'sso@example.com', 'SSO', NULL, NULL, NULL, '2026-01-12 14:13:30', NULL, 0);
INSERT INTO auth_accounts VALUES ('a1', 'u1', 'credential', 'u1', '$2b$12$hash', 'local:credential');
INSERT INTO auth_accounts VALUES ('a2', 'subject-123', 'oidc', 'u2', NULL, 'https://id.example.com');
INSERT INTO oidc_providers VALUES ('oidc', 'Pocket ID', 'https://id.example.com', 'client', '` + v1Ciphertext + `', 'openid email', 1, 'groups', 'admin', 1);
INSERT INTO subscription_lists VALUES ('default-u1', 'Default', 'u1'), ('123', 'Tech', 'u1'), ('default', 'Default', 'u2');
INSERT INTO subscriptions VALUES ('default-u1', 'UCaaaaaaaaaaaaaaaaaaaaaa', 'Chan A', 'https://yt3.googleusercontent.com/a=s900', '2026-01-12T14:35:06.407Z');
INSERT INTO subscriptions VALUES ('123', 'UCaaaaaaaaaaaaaaaaaaaaaa', 'Chan A', NULL, '2026-01-12T14:35:06.407Z');
INSERT INTO subscriptions VALUES ('123', 'UCbbbbbbbbbbbbbbbbbbbbbb', 'Chan B', NULL, '2026-01-12T14:35:06.407Z');
INSERT INTO subscriptions VALUES ('default', 'UCaaaaaaaaaaaaaaaaaaaaaa', 'Chan A', NULL, '2026-01-12T14:35:06.407Z');
INSERT INTO videos VALUES ('vid00000001', 'UCaaaaaaaaaaaaaaaaaaaaaa', 'Chan A', 'Known length', '2026-03-01T00:00:00.000Z', 300, 0);
INSERT INTO videos VALUES ('vid00000002', 'UCaaaaaaaaaaaaaaaaaaaaaa', 'Chan A', 'Unknown length', '2026-03-02T00:00:00.000Z', NULL, 1);
INSERT INTO playback_history VALUES ('vid00000001', 'u1', 'Known length', 'UCaaaaaaaaaaaaaaaaaaaaaa', 'Chan A', '2026-03-03T00:00:00.000Z', 120.5, 0);
INSERT INTO playback_history VALUES ('gone0000001', 'u1', 'Pruned video', NULL, 'Chan Z', '2026-03-03T00:00:00.000Z', 10, 1);
INSERT INTO watched_videos VALUES ('vid00000001', 'u1', '2026-03-04T00:00:00.000Z'), ('vid00000002', 'u1', '2026-03-04T00:00:00.000Z');
INSERT INTO watch_later VALUES ('later000001', 'u1', 'Saved', 'Chan Q', '2026-03-05T00:00:00.000Z');
INSERT INTO settings VALUES ('videoRetentionDays', '120'), ('oidcOnly', 'false'), ('theme', '"dark"');
INSERT INTO user_config VALUES ('u1', 'hideShorts', 'false'), ('u1', 'watchedThresholdPercent', '80'), ('u1', 'videoRetentionDays', 'null');
INSERT INTO api_keys VALUES ('k1', 'u1', 'script', 'abc123', '2026-03-01T00:00:00.000Z');
`

func TestRun(t *testing.T) {
	dir := t.TempDir()
	v1Path := filepath.Join(dir, "tubeshelf.db")
	v1, err := sql.Open("sqlite", "file:"+v1Path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v1.Exec(v1Schema); err != nil {
		t.Fatal(err)
	}
	v1.Close()

	d, err := db.Open(filepath.Join(dir, "shelf.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	t.Setenv("TUBESHELF_SECRET", "v2-secret")
	secret, _ := auth.LoadSecret(dir)

	res, err := Run(d, v1Path, secret, []string{"wrong", v1Secret}, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Warnings) != 0 {
		t.Errorf("warnings: %v", res.Warnings)
	}

	one := func(query string, args ...any) string {
		t.Helper()
		var s sql.NullString
		if err := d.QueryRow(query, args...).Scan(&s); err != nil {
			t.Fatalf("%s: %v", query, err)
		}
		return s.String
	}
	checks := []struct{ name, got, want string }{
		{"password comes from auth_accounts", one(`SELECT password_hash FROM users WHERE id = 'u1'`), "$2b$12$hash"},
		{"admin flag", one(`SELECT is_admin FROM users WHERE id = 'u1'`), "1"},
		{"created_at parsed", one(`SELECT created_at FROM users WHERE id = 'u1'`), "1768227210"},
		{"oidc subject", one(`SELECT oidc_issuer || '|' || oidc_subject FROM users WHERE id = 'u2'`), "https://id.example.com|subject-123"},
		{"local user has no oidc identity", one(`SELECT coalesce(oidc_subject, 'none') FROM users WHERE id = 'u1'`), "none"},
		{"channels are shared", one(`SELECT count(*) FROM channels`), "2"},
		{"subscriptions deduplicated per user", one(`SELECT count(*) FROM subscriptions WHERE user_id = 'u1'`), "2"},
		{"other user's subscription", one(`SELECT count(*) FROM subscriptions WHERE user_id = 'u2'`), "1"},
		{"default lists are dropped", one(`SELECT group_concat(name) FROM lists`), "Tech"},
		{"list membership", one(`SELECT count(*) FROM list_channels`), "2"},
		{"avatar kept", one(`SELECT thumbnail FROM channels WHERE id = 'UCaaaaaaaaaaaaaaaaaaaaaa'`), "https://yt3.googleusercontent.com/a=s900"},
		{"known length needs no enrichment", one(`SELECT duration_seconds || '|' || enrich_after FROM videos WHERE id = 'vid00000001'`), "300|0"},
		{"unknown length is queued", one(`SELECT enrich_after > 0 FROM videos WHERE id = 'vid00000002'`), "1"},
		{"members-only kept", one(`SELECT members_only FROM videos WHERE id = 'vid00000002'`), "1"},
		{"history-only video gets a stub", one(`SELECT title || '|' || channel_title FROM videos WHERE id = 'gone0000001'`), "Pruned video|Chan Z"},
		{"watch-later video gets a stub", one(`SELECT title FROM videos WHERE id = 'later000001'`), "Saved"},
		{"progress and watched merge", one(`SELECT progress || '|' || watched FROM watch_state WHERE video_id = 'vid00000001'`), "120.5|1"},
		{"watched without history", one(`SELECT watched FROM watch_state WHERE video_id = 'vid00000002'`), "1"},
		{"completed history is watched", one(`SELECT watched FROM watch_state WHERE video_id = 'gone0000001'`), "1"},
		{"watch later", one(`SELECT count(*) FROM watch_later WHERE user_id = 'u1'`), "1"},
		{"instance setting", one(`SELECT value FROM settings WHERE key = 'retention_days'`), "120"},
		{"boolean setting", one(`SELECT value FROM settings WHERE key = 'oidc_only'`), "0"},
		{"user setting", one(`SELECT value FROM user_settings WHERE user_id = 'u1' AND key = 'hide_shorts'`), "0"},
		{"user number setting", one(`SELECT value FROM user_settings WHERE user_id = 'u1' AND key = 'watched_percent'`), "80"},
		{"null settings skipped", one(`SELECT count(*) FROM user_settings WHERE user_id = 'u1'`), "2"},
		{"api key hash kept", one(`SELECT key_hash FROM api_keys WHERE id = 'k1'`), "abc123"},
		{"provider stays enabled", one(`SELECT enabled FROM oidc_providers`), "1"},
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, c.got, c.want)
		}
	}
	if res.WatchStates != 3 {
		t.Errorf("WatchStates = %d, want 3", res.WatchStates)
	}
	// The client secret is re-encrypted with the v2 key.
	if plain, err := secret.Open(one(`SELECT client_secret FROM oidc_providers`)); err != nil || plain != "my-client-secret" {
		t.Errorf("provider secret = %q, %v", plain, err)
	}
	// A second import must refuse instead of duplicating.
	if _, err := Run(d, v1Path, secret, nil, false); err == nil {
		t.Error("import into a non-empty database succeeded")
	}
}

func TestRunDisablesProviderWithoutSecret(t *testing.T) {
	dir := t.TempDir()
	v1Path := filepath.Join(dir, "tubeshelf.db")
	v1, _ := sql.Open("sqlite", "file:"+v1Path)
	if _, err := v1.Exec(v1Schema); err != nil {
		t.Fatal(err)
	}
	v1.Close()
	d, _ := db.Open(filepath.Join(dir, "shelf.db"))
	defer d.Close()
	secret, _ := auth.LoadSecret(dir)
	// Without the right secret the import must abort and leave nothing behind,
	// so it can be repeated once the secret is supplied.
	if _, err := Run(d, v1Path, secret, []string{"wrong"}, false); !errors.Is(err, ErrProviderSecret) {
		t.Fatalf("err = %v, want ErrProviderSecret", err)
	}
	if n := auth.UserCount(d); n != 0 {
		t.Fatalf("aborted import left %d users behind", n)
	}
	res, err := Run(d, v1Path, secret, []string{"wrong"}, true)
	if err != nil {
		t.Fatal(err)
	}
	var enabled bool
	d.QueryRow(`SELECT enabled FROM oidc_providers`).Scan(&enabled)
	if enabled || len(res.Warnings) != 1 {
		t.Errorf("enabled=%v warnings=%v; want disabled with one warning", enabled, res.Warnings)
	}
}

// Providers saved by early v1 releases without a configured secret used a
// built-in default key; they must migrate with no secret supplied at all.
func TestDecryptV1LegacyDefaultKey(t *testing.T) {
	// Produced by Node: same code path as v1Ciphertext, secret "tubeshelf-default-key-change-me".
	const legacy = "cTLg9cReGd7MdTnYkWk+Eg==:TUmFOvo31DIeJ5g6UC52TQ==:APQx+qE4ba8KP8r/Fw=="
	dir := t.TempDir()
	v1Path := filepath.Join(dir, "tubeshelf.db")
	v1, _ := sql.Open("sqlite", "file:"+v1Path)
	if _, err := v1.Exec(v1Schema); err != nil {
		t.Fatal(err)
	}
	v1.Exec(`UPDATE oidc_providers SET client_secret = ?`, legacy)
	v1.Close()
	d, _ := db.Open(filepath.Join(dir, "shelf.db"))
	defer d.Close()
	secret, _ := auth.LoadSecret(dir)
	if _, err := Run(d, v1Path, secret, nil, false); err != nil {
		t.Fatal(err)
	}
	var sealed string
	var enabled bool
	d.QueryRow(`SELECT client_secret, enabled FROM oidc_providers`).Scan(&sealed, &enabled)
	if plain, err := secret.Open(sealed); err != nil || plain != "legacy-secret" || !enabled {
		t.Errorf("secret = %q, enabled = %v, err = %v", plain, enabled, err)
	}
}
