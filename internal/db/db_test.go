package db

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func open(t *testing.T, path string) *sql.DB {
	t.Helper()
	d, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

// Restarting the app reopens the same file: migrations must not run twice
// or lose data.
func TestReopenKeepsDataAndSkipsMigrations(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.db")
	d := open(t, path)
	if err := SetSetting(d, "refresh_minutes", "45"); err != nil {
		t.Fatal(err)
	}
	d.Close()

	d = open(t, path)
	if got := Setting(d, "refresh_minutes"); got != "45" {
		t.Errorf("setting after reopen = %q, want 45", got)
	}
	var applied, files int
	d.QueryRow(`SELECT count(*) FROM schema_migrations`).Scan(&applied)
	names, _ := migrations.ReadDir("migrations")
	files = len(names)
	if applied != files {
		t.Errorf("%d migrations recorded, %d files", applied, files)
	}
}

// Deleting a user must take their data with it (foreign keys are on).
func TestForeignKeysCascade(t *testing.T) {
	d := open(t, filepath.Join(t.TempDir(), "t.db"))
	mustExec(t, d, `INSERT INTO users (id, email, created_at) VALUES ('u1', 'a@example.com', 0)`)
	mustExec(t, d, `INSERT INTO channels (id, title) VALUES ('UCaaaaaaaaaaaaaaaaaaaaaa', 'A')`)
	mustExec(t, d, `INSERT INTO subscriptions (user_id, channel_id, added_at) VALUES ('u1', 'UCaaaaaaaaaaaaaaaaaaaaaa', 0)`)
	mustExec(t, d, `INSERT INTO lists (id, user_id, name) VALUES (1, 'u1', 'L')`)
	mustExec(t, d, `INSERT INTO list_channels (list_id, channel_id) VALUES (1, 'UCaaaaaaaaaaaaaaaaaaaaaa')`)
	SetUserSetting(d, "u1", "theme", "dark")
	mustExec(t, d, `DELETE FROM users WHERE id = 'u1'`)
	for _, table := range []string{"subscriptions", "lists", "list_channels", "user_settings"} {
		var n int
		d.QueryRow(`SELECT count(*) FROM ` + table).Scan(&n)
		if n != 0 {
			t.Errorf("%s keeps %d row(s) of a deleted user", table, n)
		}
	}
}

func TestSettingsDefaultsAndClamping(t *testing.T) {
	d := open(t, filepath.Join(t.TempDir(), "t.db"))
	if got := Setting(d, "app_name"); got != "TubeShelf" {
		t.Errorf("default app_name = %q", got)
	}
	SetSetting(d, "refresh_minutes", "not a number")
	if got := SettingInt(d, "refresh_minutes", 5); got != 30 {
		t.Errorf("garbage refresh_minutes = %d, want the default 30", got)
	}
	SetSetting(d, "refresh_minutes", "1")
	if got := SettingInt(d, "refresh_minutes", 5); got != 5 {
		t.Errorf("refresh_minutes below minimum = %d, want 5", got)
	}

	mustExec(t, d, `INSERT INTO users (id, email, created_at) VALUES ('u1', 'a@example.com', 0)`)
	SetUserSetting(d, "u1", "sort", "oldest")
	SetUserSetting(d, "u1", "removed_setting", "x")
	got := UserSettings(d, "u1")
	if got["sort"] != "oldest" || got["theme"] != UserDefaults["theme"] {
		t.Errorf("user settings = %v", got)
	}
	if _, ok := got["removed_setting"]; ok {
		t.Error("an unknown stored key leaks into user settings")
	}
	// Defaults are shared: a user's settings map must be a copy.
	got["theme"] = "changed"
	if UserDefaults["theme"] == "changed" {
		t.Error("UserSettings returned the shared defaults map")
	}
}

func mustExec(t *testing.T, d *sql.DB, q string) {
	t.Helper()
	if _, err := d.Exec(q); err != nil {
		t.Fatal(err)
	}
}
