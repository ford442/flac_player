#!/usr/bin/env bash
# Deprecated wrapper — use scripts/build-wasm.sh --sdl2
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../scripts/build-wasm.sh" --sdl2 "$@"
