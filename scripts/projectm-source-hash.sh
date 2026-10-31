#!/usr/bin/env bash
# SHA-256 over the projectM host WASM inputs: what we compile (host cpp), how
# (build script, which pins PROJECTM_TAG), and with which Emscripten. The
# cloned libprojectM tree is not hashed; the pinned tag stands in for it.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
(
  cd "$PROJECT_ROOT"
  sha256sum \
    scripts/build-projectm-wasm.sh \
    scripts/emsdk-version \
    src/projectm/projectm_host.cpp \
    | sort | sha256sum | awk '{print $1}'
)
