<div align="center">
  <picture>
    <source srcset="public/icon-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="public/icon-light.svg" media="(prefers-color-scheme: light)">
    <img alt="TubeShelf icon" src="public/icon-flat.svg" width="140" height="140">
  </picture>
  <h1>TubeShelf</h1>
  <h3>Self-hosted YouTube subscription feed<br />Chronological, distraction-free, yours.</h3>
</div>

<p align="center">
  <img src="public/readme-hero.png" alt="TubeShelf feed screenshot" width="100%" />
</p>

> [!WARNING]
> TubeShelf is in early development and subject to breaking changes. Expect bugs and missing features. Contributions and feedback are welcome!

**TubeShelf** is a self-hosted YouTube subscription feed that gives you a clean, chronological video inbox — no algorithm, no tracking, no distractions.

Follow your favorite creators in a simple timeline-based feed you control. TubeShelf fetches videos directly from YouTube RSS feeds and presents them in order of upload, without recommendations or engagement manipulation.

## Features

- **Chronological feed** - Videos sorted by upload time, newest first
- **Subscribe easily** - Add channels via URL, ID, or @handle
- **Import/Export** - OPML support for migrating subscriptions
- **Mark as watched** - Track what you've seen with persistent state
- **Hide watched videos** - Filter option to show only unwatched content
- **Watch later** - Save videos for later viewing

## Limitations

> [!NOTE]
> TubeShelf uses YouTube RSS feeds, which only provide the **latest ~15 videos** per channel. This is a YouTube limitation, not a bug. TubeShelf focuses on recent uploads rather than complete channel archives.

- No video duration display (RSS feeds don't include this metadata)
- Limited to RSS feed capabilities (~15 recent videos per channel)

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

Start the container:

```bash
# Create data directory with correct permissions
mkdir -p data
chown 1000:1000 data

# Start TubeShelf
docker compose up -d
```

Access the web UI at **http://localhost:3000**

## Why TubeShelf?

Want a YouTube subscription feed without a Google account? Invidious used to be the answer, but YouTube now actively blocks it.

**TubeShelf** takes a different approach: it collects videos from YouTube RSS feeds and displays them as a clean chronological list. Click any video to open it on YouTube.

No Google account required. No algorithm. No tracking. Just your subscriptions in order.

## License

This project is licensed under [AGPL-3.0 License](LICENSE).
