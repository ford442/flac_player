#!/usr/bin/env bash
# Emscripten build for the SDL3 audio backend.
#
# Usage:
#   scripts/build-wasm.sh --sdl3       # production default (also --all)
#   scripts/build-wasm.sh --all        # SDL3 only (SDL2 playback retired)
#   scripts/build-wasm.sh --debug      # -O0 -g ASSERTIONS SAFE_HEAP (combine with target)
#   scripts/build-wasm.sh --debug --sdl3
#
# Do not add -flto until emsdk is pinned in CI and locally (wasm-build uses
# `emsdk install latest`; LTO codegen is not reproducible across LLVM).
# Do not add --closure 1 (pthread + MODULARIZE glue).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SDL_DIR="$PROJECT_ROOT/src/sdl"
OUT_DIR="$PROJECT_ROOT/public"

TARGET="${BUILD_WASM_TARGET:-sdl3}"
DEBUG=0

usage() {
  echo "Usage: $0 [--all|--sdl3] [--debug]" >&2
  echo "  --all / --sdl3  SDL3 playback WASM (default)" >&2
  echo "  --debug         -O0 -g ASSERTIONS SAFE_HEAP, 32 MiB floor" >&2
  echo "SDL2 playback was retired; projectM still uses its own USE_SDL=2 video host." >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) TARGET=sdl3 ;;
    --sdl3) TARGET=sdl3 ;;
    --sdl2)
      echo "SDL2 playback was retired. Use --sdl3 (projectM video host is a separate build)." >&2
      exit 1
      ;;
    --debug) DEBUG=1 ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
  shift
done

mkdir -p "$SDL_DIR/build" "$OUT_DIR"

PROJECT_ROOT="$PROJECT_ROOT" source "$SCRIPT_DIR/emsdk-env.sh"

# 64 MiB floor: pthread worker stacks + play ring (~1.5 MiB) + viz ring + SDL.
# 32 MiB is tight with -pthread. ALLOW_MEMORY_GROWTH is on for buffered PCM
# outliers. Without an explicit MAXIMUM_MEMORY, Emscripten still sets
# Memory.maximum to 32768 pages (2 GiB) for pthreads+growth. We lower that
# SAB max to 512 MiB. Do not raise to 1 GiB: SDL3 streams files ≥32 MB
# compressed through play_ring.h; 512 MiB fail-closes pathological full-buffer loads.
RELEASE_INITIAL_MEMORY=67108864   # 64 MiB
DEBUG_INITIAL_MEMORY=33554432     # 32 MiB
MAXIMUM_MEMORY=536870912          # 512 MiB

if [[ "$DEBUG" -eq 1 ]]; then
  OPT_FLAGS=(-O0 -g -s ASSERTIONS=1 -s SAFE_HEAP=1)
  INITIAL_MEMORY="$DEBUG_INITIAL_MEMORY"
  echo "WASM debug profile: -O0 -g ASSERTIONS=1 SAFE_HEAP=1 INITIAL_MEMORY=$INITIAL_MEMORY MAXIMUM_MEMORY=$MAXIMUM_MEMORY"
else
  # -DNDEBUG: strips printf behind #ifndef NDEBUG in audio_engine.cpp.
  # -msimd128: stereo EQ in dsp_chain.h uses f64x2 lanes (scalar fallback
  # when __wasm_simd128__ is undefined, e.g. the --debug profile).
  OPT_FLAGS=(-O3 -DNDEBUG -msimd128)
  INITIAL_MEMORY="$RELEASE_INITIAL_MEMORY"
  echo "WASM release profile: -O3 -DNDEBUG -msimd128 INITIAL_MEMORY=$INITIAL_MEMORY MAXIMUM_MEMORY=$MAXIMUM_MEMORY"
fi

# Exported SDL3 symbols (keep in sync with audio_engine.cpp EMSCRIPTEN_KEEPALIVE):
#   Lifecycle:     _init_audio _cleanup
#   Buffered:      _create_audio_buffer _set_audio_data
#   Streaming:     _set_stream_format _push_pcm _get_play_ring_fill
#                  _get_play_ring_capacity _set_stream_ended
#   Transport:     _play _pause_audio _resume_audio _stop _seek _seek_stream
#                  _set_playback_rate _get_current_time _set_volume _get_device_format
#   Speaker DSP:   _set_eq_band _set_replaygain (dsp_chain.h)
#   Viz tap:       _get_pcm_ring_state _get_pcm_ring_data
#   Heap:          _malloc _free
# Play ring capacity (C++ PLAY_RING_CAPACITY): 384000 floats (~2 s stereo f32 @ 96 kHz).
SDL3_EXPORTS='["_init_audio","_create_audio_buffer","_set_audio_data","_set_stream_format","_push_pcm","_get_play_ring_fill","_get_play_ring_capacity","_set_stream_ended","_play","_pause_audio","_resume_audio","_stop","_seek","_seek_stream","_set_playback_rate","_get_device_format","_get_current_time","_set_volume","_set_eq_band","_set_replaygain","_get_pcm_ring_state","_get_pcm_ring_data","_cleanup","_malloc","_free"]'
RUNTIME_EXPORTS='["ccall","cwrap","HEAPF32","HEAPU8","wasmMemory","getValue","setValue"]'

build_sdl3() {
  local out_js="$OUT_DIR/sdl-audio.js"
  echo "Compiling audio_engine.cpp -> $out_js (USE_SDL=3 INITIAL_MEMORY=$INITIAL_MEMORY MAXIMUM_MEMORY=$MAXIMUM_MEMORY)"
  em++ "$SDL_DIR/audio_engine.cpp" \
    -s USE_SDL=3 \
    -pthread \
    -s WASM=1 \
    -s EXPORTED_FUNCTIONS="$SDL3_EXPORTS" \
    -s EXPORTED_RUNTIME_METHODS="$RUNTIME_EXPORTS" \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY="$INITIAL_MEMORY" \
    -s MAXIMUM_MEMORY="$MAXIMUM_MEMORY" \
    -s MODULARIZE=1 \
    -s EXPORT_NAME="createSdlAudioModule" \
    -s ENVIRONMENT="web,worker" \
    "${OPT_FLAGS[@]}" \
    -o "$out_js"
  ls -lh "$OUT_DIR"/sdl-audio.* 2>/dev/null || true
}

case "$TARGET" in
  all|sdl3) build_sdl3 ;;
  *) usage ;;
esac

"$SCRIPT_DIR/update-wasm-source-hash.sh"
echo "WASM build finished ($TARGET debug=$DEBUG)."
