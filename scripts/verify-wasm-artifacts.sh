#!/usr/bin/env bash
# Fail when SDL C++ sources changed but committed WASM artifacts / hash are stale.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HASH_FILE="$PROJECT_ROOT/public/wasm-source.sha256"

required=(
  "$PROJECT_ROOT/public/sdl-audio.js"
  "$PROJECT_ROOT/public/sdl-audio.wasm"
  "$PROJECT_ROOT/public/speex-resampler.js"
  "$PROJECT_ROOT/public/speex-resampler.wasm"
)

for artifact in "${required[@]}"; do
  if [ ! -f "$artifact" ]; then
    echo "Missing WASM artifact: $artifact" >&2
    echo "Run: npm run build:wasm" >&2
    exit 1
  fi
done

if [ ! -f "$HASH_FILE" ]; then
  echo "Missing $HASH_FILE — run: npm run build:wasm" >&2
  exit 1
fi

current="$("$SCRIPT_DIR/wasm-source-hash.sh")"
expected="$(tr -d '[:space:]' < "$HASH_FILE")"

if [ "$current" != "$expected" ]; then
  echo "SDL WASM sources changed but public/wasm-source.sha256 is stale." >&2
  echo "  expected (committed): $expected" >&2
  echo "  current  (sources):   $current" >&2
  echo "Run: npm run build:wasm && commit public/sdl-audio.* public/wasm-source.sha256" >&2
  exit 1
fi

RESAMPLER_HASH_FILE="$PROJECT_ROOT/public/resampler-source.sha256"
if [ ! -f "$RESAMPLER_HASH_FILE" ]; then
  echo "Missing $RESAMPLER_HASH_FILE — run: npm run build:wasm:resampler" >&2
  exit 1
fi
resampler_current="$("$SCRIPT_DIR/resampler-source-hash.sh")"
resampler_expected="$(tr -d '[:space:]' < "$RESAMPLER_HASH_FILE")"
if [ "$resampler_current" != "$resampler_expected" ]; then
  echo "Resampler WASM sources changed but public/resampler-source.sha256 is stale." >&2
  echo "  expected (committed): $resampler_expected" >&2
  echo "  current  (sources):   $resampler_current" >&2
  echo "Run: npm run build:wasm:resampler && commit public/speex-resampler.* public/resampler-source.sha256" >&2
  exit 1
fi

echo "WASM artifacts present and source hashes match."
