#!/usr/bin/env bash
# Scalar-vs-SIMD speaker DSP golden + FFT golden, built with the
# pinned emsdk and profile and run under node (tests/native/*_golden.cpp).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$PROJECT_ROOT/.build"

PROJECT_ROOT="$PROJECT_ROOT" source "$SCRIPT_DIR/emsdk-env.sh"
source "$SCRIPT_DIR/wasm-flags.sh"
# The goldens run the exact codegen dsp-chain.wasm ships with (the standalone-dsp
# profile), not a separate -O2 build; only the link (a node executable) differs.
wasm_profile standalone-dsp

mkdir -p "$OUT"
for name in dsp_simd_golden analysis_golden; do
  em++ "${WASM_CODEGEN_FLAGS[@]}" -s ENVIRONMENT=node "$PROJECT_ROOT/tests/native/$name.cpp" -o "$OUT/$name.js"
  node "$OUT/$name.js"
done
