#!/usr/bin/env bash
# Build in-app projectM WASM host (libprojectM + projectm_host.cpp).
#
# Outputs to public/projectm/:
#   projectm-host.js, projectm-host.wasm, projectm-host.data (presets)
#
# Requires: emsdk, cmake, git
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_ROOT="$PROJECT_ROOT/.build/projectm"
OUT_DIR="$PROJECT_ROOT/public/projectm"
PROJECTM_TAG="${PROJECTM_TAG:-v4.1.6}"
HOST_CPP="$PROJECT_ROOT/src/projectm/projectm_host.cpp"

mkdir -p "$OUT_DIR" "$BUILD_ROOT"

PROJECT_ROOT="$PROJECT_ROOT" source "$SCRIPT_DIR/emsdk-env.sh"

if [ ! -d "$BUILD_ROOT/src" ]; then
  echo "Cloning projectM $PROJECTM_TAG..."
  git clone --depth 1 --branch "$PROJECTM_TAG" \
    https://github.com/projectM-visualizer/projectm.git "$BUILD_ROOT/src"
fi

cd "$BUILD_ROOT/src"
if [ -f .gitmodules ] && [ ! -d vendor/projectm-eval/.git ]; then
  echo "Initializing projectM submodules..."
  git submodule update --init --recursive --depth 1
fi
cd "$PROJECT_ROOT"

LIB_BUILD="$BUILD_ROOT/cmake-build"
LIB_PROJECTM="$LIB_BUILD/src/libprojectM/libprojectM-4.a"
LIB_PLAYLIST="$LIB_BUILD/src/playlist/libprojectM-4-playlist.a"
LIB_EVAL="$LIB_BUILD/vendor/projectm-eval/projectm-eval/libprojectM_eval.a"

if [ ! -f "$LIB_BUILD/CMakeCache.txt" ]; then
  echo "Configuring libprojectM for Emscripten..."
  rm -rf "$LIB_BUILD"
  mkdir -p "$LIB_BUILD"
  emcmake cmake -S "$BUILD_ROOT/src" -B "$LIB_BUILD" \
    -DCMAKE_BUILD_TYPE=Release \
    -DENABLE_PLAYLIST=ON \
    -DENABLE_SDL_UI=OFF \
    -DBUILD_SHARED_LIBS=OFF
fi

if [ ! -f "$LIB_PROJECTM" ] || [ ! -f "$LIB_PLAYLIST" ]; then
  echo "Building libprojectM + playlist..."
  emmake make -C "$LIB_BUILD" -j"$(nproc)" projectM projectM_playlist
fi

PRESETS_DIR="$BUILD_ROOT/src/presets"
if [ ! -d "$PRESETS_DIR" ]; then
  echo "Warning: presets directory not found at $PRESETS_DIR"
  PRESETS_DIR="$BUILD_ROOT/src/buildshare/presets"
fi

echo "Compiling projectm_host.cpp -> $OUT_DIR/projectm-host.js"
em++ "$HOST_CPP" \
  -I"$LIB_BUILD/src/api/include" \
  -I"$LIB_BUILD/src/playlist/include" \
  -I"$BUILD_ROOT/src/src/api/include" \
  -I"$BUILD_ROOT/src/src/playlist/api" \
  "$LIB_PROJECTM" \
  "$LIB_PLAYLIST" \
  "$LIB_EVAL" \
  -s USE_SDL=2 \
  -s MIN_WEBGL_VERSION=2 \
  -s MAX_WEBGL_VERSION=2 \
  -s FULL_ES2=1 \
  -s FULL_ES3=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="createProjectMModule" \
  -s ENVIRONMENT=web \
  -s EXPORTED_FUNCTIONS='["_pm_init","_pm_resize","_pm_add_pcm","_pm_next_preset","_pm_prev_preset","_pm_load_preset_data","_pm_set_beat_sensitivity","_pm_destroy","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPF32","HEAPU8","wasmMemory"]' \
  $( [ -d "$PRESETS_DIR" ] && echo "--preload-file ${PRESETS_DIR}@/presets" ) \
  -O2 \
  -o "$OUT_DIR/projectm-host.js"

echo "projectM build finished."
ls -lh "$OUT_DIR" || true
