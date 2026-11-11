// Package importv1 copies users, subscriptions, lists, videos, watch state and
// settings from a TubeShelf v1 (Node.js) database into an empty v2 database.
// The v1 file is opened read-only and never modified.
package importv1

import (
	"crypto/aes"
	"crypto/cipher"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/scrypt"
	_ "modernc.org/sqlite"

	"github.com/samumatic/tubeshelf/internal/auth"
)

// legacyDefaultSecret is the key early v1 releases used when no secret was configured.
const legacyDefaultSecret = "tubeshelf-default-key-change-me"

// ErrProviderSecret means a login provider's client secret could not be
// decrypted with any known v1 secret. Nothing was imported.
var ErrProviderSecret = errors.New("an OIDC client secret could not be decrypted")

// Result counts what was imported.
type Result struct {
	Users, Channels, Subscriptions, Lists, Videos, WatchStates, WatchLater, Providers, APIKeys int
	Warnings                                                                                   []string
}

// Run imports v1Path into dst. v1Secrets are candidates for the secret v1
// encrypted OIDC client secrets with (its OIDC_ENCRYPTION_KEY, BETTER_AUTH_SECRET,
// AUTH_SECRET or SECRET_KEY); v1's built-in default key is always tried too.
//
// The import runs once, so a provider whose secret cannot be decrypted aborts
// it with ErrProviderSecret and leaves dst empty, unless skipBadSecrets is
// set: then that provider is imported disabled and without a secret.
func Run(dst *sql.DB, v1Path string, secret auth.Secret, v1Secrets []string, skipBadSecrets bool) (*Result, error) {
	if auth.UserCount(dst) > 0 {
		return nil, errors.New("import needs an empty database: users already exist")
	}
	src, err := sql.Open("sqlite", "file:"+v1Path+"?mode=ro&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	defer src.Close()
	if !hasTable(src, "users") || !hasTable(src, "subscription_lists") {
		return nil, fmt.Errorf("%s is not a TubeShelf v1 database", v1Path)
	}
	tx, err := dst.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	im := &importer{src: src, tx: tx, secret: secret, v1Secrets: append(v1Secrets, legacyDefaultSecret),
		skipBadSecrets: skipBadSecrets, res: &Result{}, now: time.Now().Unix()}
	for _, step := range []func() error{
		im.users, im.providers, im.subscriptions, im.videos, im.watchState, im.watchLater, im.settings, im.apiKeys,
	} {
		if err := step(); err != nil {
			return nil, err
		}
	}
	return im.res, tx.Commit()
}

type importer struct {
	src            *sql.DB
	tx             *sql.Tx
	secret         auth.Secret
	v1Secrets      []string
	skipBadSecrets bool
	res            *Result
	now            int64
}

func hasTable(d *sql.DB, name string) bool {
	var n int
	d.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, name).Scan(&n)
	return n > 0
}

func (im *importer) warn(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	im.res.Warnings = append(im.res.Warnings, msg)
	slog.Warn("import: " + msg)
}

