#!/usr/bin/env bash
# Build and push ghcr.io/easylab-online/connector-telegram:pro (until CI on branch pro runs).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE=ghcr.io/easylab-online/connector-telegram
VERSION="$(node -p "require('$ROOT/package.json').version")"

if [[ -z "${GITHUB_TOKEN:-}" && -z "${GHCR_TOKEN:-}" ]]; then
  echo "Set GITHUB_TOKEN or GHCR_TOKEN (packages:write) then re-run." >&2
  exit 1
fi
TOKEN="${GHCR_TOKEN:-$GITHUB_TOKEN}"
echo "$TOKEN" | docker login ghcr.io -u x --password-stdin

docker build -f "$ROOT/Dockerfile" -t "$IMAGE:pro" -t "$IMAGE:$VERSION" "$ROOT"
docker push "$IMAGE:pro"
docker push "$IMAGE:$VERSION"
echo "OK: $IMAGE:pro"
