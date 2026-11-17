#!/usr/bin/env bash
# Emscripten build of the speaker DSP chain for the AudioWorklet graph.
#
#   scripts/build-dsp-wasm.sh    → public/dsp-chain.{js,wasm}
#
# Compiles the headers-only src/sdl/dsp_chain.h (ReplayGain -> limiter -> volume
# -> EQ) and src/sdl/dsp_fft.h (the `fft_spectrum` CPU golden, used on the main
# thread by src/audio/wasmFft.ts) through the thin C ABI in
# src/dsp/dsp_wasm_entry.cpp. No SDL, no
# pthread: the same object code the engine graph can compile, here run by
# src/audio/worklets/dspChainProcessor.js. Flags: profile `standalone-dsp`
# (scripts/wasm-flags.sh). STANDALONE_WASM keeps export names unminified and the
# import object empty, so the worklet instantiates the raw .wasm synchronously;
# the MODULARIZE glue is for main-thread / tooling use.
# src/audio/DspChainNode.ts falls back to EQChain / ReplayGainNode when this
# module fails to load.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$PROJECT_ROOT/public"

PROJECT_ROOT="$PROJECT_ROOT" source "$SCRIPT_DIR/emsdk-env.sh"

source "$SCRIPT_DIR/wasm-flags.sh"
wasm_profile standalone-dsp

mkdir -p "$OUT_DIR"

EXPORTS='["_scratch_ptr","_scratch_floats","_set_eq_band","_set_replaygain","_request_reset","_process","_fft_out_ptr","_fft_lines_ptr","_fft_spectrum"]'

echo "Compiling dsp_chain.h -> $OUT_DIR/dsp-chain.js"
em++ \
  "$PROJECT_ROOT/src/dsp/dsp_wasm_entry.cpp" \
  "${WASM_FLAGS[@]}" \
  -s EXPORTED_FUNCTIONS="$EXPORTS" \
  -s EXPORT_NAME="createDspChainModule" \
  -o "$OUT_DIR/dsp-chain.js"
ls -lh "$OUT_DIR"/dsp-chain.*

"$SCRIPT_DIR/dsp-source-hash.sh" > "$OUT_DIR/dsp-source.sha256"
echo "DSP chain WASM build finished."
