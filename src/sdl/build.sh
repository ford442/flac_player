#!/usr/bin/env bash
set -euo pipefail

# Directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$SCRIPT_DIR/../.."
BUILD_DIR="$SCRIPT_DIR/build"
SDL_DIR="${SDL_DIR:-$BUILD_DIR/SDL}"
OUT_DIR="$PROJECT_ROOT/public"
OUT_JS="$OUT_DIR/sdl-audio.js"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"

mkdir -p "$BUILD_DIR" "$OUT_DIR"

# Try to ensure Emscripten is available. Prefer emcc in PATH; otherwise try common EMSDK locations.
if command -v emcc >/dev/null 2>&1; then
  echo "Found emcc in PATH: $(command -v emcc)"
else
  if [ -n "${EMSDK:-}" ] && [ -f "$EMSDK/emsdk_env.sh" ]; then
    echo "Sourcing EMSDK from $EMSDK/emsdk_env.sh"
    # shellcheck disable=SC1090
    source "$EMSDK/emsdk_env.sh"
  elif [ -f "$HOME/emsdk/emsdk_env.sh" ]; then
    echo "Sourcing EMSDK from $HOME/emsdk/emsdk_env.sh"
    # shellcheck disable=SC1090
    source "$HOME/emsdk/emsdk_env.sh"
  elif [ -f "/content/build_space/emsdk/emsdk_env.sh" ]; then
    echo "Sourcing EMSDK from /content/build_space/emsdk/emsdk_env.sh"
    # shellcheck disable=SC1090
    source "/content/build_space/emsdk/emsdk_env.sh"
  else
    echo "Error: Emscripten (emcc) not found in PATH and no EMSDK env script detected." >&2
    echo "Please install Emscripten and activate it (see https://emscripten.org/docs/getting_started/downloads.html)" >&2
    exit 1
  fi
fi

# Re-check
if ! command -v emcc >/dev/null 2>&1; then
  echo "Error: emcc still not available after sourcing EMSDK." >&2
  exit 1
fi

# Check for other required tools
for tool in git cmake emcmake emmake; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Error: required tool '$tool' not found in PATH. Please install it or activate EMSDK." >&2
    exit 1
  fi
done

# Clone SDL3 if necessary
if [ ! -d "$SDL_DIR" ]; then
  echo "Cloning SDL3 into $SDL_DIR..."
  git clone --depth 1 https://github.com/libsdl-org/SDL.git "$SDL_DIR" || {
    echo "Error: git clone of SDL failed. If network is restricted, provide SDL source at $SDL_DIR" >&2
    exit 1
  }
else
  echo "SDL3 already present at $SDL_DIR"
fi

# Build SDL3 for Emscripten if not already built
if [ ! -f "$SDL_DIR/build_wasm/libSDL3.a" ]; then
  echo "Configuring and building SDL3 (this may take a while)..."
  pushd "$SDL_DIR" >/dev/null
  emcmake cmake -S . -B build_wasm \
    -DSDL_SHARED=OFF -DSDL_STATIC=ON -DSDL_TEST=OFF -DSDL_EXAMPLES=OFF -DCMAKE_BUILD_TYPE=Release
  emmake make -C build_wasm -j"$JOBS"
  popd >/dev/null
else
  echo "SDL3 appears already built (libSDL3.a present)."
fi

# Compile our engine
echo "Compiling audio_engine.cpp -> $OUT_JS"
# Use full path to source file
SRC_CPP="$SCRIPT_DIR/audio_engine.cpp"
if [ ! -f "$SRC_CPP" ]; then
  echo "Error: source file $SRC_CPP not found." >&2
  exit 1
fi
# Verify SDL headers and library exist before compiling
if [ ! -f "$SDL_DIR/include/SDL3/SDL.h" ]; then
  echo "Error: SDL headers not found in $SDL_DIR/include (expected $SDL_DIR/include/SDL3/SDL.h)." >&2
  echo "If you haven't run the SDL build step, run this script again to clone and build SDL, or set SDL_DIR to a prebuilt SDL path." >&2
  echo "Example: SDL_DIR=/path/to/local/SDL bash src/sdl/build.sh" >&2
  exit 1
fi

if [ ! -f "$SDL_DIR/build_wasm/libSDL3.a" ]; then
  echo "Error: SDL static library not found at $SDL_DIR/build_wasm/libSDL3.a." >&2
  echo "Try rebuilding SDL with emcmake/emmake (the script will do this) or set SDL_DIR to a prebuilt SDL with a build_wasm/libSDL3.a present." >&2
  exit 1
fi

echo "Compiling audio_engine.cpp -> $OUT_JS"
emcc "$SRC_CPP" \
  -I "$SDL_DIR/include" \
  -L "$SDL_DIR/build_wasm" -lSDL3 \
  -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_init_audio","_set_audio_data","_play","_pause_audio","_resume_audio","_stop","_seek","_get_current_time","_set_volume","_cleanup","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap"]' \
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

echo "Build finished successfully. Output files:"
ls -lh "$OUT_DIR" | grep sdl-audio || true

echo "Tip: Run 'npm run build:wasm' before producing production assets to ensure sdl-audio.* are present."
