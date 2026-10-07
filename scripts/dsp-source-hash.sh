#!/usr/bin/env bash
# SHA-256 over the DSP chain WASM inputs (public/dsp-chain.{js,wasm}).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
(
  cd "$PROJECT_ROOT"
  sha256sum \
    scripts/build-dsp-wasm.sh \
    src/dsp/dsp_wasm_entry.cpp \
    src/sdl/dsp_chain.h \
    | sort | sha256sum | awk '{print $1}'
)
