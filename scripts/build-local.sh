#!/usr/bin/env bash
#
# Build a TubeShelf Docker image from the local working tree.
#
# Usage:
#   ./scripts/build-local.sh                 # -> tubeshelf:local
#   IMAGE_TAG=test ./scripts/build-local.sh  # -> tubeshelf:test
#   ./scripts/build-local.sh --no-cache      # extra args go to `docker build`
#
# Also tags the image with the current git commit (tubeshelf:git-<sha>) so you
# can roll back to a previous local build.
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-tubeshelf}"
IMAGE_TAG="${IMAGE_TAG:-local}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TAGS=(-t "${IMAGE_NAME}:${IMAGE_TAG}")

if git rev-parse --short HEAD >/dev/null 2>&1; then
  GIT_SHA="$(git rev-parse --short HEAD)"
  if [ -n "$(git status --porcelain)" ]; then
    GIT_SHA="${GIT_SHA}-dirty"
  fi
  TAGS+=(-t "${IMAGE_NAME}:git-${GIT_SHA}")
fi

echo "==> Building ${IMAGE_NAME}:${IMAGE_TAG} from ${REPO_ROOT}"
docker build "${TAGS[@]}" "$@" .

echo
echo "==> Done:"
docker images "${IMAGE_NAME}" --format '    {{.Repository}}:{{.Tag}}  {{.Size}}  {{.CreatedSince}}'
echo
echo "Run it with:"
echo "    docker compose -f docker-compose.local.yml up -d"
