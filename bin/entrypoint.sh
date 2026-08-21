#!/bin/sh
set -e

# Ensure required directories/files
mkdir -p /app/data /app/.next/cache

# Start the application without requiring npm in the runtime image
exec dumb-init -- node /app/server.js