// each runs query on the v1 database and calls fn per row with string values
// (NULL becomes "").
func (im *importer) each(query string, fn func(col []string) error) error {
	rows, err := im.src.Query(query)
	if err != nil {
		return fmt.Errorf("v1 query failed: %w", err)
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	raw := make([]sql.NullString, len(cols))
	ptr := make([]any, len(cols))
	for i := range raw {
		ptr[i] = &raw[i]
	}
	vals := make([]string, len(cols))
	for rows.Next() {
		if err := rows.Scan(ptr...); err != nil {
			return err
		}
		for i, r := range raw {
			vals[i] = r.String
		}
		if err := fn(vals); err != nil {
			return err
		}
	}
	return rows.Err()
}

// unix parses the date formats v1 wrote: ISO 8601, SQLite datetime('now'),
// or epoch milliseconds. Unparseable values become now.
func (im *importer) unix(s string) int64 {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05", "2006-01-02T15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.Unix()
		}
	}
	if n, err := strconv.ParseInt(s, 10, 64); err == nil && n > 0 {
		if n > 1e11 {
			n /= 1000
		}
		return n
	}
	return im.now
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (im *importer) users() error {
	// better-auth kept the password and OIDC subject in auth_accounts; older
	// rows have them on users. Prefer users, fall back to auth_accounts.
	q := `SELECT u.id, u.email, coalesce(u.name, ''), u.password_hash, u.oidc_subject,
		(SELECT issuer FROM oidc_providers p WHERE p.id = u.oidc_provider), u.is_admin, u.created_at, u.last_login_at`
	if hasTable(im.src, "auth_accounts") {
		q += `, (SELECT password FROM auth_accounts a WHERE a.user_id = u.id AND a.provider_id = 'credential'),
			(SELECT account_id FROM auth_accounts a WHERE a.user_id = u.id AND a.provider_id != 'credential'),
			(SELECT issuer FROM auth_accounts a WHERE a.user_id = u.id AND a.provider_id != 'credential')`
	} else {
		q += `, NULL, NULL, NULL`
	}
	return im.each(q+` FROM users u`, func(c []string) error {
		hash, subject, issuer := c[3], c[4], c[5]
		if hash == "" {
			hash = c[9]
		}
		if subject == "" || issuer == "" {
			subject, issuer = c[10], c[11]
		}
		if subject == "" || issuer == "" {
			subject, issuer = "", ""
		}
		var last any
		if c[8] != "" {
			last = im.unix(c[8])
		}
		_, err := im.tx.Exec(`INSERT INTO users (id, email, name, password_hash, oidc_issuer, oidc_subject, is_admin, created_at, last_login_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			c[0], c[1], c[2], nullable(hash), nullable(issuer), nullable(subject), c[6] == "1", im.unix(c[7]), last)
		im.res.Users++
		return err
	})
}

// decryptV1 reverses v1's "iv:tag:ciphertext" AES-256-GCM format, whose key
// was scrypt(secret, "tubeshelf-oidc-salt").
func decryptV1(ciphertext, secret string) (string, error) {
	if !strings.Contains(ciphertext, ":") {
		return ciphertext, nil // very old v1 rows were stored unencrypted
	}
	parts := strings.Split(ciphertext, ":")
	if len(parts) != 3 {
		return "", errors.New("unexpected format")
	}
	var raw [3][]byte
	for i, p := range parts {
		b, err := base64.StdEncoding.DecodeString(p)
		if err != nil {
			return "", err
		}
		raw[i] = b
	}
	key, err := scrypt.Key([]byte(secret), []byte("tubeshelf-oidc-salt"), 16384, 8, 1, 32)
	if err != nil {
		return "", err
	}
	block, _ := aes.NewCipher(key)
	g, err := cipher.NewGCMWithNonceSize(block, len(raw[0]))
	if err != nil {
		return "", err
	}
	plain, err := g.Open(nil, raw[0], append(raw[2], raw[1]...), nil)
	return string(plain), err
}

func (im *importer) providers() error {
	if !hasTable(im.src, "oidc_providers") {
		return nil
	}
	return im.each(`SELECT id, name, issuer, client_id, client_secret, coalesce(scopes, ''), auto_provision,
		coalesce(group_claim_name, ''), coalesce(admin_group_value, ''), enabled FROM oidc_providers`, func(c []string) error {
		plain, ok := "", false
		for _, s := range im.v1Secrets {
			if p, err := decryptV1(c[4], s); err == nil {
				plain, ok = p, true
				break
			}
		}
		enabled := c[9] == "1"
		if !ok && !im.skipBadSecrets {
			return fmt.Errorf("login provider %q: %w", c[1], ErrProviderSecret)
		}
		if !ok {
			enabled = false
			im.warn("login provider %q: client secret could not be decrypted, imported disabled; enter the secret again in Admin", c[1])
		}
		_, err := im.tx.Exec(`INSERT INTO oidc_providers (id, name, issuer, client_id, client_secret, scopes,
			auto_provision, group_claim, admin_group, enabled) VALUES (?,?,?,?,?,?,?,?,?,?)`,
			c[0], c[1], c[2], c[3], im.secret.Seal(plain), c[5], c[6] == "1", c[7], c[8], enabled)
		im.res.Providers++
		return err
	})
}

func (im *importer) subscriptions() error {
	// v1 put every subscription in a list and gave each user a "Default"
	// list. v2 subscribes users to channels directly, so default lists are
	// dropped and only real lists are kept.
	listID := map[string]int64{}
	listUser := map[string]string{}
	err := im.each(`SELECT id, name, user_id FROM subscription_lists`, func(c []string) error {
		listUser[c[0]] = c[2]
		if c[0] == "default" || strings.HasPrefix(c[0], "default-") {
			return nil
		}
		res, err := im.tx.Exec(`INSERT INTO lists (user_id, name) VALUES (?, ?) ON CONFLICT DO NOTHING`, c[2], c[1])
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			// Two v1 lists with the same name merge into one.
			var id int64
			err := im.tx.QueryRow(`SELECT id FROM lists WHERE user_id = ? AND name = ?`, c[2], c[1]).Scan(&id)
			listID[c[0]] = id
			return err
		}
		listID[c[0]], _ = res.LastInsertId()
		im.res.Lists++
		return nil
	})
	if err != nil {
		return err
	}
	return im.each(`SELECT list_id, channel_id, title, coalesce(thumbnail, ''), added_at FROM subscriptions`, func(c []string) error {
		user, ok := listUser[c[0]]
		if !ok || c[1] == "" {
			return nil
		}
		res, err := im.tx.Exec(`INSERT INTO channels (id, title, thumbnail) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, c[1], c[2], c[3])
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			im.res.Channels++
		}
		res, err = im.tx.Exec(`INSERT INTO subscriptions (user_id, channel_id, added_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
			user, c[1], im.unix(c[4]))
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			im.res.Subscriptions++
		}
		if id, ok := listID[c[0]]; ok {
			_, err = im.tx.Exec(`INSERT INTO list_channels (list_id, channel_id) VALUES (?, ?) ON CONFLICT DO NOTHING`, id, c[1])
		}
		return err
	})
}

// stubVideo records a video that only exists in a user's history or watch
// later, so those pages can still show it. It is queued for enrichment.
func (im *importer) stubVideo(id, channelID, channelTitle, title string, at int64) error {
	_, err := im.tx.Exec(`INSERT INTO videos (id, channel_id, channel_title, title, published_at, enrich_after)
		VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`, id, channelID, channelTitle, title, at, im.now)
	return err
}

func (im *importer) videos() error {
	if !hasTable(im.src, "videos") {
		return nil
	}
	return im.each(`SELECT video_id, channel_id, coalesce(channel_title, ''), title, published_at,
		duration_seconds, coalesce(is_member_only, 0) FROM videos`, func(c []string) error {
		// v1 could not tell Shorts apart; the next RSS fetch corrects the kind.
		var secs, enrich any = nil, im.now
		if n, _ := strconv.Atoi(c[5]); n > 0 {
			secs, enrich = n, 0
		}
		_, err := im.tx.Exec(`INSERT INTO videos (id, channel_id, channel_title, title, published_at, duration_seconds, members_only, enrich_after)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
			c[0], c[1], c[2], c[3], im.unix(c[4]), secs, c[6] == "1", enrich)
		im.res.Videos++
		return err
	})
}

