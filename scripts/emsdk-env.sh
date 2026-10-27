#!/usr/bin/env bash
# Source Emscripten for the WASM build scripts. Safe to source from other scripts.
#
# Every public/*.wasm is built with the Emscripten release pinned in
# scripts/emsdk-version; CI installs exactly that, and docs/WASM_TOOLCHAIN.md
# records its `emcc -v`. A different LLVM emits different bytes from unchanged
# sources, so a build with any other emcc is refused.
#
# EMSDK_VERSION, when set, must equal the pin (CI exports it from the pin file).
# Candidates are tried in order ($EMSDK, $PROJECT_ROOT/emsdk, ./emsdk, ../emsdk,
# ../../emsdk, then emcc on PATH); the first holding the pinned release wins, so a
# stale global $EMSDK does not shadow a repo-local ./emsdk.
#
# WASM_ALLOW_EMSDK_MISMATCH=1 builds with whatever emcc is found, for throwaway
# local experiments only. Do not commit artifacts built that way.
#
# Bumping the pin: edit scripts/emsdk-version, then
#   (cd emsdk && ./emsdk install <ver> && ./emsdk activate <ver>)
#   npm run build:wasm && npm run build:wasm:dsp && npm run build:wasm:resampler && npm run build:projectm
# and commit every rebuilt public/ artifact and *.sha256 in the same PR (each
# source hash covers scripts/emsdk-version, so verify:wasm fails until you do).

# Not EMSDK_*: emsdk_env.sh owns that prefix.
_wasm_pin="$(tr -d '[:space:]' < "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/emsdk-version")"
_wasm_requested="${EMSDK_VERSION:-}"

_wasm_refuse() {
  echo "Error: $1" >&2
  echo "  (cd emsdk && ./emsdk install $_wasm_pin && ./emsdk activate $_wasm_pin), or set EMSDK to that install." >&2
  echo "  WASM_ALLOW_EMSDK_MISMATCH=1 for a throwaway local build (do not commit its artifacts)." >&2
}

if [ -n "$_wasm_requested" ] && [ "$_wasm_requested" != "$_wasm_pin" ]; then
  echo "Error: EMSDK_VERSION=$_wasm_requested but scripts/emsdk-version pins $_wasm_pin." >&2
  echo "  Bump the pin file (and rebuild every artifact) instead of overriding it." >&2
  unset _wasm_pin _wasm_requested
  return 1 2>/dev/null || exit 1
fi

# emscripten-version.txt holds the release as a quoted string, e.g. "6.0.11".
_wasm_sdk_version() {
  tr -d '"[:space:]' < "$1/upstream/emscripten/emscripten-version.txt" 2>/dev/null
}

_wasm_env=""
_wasm_fallback=""
for _wasm_dir in "${EMSDK:-}" "${PROJECT_ROOT:+$PROJECT_ROOT/emsdk}" ./emsdk ../emsdk ../../emsdk; do
  [ -n "$_wasm_dir" ] && [ -f "$_wasm_dir/emsdk_env.sh" ] || continue
  [ -z "$_wasm_fallback" ] && _wasm_fallback="$_wasm_dir/emsdk_env.sh"
  if [ "$(_wasm_sdk_version "$_wasm_dir")" = "$_wasm_pin" ]; then
    _wasm_env="$_wasm_dir/emsdk_env.sh"
    break
  fi
done
[ -z "$_wasm_env" ] && [ "${WASM_ALLOW_EMSDK_MISMATCH:-0}" = "1" ] && _wasm_env="$_wasm_fallback"

if [ -n "$_wasm_env" ]; then
  # shellcheck disable=SC1090
  source "$_wasm_env" >/dev/null 2>&1
elif ! command -v emcc >/dev/null 2>&1; then
  _wasm_refuse "Emscripten not found; scripts/emsdk-version pins $_wasm_pin."
  unset _wasm_pin _wasm_requested _wasm_env _wasm_fallback _wasm_dir
  unset -f _wasm_refuse _wasm_sdk_version
  return 1 2>/dev/null || exit 1
fi

_wasm_emcc="$(emcc -dumpversion 2>/dev/null || true)"
if [ "$_wasm_emcc" != "$_wasm_pin" ]; then
  if [ "${WASM_ALLOW_EMSDK_MISMATCH:-0}" = "1" ]; then
    echo "Warning: emcc ${_wasm_emcc:-<unknown>} != pinned $_wasm_pin (WASM_ALLOW_EMSDK_MISMATCH=1)." >&2
    echo "         Do not commit these artifacts." >&2
    _wasm_pin=""
  else
    _wasm_refuse "emcc ${_wasm_emcc:-<unknown>} != pinned $_wasm_pin (scripts/emsdk-version)."
    unset _wasm_pin _wasm_requested _wasm_env _wasm_fallback _wasm_dir _wasm_emcc
    unset -f _wasm_refuse _wasm_sdk_version
    return 1 2>/dev/null || exit 1
  fi
fi
# Downstream scripts and logs see the release they built with.
[ -n "$_wasm_pin" ] && export EMSDK_VERSION="$_wasm_pin"
unset _wasm_pin _wasm_requested _wasm_env _wasm_fallback _wasm_dir _wasm_emcc
unset -f _wasm_refuse _wasm_sdk_version
