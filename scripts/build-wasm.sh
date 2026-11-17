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
# Emscripten is pinned (scripts/emsdk-version, docs/WASM_TOOLCHAIN.md) and every
# flag comes from scripts/wasm-flags.sh (profile `audio-callback`). -flto is a
# follow-up in its own PR, never together with a pin bump. Do not add --closure 1.
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

# Flags: the `audio-callback` profile (scripts/wasm-flags.sh). -pthread only makes
# wasmMemory a SharedArrayBuffer: the sdl-engine worklet reads the play ring, buffered
# PCM and transport words from it with Atomics; no thread is ever started. The 512 MiB
# MAXIMUM_MEMORY also lowers the 2 GiB SAB maximum Emscripten would set for
# pthreads+growth. Do not raise it to 1 GiB: files >= 32 MB compressed stream through
# play_ring.h, and 512 MiB fail-closes pathological full-buffer loads
# (create_audio_buffer returns null above 384 MiB of PCM).
PROFILE_ARGS=()
[[ "$DEBUG" -eq 1 ]] && PROFILE_ARGS+=(--debug)
source "$SCRIPT_DIR/wasm-flags.sh"
wasm_profile audio-callback ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"}

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
  echo "Compiling audio_engine.cpp -> $out_js"
  em++ "$SDL_DIR/audio_engine.cpp" \
    "${WASM_FLAGS[@]}" \
    -s EXPORTED_FUNCTIONS="$ENGINE_EXPORTS" \
    -s EXPORTED_RUNTIME_METHODS="$RUNTIME_EXPORTS" \
    -s EXPORT_NAME="createSdlAudioModule" \
    -o "$out_js"
  ls -lh "$OUT_DIR"/sdl-audio.* 2>/dev/null || true
}

case "$TARGET" in
  all|sdl3) build_sdl3 ;;
  *) usage ;;
esac

"$SCRIPT_DIR/update-wasm-source-hash.sh"
echo "WASM build finished ($TARGET debug=$DEBUG)."
