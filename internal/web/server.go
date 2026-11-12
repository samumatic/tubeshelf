// Package web serves the HTML UI, the small JSON API and cached media.
package web

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"fmt"
	"html/template"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/samumatic/tubeshelf/internal/auth"
	"github.com/samumatic/tubeshelf/internal/db"
	"github.com/samumatic/tubeshelf/internal/fetch"
	"github.com/samumatic/tubeshelf/internal/yt"
)

//go:embed templates/*.html
var templateFS embed.FS

//go:embed static
var staticFS embed.FS

const sessionCookie = "tubeshelf_session"

type Server struct {
	DB      *sql.DB
	YT      *yt.Client
	Fetcher *fetch.Fetcher
	Secret  auth.Secret
	DataDir string
	Version string

	pages    map[string]*template.Template
	assetVer string
	logins   limiter
	segments segmentCache
	media    *http.Client
}

type ctxKey struct{}

func (s *Server) user(r *http.Request) *auth.User {
	u, _ := r.Context().Value(ctxKey{}).(*auth.User)
	return u
}

// Handler builds the routes. Call once.
func (s *Server) Handler() (http.Handler, error) {
	if err := s.loadTemplates(); err != nil {
		return nil, err
	}
	s.media = &http.Client{Timeout: 15 * time.Second}
	static, _ := fs.Sub(staticFS, "static")
	s.assetVer = hashFS(static)

	mux := http.NewServeMux()
	// Public.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	mux.Handle("GET /static/", http.StripPrefix("/static/", cacheForever(http.FileServerFS(static))))
	mux.HandleFunc("GET /login", s.loginPage)
	mux.HandleFunc("POST /login", s.loginSubmit)
	mux.HandleFunc("GET /setup", s.setupPage)
	mux.HandleFunc("POST /setup", s.setupSubmit)
	mux.HandleFunc("GET /register", s.registerPage)
	mux.HandleFunc("POST /register", s.registerSubmit)
	mux.HandleFunc("GET /api/auth/oidc/start", s.oidcStart)
	mux.HandleFunc("GET "+auth.CallbackPath, s.oidcCallback)

	// Signed-in pages.
	page := func(pattern string, h http.HandlerFunc) { mux.Handle(pattern, s.requireUser(h)) }
	page("GET /{$}", s.feedPage)
	page("GET /later", s.laterPage)
	page("GET /history", s.historyPage)
	page("GET /watch/{id}", s.watchPage)
	page("POST /videos/{id}/watched", s.setWatched)
	page("POST /videos/{id}/later", s.setLater)
	page("POST /videos/{id}/progress", s.setProgress)
	page("GET /videos/{id}/segments", s.sponsorSegments)
	page("GET /thumb/{id}", s.thumb)
	page("GET /avatar/{id}", s.avatar)
	page("POST /logout", s.logout)

	page("GET /channels", s.channelsPage)
	page("POST /channels", s.addChannel)
	page("POST /channels/import", s.importOPML)
	page("GET /channels/export.opml", s.exportOPML)
	page("POST /channels/{id}/delete", s.deleteChannel)
	page("POST /lists", s.addList)
	page("POST /lists/{id}/delete", s.deleteList)
	page("POST /lists/{id}/channels", s.setListChannel)

	page("GET /settings", s.settingsPage)
	page("POST /settings", s.saveSettings)
	page("POST /settings/profile", s.saveProfile)
	page("POST /settings/password", s.changePassword)
	page("POST /settings/keys", s.addAPIKey)
	page("POST /settings/keys/{id}/delete", s.deleteAPIKey)
	page("POST /settings/danger", s.danger)

	admin := func(pattern string, h http.HandlerFunc) { mux.Handle(pattern, s.requireUser(s.requireAdmin(h))) }
	admin("GET /admin", s.adminPage)
	admin("POST /admin/settings", s.saveInstanceSettings)
	admin("POST /admin/refresh", s.refreshAll)
	admin("POST /admin/users", s.adminAddUser)
	admin("POST /admin/users/{id}", s.adminUpdateUser)
	admin("POST /admin/providers", s.adminSaveProvider)
	admin("POST /admin/providers/{id}/delete", s.adminDeleteProvider)

	// JSON API, usable with an API key.
	api := func(pattern string, h http.HandlerFunc) { mux.Handle(pattern, s.requireAPI(h)) }
	api("GET /api/subscriptions", s.apiListSubscriptions)
	api("POST /api/subscriptions", s.apiAddSubscription)
	api("DELETE /api/subscriptions/{id}", s.apiDeleteSubscription)
	api("DELETE /api/subscriptions", s.apiDeleteSubscription)
	api("GET /api/subscriptions/export", s.exportOPML)
	mux.HandleFunc("GET /api/version", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"version": s.Version})
	})

	// Rejects cross-site POSTs (CSRF) using Sec-Fetch-Site / Origin.
	csrf := http.NewCrossOriginProtection()
	return securityHeaders(csrf.Handler(s.loadUser(mux))), nil
}

