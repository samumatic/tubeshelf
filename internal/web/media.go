package web

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/samumatic/tubeshelf/internal/yt"
)

const maxImageBytes = 2 << 20

// fetchImage downloads an image to path (atomically) unless it is cached.
func (s *Server) fetchImage(ctx context.Context, src, path string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
	if err != nil {
		return err
	}
	res, err := s.media.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK || !strings.HasPrefix(res.Header.Get("Content-Type"), "image/") {
		return fmt.Errorf("image fetch: %s", res.Status)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, io.LimitReader(res.Body, maxImageBytes)); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func (s *Server) serveImage(w http.ResponseWriter, r *http.Request, src, path string) {
	if err := s.fetchImage(r.Context(), src, path); err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=604800")
	http.ServeFile(w, r, path)
}

// thumb serves a video thumbnail from the disk cache, so browsers never
// contact Google for the feed. Only ids known to the database are fetched.
func (s *Server) thumb(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSuffix(r.PathValue("id"), ".jpg")
	var n int
	if !reVideoID.MatchString(id) || s.DB.QueryRow(`SELECT count(*) FROM videos WHERE id = ?`, id).Scan(&n) != nil || n == 0 {
		http.NotFound(w, r)
		return
	}
	// mqdefault is 320x180, true 16:9 without the letterbox bars of hqdefault.
	s.serveImage(w, r, "https://i.ytimg.com/vi/"+id+"/mqdefault.jpg", filepath.Join(s.DataDir, "thumbs", id+".jpg"))
}

var reAvatarSize = regexp.MustCompile(`=s\d+[^/]*$`)

func (s *Server) avatar(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var src string
	if !yt.IsChannelID(id) || s.DB.QueryRow(`SELECT thumbnail FROM channels WHERE id = ?`, id).Scan(&src) != nil {
		http.NotFound(w, r)
		return
	}
	u, err := url.Parse(src)
	// Only YouTube's own avatar hosts: the URL comes from scraped or imported data.
	if err != nil || u.Scheme != "https" || !(strings.HasSuffix(u.Host, ".googleusercontent.com") || strings.HasSuffix(u.Host, ".ggpht.com")) {
		http.NotFound(w, r)
		return
	}
	s.serveImage(w, r, reAvatarSize.ReplaceAllString(src, "=s88-c-k-c0x00ffffff-no-rj"), filepath.Join(s.DataDir, "avatars", id+".jpg"))
}

// PruneMedia removes cached images of videos and channels that are gone.
func (s *Server) PruneMedia() {
	for dir, query := range map[string]string{
		"thumbs":  `SELECT count(*) FROM videos WHERE id = ?`,
		"avatars": `SELECT count(*) FROM channels WHERE id = ?`,
	} {
		entries, err := os.ReadDir(filepath.Join(s.DataDir, dir))
		if err != nil {
			continue
		}
		removed := 0
		for _, e := range entries {
			var n int
			id := strings.TrimSuffix(e.Name(), ".jpg")
			if s.DB.QueryRow(query, id).Scan(&n) == nil && n == 0 {
				os.Remove(filepath.Join(s.DataDir, dir, e.Name()))
				removed++
			}
		}
		if removed > 0 {
			slog.Info("media: pruned cache", "dir", dir, "files", removed)
		}
	}
}

type segmentCache struct {
	mu sync.Mutex
	m  map[string]segmentEntry
}

type segmentEntry struct {
	at   time.Time
	segs [][2]float64
}

// sponsorSegments returns SponsorBlock sponsor segments for a video. The
// lookup runs on the server with a hash prefix, so SponsorBlock sees neither
// the viewer nor the exact video.
func (s *Server) sponsorSegments(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !reVideoID.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	s.segments.mu.Lock()
	e, hit := s.segments.m[id]
	s.segments.mu.Unlock()
	if !hit || time.Since(e.at) > 6*time.Hour {
		segs, err := s.fetchSegments(r.Context(), id)
		if err != nil {
			writeJSON(w, http.StatusOK, [][2]float64{})
			return
		}
		e = segmentEntry{at: time.Now(), segs: segs}
		s.segments.mu.Lock()
		if s.segments.m == nil || len(s.segments.m) > 2000 {
			s.segments.m = map[string]segmentEntry{}
		}
		s.segments.m[id] = e
		s.segments.mu.Unlock()
	}
	writeJSON(w, http.StatusOK, e.segs)
}

func (s *Server) fetchSegments(ctx context.Context, id string) ([][2]float64, error) {
	sum := sha256.Sum256([]byte(id))
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://sponsor.ajay.app/api/skipSegments/"+hex.EncodeToString(sum[:])[:4]+`?categories=["sponsor"]`, nil)
	res, err := s.media.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	out := [][2]float64{}
	if res.StatusCode == http.StatusNotFound {
		return out, nil
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("sponsorblock: %s", res.Status)
	}
	var all []struct {
		VideoID  string `json:"videoID"`
		Segments []struct {
			Segment [2]float64 `json:"segment"`
		} `json:"segments"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&all); err != nil {
		return nil, err
	}
	for _, v := range all {
		if v.VideoID == id {
			for _, seg := range v.Segments {
				out = append(out, seg.Segment)
			}
		}
	}
	return out, nil
}