func (im *importer) watchState() error {
	if hasTable(im.src, "playback_history") {
		err := im.each(`SELECT video_id, user_id, video_title, coalesce(channel_id, ''), channel_name, timestamp, progress, completed
			FROM playback_history`, func(c []string) error {
			at := im.unix(c[5])
			if err := im.stubVideo(c[0], c[3], c[4], c[2], at); err != nil {
				return err
			}
			progress, _ := strconv.ParseFloat(c[6], 64)
			res, err := im.tx.Exec(`INSERT INTO watch_state (user_id, video_id, progress, watched, updated_at) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT DO NOTHING`, c[1], c[0], progress, c[7] == "1", at)
			if err == nil {
				n, _ := res.RowsAffected()
				im.res.WatchStates += int(n)
			}
			return err
		})
		if err != nil {
			return err
		}
	}
	if !hasTable(im.src, "watched_videos") {
		return nil
	}
	return im.each(`SELECT video_id, user_id, watched_at FROM watched_videos`, func(c []string) error {
		var exists int
		im.tx.QueryRow(`SELECT count(*) FROM watch_state WHERE user_id = ? AND video_id = ?`, c[1], c[0]).Scan(&exists)
		_, err := im.tx.Exec(`INSERT INTO watch_state (user_id, video_id, watched, updated_at) VALUES (?, ?, 1, ?)
			ON CONFLICT(user_id, video_id) DO UPDATE SET watched = 1`, c[1], c[0], im.unix(c[2]))
		if exists == 0 {
			im.res.WatchStates++
		}
		return err
	})
}

