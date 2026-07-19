#!/usr/bin/env bash
# Build a ScreenBoard Linux agent from the repository root.
# VERSION is the single source of truth. Each successful build advances it.
# Usage: bash scripts/build-agent.sh [--patch|--minor|--major] [amd64|arm64|all]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION_FILE="$ROOT_DIR/VERSION"
BUMP="patch"
TARGET="all"

usage() {
  echo "Usage: bash scripts/build-agent.sh [--patch|--minor|--major] [amd64|arm64|all]" >&2
  echo "  Default: bump the patch version and build both Linux architectures." >&2
}

for arg in "$@"; do
  case "$arg" in
    --patch|--minor|--major)
      BUMP="${arg#--}"
      ;;
    amd64|arm64|all)
      TARGET="$arg"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

if [[ ! -f "$VERSION_FILE" ]]; then
  echo "Missing version file: $VERSION_FILE" >&2
  exit 1
fi

CURRENT_VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
if [[ ! "$CURRENT_VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "VERSION must use major.minor.patch format (found: $CURRENT_VERSION)" >&2
  exit 1
fi

MAJOR="${BASH_REMATCH[1]}"
MINOR="${BASH_REMATCH[2]}"
PATCH="${BASH_REMATCH[3]}"
case "$BUMP" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
esac
VERSION="$MAJOR.$MINOR.$PATCH"

echo "Version: $CURRENT_VERSION -> $VERSION ($BUMP)"

command -v go >/dev/null 2>&1 || {
  echo "Go is required. Install Go, then run this script again." >&2
  exit 1
}

cd "$ROOT_DIR/agent"
# Ensure go.sum includes the checksums required by a clean, reproducible build.
go mod tidy
./build.sh "$VERSION" "$TARGET"

# Do not consume a version number for a failed build. It becomes the new
# baseline only after every requested binary was built successfully.
printf '%s\n' "$VERSION" > "$VERSION_FILE"

echo
echo "Recorded $VERSION in $VERSION_FILE"
echo "Upload the matching file from: $ROOT_DIR/agent/dist/"
echo "In ScreenBoard: OTA -> choose the versioned file -> channel stable (version is filled automatically)"
