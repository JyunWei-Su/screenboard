#!/usr/bin/env bash
# Cross-compile the agent for common signage targets.
# Usage: ./build.sh [version] [amd64|arm64|all]
set -euo pipefail

# The repository-root VERSION file is managed by scripts/build-agent.sh. Keep
# this lower-level compiler strict so a direct invocation cannot silently build
# an incorrectly versioned OTA binary.
VERSION="${1:?Usage: ./build.sh <version> [amd64|arm64|all]}"
TARGET="${2:-all}"
OUT="dist"
mkdir -p "$OUT"

build() {
  local goarch="$1" name="$2"
  echo "building $name (linux/$goarch) v$VERSION"
  GOOS=linux GOARCH="$goarch" CGO_ENABLED=0 \
    go build -buildvcs=false -ldflags "-s -w -X main.AgentVersion=$VERSION" \
    -o "$OUT/${name}-v${VERSION}" .
}

case "$TARGET" in
  amd64)
    build amd64 screenboard-agent-linux-amd64
    ;;
  arm64)
    build arm64 screenboard-agent-linux-arm64
    ;;
  all)
    build amd64 screenboard-agent-linux-amd64
    build arm64 screenboard-agent-linux-arm64
    ;;
  *)
    echo "Usage: $0 [version] [amd64|arm64|all]" >&2
    exit 1
    ;;
esac

# The versioned filename is parsed automatically by the OTA upload page.
( cd "$OUT" && sha256sum screenboard-agent-linux-"$TARGET"-v* 2>/dev/null || sha256sum screenboard-agent-* )
echo "done -> $OUT/"
