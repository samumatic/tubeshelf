package web

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/samumatic/tubeshelf/internal/db"
)

const pageSize = 48

var reVideoID = regexp.MustCompile(`^[\w-]{11}$`)

type Video struct {
	ID        string
	Title     string
	ChannelID string
	Channel   string
	HasAvatar bool
	Published int64
	Kind      string
	Duration  int64
	Members   bool
	Progress  float64
	Watched   bool
	Later     bool
}

// Cursor identifies this video's position in the newest-first feed order.
func (v Video) Cursor() string { return fmt.Sprintf("%d_%s", v.Published, v.ID) }

// DayGroup is a run of feed videos published on the same day.
type DayGroup struct {
	Label  string // empty when the previous page already showed this heading
	Videos []Video
}

// dayLabel names the day of a timestamp relative to now.
func dayLabel(ts int64, now time.Time) string {
	t := time.Unix(ts, 0).In(now.Location())
	y, m, d := now.Date()
	today := time.Date(y, m, d, 0, 0, 0, 0, now.Location())
	switch days := int(today.Sub(time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, now.Location())).Hours() / 24); {
	case days < 0:
		return "Upcoming"
	case days == 0:
		return "Today"
	case days == 1:
		return "Yesterday"
	case days < 7:
		return t.Weekday().String()
	case t.Year() == now.Year():
		return t.Format("2 January")
	}
	return t.Format("2 January 2006")
}

// groupByDay splits videos (already sorted by time) into day groups. prev is
// the label the previous page ended with, so a day that continues across
// pages gets no second heading.
func groupByDay(vids []Video, now time.Time, prev string) []DayGroup {
	var out []DayGroup
	for _, v := range vids {
		label := dayLabel(v.Published, now)
		if n := len(out); n > 0 && (out[n-1].Label == label || (out[n-1].Label == "" && label == prev)) {
			out[n-1].Videos = append(out[n-1].Videos, v)
			continue
		}
		g := DayGroup{Label: label, Videos: []Video{v}}
		if len(out) == 0 && label == prev {
			g.Label = ""
		}
		out = append(out, g)
	}
	return out
}

