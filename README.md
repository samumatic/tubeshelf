<div align="center">
  <picture>
    <source srcset="public/icon-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="public/icon-light.svg" media="(prefers-color-scheme: light)">
    <img alt="TubeShelf icon" src="public/icon-flat.svg" width="140" height="140">
  </picture>
  <h1>TubeShelf</h1>
  <h3>Self-hosted YouTube subscription feed<br />Chronological, distraction-free, yours.</h3>
</div>

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

YouTube's subscription page is designed for engagement, not completeness. Videos get buried, sorted by "personalization" rather than time, and mixed with algorithmic recommendations.

TubeShelf is built for users who want:

- **Every recent upload, in chronological order** - No hidden videos
- **Full control over their feed** - No algorithm deciding what you see
- **Privacy** - Self-hosted, no tracking, no data collection
- **Simplicity** - Just your subscriptions, nothing else

## License

This project is licensed under [AGPL-3.0 License](LICENSE).
