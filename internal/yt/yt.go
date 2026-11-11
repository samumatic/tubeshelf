// Package yt talks to YouTube without an account or API key: the public RSS
// feed lists a channel's uploads, the Innertube player endpoint adds duration
// and live state, and the channel page resolves handles to channel ids.
package yt

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
		"(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
	// Pre-answers the EU cookie wall so requests are not redirected to consent.youtube.com.
	consentCookie = "SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjMwODI5LjA2X3AwGgJlbiAAKAA"
	maxBody       = 4 << 20
)

// ErrNotFound means YouTube answered 404: the channel or video is gone.
var ErrNotFound = errors.New("not found on YouTube")

// Client fetches from YouTube. BaseURL is overridable for tests.
type Client struct {
	HTTP    *http.Client
	BaseURL string
}

func New() *Client {
	return &Client{HTTP: &http.Client{Timeout: 15 * time.Second}, BaseURL: "https://www.youtube.com"}
}

func (c *Client) do(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept-Language", "en-US,en;q=0.8")
	req.Header.Set("Cookie", consentCookie)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, ErrNotFound
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("youtube: %s %s: %s", method, path, res.Status)
	}
	return io.ReadAll(io.LimitReader(res.Body, maxBody))
}

// FeedVideo is one upload from a channel's RSS feed.
type FeedVideo struct {
	ID        string
	Title     string
	Published time.Time
	Short     bool
}

// Feed is a channel's RSS feed (about the 15 newest uploads).
type Feed struct {
	Title  string
	Videos []FeedVideo
}

type rssFeed struct {
	Title   string `xml:"title"`
	Entries []struct {
		VideoID   string `xml:"http://www.youtube.com/xml/schemas/2015 videoId"`
		Title     string `xml:"title"`
		Published string `xml:"published"`
		Links     []struct {
			Rel  string `xml:"rel,attr"`
			Href string `xml:"href,attr"`
		} `xml:"link"`
	} `xml:"entry"`
}

// Feed fetches the RSS feed of a channel id (UC...).
func (c *Client) Feed(ctx context.Context, channelID string) (*Feed, error) {
	body, err := c.do(ctx, http.MethodGet, "/feeds/videos.xml?channel_id="+url.QueryEscape(channelID), nil)
	if err != nil {
		return nil, err
	}
	return parseFeed(body)
}

func parseFeed(body []byte) (*Feed, error) {
	var raw rssFeed
	if err := xml.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("youtube: parse feed: %w", err)
	}
	f := &Feed{Title: raw.Title}
	for _, e := range raw.Entries {
		t, err := time.Parse(time.RFC3339, e.Published)
		if err != nil || e.VideoID == "" {
			continue
		}
		v := FeedVideo{ID: e.VideoID, Title: e.Title, Published: t}
		for _, l := range e.Links {
			// YouTube links Shorts as /shorts/ID and everything else as /watch?v=ID.
			if l.Rel == "alternate" && strings.Contains(l.Href, "/shorts/") {
				v.Short = true
			}
		}
		f.Videos = append(f.Videos, v)
	}
	return f, nil
}

// Details is what the player endpoint knows about one video.
type Details struct {
	Seconds     int
	Live        bool
	Upcoming    bool
	MembersOnly bool
}

type playerResponse struct {
	PlayabilityStatus struct {
		Status string `json:"status"`
		Reason string `json:"reason"`
	} `json:"playabilityStatus"`
	VideoDetails *struct {
		LengthSeconds string `json:"lengthSeconds"`
		IsLive        bool   `json:"isLive"`
		IsUpcoming    bool   `json:"isUpcoming"`
	} `json:"videoDetails"`
}