func (s *Server) loadTemplates() error {
	funcs := template.FuncMap{
		"ago": ago, "dur": dur, "iso": func(t int64) string { return time.Unix(t, 0).UTC().Format(time.RFC3339) },
		"date": func(t int64) string { return time.Unix(t, 0).Format("2 Jan 2006") },
		"pct":  pct, "query": queryWith, "initial": initial,
		"card": func(v Video, set map[string]string) M { return M{"V": v, "Set": set} },
		"toggle": func(key, label string, set map[string]string) M {
			return M{"Key": key, "Label": label, "On": set[key] == "1"}
		},
		"list":        func(items ...string) []string { return items },
		"newProvider": func() auth.Provider { return auth.Provider{} },
	}
	base, err := template.New("base").Funcs(funcs).ParseFS(templateFS, "templates/_*.html")
	if err != nil {
		return err
	}
	names, _ := fs.Glob(templateFS, "templates/[a-z]*.html")
	s.pages = map[string]*template.Template{}
	for _, n := range names {
		t, err := template.Must(base.Clone()).ParseFS(templateFS, n)
		if err != nil {
			return err
		}
		s.pages[strings.TrimSuffix(strings.TrimPrefix(n, "templates/"), ".html")] = t
	}
	return nil
}

type M = map[string]any

// render executes a page inside the layout. Fragment requests (infinite
// scroll) get only the "items" block.
func (s *Server) render(w http.ResponseWriter, r *http.Request, page string, data M) {
	if data == nil {
		data = M{}
	}
	u := s.user(r)
	data["User"] = u
	if u != nil {
		data["NavLists"] = s.lists(u.ID)
	}
	data["Page"] = page
	data["AssetV"] = s.assetVer
	data["Version"] = s.Version
	data["Msg"] = r.URL.Query().Get("msg")
	data["Err"] = r.URL.Query().Get("err")
	if _, ok := data["Set"]; !ok {
		if u != nil {
			data["Set"] = db.UserSettings(s.DB, u.ID)
		} else {
			data["Set"] = db.UserDefaults
		}
	}
	block := "layout"
	if r.URL.Query().Get("fragment") == "1" {
		block = "items"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if err := s.pages[page].ExecuteTemplate(w, block, data); err != nil {
		slog.Error("render", "page", page, "err", err)
	}
}

func hashFS(f fs.FS) string {
	h := sha256.New()
	fs.WalkDir(f, ".", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := fs.ReadFile(f, p)
			h.Write([]byte(p))
			h.Write(b)
		}
		return nil
	})
	return hex.EncodeToString(h.Sum(nil))[:10]
}

func cacheForever(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Asset URLs carry ?v=<content hash>, so they can be cached for good.
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		h.ServeHTTP(w, r)
	})
}

func securityHeaders(h http.Handler) http.Handler {
	const csp = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
		"frame-src https://www.youtube-nocookie.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", csp)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.ServeHTTP(w, r)
	})
}

func isHTTPS(r *http.Request) bool {
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}

// baseURL is the public origin, used for OIDC redirects.
func baseURL(r *http.Request) string {
	if v := os.Getenv("TUBESHELF_URL"); v != "" {
		return strings.TrimRight(v, "/")
	}
	if v := os.Getenv("BETTER_AUTH_URL"); v != "" {
		return strings.TrimRight(v, "/")
	}
	scheme := "http"
	if isHTTPS(r) {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

func (s *Server) setSession(w http.ResponseWriter, r *http.Request, tok string) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: tok, Path: "/", HttpOnly: true,
		Secure: isHTTPS(r), SameSite: http.SameSiteLaxMode, MaxAge: int(auth.SessionTTL.Seconds())})
}

