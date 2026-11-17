package yt

import (
	"testing"
	"time"
)

func TestParseAgo(t *testing.T) {
	now := time.Date(2026, 11, 17, 15, 30, 45, 0, time.UTC)
	for in, want := range map[string]time.Time{
		"5 days ago":           time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC),
		"5d ago":               time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC),
		"1 month ago":          time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC),
		"1mo ago":              time.Date(2026, 10, 17, 0, 0, 0, 0, time.UTC),
		"3 minutes ago":        time.Date(2026, 11, 17, 15, 27, 0, 0, time.UTC),
		"2 hours ago":          time.Date(2026, 11, 17, 13, 0, 0, 0, time.UTC),
		"Streamed 2 weeks ago": time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC),
		"1 year ago":           time.Date(2025, 11, 17, 0, 0, 0, 0, time.UTC),
	} {
		if got, ok := parseAgo(in, now); !ok || !got.Equal(want) {
			t.Errorf("parseAgo(%q) = %v %v, want %v", in, got, ok, want)
		}
	}
	for _, in := range []string{"", "Premieres in 2 hours", "Scheduled for 20/11/2026", "1.2M views"} {
		if _, ok := parseAgo(in, now); ok {
			t.Errorf("parseAgo(%q) gave a date", in)
		}
	}
}

func TestParseUploads(t *testing.T) {
	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	page := []byte(`<html><script>var ytInitialData = {"contents":{"twoColumnBrowseResultsRenderer":{"tabs":[
	 {"tabRenderer":{"title":"Home"}},
	 {"tabRenderer":{"selected":true,"content":{"richGridRenderer":{"contents":[
	  {"richItemRenderer":{"content":{"lockupViewModel":{"contentId":"lockup00001","contentType":"LOCKUP_CONTENT_TYPE_VIDEO",
	    "metadata":{"lockupMetadataViewModel":{"title":{"content":"New layout"},"metadata":{"contentMetadataViewModel":{"metadataRows":[
	      {"metadataParts":[{"text":{"content":"A and B"}}]},
	      {"metadataParts":[{"text":{"content":"943K views"}},{"text":{"content":"3d ago"},"accessibilityLabel":"3 days ago"}]}]}}}}}}}},
	  {"richItemRenderer":{"content":{"lockupViewModel":{"contentId":"nodate00001","metadata":{"lockupMetadataViewModel":{"title":{"content":"No date"}}}}}}},
	  {"richItemRenderer":{"content":{"lockupViewModel":{"contentId":"playlist001","contentType":"LOCKUP_CONTENT_TYPE_PLAYLIST"}}}},
	  {"richItemRenderer":{"content":{"videoRenderer":{"videoId":"legacy00001","title":{"runs":[{"text":"Old layout"}]},"publishedTimeText":{"simpleText":"2 weeks ago"}}}}},
	  {"continuationItemRenderer":{}}]}}}}]}}};</script></html>`)
	got, err := parseUploads(page, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d videos, want 2 (undated and playlist skipped): %+v", len(got), got)
	}
	if got[0].ID != "lockup00001" || got[0].Title != "New layout" || !got[0].Published.Equal(time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("lockup: %+v", got[0])
	}
	if got[1].ID != "legacy00001" || got[1].Title != "Old layout" || !got[1].Published.Equal(time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("videoRenderer: %+v", got[1])
	}
	if _, err := parseUploads([]byte("<html>consent wall</html>"), now); err == nil {
		t.Error("a page without data must be an error, so the fetcher falls back to RSS")
	}
}
