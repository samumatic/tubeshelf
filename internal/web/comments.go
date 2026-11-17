package web

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/samumatic/tubeshelf/internal/yt"
)

// commentCache keeps pages briefly, so going back and forth between videos
// does not ask YouTube again.
type commentCache struct {
	mu sync.Mutex
	m  map[string]commentEntry
}

type commentEntry struct {
	at   time.Time
	page *yt.CommentsPage
}

const commentTTL = 5 * time.Minute

// comments returns one page of a video's comments as an HTML fragment for
// player.js. ?t= carries a "more" or sort token from an earlier page. The
// server asks YouTube, so the viewer's browser does not.
func (s *Server) comments(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	tok := r.URL.Query().Get("t")
	if !reVideoID.MatchString(id) || len(tok) > 4096 {
		http.NotFound(w, r)
		return
	}
	key := id + "\x00" + tok
	s.commentsCache.mu.Lock()
	e, hit := s.commentsCache.m[key]
	s.commentsCache.mu.Unlock()
	if !hit || time.Since(e.at) > commentTTL {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		page, err := s.YT.Comments(ctx, id, tok)
		if err != nil {
			slog.Warn("comments", "video", id, "err", err)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusBadGateway)
			w.Write([]byte(`<p class="muted">Comments could not be loaded from YouTube. Try again later.</p>`))
			return
		}
		e = commentEntry{at: time.Now(), page: page}
		s.commentsCache.mu.Lock()
		if s.commentsCache.m == nil || len(s.commentsCache.m) > 500 {
			s.commentsCache.m = map[string]commentEntry{}
		}
		s.commentsCache.m[key] = e
		s.commentsCache.mu.Unlock()
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "private, max-age=300")
	// The sort buttons come with the first page only; player.js keeps them when the order changes.
	data := M{"P": e.page, "First": tok == "" || r.URL.Query().Get("sort") == "1", "Sort": tok}
	if err := s.pages["comments"].ExecuteTemplate(w, "comments", data); err != nil {
		slog.Error("render comments", "err", err)
	}
}
