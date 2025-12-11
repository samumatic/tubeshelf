# TubeShelf

> [!WARNING]
> TubeShelf is still in early development and is subject to major changes from version to version. Expect bugs! Contributions and feedback are welcome.

**TubeShelf** is a self-hosted YouTube subscription feed that gives you a clean, chronological video inbox — no algorithm, no tracking, no noise.

Follow your favorite creators without missing uploads, distraction, or recommendation manipulation. TubeShelf fetches new videos directly from channels you choose and presents them in a simple, timeline-based feed you control.

## Docker

Quick start using Docker Compose (recommended):

```yaml
services:
  tubeshelf:
    image: ghcr.io/samumatic/tubeshelf:latest
    container_name: tubeshelf
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
```

The web UI will be available on port `3000` by default.

## Features

- Chronological, algorithm-free subscription feed
- Subscribe via channel URL, ID, or handle
- Local watch history & “watch later”
- Server-persisted subscriptions, watched status, and hide-watched preference
- Lightweight and privacy-focused
- Docker-ready and easy to self-host

## Why TubeShelf?

YouTube’s subscription page is optimized for engagement, not completeness. TubeShelf is built for users who want:

- Every upload, in order
- Full control over their feed
- A private, self-hosted alternative

## License

This project is licensed under [AGPL-3 License](LICENSE).