// loadUser attaches the signed-in user (if any) to the request.
func (s *Server) loadUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if c, err := r.Cookie(sessionCookie); err == nil {
			if u, renew, err := auth.SessionUser(s.DB, c.Value); err == nil {
				if renew {
					s.setSession(w, r, c.Value)
				}
				r = r.WithContext(context.WithValue(r.Context(), ctxKey{}, u))
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) requireUser(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.user(r) != nil {
			next(w, r)
			return
		}
		if r.Method != http.MethodGet || r.Header.Get("X-Requested-With") != "" {
			http.Error(w, "sign in required", http.StatusUnauthorized)
			return
		}
		if auth.UserCount(s.DB) == 0 {
			http.Redirect(w, r, "/setup", http.StatusSeeOther)
			return
		}
		http.Redirect(w, r, "/login", http.StatusSeeOther)
	})
}

func (s *Server) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.user(r).IsAdmin {
			http.Error(w, "admins only", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

// requireAPI accepts a session or an API key (X-API-Key or Bearer).
func (s *Server) requireAPI(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.user(r) == nil {
			key := strings.TrimSpace(r.Header.Get("X-API-Key"))
			if key == "" {
				key = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			}
			u, err := auth.APIKeyUser(s.DB, key)
			if err != nil {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "sign in or send an API key"})
				return
			}
			r = r.WithContext(context.WithValue(r.Context(), ctxKey{}, u))
		}
		next(w, r)
	})
}

// back redirects to where the form was submitted from, with a message.
func back(w http.ResponseWriter, r *http.Request, fallback, key, msg string) {
	target := fallback
	if ref, err := url.Parse(r.Referer()); err == nil && ref.Host == r.Host && ref.Path != "" {
		q := ref.Query()
		q.Del("msg")
		q.Del("err")
		ref.RawQuery = q.Encode()
		target = ref.RequestURI()
	}
	if msg != "" {
		sep := "?"
		if strings.Contains(target, "?") {
			sep = "&"
		}
		target += sep + key + "=" + url.QueryEscape(msg)
	}
	http.Redirect(w, r, target, http.StatusSeeOther)
}

func ok(w http.ResponseWriter, r *http.Request, fallback, msg string) {
	back(w, r, fallback, "msg", msg)
}
func fail(w http.ResponseWriter, r *http.Request, fallback string, err error) {
	back(w, r, fallback, "err", err.Error())
}

// isFetch reports a request made by app.js, which wants a bare status
// instead of a redirect.
func isFetch(r *http.Request) bool { return r.Header.Get("X-Requested-With") == "fetch" }

func clientIP(r *http.Request) string {
	if os.Getenv("TRUST_PROXY_HEADERS") != "" {
		if f := r.Header.Get("X-Forwarded-For"); f != "" {
			return strings.TrimSpace(strings.Split(f, ",")[0])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// limiter allows a few login attempts per client in a time window.
type limiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

func (l *limiter) allow(key string) bool {
	const max, window = 10, 5 * time.Minute
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.hits == nil {
		l.hits = map[string][]time.Time{}
	}
	now := time.Now()
	recent := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if now.Sub(t) < window {
			recent = append(recent, t)
		}
	}
	if len(recent) >= max {
		l.hits[key] = recent
		return false
	}
	l.hits[key] = append(recent, now)
	if len(l.hits) > 10000 {
		l.hits = map[string][]time.Time{}
	}
	return true
}

func ago(t int64) string {
	d := time.Since(time.Unix(t, 0))
	switch {
	case d < 0:
		return "scheduled"
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	case d < 30*24*time.Hour:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	case d < 365*24*time.Hour:
		return fmt.Sprintf("%dmo ago", int(d.Hours()/24/30))
	}
	return fmt.Sprintf("%dy ago", int(d.Hours()/24/365))
}

func dur(secs int64) string {
	if secs <= 0 {
		return ""
	}
	h, m, sec := secs/3600, secs%3600/60, secs%60
	if h > 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, sec)
	}
	return fmt.Sprintf("%d:%02d", m, sec)
}

func pct(progress float64, duration int64) int {
	if duration <= 0 || progress <= 0 {
		return 0
	}
	return min(100, int(progress/float64(duration)*100))
}

func initial(s string) string {
	for _, r := range s {
		return strings.ToUpper(string(r))
	}
	return "?"
}

// queryWith returns the current query string with one key replaced (or
// removed when value is empty), for filter links.
func queryWith(q url.Values, key, value string) template.URL {
	out := url.Values{}
	for k, v := range q {
		if k != "before" && k != "fragment" && k != "msg" && k != "err" {
			out[k] = v
		}
	}
	if value == "" {
		out.Del(key)
	} else {
		out.Set(key, value)
	}
	if len(out) == 0 {
		return "?"
	}
	return template.URL("?" + out.Encode())
}
