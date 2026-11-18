package web

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/samumatic/tubeshelf/internal/auth"
	"github.com/samumatic/tubeshelf/internal/db"
)

type Health struct {
	Channels, Failing, Videos, Pending int
	LastFetch                          int64
	Users, ActiveUsers, Admins         int
}

type FailingChannel struct {
	ID, Title, Error   string
	Fails, Subscribers int
	LastOK             int64
}

func (s *Server) adminStatusPage(w http.ResponseWriter, r *http.Request) {
	var h Health
	s.DB.QueryRow(`SELECT count(*), coalesce(sum(fail_count > 0), 0), coalesce(max(last_success_at), 0) FROM channels`).
		Scan(&h.Channels, &h.Failing, &h.LastFetch)
	s.DB.QueryRow(`SELECT count(*), coalesce(sum(enrich_after > 0), 0) FROM videos`).Scan(&h.Videos, &h.Pending)
	s.DB.QueryRow(`SELECT count(*), coalesce(sum(last_login_at > ?), 0), coalesce(sum(is_admin), 0) FROM users`,
		time.Now().Add(-7*24*time.Hour).Unix()).Scan(&h.Users, &h.ActiveUsers, &h.Admins)
	var failing []FailingChannel
	rows, err := s.DB.Query(`SELECT c.id, c.title, c.last_error, c.fail_count, coalesce(c.last_success_at, 0),
		(SELECT count(*) FROM subscriptions s WHERE s.channel_id = c.id)
		FROM channels c WHERE c.fail_count > 0 ORDER BY c.fail_count DESC, c.title LIMIT 100`)
	if err == nil {
		for rows.Next() {
			var f FailingChannel
			if rows.Scan(&f.ID, &f.Title, &f.Error, &f.Fails, &f.LastOK, &f.Subscribers) == nil {
				failing = append(failing, f)
			}
		}
		rows.Close()
	}
	s.render(w, r, "admin", M{"Health": h, "Failing": failing, "Checklist": s.firstRunChecklist(r), "Instance": s.instance()})
}

type checkItem struct {
	Label, Hint, URL, Action string
	Done                     bool
}

// firstRunChecklist is shown on Status until every step is done or the admin hides it.
func (s *Server) firstRunChecklist(r *http.Request) []checkItem {
	if db.Setting(s.DB, "checklist_hidden") == "1" {
		return nil
	}
	u := s.user(r)
	var subs, users, providers int
	s.DB.QueryRow(`SELECT count(*) FROM subscriptions WHERE user_id = ?`, u.ID).Scan(&subs)
	s.DB.QueryRow(`SELECT count(*) FROM users`).Scan(&users)
	s.DB.QueryRow(`SELECT count(*) FROM oidc_providers`).Scan(&providers)
	branded := db.Setting(s.DB, "app_name") != db.Defaults["app_name"] || db.Setting(s.DB, "logo_v") != "" || db.Setting(s.DB, "primary") != ""
	items := []checkItem{
		{Label: "Follow your first channels", Hint: "Add them one by one or import your YouTube subscriptions.", URL: "/channels/import", Action: "Import", Done: subs > 0},
		{Label: "Add the people who will use it", Hint: "Create accounts, turn on sign-up, or connect a login provider.", URL: "/admin/users?add=1#add", Action: "Add user", Done: users > 1 || providers > 0 || db.Setting(s.DB, "public_registration") == "1"},
		{Label: "Make it yours", Hint: "Name, logo and colour.", URL: "/admin/appearance", Action: "Branding", Done: branded},
	}
	for _, it := range items {
		if !it.Done {
			return items
		}
	}
	return nil
}

func (s *Server) hideChecklist(w http.ResponseWriter, r *http.Request) {
	db.SetSetting(s.DB, "checklist_hidden", "1")
	ok(w, r, "/admin", "Hidden. Everything stays reachable from the sidebar.")
}

func (s *Server) retryChannel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var title string
	if s.DB.QueryRow(`SELECT title FROM channels WHERE id = ?`, id).Scan(&title) != nil {
		fail(w, r, "/admin", errors.New("that channel is gone"))
		return
	}
	s.Fetcher.Retry(id)
	ok(w, r, "/admin#failing", "Trying "+title+" again now.")
}

// removeChannel unsubscribes everyone from a channel that keeps failing.
func (s *Server) removeChannel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var title string
	if s.DB.QueryRow(`SELECT title FROM channels WHERE id = ?`, id).Scan(&title) != nil {
		fail(w, r, "/admin", errors.New("that channel is gone"))
		return
	}
	if r.FormValue("confirm") != "1" {
		fail(w, r, "/admin#failing", errors.New("tick the box to confirm first"))
		return
	}
	s.DB.Exec(`DELETE FROM channels WHERE id = ?`, id)
	ok(w, r, "/admin#failing", "Removed "+title+" for everyone.")
}

// saveUserDefaults sets what people get until they choose for themselves.
func (s *Server) saveUserDefaults(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	for _, key := range []string{"theme", "view", "hide_shorts", "sponsorblock", "autoplay_next", "click_to_load"} {
		vals := r.PostForm[key]
		if len(vals) == 0 {
			continue
		}
		v := vals[len(vals)-1]
		if allowed := userChoices[key]; allowed != nil && !slices.Contains(allowed, v) || allowed == nil && v != "0" && v != "1" {
			fail(w, r, "/admin/instance", errors.New("unknown value for "+key))
			return
		}
		db.SetSetting(s.DB, db.DefaultPrefix+key, v)
	}
	ok(w, r, "/admin/instance#defaults", "Saved. People who have not changed these themselves see the new defaults.")
}

func (s *Server) instanceDanger(w http.ResponseWriter, r *http.Request) {
	if r.FormValue("confirm") != "1" {
		fail(w, r, "/admin/instance#danger", errors.New("tick the box to confirm first"))
		return
	}
	me := s.user(r)
	switch r.FormValue("action") {
	case "sessions":
		s.DB.Exec(`DELETE FROM sessions WHERE user_id != ?`, me.ID)
		ok(w, r, "/admin/instance#danger", "Everyone else is signed out.")
	case "keys":
		s.DB.Exec(`DELETE FROM api_keys`)
		ok(w, r, "/admin/instance#danger", "Every API key is deleted, yours included.")
	default:
		http.Error(w, "unknown action", http.StatusBadRequest)
	}
}

func (s *Server) checkIssuer(r *http.Request, issuer string) error {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	return auth.CheckIssuer(ctx, issuer)
}
