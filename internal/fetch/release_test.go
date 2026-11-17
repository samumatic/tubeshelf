package fetch

import (
	"context"
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
