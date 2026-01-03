#!/usr/bin/env bash
set -euo pipefail

# Directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$SCRIPT_DIR/../.."
BUILD_DIR="$SCRIPT_DIR/build"
OUT_DIR="$PROJECT_ROOT/dist"
OUT_JS="$OUT_DIR/sdl2-audio.js"

mkdir -p "$BUILD_DIR" "$OUT_DIR"

# Check for emcc
# Try to source emsdk_env.sh from various locations
if [ -f "/content/build_space/emsdk/emsdk_env.sh" ]; then
    source /content/build_space/emsdk/emsdk_env.sh
elif [ -f "./emsdk/emsdk_env.sh" ]; then
    source ./emsdk/emsdk_env.sh
elif [ -f "../emsdk/emsdk_env.sh" ]; then
    source ../emsdk/emsdk_env.sh
elif [ -f "../../emsdk/emsdk_env.sh" ]; then
    source ../../emsdk/emsdk_env.sh
else
    echo "Warning: emsdk_env.sh not found. Assuming emcc is in PATH."
fi

echo "Compiling audio_engine_sdl2.cpp -> $OUT_JS using -sUSE_SDL=2"

# Compile using SDL2 port
# -s AUDIO_WORKLET=1 enables AudioWorklet support
# -s WASM_WORKERS=0 (default) or 1? Standard SDL2 AudioWorklet doesn't require Wasm Workers.
# -s ASYNCIFY might be needed if we block? We don't block.
# -s EXIT_RUNTIME=0 to keep alive.

emcc "$SCRIPT_DIR/audio_engine_sdl2.cpp" \
  -s USE_SDL=2 \
  -s USE_PTHREADS=1 \
  -s AUDIO_WORKLET=1 \
  -s WASM_WORKERS=1 \
  -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_init_audio","_set_audio_data","_play","_pause_audio","_resume_audio","_stop","_seek","_get_current_time","_set_volume","_cleanup","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPF32","HEAPU8","wasmMemory","getValue","setValue"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=268435456 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="createSdl2AudioModule" \
  -s ENVIRONMENT="web,worker" \
  -O3 \
  -o "$OUT_JS"

if [ $? -ne 0 ]; then
  echo "Error: emcc compilation for SDL2 failed" >&2
  exit 1
fi

echo "SDL2 Build finished successfully."
ls -lh "$OUT_DIR" | grep sdl2-audio || true
