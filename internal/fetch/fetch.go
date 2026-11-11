// Package fetch keeps the video table current in the background: it polls
// each subscribed channel's RSS feed on a schedule, enriches new videos with
// duration and live state, and prunes videos past the retention window.
package fetch

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/samumatic/tubeshelf/internal/db"
	"github.com/samumatic/tubeshelf/internal/yt"
)

const (
	tick            = 20 * time.Second
	enrichBatch     = 30
	maxEnrichTries  = 5
	liveRecheck     = 15 * time.Minute
	upcomingRecheck = 30 * time.Minute
	maxBackoff      = 24 * time.Hour
)

// Source is the part of yt.Client the fetcher needs.
type Source interface {
	Feed(ctx context.Context, channelID string) (*yt.Feed, error)
	Details(ctx context.Context, videoID string) (*yt.Details, error)
	Resolve(ctx context.Context, input string) (*yt.Channel, error)
}

// noAvatar marks a channel whose avatar lookup failed, so it is not retried forever.
const noAvatar = "-"

type Fetcher struct {
	DB  *sql.DB
	YT  Source
	Now func() time.Time
	// OnPrune, if set, runs after old videos were deleted.
	OnPrune func()
	wake    chan struct{}
}

func New(d *sql.DB, src Source) *Fetcher {
	return &Fetcher{DB: d, YT: src, Now: time.Now, wake: make(chan struct{}, 1)}
}

// Wake makes the loop run a pass now instead of at the next tick.
func (f *Fetcher) Wake() {
	select {
	case f.wake <- struct{}{}:
	default:
	}
}

// RefreshAll marks every channel as due and wakes the loop.
func (f *Fetcher) RefreshAll() {
	f.DB.Exec(`UPDATE channels SET next_fetch_at = 0`)
	f.Wake()
}

// Run loops until ctx is cancelled.
func (f *Fetcher) Run(ctx context.Context) {
	t := time.NewTicker(tick)
	defer t.Stop()
	lastPrune := time.Time{}
	for {
		f.Pass(ctx)
		if f.Now().Sub(lastPrune) > 6*time.Hour {
			f.prune()
			lastPrune = f.Now()
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-f.wake:
		}
	}
}

// Pass fetches all due channels, then enriches a batch of videos.
func (f *Fetcher) Pass(ctx context.Context) {
	workers := db.SettingInt(f.DB, "fetch_concurrency", 1)
	due := f.column(`SELECT id FROM channels
		WHERE next_fetch_at <= ? AND id IN (SELECT channel_id FROM subscriptions)
		ORDER BY next_fetch_at`, f.Now().Unix())
	parallel(ctx, workers, due, f.fetchChannel)

	pending := f.column(`SELECT id FROM videos WHERE enrich_after > 0 AND enrich_after <= ?
		ORDER BY published_at DESC LIMIT ?`, f.Now().Unix(), enrichBatch)
	parallel(ctx, workers, pending, f.enrich)
	if len(pending) == enrichBatch {
		f.Wake() // more waiting
	}
}

func parallel(ctx context.Context, workers int, ids []string, fn func(context.Context, string)) {
	var wg sync.WaitGroup
	ch := make(chan string)
	for range min(workers, len(ids)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for id := range ch {
				fn(ctx, id)
			}
		}()
	}
	for _, id := range ids {
		if ctx.Err() != nil {
			break
		}
		ch <- id
	}
	close(ch)
	wg.Wait()
}

func (f *Fetcher) column(query string, args ...any) []string {
	rows, err := f.DB.Query(query, args...)
	if err != nil {
		slog.Error("fetch: query", "err", err)
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if rows.Scan(&s) == nil {
			out = append(out, s)
		}
	}
	return out
}

// backoff doubles the base delay per failure, capped at maxBackoff.
func backoff(base time.Duration, fails int) time.Duration {
	d := base
	for i := 1; i < fails && d < maxBackoff; i++ {
		d *= 2
	}
	return min(d, maxBackoff)
}

