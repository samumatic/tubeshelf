// TubeShelf: a self-hosted YouTube subscription feed without a Google account.
package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/samumatic/tubeshelf/internal/auth"
	"github.com/samumatic/tubeshelf/internal/db"
	"github.com/samumatic/tubeshelf/internal/fetch"
	"github.com/samumatic/tubeshelf/internal/importv1"
	"github.com/samumatic/tubeshelf/internal/web"
	"github.com/samumatic/tubeshelf/internal/yt"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

const usage = `tubeshelf [command]

  serve                     run the server (default)
  import-v1 [file]          import a TubeShelf v1 database (default: <data>/tubeshelf.db)
  reset-password <email>    set a new password for a user (read from stdin)
  make-admin <email>        give a user the admin role
  health                    exit 0 if the local server answers (for container healthchecks)
  version

Environment:
  TUBESHELF_DATA    data directory (default ./data)
  PORT              listen port (default 3000)
  TUBESHELF_URL     public URL, needed for OIDC behind a proxy that rewrites Host
  TUBESHELF_SECRET  secret for encrypting OIDC client secrets (default: kept in <data>/.secret)
  TRUST_PROXY_HEADERS=1  use X-Forwarded-For for login rate limiting
  TUBESHELF_IMPORT_SKIP_OIDC=1  import v1 data even if an OIDC client secret cannot be decrypted
`

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	if err := run(cmd, os.Args[min(2, len(os.Args)):]); err != nil {
		fmt.Fprintln(os.Stderr, "tubeshelf:", err)
		os.Exit(1)
	}
}

func run(cmd string, args []string) error {
	port := env("PORT", "3000")
	switch cmd {
	case "version":
		fmt.Println(version)
		return nil
	case "help", "-h", "--help":
		fmt.Print(usage)
		return nil
	case "health":
		c := http.Client{Timeout: 3 * time.Second}
		res, err := c.Get("http://127.0.0.1:" + port + "/healthz")
		if err != nil {
			return err
		}
		res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return errors.New(res.Status)
		}
		return nil
	}

	dataDir := env("TUBESHELF_DATA", "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return err
	}
	d, err := db.Open(filepath.Join(dataDir, "shelf.db"))
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer d.Close()
	secret, err := auth.LoadSecret(dataDir)
	if err != nil {
		return fmt.Errorf("load secret: %w", err)
	}
	v1Path := filepath.Join(dataDir, "tubeshelf.db")
	importV1 := func(path string) error {
		res, err := importv1.Run(d, path, secret, v1Secrets(dataDir), os.Getenv("TUBESHELF_IMPORT_SKIP_OIDC") == "1")
		if errors.Is(err, importv1.ErrProviderSecret) {
			return fmt.Errorf(`%w.
Nothing was imported. Start again with the secret your 1.x container used
(BETTER_AUTH_SECRET or OIDC_ENCRYPTION_KEY, same value as before).
To import anyway and re-enter the client secret under Admin later, set TUBESHELF_IMPORT_SKIP_OIDC=1`, err)
		}
		if err != nil {
			return err
		}
		slog.Info("imported v1 database", "file", path, "users", res.Users, "channels", res.Channels,
			"subscriptions", res.Subscriptions, "lists", res.Lists, "videos", res.Videos,
			"watch_states", res.WatchStates, "watch_later", res.WatchLater, "providers", res.Providers, "api_keys", res.APIKeys)
		return nil
	}

	switch cmd {
	case "import-v1":
		if len(args) > 0 {
			v1Path = args[0]
		}
		return importV1(v1Path)
	case "reset-password", "make-admin":
		if len(args) != 1 {
			return errors.New("usage: tubeshelf " + cmd + " <email>")
		}
		var id string
		if d.QueryRow(`SELECT id FROM users WHERE email = ?`, args[0]).Scan(&id) != nil {
			return fmt.Errorf("no user with email %s", args[0])
		}
		if cmd == "make-admin" {
			_, err := d.Exec(`UPDATE users SET is_admin = 1 WHERE id = ?`, id)
			return err
		}
		fmt.Fprint(os.Stderr, "New password: ")
		line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		return auth.SetPassword(d, id, strings.TrimRight(line, "\r\n"))
	case "serve":
	default:
		fmt.Print(usage)
		return fmt.Errorf("unknown command %q", cmd)
	}

	// Upgrading from v1: the old database sits next to the new one. Import it
	// once, on the first start; the v1 file is left untouched.
	if auth.UserCount(d) == 0 {
		if _, err := os.Stat(v1Path); err == nil {
			// Starting empty instead would let someone create a fresh admin
			// and make the import impossible, so a failed import stops here.
			if err := importV1(v1Path); err != nil {
				return fmt.Errorf("importing %s: %w", v1Path, err)
			}
		}
	}

	client := yt.New()
	fetcher := fetch.New(d, client)
	srv := &web.Server{DB: d, YT: client, Fetcher: fetcher, Secret: secret, DataDir: dataDir, Version: version}
	fetcher.OnPrune = srv.PruneMedia
	handler, err := srv.Handler()
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go fetcher.Run(ctx)

	httpSrv := &http.Server{
		Addr:              net.JoinHostPort(env("TUBESHELF_HOST", ""), port),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	go func() {
		<-ctx.Done()
		shut, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		httpSrv.Shutdown(shut)
	}()
	slog.Info("tubeshelf listening", "addr", httpSrv.Addr, "version", version, "data", dataDir)
	if err := httpSrv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// v1Secrets lists every place v1 could have taken its encryption secret from.
func v1Secrets(dataDir string) []string {
	var out []string
	for _, k := range []string{"OIDC_ENCRYPTION_KEY", "BETTER_AUTH_SECRET", "AUTH_SECRET", "SECRET_KEY"} {
		if v := os.Getenv(k); v != "" {
			out = append(out, v)
		}
	}
	if b, err := os.ReadFile(filepath.Join(dataDir, ".better-auth-secret")); err == nil {
		out = append(out, strings.TrimSpace(string(b)))
	}
	return out
}
