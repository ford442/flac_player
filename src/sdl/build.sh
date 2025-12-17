#!/bin/bash
set -e

# Directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$SCRIPT_DIR/../.."
source /content/build_space/emsdk/emsdk_env.sh

# Create a build directory
BUILD_DIR="$SCRIPT_DIR/build"
mkdir -p "$BUILD_DIR"

# Check for SDL3
SDL_DIR="$BUILD_DIR/SDL"
if [ ! -d "$SDL_DIR" ]; then
    echo "Cloning SDL3..."
    git clone https://github.com/libsdl-org/SDL.git "$SDL_DIR"
else
    echo "SDL3 already present."
fi

# Build SDL3 for Emscripten
# We assume emsdk is active in the current shell
if [ ! -f "$SDL_DIR/build_wasm/libSDL3.a" ]; then
    echo "Configuring and building SDL3..."
    cd "$SDL_DIR"

    # Configure with CMake
    # -DSDL_AUDIO=ON is default, but we ensure it.
    # We disable other subsystems to save size if possible, but SDL3 is modular.
    emcmake cmake -S . -B build_wasm \
        -DSDL_SHARED=OFF \
        -DSDL_STATIC=ON \
        -DSDL_TEST=OFF \
        -DSDL_EXAMPLES=OFF \
        -DCMAKE_BUILD_TYPE=Release

    # Build
    emmake make -C build_wasm -j$(nproc)
    cd "$SCRIPT_DIR"
else
    echo "SDL3 library already built."
fi

# Compile our engine
echo "Compiling audio_engine.cpp..."
emcc audio_engine.cpp \
    -I "$SDL_DIR/include" \
    -L "$SDL_DIR/build_wasm" -lSDL3 \
    -s WASM=1 \
    -s EXPORTED_FUNCTIONS="['_init_audio', '_set_audio_data', '_play', '_pause_audio', '_resume_audio', '_stop', '_seek', '_get_current_time', '_set_volume', '_cleanup', '_malloc', '_free']" \
    -s EXPORTED_RUNTIME_METHODS="['ccall', 'cwrap']" \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME="createSdlAudioModule" \
    -s ENVIRONMENT="web,worker" \
    -O3 \
    -o "$PROJECT_ROOT/public/sdl-audio.js"

echo "Build complete. Files output to public/sdl-audio.js and .wasm"
