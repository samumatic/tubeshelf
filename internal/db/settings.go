package db

import (
	"database/sql"
	"strconv"
)

// Instance settings and their defaults. Values are stored as strings.
var Defaults = map[string]string{
	"refresh_minutes":     "30",
	"fetch_concurrency":   "3",
	"retention_days":      "270",
	"public_registration": "0",
	"oidc_only":           "0",
	// Appearance (Administration › Appearance).
	"app_name":        "TubeShelf",
	"layout":          "backdrop", // backdrop | plain
	"primary":         "",         // "" = monochrome, else #rrggbb
	"radius":          "1.25",     // corner radius scale
	"background_v":    "",         // version of the uploaded background, "" = built-in
	"background_type": "",
	"logo_v":          "",
	"logo_type":       "",
}

// Per-user settings and their defaults.
var UserDefaults = map[string]string{
	"theme":            "system", // system | dark | light
	"view":             "grid",   // grid | list
	"sort":             "newest", // newest | oldest
	"hide_shorts":      "1",
	"hide_watched":     "0",
	"hide_members":     "0",
	"hide_live":        "0",
	"group_days":       "1", // day headings in the feed
	"sponsorblock":     "1",
	"watched_percent":  "90",
	"open_on_youtube":  "0",
	"captions":         "0",        // remembered from the player's captions button
	"theater":          "0",        // the watch page's large-video mode
	"autoplay_next":    "1",        // play Up next's first video after a countdown
	"later_autoremove": "0",        // marking a video watched also takes it off Watch later
	"click_to_load":    "0",        // load the YouTube player only after a click
	"text_size":        "normal",   // normal | large | larger, for TVs and tired eyes
	"sidebar":          "expanded", // expanded | collapsed (from 1024px)
	"sidebar_width":    "256",      // px, 208 to 400 in steps of 16
}

type querier interface {
	QueryRow(query string, args ...any) *sql.Row
}

// Setting returns an instance setting or its default.
func Setting(q querier, key string) string {
	var v string
	if err := q.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&v); err != nil {
		return Defaults[key]
	}
	return v
}

// SettingInt returns an instance setting as a number, clamped to at least min.
func SettingInt(q querier, key string, min int) int {
	n, err := strconv.Atoi(Setting(q, key))
	if err != nil {
		n, _ = strconv.Atoi(Defaults[key])
	}
	if n < min {
		n = min
	}
	return n
}

// SetSetting stores an instance setting.
func SetSetting(d *sql.DB, key, value string) error {
	_, err := d.Exec(`INSERT INTO settings (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// DefaultPrefix marks instance settings that change a user setting's default
// for everyone who has not chosen it themselves ("default.theme").
const DefaultPrefix = "default."

// EffectiveDefaults returns UserDefaults with the admin's instance defaults applied.
func EffectiveDefaults(d *sql.DB) map[string]string {
	out := make(map[string]string, len(UserDefaults))
	for k, v := range UserDefaults {
		out[k] = v
	}
	rows, err := d.Query(`SELECT substr(key, ?), value FROM settings WHERE key LIKE 'default.%'`, len(DefaultPrefix)+1)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var k, v string
		if rows.Scan(&k, &v) == nil {
			if _, known := UserDefaults[k]; known {
				out[k] = v
			}
		}
	}
	return out
}

// UserSettings returns all settings of a user with defaults filled in.
func UserSettings(d *sql.DB, userID string) map[string]string {
	out := EffectiveDefaults(d)
	rows, err := d.Query(`SELECT key, value FROM user_settings WHERE user_id = ?`, userID)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var k, v string
		if rows.Scan(&k, &v) == nil {
			if _, known := UserDefaults[k]; known {
				out[k] = v
			}
		}
	}
	return out
}

// SetUserSetting stores one setting of a user.
func SetUserSetting(d *sql.DB, userID, key, value string) error {
	_, err := d.Exec(`INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
		ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`, userID, key, value)
	return err
}
