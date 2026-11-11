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
	"net/http"
	"regexp"
	"strings"
	"time"

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
	s.render(w, r, "channels", M{"Channels": chans, "Lists": s.lists(u.ID)})
}

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
		fail(w, r, "/channels", errors.New("enter a channel URL, @handle or channel id"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	ch, err := s.YT.Resolve(ctx, input)
	if err != nil {
		fail(w, r, "/channels", fmt.Errorf("could not find that channel: %w", err))
		return
	}
	added, err := s.subscribe(s.user(r).ID, *ch)
	if err != nil {
		fail(w, r, "/channels", err)
		return
	}
	s.Fetcher.Wake()
	if !added {
		ok(w, r, "/channels", "Already subscribed to "+ch.Title)
		return
	}
	ok(w, r, "/channels", "Subscribed to "+ch.Title)
}

func (s *Server) deleteChannel(w http.ResponseWriter, r *http.Request) {
	if err := s.unsubscribe(s.user(r).ID, r.PathValue("id")); err != nil {
		fail(w, r, "/channels", err)
		return
	}
	ok(w, r, "/channels", "Unsubscribed")
}

func (s *Server) addList(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.FormValue("name"))
	if name == "" || len(name) > 60 {
		fail(w, r, "/channels", errors.New("list name must be 1 to 60 characters"))
		return
	}
	if _, err := s.DB.Exec(`INSERT INTO lists (user_id, name) VALUES (?, ?)`, s.user(r).ID, name); err != nil {
		fail(w, r, "/channels", errors.New("a list with that name already exists"))
		return
	}
	ok(w, r, "/channels", "List created")
}

func (s *Server) deleteList(w http.ResponseWriter, r *http.Request) {
	s.DB.Exec(`DELETE FROM lists WHERE id = ? AND user_id = ?`, r.PathValue("id"), s.user(r).ID)
	ok(w, r, "/channels", "List deleted")
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
}

// parseImport reads OPML (as exported by TubeShelf, NewPipe, FreeTube and
// others), a Google Takeout subscriptions.csv, or one channel per line.
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
				}
				if len(o.Children) > 0 {
					// Folders that just wrap everything are not real lists.
					child := name
					if o.XMLURL != "" || strings.EqualFold(name, "YouTube Subscriptions") || strings.EqualFold(name, "Subscriptions") {
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
	default:
		sc := bufio.NewScanner(bytes.NewReader(data))
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if id := reAnyChannelID.FindString(line); id != "" {
				out = append(out, imported{ID: id})
			} else if line != "" {
				out = append(out, imported{Ref: line})
			}
		}
	}
	if len(out) == 0 {
		return nil, errors.New("no channels found in that file")
	}
	return out, nil
}

func (s *Server) importOPML(w http.ResponseWriter, r *http.Request) {
	u := s.user(r)
	r.Body = http.MaxBytesReader(w, r.Body, maxImportBytes)
	file, _, err := r.FormFile("file")
	if err != nil {
		fail(w, r, "/channels", errors.New("choose a file to import (2 MB at most)"))
		return
	}
	defer file.Close()
	data, _ := io.ReadAll(file)
	items, err := parseImport(data)
	if err != nil {
		fail(w, r, "/channels", err)
		return
	}
	added, failed := 0, 0
	listIDs := map[string]int64{}
	for _, it := range items {
		ch := yt.Channel{ID: it.ID, Title: it.Title}
		if it.Ref != "" {
			ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
			res, err := s.YT.Resolve(ctx, it.Ref)
			cancel()
			if err != nil {
				failed++
				continue
			}
			ch = *res
		}
		isNew, err := s.subscribe(u.ID, ch)
		if err != nil {
			failed++
			continue
		}
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
	msg := fmt.Sprintf("Imported %d new of %d channels", added, len(items))
	if failed > 0 {
		msg += fmt.Sprintf(", %d could not be found", failed)
	}
	ok(w, r, "/channels", msg)
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
