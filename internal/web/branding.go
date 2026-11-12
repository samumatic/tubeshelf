package web

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/samumatic/tubeshelf/internal/db"
)

// Brand is what the admin set under Administration › Appearance, ready for the templates.
type Brand struct {
	Name             string
	Layout           string // backdrop | plain
	Primary          string // "" for monochrome, else #rrggbb
	Radius           string
	Background       string // URL: the uploaded image or the built-in one
	CustomBackground bool
	Logo             string // URL, "" for the built-in mark
	Theme            string // URL of the stylesheet with the color and radius
}

// Uploadable images and their size limits.
var brandImages = map[string]int64{"background": 8 << 20, "logo": 1 << 20}

var imageTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/webp": true, "image/gif": true}

// Corner radius scales, as in Pocket ID; 1.25 is TubeShelf's default look.
var radiusChoices = []struct{ Value, Label string }{
	{"0", "Square"}, {"0.5", "Subtle"}, {"1", "Medium"}, {"1.25", "Round"}, {"1.5", "Rounder"},
}

// Preset primary colors; "" keeps the monochrome ink of each theme.
var primaryChoices = []struct{ Value, Label, Class string }{
	{"", "Monochrome", "sw-mono"},
	{"#e5484d", "Red", "sw-red"}, {"#f76b15", "Orange", "sw-orange"}, {"#ffc53d", "Amber", "sw-amber"},
	{"#30a46c", "Green", "sw-green"}, {"#12a594", "Teal", "sw-teal"}, {"#0090ff", "Blue", "sw-blue"},
	{"#3e63dd", "Indigo", "sw-indigo"}, {"#8e4ec6", "Violet", "sw-violet"}, {"#d6409f", "Pink", "sw-pink"},
}

func (s *Server) brand() Brand {
	get := func(k string) string { return db.Setting(s.DB, k) }
	b := Brand{Name: get("app_name"), Layout: get("layout"), Primary: get("primary"), Radius: get("radius"),
		Background: "/static/backdrop.svg?v=" + s.assetVer}
	if v := get("background_v"); v != "" {
		b.Background = "/branding/background?v=" + v
		b.CustomBackground = true
	}
	if v := get("logo_v"); v != "" {
		b.Logo = "/branding/logo?v=" + v
	}
	sum := sha256.Sum256([]byte(b.Primary + "|" + b.Radius))
	b.Theme = "/branding/theme.css?v=" + hex.EncodeToString(sum[:])[:10]
	return b
}

// themeCSS overrides the color and radius tokens of app.css; it outranks
// their selectors so it applies in light and dark alike.
func themeCSS(primary, radius string) string {
	f, err := strconv.ParseFloat(radius, 64)
	if err != nil {
		f = 1.25
	}
	var b strings.Builder
	b.WriteString(":root:root {")
	for _, r := range []struct {
		name string
		px   float64
	}{{"xs", 6}, {"sm", 10}, {"md", 12}, {"lg", 16}, {"xl", 20}, {"3xl", 24}} {
		fmt.Fprintf(&b, " --radius-%s: %gpx;", r.name, r.px*f)
	}
	b.WriteString(" }\n")
	if rgb, ok := parseHex(primary); ok {
		fmt.Fprintf(&b, ":root:root[data-theme] { --primary: %s; --primary-fg: %s; --primary-hover: color-mix(in oklab, %s 85%%, #000); }\n",
			primary, readableOn(rgb), primary)
	}
	return b.String()
}

func parseHex(s string) ([3]float64, bool) {
	var rgb [3]float64
	if len(s) != 7 || s[0] != '#' {
		return rgb, false
	}
	for i := range 3 {
		n, err := strconv.ParseUint(s[1+2*i:3+2*i], 16, 8)
		if err != nil {
			return rgb, false
		}
		rgb[i] = float64(n) / 255
	}
	return rgb, true
}

// readableOn picks black or white text, whichever has more contrast on the color.
func readableOn(rgb [3]float64) string {
	lin := func(c float64) float64 {
		if c <= 0.04045 {
			return c / 12.92
		}
		return math.Pow((c+0.055)/1.055, 2.4)
	}
	l := 0.2126*lin(rgb[0]) + 0.7152*lin(rgb[1]) + 0.0722*lin(rgb[2])
	if (l+0.05)/0.05 > 1.05/(l+0.05) {
		return "#000000"
	}
	return "#ffffff"
}

func (s *Server) themeStylesheet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	io.WriteString(w, themeCSS(db.Setting(s.DB, "primary"), db.Setting(s.DB, "radius")))
}

