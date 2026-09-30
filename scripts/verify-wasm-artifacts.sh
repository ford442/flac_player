#!/usr/bin/env bash
# Fail when WASM sources (or the pinned emsdk in scripts/emsdk-version) changed
# but committed artifacts / source hashes are stale. Three independent graphs:
#   SDL3 playback  public/sdl-audio.*            wasm-source.sha256
#   SpeexDSP       public/speex-resampler.*      resampler-source.sha256
#   projectM host  public/projectm/projectm-host.*  projectm/projectm-source.sha256
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PUBLIC="$PROJECT_ROOT/public"

# Byte sizes below catch an empty/truncated/LFS-pointer .wasm that a hash match can't
# (the hash covers sources, not the committed binary). Floors are ~half of today's
# sizes; raise them deliberately if a graph legitimately shrinks.
min_bytes() {
  local artifact="$1" min="$2" size
  size="$(wc -c < "$artifact" | tr -d '[:space:]')"
  if [ "$size" -lt "$min" ]; then
    echo "${artifact#"$PROJECT_ROOT/"} is $size bytes (< $min): truncated or placeholder artifact?" >&2
    exit 1
  fi
}

# check <label> <hash script> <hash file> <rebuild cmd> <artifact>...
check() {
  local label="$1" hash_script="$2" hash_file="$3" rebuild="$4"
  shift 4
  local artifact
  for artifact in "$@"; do
    if [ ! -f "$artifact" ]; then
      echo "Missing $label WASM artifact: $artifact" >&2
      echo "Run: $rebuild" >&2
      exit 1
    fi
  done
  if [ ! -f "$hash_file" ]; then
    echo "Missing $hash_file — run: $rebuild" >&2
    exit 1
  fi
  local current expected
  current="$("$SCRIPT_DIR/$hash_script")"
  expected="$(tr -d '[:space:]' < "$hash_file")"
  if [ "$current" != "$expected" ]; then
    echo "$label WASM sources changed but ${hash_file#"$PROJECT_ROOT/"} is stale." >&2
    echo "  expected (committed): $expected" >&2
    echo "  current  (sources):   $current" >&2
    echo "Run: $rebuild && commit the rebuilt artifacts + ${hash_file#"$PROJECT_ROOT/"}" >&2
    exit 1
  fi
}

check "SDL" wasm-source-hash.sh "$PUBLIC/wasm-source.sha256" "npm run build:wasm" \
  "$PUBLIC/sdl-audio.js" "$PUBLIC/sdl-audio.wasm"

check "Resampler" resampler-source-hash.sh "$PUBLIC/resampler-source.sha256" "npm run build:wasm:resampler" \
  "$PUBLIC/speex-resampler.js" "$PUBLIC/speex-resampler.wasm"

# projectM is optional at runtime (ShaderGUI fallback), but once its artifacts
# are committed they must match projectm_host.cpp + the build script + the pin.
if [ -f "$PUBLIC/projectm/projectm-host.wasm" ]; then
  check "projectM" projectm-source-hash.sh "$PUBLIC/projectm/projectm-source.sha256" "npm run build:projectm" \
    "$PUBLIC/projectm/projectm-host.js" "$PUBLIC/projectm/projectm-host.wasm"
fi

min_bytes "$PUBLIC/sdl-audio.wasm" 300000
min_bytes "$PUBLIC/sdl-audio.js" 50000
min_bytes "$PUBLIC/speex-resampler.wasm" 10000
min_bytes "$PUBLIC/speex-resampler.js" 2000
if [ -f "$PUBLIC/projectm/projectm-host.wasm" ]; then
  min_bytes "$PUBLIC/projectm/projectm-host.wasm" 700000
  min_bytes "$PUBLIC/projectm/projectm-host.js" 50000
fi

echo "WASM artifacts present and source hashes match (emsdk $(tr -d '[:space:]' < "$SCRIPT_DIR/emsdk-version"))."
