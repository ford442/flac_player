#!/usr/bin/env bash
# Compute a single SHA-256 over SDL WASM source inputs (used for freshness checks).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

(
  cd "$PROJECT_ROOT"
  sha256sum \
    scripts/build-wasm.sh \
    src/sdl/audio_engine.cpp \
    src/sdl/audio_engine_sdl2.cpp \
    src/sdl/pcm_ring.h \
    2>/dev/null | sort | sha256sum | awk '{print $1}'
)
