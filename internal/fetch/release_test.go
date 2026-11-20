package fetch

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/samumatic/tubeshelf/internal/yt"
)

// Seeing a known video again in the feed must not wipe what enrichment found
// or queue it for another lookup.
func TestRefetchKeepsEnrichedData(t *testing.T) {
	d, src, f, now := setup(t)
	src.feed = &yt.Feed{Title: "T", Videos: []yt.FeedVideo{{ID: "video000001", Title: "A", Published: now.Add(-time.Hour)}}}
	src.details["video000001"] = &yt.Details{Seconds: 300, MembersOnly: true}
	f.Pass(context.Background())

	*now = now.Add(2 * time.Hour)
	src.feed.Videos[0].Title = "A (renamed)"
	f.Pass(context.Background())
	var title string
	var members bool
	d.QueryRow(`SELECT title, members_only FROM videos WHERE id = 'video000001'`).Scan(&title, &members)
	if v := video(t, d, "video000001"); v.secs.Int64 != 300 || v.enrich != 0 {
		t.Errorf("refetch reset enrichment: %+v", v)
	}
	if title != "A (renamed)" || !members {
		t.Errorf("after refetch: title %q, members %v", title, members)
	}
}

// A feed without a title (YouTube hiccup) must not blank the channel name.
func TestEmptyFeedTitleKeepsChannelName(t *testing.T) {
	d, src, f, _ := setup(t)
	src.feed = &yt.Feed{}
	f.Pass(context.Background())
	var title string
	d.QueryRow(`SELECT title FROM channels WHERE id = ?`, chanID).Scan(&title)
	if title != "old title" {
		t.Errorf("channel title = %q, want it kept", title)
	}
}

// Nobody subscribed: the channel is not fetched, and pruning removes it.
func TestUnsubscribedChannelIsNotFetched(t *testing.T) {
	d, src, f, now := setup(t)
	d.Exec(`DELETE FROM subscriptions`)
	src.feed = &yt.Feed{Title: "T", Videos: []yt.FeedVideo{{ID: "video000001", Title: "A", Published: now.Add(-time.Hour)}}}
	f.Pass(context.Background())
	var n int
	d.QueryRow(`SELECT count(*) FROM videos`).Scan(&n)
	if n != 0 {
		t.Error("a channel nobody subscribes to was fetched")
	}
	f.prune()
	d.QueryRow(`SELECT count(*) FROM channels`).Scan(&n)
	if n != 0 {
		t.Error("prune kept a channel nobody subscribes to")
	}
}

func TestBackoffIsCapped(t *testing.T) {
	for fails, want := range map[int]time.Duration{1: time.Minute, 2: 2 * time.Minute, 3: 4 * time.Minute, 100: maxBackoff} {
		if got := backoff(time.Minute, fails); got != want {
			t.Errorf("backoff(1m, %d) = %v, want %v", fails, got, want)
		}
	}
}

// A channel's first fetch adds older uploads from its page, once. RSS dates
// win over the page's approximate ones, and a failing page changes nothing.
func TestFirstFetchAddsBacklogOnce(t *testing.T) {
	d, src, f, now := setup(t)
	src.feed = &yt.Feed{Title: "T", Videos: []yt.FeedVideo{{ID: "rssvideo001", Title: "From RSS", Published: now.Add(-90 * time.Minute)}}}
	src.uploads = []yt.FeedVideo{
		{ID: "rssvideo001", Title: "From page", Published: now.Add(-2 * time.Hour)},
		{ID: "oldvideo001", Title: "Older", Published: now.AddDate(0, 0, -40)},
		{ID: "ancient0001", Title: "Past retention", Published: now.AddDate(-2, 0, 0)},
	}
	f.Pass(context.Background())

	var published int64
	var title string
	d.QueryRow(`SELECT published_at, title FROM videos WHERE id = 'rssvideo001'`).Scan(&published, &title)
	if published != now.Add(-90*time.Minute).Unix() || title != "From RSS" {
		t.Errorf("RSS data was overwritten by the page: %d %q", published, title)
	}
	if v := video(t, d, "oldvideo001"); v.enrich == 0 {
		t.Error("backlog video not queued for duration lookup")
	}
	var n int
	d.QueryRow(`SELECT count(*) FROM videos WHERE id = 'ancient0001'`).Scan(&n)
	if n != 0 {
		t.Error("backlog video past retention was stored")
	}

	*now = now.Add(time.Hour)
	f.Pass(context.Background())
	if src.uploadCalls != 1 {
		t.Errorf("channel page read %d times, want once", src.uploadCalls)
	}
}

