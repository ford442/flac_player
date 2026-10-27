#!/usr/bin/env bash
# Emscripten build of the C++ playback engine (src/sdl/audio_engine.cpp) for the
# `sdl` output mode. The engine no longer links SDL (#268): it owns the play ring,
# buffered PCM and the transport block, and the `sdl-engine` AudioWorkletProcessor
# renders from them on the audio thread.
#
# Usage:
#   scripts/build-wasm.sh --sdl3       # production default (also --all)
#   scripts/build-wasm.sh --all        # same
#   scripts/build-wasm.sh --debug      # -O0 -g ASSERTIONS SAFE_HEAP (combine with target)
#   scripts/build-wasm.sh --debug --sdl3
#
# Emscripten is pinned (scripts/emsdk-version, docs/WASM_TOOLCHAIN.md). Keep
# -flto off until a follow-up confirms public/sdl-audio.wasm is byte-stable
# under the pin; add it in its own PR, never together with a pin bump.
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
  echo "  --all / --sdl3  C++ playback engine WASM (default)" >&2
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

# -pthread is what makes wasmMemory a SharedArrayBuffer: the sdl-engine worklet
# reads the play ring, buffered PCM and transport words from it with Atomics.
# No thread is ever started. 64 MiB floor: play ring (2 MiB) + pthread runtime;
# ALLOW_MEMORY_GROWTH is on for buffered PCM. Without an explicit MAXIMUM_MEMORY,
# Emscripten still sets Memory.maximum to 32768 pages (2 GiB) for pthreads+growth;
# we lower that SAB max to 512 MiB. Do not raise to 1 GiB: files >= 32 MB
# compressed stream through play_ring.h, and 512 MiB fail-closes pathological
# full-buffer loads (create_audio_buffer returns null above 384 MiB of PCM).
RELEASE_INITIAL_MEMORY=67108864   # 64 MiB
DEBUG_INITIAL_MEMORY=33554432     # 32 MiB
MAXIMUM_MEMORY=536870912          # 512 MiB

if [[ "$DEBUG" -eq 1 ]]; then
  OPT_FLAGS=(-O0 -g -s ASSERTIONS=1 -s SAFE_HEAP=1)
  INITIAL_MEMORY="$DEBUG_INITIAL_MEMORY"
  echo "WASM debug profile: -O0 -g ASSERTIONS=1 SAFE_HEAP=1 INITIAL_MEMORY=$INITIAL_MEMORY MAXIMUM_MEMORY=$MAXIMUM_MEMORY"
else
  # -msimd128: the template flags for every engine graph (dsp-chain.wasm needs
  # them for dsp_chain.h / dsp_fft.h); harmless here.
  OPT_FLAGS=(-O3 -DNDEBUG -msimd128)
  INITIAL_MEMORY="$RELEASE_INITIAL_MEMORY"
  echo "WASM release profile: -O3 -DNDEBUG -msimd128 INITIAL_MEMORY=$INITIAL_MEMORY MAXIMUM_MEMORY=$MAXIMUM_MEMORY"
fi

# Exports (keep in sync with audio_engine.cpp EMSCRIPTEN_KEEPALIVE and the
# SdlModule interface in Sdl3AudioPlayer.ts):
#   Lifecycle:  _init_audio _cleanup
#   Buffered:   _create_audio_buffer _set_audio_data
#   Streaming:  _set_stream_format _push_pcm _get_play_ring_fill
#               _get_play_ring_capacity _set_stream_ended
#   Transport:  _play _pause_audio _resume_audio _stop _seek _seek_stream _rebase
#               _set_playback_rate _get_current_time _is_drained
#   Worklet:    _set_output_owner _get_engine_state _get_play_ring_state _get_play_ring_data
#   Heap:       _malloc _free
ENGINE_EXPORTS='["_init_audio","_create_audio_buffer","_set_audio_data","_set_stream_format","_push_pcm","_get_play_ring_fill","_get_play_ring_capacity","_set_stream_ended","_play","_pause_audio","_resume_audio","_stop","_seek","_seek_stream","_rebase","_set_playback_rate","_get_current_time","_is_drained","_set_output_owner","_get_engine_state","_get_play_ring_state","_get_play_ring_data","_cleanup","_malloc","_free"]'
RUNTIME_EXPORTS='["ccall","cwrap","HEAPF32","HEAPU8","wasmMemory","getValue","setValue"]'

build_sdl3() {
  local out_js="$OUT_DIR/sdl-audio.js"
  echo "Compiling audio_engine.cpp -> $out_js (INITIAL_MEMORY=$INITIAL_MEMORY MAXIMUM_MEMORY=$MAXIMUM_MEMORY)"
  em++ "$SDL_DIR/audio_engine.cpp" \
    -std=c++17 \
    -pthread \
    -s WASM=1 \
    -s EXPORTED_FUNCTIONS="$ENGINE_EXPORTS" \
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
