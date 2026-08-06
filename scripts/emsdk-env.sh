#!/usr/bin/env bash
# Source Emscripten environment. Safe to source from other scripts.
# Set EMSDK to override the search root.

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
    source "$_candidate"
    return 0 2>/dev/null || exit 0
  fi
done

if command -v em++ >/dev/null 2>&1 || command -v emcc >/dev/null 2>&1; then
  echo "Warning: emsdk_env.sh not found; using em++ from PATH" >&2
  return 0 2>/dev/null || exit 0
fi

echo "Error: Emscripten not found. Install emsdk (see README) or set EMSDK." >&2
return 1 2>/dev/null || exit 1
