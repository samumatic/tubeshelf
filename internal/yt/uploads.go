package yt

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	reInitialData = regexp.MustCompile(`(?s)var ytInitialData = (\{.+?\});</script>`)
	reAgo         = regexp.MustCompile(`(?i)(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mos?|years?|yrs?|y)\s+ago`)
)

// Uploads scrapes a channel's Videos tab, which lists about 30 uploads where
// the RSS feed has 15. YouTube only gives relative dates there ("3 weeks
// ago"), so Published is approximate; Shorts are not on that tab.
func (c *Client) Uploads(ctx context.Context, channelID string) ([]FeedVideo, error) {
	if !IsChannelID(channelID) {
		return nil, errors.New("not a channel id")
	}
	body, err := c.do(ctx, http.MethodGet, "/channel/"+channelID+"/videos?hl=en&gl=US", nil)
	if err != nil {
		return nil, err
	}
	return parseUploads(body, time.Now())
}

func parseUploads(page []byte, now time.Time) ([]FeedVideo, error) {
	m := reInitialData.FindSubmatch(page)
	if m == nil {
		return nil, errors.New("youtube: no ytInitialData on the channel page")
	}
	var data any
	if err := json.Unmarshal(m[1], &data); err != nil {
		return nil, err
	}
	var out []FeedVideo
	for _, tab := range list(data, "contents", "twoColumnBrowseResultsRenderer", "tabs") {
		if at(tab, "tabRenderer", "selected") != true {
			continue
		}
		for _, item := range list(tab, "tabRenderer", "content", "richGridRenderer", "contents") {
			content := at(item, "richItemRenderer", "content")
			if lockup := at(content, "lockupViewModel"); lockup != nil {
				if v, ok := parseLockup(lockup, now); ok {
					out = append(out, v)
				}
			} else if r := at(content, "videoRenderer"); r != nil {
				if v, ok := parseVideoRenderer(r, now); ok {
					out = append(out, v)
				}
			}
		}
	}
	if len(out) == 0 {
		return nil, errors.New("youtube: no videos on the channel page")
	}
	return out, nil
}

func parseLockup(l any, now time.Time) (FeedVideo, bool) {
	if t := str(l, "contentType"); t != "" && t != "LOCKUP_CONTENT_TYPE_VIDEO" {
		return FeedVideo{}, false
	}
	meta := at(l, "metadata", "lockupMetadataViewModel")
	v := FeedVideo{ID: str(l, "contentId"), Title: str(meta, "title", "content")}
	// One row is usually [views, time ago]; a collab credit line can come first.
	for _, row := range list(meta, "metadata", "contentMetadataViewModel", "metadataRows") {
		for _, part := range list(row, "metadataParts") {
			for _, s := range []string{str(part, "accessibilityLabel"), str(part, "text", "content")} {
				if t, ok := parseAgo(s, now); ok && v.Published.IsZero() {
					v.Published = t
				}
			}
		}
	}
	// Without a date the entry is malformed; a made-up "now" would sort an old video to the top.
	return v, v.ID != "" && v.Title != "" && !v.Published.IsZero()
}

func parseVideoRenderer(r any, now time.Time) (FeedVideo, bool) {
	v := FeedVideo{ID: str(r, "videoId"), Title: text(at(r, "title"))}
	v.Published, _ = parseAgo(text(at(r, "publishedTimeText")), now)
	return v, v.ID != "" && v.Title != "" && !v.Published.IsZero()
}

// parseAgo turns "5 days ago" or "5d ago" into a time, rounded down to the
// unit's precision. "Streamed 2 weeks ago" works too; "Premieres soon" does not.
func parseAgo(s string, now time.Time) (time.Time, bool) {
	m := reAgo.FindStringSubmatch(s)
	if m == nil {
		return time.Time{}, false
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return time.Time{}, false
	}
	unit := strings.ToLower(m[2])
	day := func(t time.Time) time.Time { return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location()) }
	switch {
	case strings.HasPrefix(unit, "mo"):
		return day(now.AddDate(0, -n, 0)), true
	case unit[0] == 's':
		return now.Add(-time.Duration(n) * time.Second).Truncate(time.Second), true
	case unit[0] == 'm':
		return now.Add(-time.Duration(n) * time.Minute).Truncate(time.Minute), true
	case unit[0] == 'h':
		return now.Add(-time.Duration(n) * time.Hour).Truncate(time.Hour), true
	case unit[0] == 'd':
		return day(now.AddDate(0, 0, -n)), true
	case unit[0] == 'w':
		return day(now.AddDate(0, 0, -7*n)), true
	case unit[0] == 'y':
		return day(now.AddDate(-n, 0, 0)), true
	}
	return time.Time{}, false
}
