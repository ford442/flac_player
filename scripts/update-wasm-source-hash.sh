#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HASH_FILE="$PROJECT_ROOT/public/wasm-source.sha256"

hash="$("$SCRIPT_DIR/wasm-source-hash.sh")"
printf '%s\n' "$hash" > "$HASH_FILE"
echo "Updated $HASH_FILE -> $hash"
