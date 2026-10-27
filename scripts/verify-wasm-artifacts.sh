#!/usr/bin/env bash
# Fail when WASM sources (or the emsdk pin in scripts/emsdk-version) changed but
# the committed artifacts / source hashes are stale. One check per graph:
#   SDL3 playback  public/sdl-audio.*               wasm-source.sha256
#   SpeexDSP       public/speex-resampler.*         resampler-source.sha256
#   DSP chain      public/dsp-chain.*               dsp-source.sha256
#   projectM host  public/projectm/projectm-host.*  projectm/projectm-source.sha256
# Hashes cover sources + build script + pin, not the binaries; CI's wasm-build
# job rebuilds a changed graph and diffs the bytes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PUBLIC="$PROJECT_ROOT/public"

# check <label> <hash script> <hash file> <rebuild cmd> <artifact>...
check() {
  local label="$1" hash_script="$2" hash_file="$3" rebuild="$4"
  shift 4
  local artifact
  for artifact in "$@"; do
    if [ ! -f "$artifact" ]; then
      echo "Missing $label WASM artifact: ${artifact#"$PROJECT_ROOT/"}" >&2
      echo "Run: $rebuild" >&2
      exit 1
    fi
  done
  if [ ! -f "$hash_file" ]; then
    echo "Missing ${hash_file#"$PROJECT_ROOT/"} — run: $rebuild" >&2
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

check "DSP chain" dsp-source-hash.sh "$PUBLIC/dsp-source.sha256" "npm run build:wasm:dsp" \
  "$PUBLIC/dsp-chain.js" "$PUBLIC/dsp-chain.wasm"

# Optional at runtime (ShaderGUI is the fallback), but committed artifacts must
# match projectm_host.cpp + the build script + the pin.
check "projectM" projectm-source-hash.sh "$PUBLIC/projectm/projectm-source.sha256" "npm run build:projectm" \
  "$PUBLIC/projectm/projectm-host.js" "$PUBLIC/projectm/projectm-host.wasm" "$PUBLIC/projectm/projectm-host.data"

echo "WASM artifacts present and source hashes match."
