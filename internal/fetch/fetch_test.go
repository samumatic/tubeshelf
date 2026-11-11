package fetch

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/samumatic/tubeshelf/internal/db"
	"github.com/samumatic/tubeshelf/internal/yt"
)

const chanID = "UCdC0An4ZPNr_YiFiYoVbwaw"

type fake struct {
	feed     *yt.Feed
	feedErr  error
	details  map[string]*yt.Details
	avatar   string
	resolves int
}

func (f *fake) Feed(context.Context, string) (*yt.Feed, error) { return f.feed, f.feedErr }
func (f *fake) Resolve(_ context.Context, id string) (*yt.Channel, error) {
	f.resolves++
	if f.avatar == "" {
		return nil, errors.New("no page")
	}
	return &yt.Channel{ID: id, Thumbnail: f.avatar}, nil
}
func (f *fake) Details(_ context.Context, id string) (*yt.Details, error) {
	if d, ok := f.details[id]; ok {
		return d, nil
	}
	return nil, errors.New("boom")
}

func setup(t *testing.T) (*sql.DB, *fake, *Fetcher, *time.Time) {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	d.Exec(`INSERT INTO users (id, email, created_at) VALUES ('u', 'a@b.c', 0)`)
	d.Exec(`INSERT INTO channels (id, title) VALUES (?, 'old title')`, chanID)
	d.Exec(`INSERT INTO subscriptions (user_id, channel_id, added_at) VALUES ('u', ?, 0)`, chanID)
	now := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	src := &fake{details: map[string]*yt.Details{}}
	f := New(d, src)
	f.Now = func() time.Time { return now }
	return d, src, f, &now
}

type row struct {
	kind   string
	secs   sql.NullInt64
	enrich int64
}

func video(t *testing.T, d *sql.DB, id string) row {
	t.Helper()
	var r row
	if err := d.QueryRow(`SELECT kind, duration_seconds, enrich_after FROM videos WHERE id = ?`, id).Scan(&r.kind, &r.secs, &r.enrich); err != nil {
		t.Fatalf("video %s: %v", id, err)
	}
	return r
}

func TestPassFetchesAndEnriches(t *testing.T) {
	d, src, f, now := setup(t)
	src.feed = &yt.Feed{Title: "New Title", Videos: []yt.FeedVideo{
		{ID: "video000001", Title: "A video", Published: now.Add(-time.Hour)},
		{ID: "short000001", Title: "A short", Published: now.Add(-2 * time.Hour), Short: true},
		{ID: "live0000001", Title: "A stream", Published: now.Add(-3 * time.Hour)},
		{ID: "ancient0001", Title: "Too old", Published: now.AddDate(-2, 0, 0)},
	}}
	src.details["video000001"] = &yt.Details{Seconds: 916}
	src.details["short000001"] = &yt.Details{Seconds: 42}
	src.details["live0000001"] = &yt.Details{Live: true}

	f.Pass(context.Background())

	if v := video(t, d, "video000001"); v.kind != "video" || v.secs.Int64 != 916 || v.enrich != 0 {
		t.Errorf("video: %+v", v)
	}
	if v := video(t, d, "short000001"); v.kind != "short" || v.secs.Int64 != 42 {
		t.Errorf("short must keep its kind after enrichment: %+v", v)
	}
	if v := video(t, d, "live0000001"); v.kind != "live" || v.secs.Valid || v.enrich != now.Add(liveRecheck).Unix() {
		t.Errorf("live stream must be queued for a recheck: %+v", v)
	}
	var n int
	d.QueryRow(`SELECT count(*) FROM videos WHERE id = 'ancient0001'`).Scan(&n)
	if n != 0 {
		t.Error("video older than retention was stored")
	}
	var title string
	var next int64
	d.QueryRow(`SELECT title, next_fetch_at FROM channels WHERE id = ?`, chanID).Scan(&title, &next)
	if title != "New Title" {
		t.Errorf("channel title = %q", title)
	}
	if lo, hi := now.Add(27*time.Minute).Unix(), now.Add(33*time.Minute).Unix(); next < lo || next > hi {
		t.Errorf("next fetch %v not within 30min ±10%%", time.Unix(next, 0).Sub(*now))
	}

	// The stream ended: the recheck turns it into a normal video.
	*now = now.Add(liveRecheck + time.Second)
	src.details["live0000001"] = &yt.Details{Seconds: 7200}
	f.Pass(context.Background())
	if v := video(t, d, "live0000001"); v.kind != "video" || v.secs.Int64 != 7200 || v.enrich != 0 {
		t.Errorf("ended stream: %+v", v)
	}
}

