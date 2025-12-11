#!/bin/sh
set -e

PUID=${PUID:-1000}
PGID=${PGID:-1000}

# Create group/user if not present (Alpine)
if ! getent group "$PGID" >/dev/null 2>&1; then
  addgroup -g "$PGID" appgrp || true
fi
if ! getent passwd "$PUID" >/dev/null 2>&1; then
  adduser -D -H -u "$PUID" -G appgrp appuser || true
fi

# Ensure required directories/files
mkdir -p /app/data /app/.next/cache
[ -f /app/data/subscriptions.json ] || echo "[]" > /app/data/subscriptions.json
[ -f /app/data/watchedVideos.json ] || echo "[]" > /app/data/watchedVideos.json
[ -f /app/data/userConfig.json ] || echo '{"hideWatched":false}' > /app/data/userConfig.json

# Fix ownership on bind mounts and cache
chown -R "$PUID":"$PGID" /app/data || true
chown -R "$PUID":"$PGID" /app/.next || true

# Drop privileges and start
exec dumb-init -- su-exec "$PUID":"$PGID" node server.js
