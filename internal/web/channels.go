package web

import (
	"bufio"
	"bytes"
	"cmp"
	"context"
	"encoding/csv"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/samumatic/tubeshelf/internal/db"
	"github.com/samumatic/tubeshelf/internal/yt"
)

const maxImportBytes = 2 << 20

var reAnyChannelID = regexp.MustCompile(`UC[\w-]{22}`)

type ChannelRow struct {
	ID          string
	Title       string
	LastSuccess int64
	LastError   string
	Videos      int
	HasAvatar   bool
	InList      map[int64]bool
}

func (s *Server) userChannels(userID string) ([]ChannelRow, error) {
	rows, err := s.DB.Query(`SELECT c.id, c.title, coalesce(c.last_success_at, 0), c.last_error,
			(SELECT count(*) FROM videos v WHERE v.channel_id = c.id), c.thumbnail LIKE 'https://%'
		FROM subscriptions s JOIN channels c ON c.id = s.channel_id
		WHERE s.user_id = ? ORDER BY c.title COLLATE NOCASE`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChannelRow
	byID := map[string]int{}
	for rows.Next() {
		c := ChannelRow{InList: map[int64]bool{}}
		if err := rows.Scan(&c.ID, &c.Title, &c.LastSuccess, &c.LastError, &c.Videos, &c.HasAvatar); err != nil {
			return nil, err
		}
		byID[c.ID] = len(out)
		out = append(out, c)
	}
	members, err := s.DB.Query(`SELECT lc.list_id, lc.channel_id FROM list_channels lc
		JOIN lists l ON l.id = lc.list_id WHERE l.user_id = ?`, userID)
	if err != nil {
		return nil, err
	}
	defer members.Close()
	for members.Next() {
		var list int64
		var ch string
		if members.Scan(&list, &ch) == nil {
			if i, ok := byID[ch]; ok {
				out[i].InList[list] = true
			}
		}
	}
	return out, nil
}

func (s *Server) channelsPage(w http.ResponseWriter, r *http.Request) {
	u := s.user(r)
	chans, err := s.userChannels(u.ID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.render(w, r, "channels", M{"Channels": chans, "Lists": s.lists(u.ID), "Suggestions": s.suggestions(u.ID, 12),
		"Typed": r.URL.Query().Get("typed")})
}

func (s *Server) listsPage(w http.ResponseWriter, r *http.Request) {
	s.render(w, r, "lists", M{"Lists": s.lists(s.user(r).ID)})
}

func (s *Server) importPage(w http.ResponseWriter, r *http.Request) {
	var failed []string
	if f := r.URL.Query().Get("failed"); f != "" {
		failed = strings.Split(f, "\n")
	}
	s.render(w, r, "import", M{"Failed": failed, "FailedN": r.URL.Query().Get("failedn")})
}

// libraryPage is the phone's way into the Library and Administration pages,
// which the sidebar shows on wider screens.
func (s *Server) libraryPage(w http.ResponseWriter, r *http.Request) { s.render(w, r, "library", nil) }

// subscribe stores the channel if new and subscribes the user. It reports
// whether the subscription was new.
func (s *Server) subscribe(userID string, ch yt.Channel) (bool, error) {
	if !yt.IsChannelID(ch.ID) {
		return false, fmt.Errorf("not a channel id: %q", ch.ID)
	}
	if ch.Title == "" {
		ch.Title = ch.ID
	}
	// A real title or avatar replaces a placeholder left by an id-only import.
	if _, err := s.DB.Exec(`INSERT INTO channels (id, title, thumbnail) VALUES (?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			title = CASE WHEN channels.title = channels.id THEN excluded.title ELSE channels.title END,
			thumbnail = CASE WHEN excluded.thumbnail != '' THEN excluded.thumbnail ELSE channels.thumbnail END`,
		ch.ID, ch.Title, ch.Thumbnail); err != nil {
		return false, err
	}
	res, err := s.DB.Exec(`INSERT INTO subscriptions (user_id, channel_id, added_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
		userID, ch.ID, time.Now().Unix())
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *Server) unsubscribe(userID, channelID string) error {
	if _, err := s.DB.Exec(`DELETE FROM list_channels WHERE channel_id = ? AND list_id IN (SELECT id FROM lists WHERE user_id = ?)`,
		channelID, userID); err != nil {
		return err
	}
	_, err := s.DB.Exec(`DELETE FROM subscriptions WHERE user_id = ? AND channel_id = ?`, userID, channelID)
	return err
}

func (s *Server) addChannel(w http.ResponseWriter, r *http.Request) {
	input := strings.TrimSpace(r.FormValue("channel"))
	if input == "" {
		fail(w, r, "/channels", errors.New("Type a channel's name, @handle or YouTube link"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	ch, err := s.resolveChannel(ctx, input)
	if err != nil {
		slog.Info("subscribe: channel not found", "input", input, "err", err)
		failKeep(w, r, "/channels", fmt.Errorf("Couldn't find a YouTube channel for “%s”. Paste the channel's link (youtube.com/@name) or its @handle", input), input)
		return
	}
	added, err := s.subscribe(s.user(r).ID, *ch)
	if err != nil {
		fail(w, r, "/channels", err)
		return
	}
	s.Fetcher.Wake()
	if !added {
		okThen(w, r, "/channels", "You already follow "+ch.Title+".", "/?channel="+ch.ID, "Open channel")
		return
	}
	okThen(w, r, "/channels", "Subscribed to "+ch.Title+". New videos show up in your feed.", "/", "Open the feed")
}

// resolveChannel finds a channel from what someone typed: a link, an @handle
// or an id as YouTube knows them, or just a name. A name is first matched
// against the channels this server already follows, then tried as a handle.
func (s *Server) resolveChannel(ctx context.Context, input string) (*yt.Channel, error) {
	ch, err := s.YT.Resolve(ctx, input)
	if err == nil {
		return ch, nil
	}
	if strings.ContainsAny(input, "/@.") {
		return nil, err
	}
	var c yt.Channel
	if s.DB.QueryRow(`SELECT id, title, thumbnail FROM channels WHERE title = ? COLLATE NOCASE
		ORDER BY (SELECT count(*) FROM subscriptions WHERE channel_id = channels.id) DESC LIMIT 1`, input).Scan(&c.ID, &c.Title, &c.Thumbnail) == nil {
		return &c, nil
	}
	return s.YT.Resolve(ctx, "@"+strings.Join(strings.Fields(input), ""))
}

// suggestions are channels other people on this server follow and this user does not.
func (s *Server) suggestions(userID string, limit int) []ChannelRow {
	rows, err := s.DB.Query(`SELECT c.id, c.title, c.thumbnail LIKE 'https://%', count(*) AS n FROM channels c
		JOIN subscriptions s ON s.channel_id = c.id
		WHERE c.id NOT IN (SELECT channel_id FROM subscriptions WHERE user_id = ?) AND c.last_error = ''
		GROUP BY c.id ORDER BY n DESC, c.title COLLATE NOCASE LIMIT ?`, userID, limit)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []ChannelRow
	for rows.Next() {
		var c ChannelRow
		if rows.Scan(&c.ID, &c.Title, &c.HasAvatar, &c.Videos) == nil {
			out = append(out, c)
		}
	}
	return out
}

func (s *Server) deleteChannel(w http.ResponseWriter, r *http.Request) {
	if err := s.unsubscribe(s.user(r).ID, r.PathValue("id")); err != nil {
		fail(w, r, "/channels", err)
		return
	}
	// From the channel's own page, whose feed is now empty, go back to the feed.
	if r.FormValue("next") == "/" {
		http.Redirect(w, r, "/?msg="+url.QueryEscape("Unsubscribed"), http.StatusSeeOther)
		return
	}
	ok(w, r, "/channels", "Unsubscribed")
}

func (s *Server) addList(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" || len(name) > 60 {
		fail(w, r, "/lists", errors.New("A list name needs 1 to 60 characters"))
		return
	}
	if _, err := s.DB.Exec(`INSERT INTO lists (user_id, name, position) VALUES (?, ?,
		(SELECT coalesce(max(position), 0) + 1 FROM lists WHERE user_id = ?))`, s.user(r).ID, name, s.user(r).ID); err != nil {
		fail(w, r, "/lists", fmt.Errorf("You already have a list called “%s”", name))
		return
	}
	okThen(w, r, "/lists", "Created “"+name+"”. Now pick its channels with the list buttons on Channels.", "/channels", "Open Channels")
}

// renameList also moves a list up or down: lists keep the order their owner gives them.
func (s *Server) updateList(w http.ResponseWriter, r *http.Request) {
	u := s.user(r)
	id := r.PathValue("id")
	switch r.FormValue("action") {
	case "rename":
		name := strings.TrimSpace(r.FormValue("name"))
		if name == "" || len(name) > 60 {
			fail(w, r, "/lists", errors.New("a list name needs 1 to 60 characters"))
			return
		}
		if _, err := s.DB.Exec(`UPDATE lists SET name = ? WHERE id = ? AND user_id = ?`, name, id, u.ID); err != nil {
			fail(w, r, "/lists", fmt.Errorf("you already have a list called “%s”", name))
			return
		}
		ok(w, r, "/lists", "Renamed to “"+name+"”.")
	case "up", "down":
		lists := s.lists(u.ID)
		i := slices.IndexFunc(lists, func(l List) bool { return fmt.Sprint(l.ID) == id })
		j := i - 1
		if r.FormValue("action") == "down" {
			j = i + 1
		}
		if i < 0 || j < 0 || j >= len(lists) {
			s.done(w, r)
			return
		}
		lists[i], lists[j] = lists[j], lists[i]
		for pos, l := range lists {
			s.DB.Exec(`UPDATE lists SET position = ? WHERE id = ?`, pos+1, l.ID)
		}
		http.Redirect(w, r, "/lists", http.StatusSeeOther)
	default:
		http.Error(w, "unknown action", http.StatusBadRequest)
	}
}

func (s *Server) deleteList(w http.ResponseWriter, r *http.Request) {
	s.DB.Exec(`DELETE FROM lists WHERE id = ? AND user_id = ?`, r.PathValue("id"), s.user(r).ID)
	ok(w, r, "/lists", "List deleted. Its channels stay subscribed.")
}

func (s *Server) setListChannel(w http.ResponseWriter, r *http.Request) {
	u := s.user(r)
	var listID int64
	if s.DB.QueryRow(`SELECT id FROM lists WHERE id = ? AND user_id = ?`, r.PathValue("id"), u.ID).Scan(&listID) != nil {
		http.NotFound(w, r)
		return
	}
	ch := r.FormValue("channel")
	var err error
	if r.FormValue("on") == "1" {
		_, err = s.DB.Exec(`INSERT INTO list_channels (list_id, channel_id)
			SELECT ?, channel_id FROM subscriptions WHERE user_id = ? AND channel_id = ? ON CONFLICT DO NOTHING`, listID, u.ID, ch)
	} else {
		_, err = s.DB.Exec(`DELETE FROM list_channels WHERE list_id = ? AND channel_id = ?`, listID, ch)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	s.done(w, r)
}

type outline struct {
	Text     string    `xml:"text,attr"`
	Title    string    `xml:"title,attr"`
	XMLURL   string    `xml:"xmlUrl,attr"`
	Children []outline `xml:"outline"`
}

type opml struct {
	XMLName xml.Name  `xml:"opml"`
	Version string    `xml:"version,attr"`
	Title   string    `xml:"head>title"`
	Body    []outline `xml:"body>outline"`
}

// imported is one channel found in an uploaded file. List is the OPML folder
// it sat in, if any. Ref is set instead of ID when only a handle or URL is known.
type imported struct {
	ID, Title, List, Ref string
	Bad                  bool // a line that names no channel; counted as not found
}

// parseImport reads OPML (as exported by TubeShelf, NewPipe, FreeTube and
// others), a Google Takeout subscriptions.csv, a JSON export (NewPipe,
// FreeTube: every channel id in it), or one channel per line.
func parseImport(data []byte) ([]imported, error) {
	data = bytes.TrimSpace(bytes.TrimPrefix(data, []byte("\xef\xbb\xbf")))
	var out []imported
	switch {
	case bytes.HasPrefix(data, []byte("<")):
		var doc opml
		if err := xml.Unmarshal(data, &doc); err != nil {
			return nil, fmt.Errorf("not a valid OPML file: %w", err)
		}
		var walk func(items []outline, list string)
		walk = func(items []outline, list string) {
			for _, o := range items {
				name := o.Title
				if name == "" {
					name = o.Text
				}
				if id := reAnyChannelID.FindString(o.XMLURL); id != "" {
					out = append(out, imported{ID: id, Title: name, List: list})
				} else if o.XMLURL != "" {
					out = append(out, imported{Ref: o.XMLURL, Bad: true}) // a feed that is not a YouTube channel
				}
				if len(o.Children) > 0 {
					// Folders that just wrap everything are not real lists.
					child := listName(name)
					if child == "" || o.XMLURL != "" || strings.EqualFold(name, "YouTube Subscriptions") || strings.EqualFold(name, "Subscriptions") {
						child = list
					}
					walk(o.Children, child)
				}
			}
		}
		walk(doc.Body, "")
	case bytes.HasPrefix(data, []byte("Channel Id")) || bytes.HasPrefix(data, []byte("Channel ID")):
		rd := csv.NewReader(bytes.NewReader(data))
		rd.FieldsPerRecord = -1
		rows, err := rd.ReadAll()
		if err != nil {
			return nil, fmt.Errorf("not a valid CSV file: %w", err)
		}
		for _, row := range rows[1:] {
			if len(row) > 0 && yt.IsChannelID(strings.TrimSpace(row[0])) {
				it := imported{ID: strings.TrimSpace(row[0])}
				if len(row) > 2 {
					it.Title = row[2]
				}
				out = append(out, it)
			}
		}
	case bytes.HasPrefix(data, []byte("{")) || bytes.HasPrefix(data, []byte("[")):
		// Read as text, every word would be looked up as a channel name.
		seen := map[string]bool{}
		for _, id := range reAnyChannelID.FindAll(data, -1) {
			if !seen[string(id)] {
				seen[string(id)] = true
				out = append(out, imported{ID: string(id)})
			}
		}
	default:
		sc := bufio.NewScanner(bytes.NewReader(data))
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			switch {
			case line == "" || strings.HasPrefix(line, "#"):
			case reAnyChannelID.MatchString(line):
				out = append(out, imported{ID: reAnyChannelID.FindString(line)})
			case strings.HasPrefix(line, "@") || strings.Contains(strings.ToLower(line), "youtube.com/"):
				out = append(out, imported{Ref: line})
			default:
				out = append(out, imported{Ref: line, Bad: true})
			}
		}
	}
	if !slices.ContainsFunc(out, func(it imported) bool { return !it.Bad }) {
		return nil, errors.New("no channels found in that file")
	}
	return out, nil
}

func (s *Server) importOPML(w http.ResponseWriter, r *http.Request) {
	u := s.user(r)
	r.Body = http.MaxBytesReader(w, r.Body, maxImportBytes)
	file, _, err := r.FormFile("file")
	if err != nil {
		fail(w, r, "/channels/import", errors.New("choose a file to import (2 MB at most)"))
		return
	}
	defer file.Close()
	data, _ := io.ReadAll(file)
	if len(bytes.TrimSpace(data)) == 0 {
		fail(w, r, "/channels/import", errors.New("that file is empty; export your subscriptions again and choose the new file"))
		return
	}
	items, err := parseImport(data)
	if err != nil {
		fail(w, r, "/channels/import", err)
		return
	}
	added, failed := 0, 0
	var failedNames []string
	miss := func(it imported) {
		failed++
		if len(failedNames) < 20 {
			failedNames = append(failedNames, cmp.Or(it.Title, it.Ref, it.ID))
		}
	}
	listIDs := map[string]int64{}
	// A channel can be in several folders (TubeShelf's own export lists it at the top and in each list).
	channels := map[string]bool{}
	for _, it := range items {
		if it.Bad {
			miss(it)
			continue
		}
		ch := yt.Channel{ID: it.ID, Title: it.Title}
		if it.Ref != "" {
			ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
			res, err := s.YT.Resolve(ctx, it.Ref)
			cancel()
			if err != nil {
				miss(it)
				continue
			}
			ch = *res
		}
		isNew, err := s.subscribe(u.ID, ch)
		if err != nil {
			miss(it)
			continue
		}
		channels[ch.ID] = true
		if isNew {
			added++
		}
		if it.List == "" {
			continue
		}
		id, seen := listIDs[it.List]
		if !seen {
			s.DB.Exec(`INSERT INTO lists (user_id, name) VALUES (?, ?) ON CONFLICT DO NOTHING`, u.ID, it.List)
			s.DB.QueryRow(`SELECT id FROM lists WHERE user_id = ? AND name = ?`, u.ID, it.List).Scan(&id)
			listIDs[it.List] = id
		}
		s.DB.Exec(`INSERT INTO list_channels (list_id, channel_id) VALUES (?, ?) ON CONFLICT DO NOTHING`, id, ch.ID)
	}
	s.Fetcher.Wake()
	msg := fmt.Sprintf("Imported %d new of %d channels. Their videos arrive over the next minutes.", added, len(channels)+failed)
	if added == 0 && len(channels) > 0 {
		msg = fmt.Sprintf("You already follow every channel in that file (%d).", len(channels))
	}
	q := url.Values{"msg": {msg}, "go": {"/"}, "golabel": {"Open the feed"}}
	if failed > 0 {
		q.Set("failed", strings.Join(failedNames, "\n"))
		q.Set("failedn", fmt.Sprint(failed))
	}
	http.Redirect(w, r, "/channels/import?"+q.Encode(), http.StatusSeeOther)
}

func feedURL(id string) string { return "https://www.youtube.com/feeds/videos.xml?channel_id=" + id }

// exportOPML writes every subscription at the top level, then one folder per
// list, which parseImport turns back into lists.
func (s *Server) exportOPML(w http.ResponseWriter, r *http.Request) {
	u := s.user(r)
	chans, err := s.userChannels(u.ID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	doc := opml{Version: "2.0", Title: "TubeShelf subscriptions"}
	for _, c := range chans {
		doc.Body = append(doc.Body, outline{Text: c.Title, Title: c.Title, XMLURL: feedURL(c.ID)})
	}
	for _, l := range s.lists(u.ID) {
		folder := outline{Text: l.Name, Title: l.Name}
		for _, c := range chans {
			if c.InList[l.ID] {
				folder.Children = append(folder.Children, outline{Text: c.Title, Title: c.Title, XMLURL: feedURL(c.ID)})
			}
		}
		if len(folder.Children) > 0 {
			doc.Body = append(doc.Body, folder)
		}
	}
	w.Header().Set("Content-Type", "text/x-opml; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="tubeshelf-subscriptions.opml"`)
	io.WriteString(w, xml.Header)
	enc := xml.NewEncoder(w)
	enc.Indent("", "  ")
	enc.Encode(doc)
}

func (s *Server) apiListSubscriptions(w http.ResponseWriter, r *http.Request) {
	chans, err := s.userChannels(s.user(r).ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	out := make([]map[string]string, 0, len(chans))
	for _, c := range chans {
		out = append(out, map[string]string{"channelId": c.ID, "title": c.Title, "url": "https://www.youtube.com/channel/" + c.ID})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) apiAddSubscription(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Channel string `json:"channel"`
		Input   string `json:"input"` // v1 field name
	}
	err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)
	if body.Channel == "" {
		body.Channel = body.Input
	}
	if err != nil || strings.TrimSpace(body.Channel) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": `send {"channel": "<url, @handle or id>"}`})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	ch, err := s.YT.Resolve(ctx, body.Channel)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	added, err := s.subscribe(s.user(r).ID, *ch)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	s.Fetcher.Wake()
	status := http.StatusOK
	if added {
		status = http.StatusCreated
	}
	writeJSON(w, status, map[string]string{"channelId": ch.ID, "title": ch.Title})
}

func (s *Server) apiDeleteSubscription(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" { // v1 form: DELETE /api/subscriptions?channelId=...
		id = cmp.Or(r.URL.Query().Get("channelId"), r.URL.Query().Get("id"))
	}
	if err := s.unsubscribe(s.user(r).ID, id); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// listName applies the rules of the Create list form to a folder name from an
// import: trimmed, at most 60 bytes, cut at a character boundary.
func listName(s string) string {
	s = strings.TrimSpace(s)
	for len(s) > 60 {
		_, size := utf8.DecodeLastRuneInString(s)
		s = s[:len(s)-size]
	}
	return strings.TrimSpace(s)
}

// apiVideos searches the caller's feed: the palette's video results, and a small API for scripts.
func (s *Server) apiVideos(w http.ResponseWriter, r *http.Request) {
	u := s.user(r)
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "q is required"})
		return
	}
	set := db.UserSettings(s.DB, u.ID)
	set["hide_watched"], set["hide_shorts"], set["hide_members"], set["hide_live"] = "0", "0", "0", "0"
	vids, _, err := s.feedVideos(u.ID, set, map[string]string{"q": q}, 8)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	out := make([]map[string]any, 0, len(vids))
	for _, v := range vids {
		out = append(out, map[string]any{"id": v.ID, "title": v.Title, "channel": v.Channel, "published": v.Published, "watched": v.Watched})
	}
	writeJSON(w, http.StatusOK, out)
}
