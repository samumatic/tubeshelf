<div align="center">
  <picture>
    <source srcset="docs/icon-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="docs/icon-light.svg" media="(prefers-color-scheme: light)">
    <img alt="TubeShelf icon" src="docs/icon-flat.svg" width="140" height="140">
  </picture>
  <h1>TubeShelf</h1>
  <h3>Self-hosted YouTube subscription feed<br />chronological, distraction-free, yours.</h3>
</div>

> [!WARNING]
> TubeShelf is in early development and subject to breaking changes. Expect bugs and missing features. Contributions and feedback are welcome!

**TubeShelf** is a self-hosted YouTube subscription experience without a Google account. Browse your subscriptions in a clean, chronological feed - no algorithm, no tracking, just the videos you want in the order they were uploaded.

## Features

- **Chronological feed** - videos sorted by upload time, no algorithm
- **No Google account, no API key** - channels are read from YouTube's public RSS feeds
- **Background fetching** - the feed is served from the local database and is always ready
- **Filters** - hide Shorts, live streams, members-only and watched videos; search; newest or oldest first
- **Lists** - group channels and filter the feed by list
- **Built-in player** - resumes where you stopped, marks videos as watched, skips sponsors (SponsorBlock), keyboard shortcuts
- **Watch later and history**
- **Import/export** - OPML, Google Takeout `subscriptions.csv`, or a plain list of channels
- **Private by default** - thumbnails and avatars are cached and served by TubeShelf, so your browser only contacts YouTube when you press play
- **Multi-user** - local accounts, OIDC single sign-on, per-user API keys
- **Small** - one static Go binary, about 6 MB to pull, a few MB of RAM

## Quick Start

### Docker Compose (Recommended)

```yaml
services:
  tubeshelf:
    image: ghcr.io/samumatic/tubeshelf:latest
    container_name: tubeshelf
    restart: unless-stopped
    ports:
      - "3000:3000"
    user: "1000:1000"
    security_opt:
      - no-new-privileges:true
    volumes:
      - ./data:/app/data
```

```bash
mkdir -p data
```

```bash
chown 1000:1000 data
```

```bash
docker compose up -d
```

Open **http://localhost:3000** and create the admin account.

### Configuration

Everything is optional.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `TUBESHELF_DATA` | `/app/data` | Database, cached thumbnails, generated secret |
| `TUBESHELF_URL` | from the request | Public URL; set it when OIDC runs behind a proxy that rewrites `Host` |
| `TUBESHELF_SECRET` | generated in the data directory | Encrypts OIDC client secrets |
| `TRUST_PROXY_HEADERS` | unset | Set to `1` to rate-limit logins by `X-Forwarded-For` |

Refresh interval, video retention, registration and login providers are set in the app under **Admin**.

### Upgrading from 1.x

Keep the same `./data` volume. On its first start, 2.x imports users, subscriptions, lists, watch history, watch later, settings, API keys and login providers from the 1.x database (`data/tubeshelf.db`) into a new file (`data/shelf.db`). The 1.x file is not modified, so going back to a 1.x image is possible.

- Passwords and API keys keep working.
- Keep `BETTER_AUTH_SECRET` (or `OIDC_ENCRYPTION_KEY`) set for the first start so OIDC client secrets can be carried over. If it is missing, the provider is imported disabled and you re-enter its secret under Admin.
- The OIDC redirect URI is unchanged (`/api/auth/oidc/callback`).
- Removed in 2.x: video comments, SubRelay sync, the welcome wizard, the "standard" scraping fetcher.

## CLI

```bash
docker exec -it tubeshelf /tubeshelf reset-password <email>
```

```bash
docker exec tubeshelf /tubeshelf make-admin <email>
```

## API

Create a key under **Settings > API keys** and send it as `X-API-Key`.

| Request | Purpose |
|---|---|
| `GET /api/subscriptions` | List subscriptions |
| `POST /api/subscriptions` with `{"channel": "<url, @handle or id>"}` | Subscribe |
| `DELETE /api/subscriptions/<channel id>` | Unsubscribe |
| `GET /api/subscriptions/export` | OPML export |

## Development

```bash
go test ./...
```

```bash
go run .
```

## Why TubeShelf?

Some Invidious instances do work, though with varying issues. However, they aim to replicate the entire YouTube interface. **TubeShelf** takes a different path: instead of building an alternative YouTube frontend, it focuses on a single, well-defined goal:  
A distraction-free subscription feed without a Google account.

It fetches videos from your subscriptions and displays them chronologically, and plays them in a privacy-friendly embed or on YouTube, as you prefer.

## AI Assistance Disclaimer
This project was developed with assistance from AI/LLMs (including GitHub Copilot, ChatGPT, and related tools), supervised by humans who occasionally knew what they were doing.

---

<sub>TubeShelf is designed primarily for local/home network use.</sub>

## License

This project is licensed under [AGPL-3.0 License](LICENSE).
