#!/usr/bin/env bash
# Source Emscripten environment. Safe to source from other scripts.
# Set EMSDK to override the search root.
#
# Every WASM artifact in public/ is built with the Emscripten release pinned in
# scripts/emsdk-version (CI installs exactly that). Different LLVM → different
# .wasm bytes even for unchanged sources, so a mismatched toolchain is an error.
# Set WASM_ALLOW_EMSDK_MISMATCH=1 for throwaway local builds only; do not
# commit artifacts built that way.
#
# Bumping the pin: edit scripts/emsdk-version, then
#   (cd emsdk && ./emsdk install <ver> && ./emsdk activate <ver>)
#   npm run build:wasm && npm run build:wasm:resampler && npm run build:projectm
# and commit the rebuilt public/ artifacts + *.sha256 in the same PR (every
# source hash covers scripts/emsdk-version, so verify:wasm fails until you do).

# Not EMSDK_*: emsdk_env.sh resets that prefix when sourced.
_emsdk_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_emsdk_pin="$(tr -d '[:space:]' < "$_emsdk_script_dir/emsdk-version")"

_emsdk_found=0
_emsdk_candidates=(
  "${EMSDK:+$EMSDK/emsdk_env.sh}"
  "${PROJECT_ROOT:+$PROJECT_ROOT/emsdk/emsdk_env.sh}"
  "./emsdk/emsdk_env.sh"
  "../emsdk/emsdk_env.sh"
  "../../emsdk/emsdk_env.sh"
  "/content/build_space/emsdk/emsdk_env.sh"
)

for _candidate in "${_emsdk_candidates[@]}"; do
  if [ -n "$_candidate" ] && [ -f "$_candidate" ]; then
    # shellcheck disable=SC1090
    source "$_candidate" >/dev/null 2>&1
    _emsdk_found=1
    break
  fi
done

if [ "$_emsdk_found" -eq 0 ]; then
  if command -v emcc >/dev/null 2>&1; then
    echo "Warning: emsdk_env.sh not found; using emcc from PATH" >&2
  else
    echo "Error: Emscripten not found. Install emsdk $_emsdk_pin (see README) or set EMSDK." >&2
    return 1 2>/dev/null || exit 1
  fi
fi

_emcc_version="$(emcc -dumpversion 2>/dev/null || true)"
if [ "$_emcc_version" != "$_emsdk_pin" ]; then
  if [ "${WASM_ALLOW_EMSDK_MISMATCH:-0}" = "1" ]; then
    echo "Warning: emcc $_emcc_version != pinned $_emsdk_pin (WASM_ALLOW_EMSDK_MISMATCH=1)." >&2
    echo "         Do not commit these artifacts." >&2
  else
    echo "Error: emcc ${_emcc_version:-<unknown>} != pinned $_emsdk_pin (scripts/emsdk-version)." >&2
    echo "  (cd emsdk && ./emsdk install $_emsdk_pin && ./emsdk activate $_emsdk_pin)" >&2
    echo "  or WASM_ALLOW_EMSDK_MISMATCH=1 for a throwaway local build." >&2
    return 1 2>/dev/null || exit 1
  fi
fi
export EMSCRIPTEN_PINNED_VERSION="$_emsdk_pin"
unset _emsdk_script_dir _emsdk_pin _emsdk_found _emsdk_candidates _candidate _emcc_version
