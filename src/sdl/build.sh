#!/usr/bin/env bash
set -euo pipefail

# Directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$SCRIPT_DIR/../.."
BUILD_DIR="$SCRIPT_DIR/build"
OUT_DIR="$PROJECT_ROOT/public"
OUT_JS="$OUT_DIR/sdl-audio.js"

mkdir -p "$BUILD_DIR" "$OUT_DIR"

# Check for emcc
if ! command -v emcc >/dev/null 2>&1; then
  # Try to source EMSDK if likely locations exist
  if [ -n "${EMSDK:-}" ] && [ -f "$EMSDK/emsdk_env.sh" ]; then
    source "$EMSDK/emsdk_env.sh"
  elif [ -f "$HOME/emsdk/emsdk_env.sh" ]; then
    source "$HOME/emsdk/emsdk_env.sh"
  else
    echo "Error: Emscripten (emcc) not found. Please activate emsdk." >&2
    exit 1
  fi
fi

echo "Compiling audio_engine.cpp -> $OUT_JS using -sUSE_SDL=3"

# Compile directly using the SDL3 port
emcc "$SCRIPT_DIR/audio_engine.cpp" \
  -s USE_SDL=3 \
  -s USE_PTHREADS=1 \
  -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_init_audio","_set_audio_data","_play","_pause_audio","_resume_audio","_stop","_seek","_get_current_time","_set_volume","_cleanup","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPF32","HEAPU8"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="createSdlAudioModule" \
  -s ENVIRONMENT="web,worker" \
  -s AUDIO_WORKLET=1 \
  -s WASM_WORKERS=1 \
  -O3 \
  -o "$OUT_JS"

if [ $? -ne 0 ]; then
  echo "Error: emcc compilation failed" >&2
  exit 1
fi

echo "Build finished successfully."
ls -lh "$OUT_DIR" | grep sdl-audio || true