type List struct {
	ID       int64
	Name     string
	Channels int
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

const videoCols = `v.id, v.title, v.channel_id, coalesce(c.title, v.channel_title), v.published_at, v.kind,
	coalesce(v.duration_seconds, 0), v.members_only, coalesce(ws.progress, 0), coalesce(ws.watched, 0), wl.video_id IS NOT NULL,
	coalesce(c.thumbnail LIKE 'https://%', 0)`

// videoJoins needs the user id twice.
const videoJoins = ` LEFT JOIN channels c ON c.id = v.channel_id
	LEFT JOIN watch_state ws ON ws.user_id = ? AND ws.video_id = v.id
	LEFT JOIN watch_later wl ON wl.user_id = ? AND wl.video_id = v.id `

func (s *Server) videos(query string, args ...any) ([]Video, error) {
	rows, err := s.DB.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Video
	for rows.Next() {
		var v Video
		if err := rows.Scan(&v.ID, &v.Title, &v.ChannelID, &v.Channel, &v.Published, &v.Kind,
			&v.Duration, &v.Members, &v.Progress, &v.Watched, &v.Later, &v.HasAvatar); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Server) lists(userID string) []List {
	rows, err := s.DB.Query(`SELECT id, name, (SELECT count(*) FROM list_channels WHERE list_id = lists.id)
		FROM lists WHERE user_id = ? ORDER BY name COLLATE NOCASE`, userID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []List
	for rows.Next() {
		var l List
		if rows.Scan(&l.ID, &l.Name, &l.Channels) == nil {
			out = append(out, l)
		}
	}
	return out
}

// feedVideos returns one page of the user's feed plus the cursor of the next page.
func (s *Server) feedVideos(userID string, set map[string]string, q map[string]string, limit int) ([]Video, string, error) {
	where := []string{"1=1"}
	args := []any{userID, userID, userID}
	if set["hide_shorts"] == "1" {
		where = append(where, "v.kind != 'short'")
	}
	if set["hide_live"] == "1" {
		where = append(where, "v.kind NOT IN ('live', 'upcoming')")
	}
	if set["hide_members"] == "1" {
		where = append(where, "v.members_only = 0")
	}
	if set["hide_watched"] == "1" {
		where = append(where, "coalesce(ws.watched, 0) = 0")
	}
	if v := q["q"]; v != "" {
		like := "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(v) + "%"
		where = append(where, `(v.title LIKE ? ESCAPE '\' OR c.title LIKE ? ESCAPE '\')`)
		args = append(args, like, like)
	}
	if v := q["channel"]; v != "" {
		where = append(where, "v.channel_id = ?")
		args = append(args, v)
	}
	if v := q["list"]; v != "" {
		where = append(where, "v.channel_id IN (SELECT lc.channel_id FROM list_channels lc JOIN lists l ON l.id = lc.list_id WHERE l.id = ? AND l.user_id = ?)")
		args = append(args, v, userID)
	}
	cmp, order := "<", "DESC"
	if set["sort"] == "oldest" {
		cmp, order = ">", "ASC"
	}
	if ts, id, found := strings.Cut(q["before"], "_"); found {
		where = append(where, "(v.published_at, v.id) "+cmp+" (?, ?)")
		n, _ := strconv.ParseInt(ts, 10, 64)
		args = append(args, n, id)
	}
	args = append(args, limit+1)
	vids, err := s.videos(`SELECT `+videoCols+` FROM videos v
		JOIN subscriptions sub ON sub.channel_id = v.channel_id AND sub.user_id = ?`+videoJoins+`
		WHERE `+strings.Join(where, " AND ")+`
		ORDER BY v.published_at `+order+`, v.id `+order+` LIMIT ?`, args...)
	if err != nil {
		return nil, "", err
	}
	next := ""
	if len(vids) > limit {
		vids = vids[:limit]
		next = vids[limit-1].Cursor()
	}
	return vids, next, nil
}

func (s *Server) feedPage(w http.ResponseWriter, r *http.Request) {
	u := s.user(r)
	set := db.UserSettings(s.DB, u.ID)
	q := map[string]string{}
	for _, k := range []string{"q", "channel", "list", "before"} {
		q[k] = strings.TrimSpace(r.URL.Query().Get(k))
	}
	vids, next, err := s.feedVideos(u.ID, set, q, pageSize)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	prev := ""
	if ts, _, found := strings.Cut(q["before"], "_"); found {
		n, _ := strconv.ParseInt(ts, 10, 64)
		prev = dayLabel(n, time.Now())
	}
	groups := []DayGroup{{Videos: vids}} // one continuous grid
	// A channel posts about once a day; day headings would leave one video per row.
	if set["group_days"] == "1" && q["channel"] == "" {
		groups = groupByDay(vids, time.Now(), prev)
	}
	data := M{"Videos": vids, "Groups": groups, "Next": next, "Q": r.URL.Query(), "Set": set, "Search": q["q"],
		"Lists": s.lists(u.ID), "ListID": q["list"], "ChannelID": q["channel"]}
	if q["channel"] != "" {
		var title string
		var avatar bool
		s.DB.QueryRow(`SELECT title, coalesce(thumbnail LIKE 'https://%', 0) FROM channels WHERE id = ?`, q["channel"]).Scan(&title, &avatar)
		data["ChannelTitle"], data["ChannelAvatar"] = title, avatar
	}
	if len(vids) == 0 && q["before"] == "" {
		var subs, pending int
		s.DB.QueryRow(`SELECT count(*), coalesce(sum(c.last_success_at IS NULL AND c.last_error = ''), 0) FROM subscriptions s
			JOIN channels c ON c.id = s.channel_id WHERE s.user_id = ?`, u.ID).Scan(&subs, &pending)
		data["Subs"], data["Pending"] = subs, pending
	}
	s.render(w, r, "feed", data)
}

func (s *Server) laterPage(w http.ResponseWriter, r *http.Request) {
	u := s.user(r)
	vids, err := s.videos(`SELECT `+videoCols+` FROM watch_later l JOIN videos v ON v.id = l.video_id`+videoJoins+`
		WHERE l.user_id = ? ORDER BY l.added_at DESC`, u.ID, u.ID, u.ID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.render(w, r, "later", M{"Videos": vids})
}

func (s *Server) historyPage(w http.ResponseWriter, r *http.Request) {
	u := s.user(r)
	vids, err := s.videos(`SELECT `+videoCols+` FROM watch_state h JOIN videos v ON v.id = h.video_id`+videoJoins+`
		WHERE h.user_id = ? ORDER BY h.updated_at DESC LIMIT 200`, u.ID, u.ID, u.ID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.render(w, r, "history", M{"Videos": vids})
}

func (s *Server) watchPage(w http.ResponseWriter, r *http.Request) {
	u := s.user(r)
	id := r.PathValue("id")
	if !reVideoID.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	vids, err := s.videos(`SELECT `+videoCols+` FROM videos v`+videoJoins+` WHERE v.id = ?`, u.ID, u.ID, id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// Any valid id can be played, also one that is not in the database.
	v := Video{ID: id, Title: "Video"}
	if len(vids) > 0 {
		v = vids[0]
	}
	set := db.UserSettings(s.DB, u.ID)
	start := 0
	// Resume, unless the video was finished or barely started.
	if !v.Watched && v.Progress > 10 && (v.Duration == 0 || v.Progress < float64(v.Duration)-10) {
		start = int(v.Progress)
	}
	next, _, _ := s.feedVideos(u.ID, set, map[string]string{"before": v.Cursor()}, 8)
	s.render(w, r, "watch", M{"V": v, "Start": start, "Set": set, "UpNext": next})
}

func (s *Server) done(w http.ResponseWriter, r *http.Request) {
	if isFetch(r) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ok(w, r, "/", "")
}

func (s *Server) setWatched(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !reVideoID.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	on := r.FormValue("on") == "1"
	// Unmarking also clears the resume position.
	_, err := s.DB.Exec(`INSERT INTO watch_state (user_id, video_id, watched, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(user_id, video_id) DO UPDATE SET watched = excluded.watched, updated_at = excluded.updated_at,
			progress = CASE WHEN excluded.watched = 1 THEN progress ELSE 0 END`,
		s.user(r).ID, id, on, time.Now().Unix())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.done(w, r)
}

func (s *Server) setLater(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !reVideoID.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	var err error
	if r.FormValue("on") == "1" {
		_, err = s.DB.Exec(`INSERT INTO watch_later (user_id, video_id, added_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
			s.user(r).ID, id, time.Now().Unix())
	} else {
		_, err = s.DB.Exec(`DELETE FROM watch_later WHERE user_id = ? AND video_id = ?`, s.user(r).ID, id)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.done(w, r)
}

// setProgress stores the playback position and marks the video watched once
// the user's threshold is passed.
func (s *Server) setProgress(w http.ResponseWriter, r *http.Request) {
	u := s.user(r)
	id := r.PathValue("id")
	t, _ := strconv.ParseFloat(r.FormValue("t"), 64)
	d, _ := strconv.ParseFloat(r.FormValue("d"), 64)
	if !reVideoID.MatchString(id) || t < 0 {
		http.Error(w, "bad progress", http.StatusBadRequest)
		return
	}
	threshold, _ := strconv.ParseFloat(db.UserSettings(s.DB, u.ID)["watched_percent"], 64)
	if threshold < 25 || threshold > 100 {
		threshold = 90
	}
	watched := d > 0 && (t/d*100 >= threshold || r.FormValue("ended") == "1")
	_, err := s.DB.Exec(`INSERT INTO watch_state (user_id, video_id, progress, watched, updated_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(user_id, video_id) DO UPDATE SET progress = excluded.progress, updated_at = excluded.updated_at,
			watched = max(watched, excluded.watched)`, u.ID, id, t, watched, time.Now().Unix())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if d > 0 {
		// The player knows the real length; fill it in if enrichment has not.
		s.DB.Exec(`UPDATE videos SET duration_seconds = ? WHERE id = ? AND duration_seconds IS NULL AND kind IN ('video', 'short')`, int(d), id)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"watched": watched})
}