func (f *Fetcher) fetchChannel(ctx context.Context, id string) {
	now := f.Now()
	interval := time.Duration(db.SettingInt(f.DB, "refresh_minutes", 5)) * time.Minute
	feed, err := f.YT.Feed(ctx, id)
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		var fails int
		f.DB.QueryRow(`SELECT fail_count FROM channels WHERE id = ?`, id).Scan(&fails)
		next := now.Add(backoff(interval, fails+1))
		f.DB.Exec(`UPDATE channels SET fail_count = fail_count + 1, last_error = ?, next_fetch_at = ? WHERE id = ?`,
			err.Error(), next.Unix(), id)
		slog.Warn("fetch: channel failed", "channel", id, "err", err)
		return
	}

	tx, err := f.DB.Begin()
	if err != nil {
		slog.Error("fetch: begin", "err", err)
		return
	}
	defer tx.Rollback()
	cutoff := now.AddDate(0, 0, -db.SettingInt(f.DB, "retention_days", 1)).Unix()
	for _, v := range feed.Videos {
		if v.Published.Unix() < cutoff {
			continue
		}
		kind := "video"
		if v.Short {
			kind = "short"
		}
		// New rows are queued for enrichment; existing rows only get a fresh title.
		if _, err := tx.Exec(`INSERT INTO videos (id, channel_id, channel_title, title, published_at, kind, enrich_after)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET title = excluded.title, channel_title = excluded.channel_title,
				channel_id = excluded.channel_id,
				kind = CASE WHEN excluded.kind = 'short' THEN 'short' ELSE kind END`,
			v.ID, id, feed.Title, v.Title, v.Published.Unix(), kind, now.Unix()); err != nil {
			slog.Error("fetch: upsert video", "video", v.ID, "err", err)
			return
		}
	}
	// ±10% jitter spreads channels out so they do not all fire in one burst.
	jitter := time.Duration((rand.Float64()*0.2 - 0.1) * float64(interval))
	if _, err := tx.Exec(`UPDATE channels SET title = CASE WHEN ? != '' THEN ? ELSE title END,
		fail_count = 0, last_error = '', last_success_at = ?, next_fetch_at = ? WHERE id = ?`,
		feed.Title, feed.Title, now.Unix(), now.Add(interval+jitter).Unix(), id); err != nil {
		slog.Error("fetch: update channel", "err", err)
		return
	}
	if err := tx.Commit(); err != nil {
		slog.Error("fetch: commit", "err", err)
		return
	}

	// Channels imported by id alone (OPML, CSV) have no avatar yet: look it up once.
	var thumb string
	if f.DB.QueryRow(`SELECT thumbnail FROM channels WHERE id = ?`, id).Scan(&thumb) == nil && thumb == "" {
		thumb = noAvatar
		if ch, err := f.YT.Resolve(ctx, id); err == nil && ch.Thumbnail != "" {
			thumb = ch.Thumbnail
		}
		f.DB.Exec(`UPDATE channels SET thumbnail = ? WHERE id = ?`, thumb, id)
	}
}

func (f *Fetcher) enrich(ctx context.Context, id string) {
	now := f.Now()
	d, err := f.YT.Details(ctx, id)
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		if errors.Is(err, yt.ErrNotFound) {
			f.DB.Exec(`UPDATE videos SET enrich_after = 0 WHERE id = ?`, id)
			return
		}
		// Retry with backoff, then give up and leave the duration unknown.
		var tries int
		f.DB.QueryRow(`SELECT enrich_attempts FROM videos WHERE id = ?`, id).Scan(&tries)
		tries++
		next := now.Add(backoff(10*time.Minute, tries)).Unix()
		if tries >= maxEnrichTries {
			next = 0
		}
		f.DB.Exec(`UPDATE videos SET enrich_attempts = ?, enrich_after = ? WHERE id = ?`, tries, next, id)
		return
	}

	// A stream is rechecked until it has ended and reports a real length.
	var next int64
	state := "video"
	switch {
	case d.Upcoming:
		state, next = "upcoming", now.Add(upcomingRecheck).Unix()
	case d.Live:
		state, next = "live", now.Add(liveRecheck).Unix()
	}
	var secs any
	if d.Seconds > 0 {
		secs = d.Seconds
	}
	// Shorts keep their kind: only the RSS link identifies them reliably.
	f.DB.Exec(`UPDATE videos SET duration_seconds = ?, members_only = ?, enrich_after = ?, enrich_attempts = 0,
		kind = CASE WHEN kind = 'short' THEN 'short' ELSE ? END WHERE id = ?`,
		secs, d.MembersOnly, next, state, id)
}

// prune deletes videos past retention that no user saved or has progress on.
func (f *Fetcher) prune() {
	cutoff := f.Now().AddDate(0, 0, -db.SettingInt(f.DB, "retention_days", 1)).Unix()
	res, err := f.DB.Exec(`DELETE FROM videos WHERE published_at < ?
		AND id NOT IN (SELECT video_id FROM watch_later)
		AND id NOT IN (SELECT video_id FROM watch_state)`, cutoff)
	if err != nil {
		slog.Error("fetch: prune", "err", err)
		return
	}
	if n, _ := res.RowsAffected(); n > 0 {
		slog.Info("fetch: pruned old videos", "count", n)
	}
	f.DB.Exec(`DELETE FROM sessions WHERE expires_at < ?`, f.Now().Unix())
	f.DB.Exec(`DELETE FROM channels WHERE id NOT IN (SELECT channel_id FROM subscriptions)`)
	if f.OnPrune != nil {
		f.OnPrune()
	}
}
