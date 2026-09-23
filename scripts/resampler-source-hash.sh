#!/usr/bin/env bash
# SHA-256 over the resampler WASM inputs (the build script pins the SpeexDSP tarball hash).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
(
  cd "$PROJECT_ROOT"
  sha256sum \
    scripts/build-resampler-wasm.sh \
    src/resampler/speex_resampler_wasm.c \
    | sort | sha256sum | awk '{print $1}'
)