// Details asks the Innertube player endpoint about a video. It needs no key;
// the response carries length and live state even when playback is refused.
func (c *Client) Details(ctx context.Context, videoID string) (*Details, error) {
	req, _ := json.Marshal(map[string]any{
		"videoId": videoID,
		"context": map[string]any{"client": map[string]string{
			"clientName": "WEB", "clientVersion": "2.20250101.00.00", "hl": "en", "gl": "US",
		}},
	})
	body, err := c.do(ctx, http.MethodPost, "/youtubei/v1/player?prettyPrint=false", req)
	if err != nil {
		return nil, err
	}
	return parseDetails(body)
}

func parseDetails(body []byte) (*Details, error) {
	var p playerResponse
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, fmt.Errorf("youtube: parse player: %w", err)
	}
	if p.VideoDetails == nil {
		if p.PlayabilityStatus.Status == "ERROR" {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("youtube: player has no video details (%s)", p.PlayabilityStatus.Status)
	}
	secs, _ := strconv.Atoi(p.VideoDetails.LengthSeconds)
	return &Details{
		Seconds:     secs,
		Live:        p.VideoDetails.IsLive,
		Upcoming:    p.VideoDetails.IsUpcoming,
		MembersOnly: strings.Contains(strings.ToLower(p.PlayabilityStatus.Reason), "members-only"),
	}, nil
}

// Channel identifies a channel.
type Channel struct {
	ID        string
	Title     string
	Thumbnail string
}

var (
	reChannelID = regexp.MustCompile(`^UC[\w-]{22}$`)
	reCanonical = regexp.MustCompile(`<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[\w-]{22})"`)
	reOGTitle   = regexp.MustCompile(`<meta property="og:title" content="([^"]*)"`)
	reOGImage   = regexp.MustCompile(`<meta property="og:image" content="([^"]*)"`)
)

// IsChannelID reports whether s looks like a channel id.
func IsChannelID(s string) bool { return reChannelID.MatchString(s) }

// channelPath turns user input (channel id, @handle, or any youtube.com
// channel URL) into the path of that channel's page.
func channelPath(input string) (string, error) {
	s := strings.TrimSpace(input)
	if IsChannelID(s) {
		return "/channel/" + s, nil
	}
	if strings.HasPrefix(s, "@") {
		return "/" + url.PathEscape(s), nil
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", fmt.Errorf("not a channel: %q", input)
	}
	host := strings.TrimPrefix(strings.TrimPrefix(u.Hostname(), "www."), "m.")
	if host != "youtube.com" {
		return "", fmt.Errorf("not a YouTube channel: %q", input)
	}
	parts := strings.Split(strings.Trim(u.EscapedPath(), "/"), "/")
	switch {
	case len(parts) >= 1 && strings.HasPrefix(parts[0], "@"):
		return "/" + parts[0], nil
	case len(parts) >= 2 && (parts[0] == "channel" || parts[0] == "c" || parts[0] == "user"):
		return "/" + parts[0] + "/" + parts[1], nil
	}
	return "", fmt.Errorf("not a YouTube channel: %q", input)
}

// Resolve looks up a channel from an id, @handle or channel URL.
func (c *Client) Resolve(ctx context.Context, input string) (*Channel, error) {
	path, err := channelPath(input)
	if err != nil {
		return nil, err
	}
	body, err := c.do(ctx, http.MethodGet, path+"?hl=en&gl=US", nil)
	if err != nil {
		return nil, err
	}
	return parseChannel(body)
}

func parseChannel(body []byte) (*Channel, error) {
	m := reCanonical.FindSubmatch(body)
	if m == nil {
		return nil, errors.New("youtube: channel page has no channel id")
	}
	ch := &Channel{ID: string(m[1])}
	if t := reOGTitle.FindSubmatch(body); t != nil {
		ch.Title = html.UnescapeString(string(t[1]))
	}
	if t := reOGImage.FindSubmatch(body); t != nil {
		ch.Thumbnail = html.UnescapeString(string(t[1]))
	}
	if ch.Title == "" {
		ch.Title = ch.ID
	}
	return ch, nil
}
