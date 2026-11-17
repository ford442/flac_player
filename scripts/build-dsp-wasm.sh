#!/usr/bin/env bash
# Emscripten build of the speaker DSP chain for the AudioWorklet graph.
#
#   scripts/build-dsp-wasm.sh    → public/dsp-chain.{js,wasm}
#
# Compiles the headers-only src/sdl/dsp_chain.h (ReplayGain -> limiter -> volume
# -> pitch hold (dsp_stretch.h, Signalsmith Stretch) -> EQ), src/sdl/dsp_fft.h
# (the `fft_spectrum` CPU golden, used on the main thread by src/audio/wasmFft.ts)
# and src/sdl/dsp_loudness.h (EBU R128 momentary / short-term, main thread,
# src/audio/loudnessMeter.ts) through the thin C ABI in
# src/dsp/dsp_wasm_entry.cpp. Third-party headers come pinned from
# scripts/dsp-third-party.sh. No SDL, no
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
PROJECT_ROOT="$PROJECT_ROOT" source "$SCRIPT_DIR/dsp-third-party.sh"
dsp_third_party_fetch

source "$SCRIPT_DIR/wasm-flags.sh"
wasm_profile standalone-dsp

mkdir -p "$OUT_DIR"

# Keep in sync with dsp_wasm_entry.cpp (EMSCRIPTEN_KEEPALIVE) and the DspExports
# typedefs in dspChainProcessor.js / wasmFft.ts / loudnessMeter.ts.
EXPORTS='["_scratch_ptr","_scratch_floats","_set_eq_band","_set_replaygain","_request_reset","_process","_set_playback_rate","_configure_stretch","_stretch_engaged","_fft_out_ptr","_fft_lines_ptr","_fft_spectrum","_loudness_reset","_loudness_push","_loudness_momentary","_loudness_short_term"]'

echo "Compiling dsp_chain.h -> $OUT_DIR/dsp-chain.js"
em++ \
  "$PROJECT_ROOT/src/dsp/dsp_wasm_entry.cpp" \
  "${DSP_THIRD_PARTY_INCLUDES[@]}" \
  "${WASM_FLAGS[@]}" \
  -s EXPORTED_FUNCTIONS="$EXPORTS" \
  -s EXPORT_NAME="createDspChainModule" \
  -o "$OUT_DIR/dsp-chain.js"
ls -lh "$OUT_DIR"/dsp-chain.*

"$SCRIPT_DIR/dsp-source-hash.sh" > "$OUT_DIR/dsp-source.sha256"
echo "DSP chain WASM build finished."
