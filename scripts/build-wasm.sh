#!/usr/bin/env bash
# Unified Emscripten build for SDL3 and SDL2 audio backends.
#
# Usage:
#   scripts/build-wasm.sh --all          # default: SDL3 + SDL2
#   scripts/build-wasm.sh --sdl3
#   scripts/build-wasm.sh --sdl2
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SDL_DIR="$PROJECT_ROOT/src/sdl"
OUT_DIR="$PROJECT_ROOT/public"

TARGET="${BUILD_WASM_TARGET:-all}"

usage() {
  echo "Usage: $0 [--all|--sdl3|--sdl2]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) TARGET=all ;;
    --sdl3) TARGET=sdl3 ;;
    --sdl2) TARGET=sdl2 ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
  shift
done

mkdir -p "$SDL_DIR/build" "$OUT_DIR"

PROJECT_ROOT="$PROJECT_ROOT" source "$SCRIPT_DIR/emsdk-env.sh"

build_sdl3() {
  local out_js="$OUT_DIR/sdl-audio.js"
  echo "Compiling audio_engine.cpp -> $out_js (USE_SDL=3)"
  emcc "$SDL_DIR/audio_engine.cpp" \
    -s USE_SDL=3 \
    -s USE_PTHREADS=1 \
    -s WASM=1 \
    -s EXPORTED_FUNCTIONS='["_init_audio","_create_audio_buffer","_set_audio_data","_play","_pause_audio","_resume_audio","_stop","_seek","_get_current_time","_set_volume","_get_pcm_ring_state","_get_pcm_ring_data","_cleanup","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPF32","HEAPU8","wasmMemory","getValue","setValue"]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=268435456 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME="createSdlAudioModule" \
    -s ENVIRONMENT="web,worker" \
    -O3 \
    -o "$out_js"
  ls -lh "$OUT_DIR"/sdl-audio.* 2>/dev/null || true
}

build_sdl2() {
  local out_js="$OUT_DIR/sdl2-audio.js"
  echo "Compiling audio_engine_sdl2.cpp -> $out_js (USE_SDL=2)"
  emcc "$SDL_DIR/audio_engine_sdl2.cpp" \
    -s USE_SDL=2 \
    -s USE_PTHREADS=1 \
    -s AUDIO_WORKLET=1 \
    -s WASM_WORKERS=1 \
    -s WASM=1 \
    -s EXPORTED_FUNCTIONS='["_init_audio","_set_audio_data","_play","_pause_audio","_resume_audio","_stop","_seek","_get_current_time","_set_volume","_get_pcm_ring_state","_get_pcm_ring_data","_cleanup","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPF32","HEAPU8","wasmMemory","getValue","setValue"]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=268435456 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME="createSdl2AudioModule" \
    -s ENVIRONMENT="web,worker" \
    -O3 \
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
echo "WASM build finished ($TARGET)."