func (s *Server) brandFile(kind string) string { return filepath.Join(s.DataDir, "branding", kind) }

// brandImage serves an uploaded image. It is public: the sign-in page shows them.
func (s *Server) brandImage(w http.ResponseWriter, r *http.Request) {
	kind := r.PathValue("kind")
	if _, ok := brandImages[kind]; !ok || db.Setting(s.DB, kind+"_v") == "" {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(s.brandFile(kind))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", db.Setting(s.DB, kind+"_type"))
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeContent(w, r, "", st.ModTime(), f)
}

func (s *Server) adminAppearancePage(w http.ResponseWriter, r *http.Request) {
	s.render(w, r, "admin-appearance", M{"Radii": radiusChoices, "Primaries": primaryChoices,
		"CustomPrimary": customPrimary(db.Setting(s.DB, "primary"))})
}

// customPrimary is the stored color when it is none of the presets.
func customPrimary(v string) string {
	for _, p := range primaryChoices {
		if p.Value == v {
			return ""
		}
	}
	return v
}

func (s *Server) saveAppearance(w http.ResponseWriter, r *http.Request) {
	const back = "/admin/appearance"
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20)
	if err := r.ParseMultipartForm(10 << 20); err != nil {
		fail(w, r, back, errors.New("the upload is too large: 8 MB for the background, 1 MB for the logo"))
		return
	}
	name := strings.TrimSpace(r.FormValue("app_name"))
	if name == "" || len([]rune(name)) > 40 {
		fail(w, r, back, errors.New("the application name must be 1 to 40 characters"))
		return
	}
	layout := r.FormValue("layout")
	if layout != "backdrop" && layout != "plain" {
		fail(w, r, back, errors.New("choose a layout"))
		return
	}
	primary := r.FormValue("primary")
	if primary == "custom" {
		primary = strings.ToLower(r.FormValue("primary_custom"))
	}
	if _, ok := parseHex(primary); primary != "" && !ok {
		fail(w, r, back, errors.New("choose a primary color"))
		return
	}
	radius := r.FormValue("radius")
	validRadius := false
	for _, c := range radiusChoices {
		validRadius = validRadius || c.Value == radius
	}
	if !validRadius {
		fail(w, r, back, errors.New("choose a corner radius"))
		return
	}
	// Read and check every image before storing anything.
	uploads := map[string][]byte{}
	types := map[string]string{}
	for kind, limit := range brandImages {
		f, hdr, err := r.FormFile(kind)
		if errors.Is(err, http.ErrMissingFile) {
			continue
		}
		if err != nil {
			fail(w, r, back, err)
			return
		}
		data, err := io.ReadAll(io.LimitReader(f, limit+1))
		f.Close()
		if err != nil {
			fail(w, r, back, err)
			return
		}
		if len(data) == 0 {
			continue
		}
		if int64(len(data)) > limit {
			fail(w, r, back, fmt.Errorf("the %s may be %d MB at most", kind, limit>>20))
			return
		}
		ct := http.DetectContentType(data)
		if !imageTypes[ct] {
			fail(w, r, back, fmt.Errorf("%s: use a PNG, JPEG, WebP or GIF image", hdr.Filename))
			return
		}
		uploads[kind], types[kind] = data, ct
	}
	for kind, data := range uploads {
		if err := s.storeBrandImage(kind, data); err != nil {
			fail(w, r, back, err)
			return
		}
		db.SetSetting(s.DB, kind+"_type", types[kind])
		db.SetSetting(s.DB, kind+"_v", strconv.FormatInt(time.Now().UnixNano(), 36))
	}
	db.SetSetting(s.DB, "app_name", name)
	db.SetSetting(s.DB, "layout", layout)
	db.SetSetting(s.DB, "primary", primary)
	db.SetSetting(s.DB, "radius", radius)
	ok(w, r, back, "Appearance saved")
}

func (s *Server) storeBrandImage(kind string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(s.brandFile(kind)), 0o755); err != nil {
		return err
	}
	tmp := s.brandFile(kind) + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.brandFile(kind))
}

// resetBrandImage goes back to the built-in image.
func (s *Server) resetBrandImage(w http.ResponseWriter, r *http.Request) {
	kind := r.FormValue("kind")
	if _, ok := brandImages[kind]; !ok {
		http.Error(w, "unknown image", http.StatusBadRequest)
		return
	}
	os.Remove(s.brandFile(kind))
	db.SetSetting(s.DB, kind+"_v", "")
	db.SetSetting(s.DB, kind+"_type", "")
	ok(w, r, "/admin/appearance", "Back to the default "+kind)
}
