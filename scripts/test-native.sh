#!/usr/bin/env bash
# Build and run tests/native/*_test.cpp with the host compiler (clang++ when
# present), -Wall -Wextra -Werror. No emsdk. Writes .build/native/compile_commands.json.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$PROJECT_ROOT/.build/native"

if [ -z "${CXX:-}" ] && command -v clang++ >/dev/null 2>&1; then
  export CXX=clang++
fi

cmake -S "$PROJECT_ROOT/tests/native" -B "$BUILD_DIR" >/dev/null
cmake --build "$BUILD_DIR" --parallel
ctest --test-dir "$BUILD_DIR" --output-on-failure