// Rescrape reads the page again on the next pass only, even for a channel
// that already had its first fetch.
func TestRescrapeReadsPageOnce(t *testing.T) {
	d, src, f, now := setup(t)
	src.feed = &yt.Feed{Title: "T"}
	f.Pass(context.Background())
	src.uploads = []yt.FeedVideo{{ID: "oldvideo001", Title: "Older", Published: now.AddDate(0, 0, -3)}}
	f.Rescrape(chanID)
	f.Pass(context.Background())
	if src.uploadCalls != 2 {
		t.Fatalf("channel page read %d times, want twice", src.uploadCalls)
	}
	var n int
	d.QueryRow(`SELECT count(*) FROM videos WHERE id = 'oldvideo001'`).Scan(&n)
	if n != 1 {
		t.Error("rescraped video not stored")
	}
	f.Retry(chanID)
	f.Pass(context.Background())
	if src.uploadCalls != 2 {
		t.Errorf("a plain retry read the page again (%d reads)", src.uploadCalls)
	}
}

func TestBacklogFailureFallsBackToRSS(t *testing.T) {
	d, src, f, now := setup(t)
	src.feed = &yt.Feed{Title: "T", Videos: []yt.FeedVideo{{ID: "rssvideo001", Title: "From RSS", Published: now.Add(-time.Hour)}}}
	src.uploadsErr = errors.New("consent wall")
	f.Pass(context.Background())
	var n int
	d.QueryRow(`SELECT count(*) FROM videos`).Scan(&n)
	if n != 1 {
		t.Errorf("got %d videos, want the RSS one", n)
	}
	var ok bool
	d.QueryRow(`SELECT last_success_at IS NOT NULL FROM channels WHERE id = ?`, chanID).Scan(&ok)
	if !ok {
		t.Error("a failing channel page marked the whole fetch as failed")
	}
}

// The page only says "3 weeks ago"; the duration lookup brings the exact upload
// date for those rows, and leaves RSS dates alone.
func TestBacklogGetsExactDate(t *testing.T) {
	d, src, f, now := setup(t)
	rssAt := now.Add(-90 * time.Minute)
	exact := now.AddDate(0, 0, -22).Add(5 * time.Hour)
	src.feed = &yt.Feed{Title: "T", Videos: []yt.FeedVideo{{ID: "rssvideo001", Title: "From RSS", Published: rssAt}}}
	src.uploads = []yt.FeedVideo{{ID: "oldvideo001", Title: "Older", Published: now.AddDate(0, 0, -21)}}
	src.details["rssvideo001"] = &yt.Details{Seconds: 60, Published: rssAt.Add(-time.Hour)}
	src.details["oldvideo001"] = &yt.Details{Seconds: 60, Published: exact}
	f.Pass(context.Background())

	var rss, old int64
	d.QueryRow(`SELECT published_at FROM videos WHERE id = 'rssvideo001'`).Scan(&rss)
	d.QueryRow(`SELECT published_at FROM videos WHERE id = 'oldvideo001'`).Scan(&old)
	if rss != rssAt.Unix() {
		t.Errorf("RSS date changed: %v", time.Unix(rss, 0).UTC())
	}
	if old != exact.Unix() {
		t.Errorf("backlog date = %v, want %v", time.Unix(old, 0).UTC(), exact)
	}
}