func TestChannelFailureBacksOff(t *testing.T) {
	d, src, f, now := setup(t)
	src.feedErr = errors.New("youtube: 500")
	var prev time.Duration
	for i := 1; i <= 3; i++ {
		f.Pass(context.Background())
		var fails int
		var next int64
		var msg string
		d.QueryRow(`SELECT fail_count, next_fetch_at, last_error FROM channels WHERE id = ?`, chanID).Scan(&fails, &next, &msg)
		wait := time.Unix(next, 0).Sub(*now)
		if fails != i || msg == "" || wait <= prev {
			t.Fatalf("attempt %d: fails=%d wait=%v prev=%v err=%q", i, fails, wait, prev, msg)
		}
		prev = wait
		*now = time.Unix(next, 0).Add(time.Second)
	}
	// Recovery resets the failure state.
	src.feedErr, src.feed = nil, &yt.Feed{Title: "T"}
	f.Pass(context.Background())
	var fails int
	var msg string
	d.QueryRow(`SELECT fail_count, last_error FROM channels WHERE id = ?`, chanID).Scan(&fails, &msg)
	if fails != 0 || msg != "" {
		t.Errorf("after recovery: fails=%d err=%q", fails, msg)
	}
}

func TestEnrichGivesUpAfterMaxTries(t *testing.T) {
	d, src, f, now := setup(t)
	src.feed = &yt.Feed{Title: "T", Videos: []yt.FeedVideo{{ID: "nodetails01", Title: "x", Published: now.Add(-time.Hour)}}}
	for range maxEnrichTries + 2 {
		f.Pass(context.Background())
		*now = now.Add(48 * time.Hour)
		d.Exec(`UPDATE channels SET next_fetch_at = ?`, now.Add(time.Hour).Unix()) // isolate enrichment
	}
	v := video(t, d, "nodetails01")
	var tries int
	d.QueryRow(`SELECT enrich_attempts FROM videos WHERE id = 'nodetails01'`).Scan(&tries)
	if v.enrich != 0 || tries != maxEnrichTries {
		t.Errorf("enrich_after=%d attempts=%d, want 0 and %d", v.enrich, tries, maxEnrichTries)
	}
}

func TestPruneKeepsSavedVideos(t *testing.T) {
	d, _, f, now := setup(t)
	old := now.AddDate(-1, 0, 0).Unix()
	for _, id := range []string{"plain", "saved", "seen"} {
		d.Exec(`INSERT INTO videos (id, channel_id, title, published_at) VALUES (?, ?, 't', ?)`, id, chanID, old)
	}
	d.Exec(`INSERT INTO watch_later (user_id, video_id, added_at) VALUES ('u', 'saved', 0)`)
	d.Exec(`INSERT INTO watch_state (user_id, video_id, watched, updated_at) VALUES ('u', 'seen', 1, 0)`)
	f.prune()
	var n int
	d.QueryRow(`SELECT count(*) FROM videos`).Scan(&n)
	if n != 2 {
		t.Errorf("%d videos left, want 2 (saved and seen)", n)
	}
}

func TestAvatarIsLookedUpOnce(t *testing.T) {
	d, src, f, now := setup(t)
	src.feed = &yt.Feed{Title: "T"}
	thumb := func() (s string) {
		d.QueryRow(`SELECT thumbnail FROM channels WHERE id = ?`, chanID).Scan(&s)
		return
	}
	// A failed lookup is remembered instead of being repeated on every fetch.
	f.Pass(context.Background())
	*now = now.Add(time.Hour)
	f.Pass(context.Background())
	if thumb() != noAvatar || src.resolves != 1 {
		t.Errorf("after failed lookup: thumbnail=%q resolves=%d", thumb(), src.resolves)
	}
	d.Exec(`UPDATE channels SET thumbnail = ''`)
	src.avatar = "https://yt3.googleusercontent.com/a=s900"
	*now = now.Add(time.Hour)
	f.Pass(context.Background())
	if thumb() != src.avatar {
		t.Errorf("thumbnail = %q", thumb())
	}
}
