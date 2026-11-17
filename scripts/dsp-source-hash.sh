#!/usr/bin/env bash
# SHA-256 over the DSP chain WASM inputs (public/dsp-chain.{js,wasm}); dsp-third-party.sh
# pins the Signalsmith tarballs by SHA-256, so hashing it covers their contents.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
(
  cd "$PROJECT_ROOT"
  sha256sum \
    scripts/build-dsp-wasm.sh \
    scripts/dsp-third-party.sh \
    scripts/emsdk-version \
    scripts/wasm-flags.sh \
    src/dsp/dsp_wasm_entry.cpp \
    src/sdl/dsp_chain.h \
    src/sdl/dsp_fft.h \
    src/sdl/dsp_loudness.h \
    src/sdl/dsp_stretch.h \
    | sort | sha256sum | awk '{print $1}'
)
