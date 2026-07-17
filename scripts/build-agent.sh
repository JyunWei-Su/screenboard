#!/usr/bin/env bash
# Build a ScreenBoard Linux agent from the repository root.
# Usage: bash scripts/build-agent.sh [version] [amd64|arm64|all]
set -euo pipefail

VERSION="${1:-0.1.0}"
TARGET="${2:-all}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$TARGET" in
  amd64|arm64|all) ;;
  *)
    echo "Usage: bash scripts/build-agent.sh [version] [amd64|arm64|all]" >&2
    exit 1
    ;;
esac

command -v go >/dev/null 2>&1 || {
  echo "Go is required. Install Go, then run this script again." >&2
  exit 1
}

cd "$ROOT_DIR/agent"
# Ensure go.sum includes the checksums required by a clean, reproducible build.
go mod tidy
./build.sh "$VERSION" "$TARGET"

echo
echo "Upload the matching file from: $ROOT_DIR/agent/dist/"
echo "In ScreenBoard: OTA -> choose the versioned file -> channel stable (version is filled automatically)"