func (im *importer) watchLater() error {
	if !hasTable(im.src, "watch_later") {
		return nil
	}
	return im.each(`SELECT video_id, user_id, title, channel, added_at FROM watch_later`, func(c []string) error {
		at := im.unix(c[4])
		if err := im.stubVideo(c[0], "", c[3], c[2], at); err != nil {
			return err
		}
		_, err := im.tx.Exec(`INSERT INTO watch_later (user_id, video_id, added_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, c[1], c[0], at)
		im.res.WatchLater++
		return err
	})
}

// v1 stored values as JSON: true, 90, "newest".
func plain(jsonValue string) string {
	v := strings.Trim(jsonValue, `"`)
	switch v {
	case "true":
		return "1"
	case "false":
		return "0"
	}
	return v
}

func (im *importer) settings() error {
	instance := map[string]string{
		"videoRetentionDays": "retention_days", "feedRefreshMinutes": "refresh_minutes",
		"feedConcurrency": "fetch_concurrency", "oidcOnly": "oidc_only", "publicRegistration": "public_registration",
	}
	perUser := map[string]string{
		"hideShorts": "hide_shorts", "hideWatched": "hide_watched", "hideMemberOnly": "hide_members",
		"watchedThresholdPercent": "watched_percent", "theme": "theme", "defaultSortOrder": "sort",
		"sponsorBlockEnabled": "sponsorblock",
	}
	if hasTable(im.src, "settings") {
		err := im.each(`SELECT key, value FROM settings`, func(c []string) error {
			if k, ok := instance[c[0]]; ok && plain(c[1]) != "null" {
				_, err := im.tx.Exec(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT DO NOTHING`, k, plain(c[1]))
				return err
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	if !hasTable(im.src, "user_config") {
		return nil
	}
	return im.each(`SELECT user_id, key, value FROM user_config WHERE user_id IN (SELECT id FROM users)`, func(c []string) error {
		if k, ok := perUser[c[1]]; ok && plain(c[2]) != "null" {
			_, err := im.tx.Exec(`INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, c[0], k, plain(c[2]))
			return err
		}
		return nil
	})
}

func (im *importer) apiKeys() error {
	if !hasTable(im.src, "api_keys") {
		return nil
	}
	// v1 also stored the SHA-256 of the key, so existing keys keep working.
	return im.each(`SELECT id, user_id, name, key_hash, created_at FROM api_keys WHERE user_id IN (SELECT id FROM users)`, func(c []string) error {
		_, err := im.tx.Exec(`INSERT INTO api_keys (id, user_id, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
			c[0], c[1], c[2], c[3], im.unix(c[4]))
		im.res.APIKeys++
		return err
	})
}
