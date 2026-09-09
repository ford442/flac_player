#!/usr/bin/env bash
# Unified Emscripten build for SDL3 and SDL2 audio backends.
#
# Usage:
#   scripts/build-wasm.sh --all          # default: SDL3 + SDL2
#   scripts/build-wasm.sh --sdl3
#   scripts/build-wasm.sh --sdl2
#   scripts/build-wasm.sh --debug      # -O0 -g ASSERTIONS SAFE_HEAP (combine with target)
#   scripts/build-wasm.sh --debug --sdl3
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SDL_DIR="$PROJECT_ROOT/src/sdl"
OUT_DIR="$PROJECT_ROOT/public"

TARGET="${BUILD_WASM_TARGET:-all}"
DEBUG=0

usage() {
  echo "Usage: $0 [--all|--sdl3|--sdl2] [--debug]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) TARGET=all ;;
    --sdl3) TARGET=sdl3 ;;
    --sdl2) TARGET=sdl2 ;;
    --debug) DEBUG=1 ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
  shift
done

mkdir -p "$SDL_DIR/build" "$OUT_DIR"

PROJECT_ROOT="$PROJECT_ROOT" source "$SCRIPT_DIR/emsdk-env.sh"

# 64 MiB floor: pthread worker stacks + play ring (~1.5 MiB) + viz ring + SDL.
# 32 MiB is tight with -pthread. ALLOW_MEMORY_GROWTH still on for outliers.
# Debug uses a smaller floor; SAFE_HEAP/ASSERTIONS catch HEAP OOB.
RELEASE_INITIAL_MEMORY=67108864
DEBUG_INITIAL_MEMORY=33554432

if [[ "$DEBUG" -eq 1 ]]; then
  OPT_FLAGS=(-O0 -g -s ASSERTIONS=1 -s SAFE_HEAP=1)
  INITIAL_MEMORY="$DEBUG_INITIAL_MEMORY"
  echo "WASM debug profile: -O0 -g ASSERTIONS=1 SAFE_HEAP=1 INITIAL_MEMORY=$INITIAL_MEMORY"
else
  OPT_FLAGS=(-O3)
  INITIAL_MEMORY="$RELEASE_INITIAL_MEMORY"
fi

# Exported SDL3 symbols (keep in sync with audio_engine.cpp EMSCRIPTEN_KEEPALIVE):
#   Lifecycle:     _init_audio _cleanup
#   Buffered:      _create_audio_buffer _set_audio_data
#   Streaming:     _set_stream_format _push_pcm _get_play_ring_fill
#                  _get_play_ring_capacity _set_stream_ended
#   Transport:     _play _pause_audio _resume_audio _stop _seek _get_current_time _set_volume
#   Viz tap:       _get_pcm_ring_state _get_pcm_ring_data
#   Heap:          _malloc _free
# Play ring capacity (C++ PLAY_RING_CAPACITY): 384000 floats (~2 s stereo f32 @ 96 kHz).
SDL3_EXPORTS='["_init_audio","_create_audio_buffer","_set_audio_data","_set_stream_format","_push_pcm","_get_play_ring_fill","_get_play_ring_capacity","_set_stream_ended","_play","_pause_audio","_resume_audio","_stop","_seek","_get_current_time","_set_volume","_get_pcm_ring_state","_get_pcm_ring_data","_cleanup","_malloc","_free"]'
SDL2_EXPORTS='["_init_audio","_set_audio_data","_play","_pause_audio","_resume_audio","_stop","_seek","_get_current_time","_set_volume","_get_pcm_ring_state","_get_pcm_ring_data","_cleanup","_malloc","_free"]'
RUNTIME_EXPORTS='["ccall","cwrap","HEAPF32","HEAPU8","wasmMemory","getValue","setValue"]'

build_sdl3() {
  local out_js="$OUT_DIR/sdl-audio.js"
  echo "Compiling audio_engine.cpp -> $out_js (USE_SDL=3 INITIAL_MEMORY=$INITIAL_MEMORY)"
  em++ "$SDL_DIR/audio_engine.cpp" \
    -s USE_SDL=3 \
    -pthread \
    -s WASM=1 \
    -s EXPORTED_FUNCTIONS="$SDL3_EXPORTS" \
    -s EXPORTED_RUNTIME_METHODS="$RUNTIME_EXPORTS" \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY="$INITIAL_MEMORY" \
    -s MODULARIZE=1 \
    -s EXPORT_NAME="createSdlAudioModule" \
    -s ENVIRONMENT="web,worker" \
    "${OPT_FLAGS[@]}" \
    -o "$out_js"
  ls -lh "$OUT_DIR"/sdl-audio.* 2>/dev/null || true
}

build_sdl2() {
  local out_js="$OUT_DIR/sdl2-audio.js"
  echo "Compiling audio_engine_sdl2.cpp -> $out_js (USE_SDL=2 INITIAL_MEMORY=$INITIAL_MEMORY)"
  em++ "$SDL_DIR/audio_engine_sdl2.cpp" \
    -s USE_SDL=2 \
    -pthread \
    -s AUDIO_WORKLET=1 \
    -s WASM_WORKERS=1 \
    -s WASM=1 \
    -s EXPORTED_FUNCTIONS="$SDL2_EXPORTS" \
    -s EXPORTED_RUNTIME_METHODS="$RUNTIME_EXPORTS" \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY="$INITIAL_MEMORY" \
    -s MODULARIZE=1 \
    -s EXPORT_NAME="createSdl2AudioModule" \
    -s ENVIRONMENT="web,worker" \
    "${OPT_FLAGS[@]}" \
    -o "$out_js"
  ls -lh "$OUT_DIR"/sdl2-audio.* 2>/dev/null || true
}

case "$TARGET" in
  all)
    build_sdl3
    build_sdl2
    ;;
  sdl3) build_sdl3 ;;
  sdl2) build_sdl2 ;;
  *) usage ;;
esac

"$SCRIPT_DIR/update-wasm-source-hash.sh"
echo "WASM build finished ($TARGET debug=$DEBUG)."
