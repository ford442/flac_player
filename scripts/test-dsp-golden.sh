#!/usr/bin/env bash
# Scalar-vs-SIMD speaker DSP golden + analysis ring / FFT golden, built with the
# pinned emsdk and run under node (tests/native/*_golden.cpp).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$PROJECT_ROOT/.build"

PROJECT_ROOT="$PROJECT_ROOT" source "$SCRIPT_DIR/emsdk-env.sh"

mkdir -p "$OUT"
for name in dsp_simd_golden analysis_golden; do
  em++ -std=c++17 -O2 -msimd128 "$PROJECT_ROOT/tests/native/$name.cpp" -o "$OUT/$name.js"
  node "$OUT/$name.js"
done
