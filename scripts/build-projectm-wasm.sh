#!/usr/bin/env bash
# Build in-app projectM WASM host (libprojectM + projectm_host.cpp).
#
# Host is a GL/SDL2 video module (USE_SDL=2, WebGL2-only, FULL_ES3, preset
# preload). Keep it separate from sdl-audio.wasm and keep USE_SDL=2. -O2 is the Emscripten default for large CMake/static-lib links:
# faster compiles, less brittle inlining across libprojectM, and the host is
# not on the audio callback. SDL audio uses -O3 because the pthread callback
# + ring copy is the hot path. Do not copy SDL's -O3 (or a future pinned-emsdk
# -flto) here without a dedicated projectM size/perf measurement.
#
# No -pthread: the host renders on the main thread and is fed PCM by JS
# (pm_add_pcm); it is not on the SDL audio callback. Add it only with a
# measured audio-tap benefit.
#
# Heap: MAXIMUM_MEMORY caps growth (see PM_MAXIMUM_MEMORY below). Without it
# Emscripten allows growth to 2 GiB.
#
# Reproducibility: built with the emsdk pinned in scripts/emsdk-version. The
# cached libprojectM checkout/static libs under .build/projectm are stamped
# with PROJECTM_TAG + emcc version and wiped when either changes.
# public/projectm/projectm-source.sha256 (scripts/projectm-source-hash.sh) is
# checked by npm run verify:wasm. Overriding PROJECTM_TAG builds a
# non-canonical artifact and does not update that hash.
#
# Outputs to public/projectm/:
#   projectm-host.js, projectm-host.wasm, projectm-host.data (presets)
#
# Requires: emsdk, cmake, git
#
# Usage:
#   scripts/build-projectm-wasm.sh
#   scripts/build-projectm-wasm.sh --debug   # -O0 -g ASSERTIONS SAFE_HEAP
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_ROOT="$PROJECT_ROOT/.build/projectm"
OUT_DIR="$PROJECT_ROOT/public/projectm"
PROJECTM_DEFAULT_TAG="v4.1.6"
PROJECTM_TAG="${PROJECTM_TAG:-$PROJECTM_DEFAULT_TAG}"
HOST_CPP="$PROJECT_ROOT/src/projectm/projectm_host.cpp"
DEBUG=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --debug) DEBUG=1 ;;
    -h|--help)
      echo "Usage: $0 [--debug]" >&2
      exit 1
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--debug]" >&2
      exit 1
      ;;
  esac
  shift
done

mkdir -p "$OUT_DIR" "$BUILD_ROOT"

PROJECT_ROOT="$PROJECT_ROOT" source "$SCRIPT_DIR/emsdk-env.sh"

STAMP_FILE="$BUILD_ROOT/build-stamp"
STAMP="PROJECTM_TAG=$PROJECTM_TAG EMCC=$(emcc -dumpversion)"
if [ "$(cat "$STAMP_FILE" 2>/dev/null || true)" != "$STAMP" ]; then
  echo "projectM build cache stale or unstamped ($STAMP); rebuilding from scratch."
  rm -rf "$BUILD_ROOT/src" "$BUILD_ROOT/cmake-build"
fi

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

printf '%s\n' "$STAMP" > "$STAMP_FILE"

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

if [[ "$DEBUG" -eq 1 ]]; then
  PM_OPT_FLAGS=(-O0 -g -s ASSERTIONS=1 -s SAFE_HEAP=1)
  echo "projectM debug profile: -O0 -g ASSERTIONS=1 SAFE_HEAP=1"
else
  PM_OPT_FLAGS=(-O2)
fi

# FULL_ES3 already implies FULL_ES2 (emscripten tools/link.py), so FULL_ES2=1
# is not passed separately. MIN_WEBGL_VERSION=2: no WebGL1 context path.
PM_MAXIMUM_MEMORY=268435456   # 256 MiB

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
  -s FULL_ES3=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MAXIMUM_MEMORY="$PM_MAXIMUM_MEMORY" \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="createProjectMModule" \
  -s ENVIRONMENT=web \
  -s EXPORTED_FUNCTIONS='["_pm_init","_pm_resize","_pm_add_pcm","_pm_next_preset","_pm_prev_preset","_pm_load_preset_data","_pm_set_beat_sensitivity","_pm_destroy","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["HEAPF32","HEAPU8","wasmMemory"]' \
  $( [ -d "$PRESETS_DIR" ] && echo "--preload-file ${PRESETS_DIR}@/presets" ) \
  "${PM_OPT_FLAGS[@]}" \
  -o "$OUT_DIR/projectm-host.js"

if [ "$PROJECTM_TAG" = "$PROJECTM_DEFAULT_TAG" ]; then
  "$SCRIPT_DIR/projectm-source-hash.sh" > "$OUT_DIR/projectm-source.sha256"
  echo "Updated $OUT_DIR/projectm-source.sha256"
else
  echo "Warning: PROJECTM_TAG=$PROJECTM_TAG is not the pinned $PROJECTM_DEFAULT_TAG;" >&2
  echo "         projectm-source.sha256 not updated. Do not commit these artifacts." >&2
fi

echo "projectM build finished."
ls -lh "$OUT_DIR" || true
