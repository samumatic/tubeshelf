package web

import (
	"compress/gzip"
	"net/http"
	"strings"
	"sync"
)

var gzipPool = sync.Pool{New: func() any { w, _ := gzip.NewWriterLevel(nil, gzip.DefaultCompression); return w }}

// compressible lists the types worth compressing; images and video are compressed already.
func compressible(ct string) bool {
	for _, p := range []string{"text/", "application/json", "application/javascript", "image/svg+xml", "application/xml", "application/speculationrules+json", "text/x-opml"} {
		if strings.HasPrefix(ct, p) {
			return true
		}
	}
	return false
}

type gzipResponse struct {
	http.ResponseWriter
	gz      *gzip.Writer
	decided bool
}

func (g *gzipResponse) WriteHeader(code int) {
	if !g.decided {
		g.decided = true
		h := g.Header()
		if h.Get("Content-Encoding") == "" && code != http.StatusNoContent && code != http.StatusNotModified && compressible(h.Get("Content-Type")) {
			h.Set("Content-Encoding", "gzip")
			h.Del("Content-Length")
			g.gz = gzipPool.Get().(*gzip.Writer)
			g.gz.Reset(g.ResponseWriter)
		}
	}
	g.ResponseWriter.WriteHeader(code)
}

func (g *gzipResponse) Write(b []byte) (int, error) {
	if !g.decided {
		if g.Header().Get("Content-Type") == "" {
			g.Header().Set("Content-Type", http.DetectContentType(b))
		}
		g.WriteHeader(http.StatusOK)
	}
	if g.gz != nil {
		return g.gz.Write(b)
	}
	return g.ResponseWriter.Write(b)
}

func (g *gzipResponse) Flush() {
	if g.gz != nil {
		g.gz.Flush()
	}
	if f, ok := g.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (g *gzipResponse) close() {
	if g.gz != nil {
		g.gz.Close()
		gzipPool.Put(g.gz)
	}
}

// compress gzips text responses for clients that accept it: pages, CSS, JS and JSON.
func compress(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Vary", "Accept-Encoding")
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") || r.Method == http.MethodHead || r.Header.Get("Range") != "" {
			h.ServeHTTP(w, r)
			return
		}
		g := &gzipResponse{ResponseWriter: w}
		defer g.close()
		h.ServeHTTP(g, r)
	})
}
