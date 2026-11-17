#!/usr/bin/env bash
# The one place WASM compile/link profiles live. Source it AFTER emsdk-env.sh:
#
#   PROJECT_ROOT="$PROJECT_ROOT" source "$SCRIPT_DIR/emsdk-env.sh"
#   source "$SCRIPT_DIR/wasm-flags.sh"
#   wasm_profile audio-callback [--debug]
#   em++ src.cpp "${WASM_FLAGS[@]}" -s EXPORTED_FUNCTIONS=... -o out.js
#
# wasm_profile NAME sets, and prints one line naming the emsdk release and profile:
#   WASM_CODEGEN_FLAGS  what changes the emitted code (-O, -std, -msimd128, -pthread,
#                       exceptions/RTTI). Standalone tools (the DSP golden) take only these.
#   WASM_LINK_FLAGS     heap, stack, ENVIRONMENT, glue shape.
#   WASM_FLAGS          both, for a one-step em++/emcc build.
# Export lists, sources and output names stay in each build script, next to the C ABI
# they mirror (audio_engine.cpp EMSCRIPTEN_KEEPALIVE, dsp_wasm_entry.cpp, ...).
#
# Profiles
#   audio-callback  the engine graph (public/sdl-audio.*): -O3 -DNDEBUG -msimd128,
#                   C++17 without exceptions/RTTI, -pthread (only to make wasmMemory a
#                   SharedArrayBuffer for the worklet's Atomics; no thread is started, so
#                   no PTHREAD_POOL_SIZE), 64 MiB -> 512 MiB growable heap, 64 KiB stack.
#   standalone-dsp  public/dsp-chain.*: the audio-callback codegen plus
#                   -fno-threadsafe-statics, STANDALONE_WASM (empty import object so the
#                   worklet instantiates the raw .wasm), 1 MiB heap, growth off, 64 KiB stack.
#                   dsp_chain.h is compiled by this profile and audio-callback only.
#   resampler       public/speex-resampler.* (C): -O3 -DNDEBUG -msimd128, 4 MiB -> 16 MiB
#                   growable heap. ENVIRONMENT keeps `node`: tests/resampler.test.ts loads
#                   the glue there.
#   projectm        public/projectm/projectm-host.*: -O2 (not on the audio callback; do not
#                   copy -O3 without measuring), WebGL2 only, 256 MiB heap cap, exceptions
#                   on because libprojectM throws on a bad preset. No SDL, no -pthread.
#
# -flto is deliberately in none of them: it is a follow-up on the pin, to be measured on
# audio-callback and standalone-dsp only, never projectm. --closure 1 breaks the
# pthread + MODULARIZE glue.
#
# --debug (audio-callback, resampler, projectm): -O0 -g ASSERTIONS SAFE_HEAP.

_wasm_mib() { echo $(( $1 * 1024 * 1024 )); }

wasm_profile() {
  local name="${1:-}" debug=0
  shift || true
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --debug) debug=1 ;;
      *) echo "wasm_profile: unknown option $1" >&2; return 1 ;;
    esac
    shift
  done

  local opt=(-O3 -DNDEBUG -msimd128)
  local debug_opt=(-O0 -g -s ASSERTIONS=1 -s SAFE_HEAP=1)
  local audio_cc=(-std=c++17 -fno-exceptions -fno-rtti)

  case "$name" in
    audio-callback)
      local initial_mib=64
      WASM_CODEGEN_FLAGS=("${opt[@]}" "${audio_cc[@]}" -pthread)
      if [[ "$debug" -eq 1 ]]; then
        WASM_CODEGEN_FLAGS=("${debug_opt[@]}" "${audio_cc[@]}" -pthread)
        initial_mib=32
      fi
      WASM_LINK_FLAGS=(
        -s WASM=1
        -s ALLOW_MEMORY_GROWTH=1
        -s INITIAL_MEMORY="$(_wasm_mib "$initial_mib")"
        -s MAXIMUM_MEMORY="$(_wasm_mib 512)"
        -s STACK_SIZE=65536
        -s MODULARIZE=1
        -s ENVIRONMENT="web,worker"
      )
      ;;
    standalone-dsp)
      [[ "$debug" -eq 0 ]] || { echo "wasm_profile: standalone-dsp has no --debug" >&2; return 1; }
      WASM_CODEGEN_FLAGS=("${opt[@]}" "${audio_cc[@]}" -fno-threadsafe-statics)
      WASM_LINK_FLAGS=(
        -s STANDALONE_WASM=1 --no-entry
        -s INITIAL_MEMORY="$(_wasm_mib 1)"
        -s ALLOW_MEMORY_GROWTH=0
        -s STACK_SIZE=65536
        -s MODULARIZE=1
        -s ENVIRONMENT="web,worker"
      )
      ;;
    resampler)
      WASM_CODEGEN_FLAGS=("${opt[@]}")
      WASM_LINK_FLAGS=(
        -s WASM=1
        -s ALLOW_MEMORY_GROWTH=1
        -s INITIAL_MEMORY="$(_wasm_mib 4)"
        -s MAXIMUM_MEMORY="$(_wasm_mib 16)"
        -s MODULARIZE=1
        -s ENVIRONMENT="web,worker,node"
      )
      [[ "$debug" -eq 0 ]] || WASM_CODEGEN_FLAGS=("${debug_opt[@]}")
      ;;
    projectm)
      WASM_CODEGEN_FLAGS=(-O2)
      WASM_LINK_FLAGS=(
        -s NO_DISABLE_EXCEPTION_CATCHING
        -s MIN_WEBGL_VERSION=2
        -s MAX_WEBGL_VERSION=2
        -s FULL_ES3=1
        -s ALLOW_MEMORY_GROWTH=1
        -s MAXIMUM_MEMORY="$(_wasm_mib 256)"
        -s MODULARIZE=1
        -s ENVIRONMENT=web
      )
      [[ "$debug" -eq 0 ]] || WASM_CODEGEN_FLAGS=("${debug_opt[@]}")
      ;;
    *)
      echo "wasm_profile: unknown profile '$name' (audio-callback|standalone-dsp|resampler|projectm)" >&2
      return 1
      ;;
  esac

  WASM_PROFILE="$name"
  WASM_FLAGS=("${WASM_CODEGEN_FLAGS[@]}" "${WASM_LINK_FLAGS[@]}")
  # Every build script prints this line, so a log shows which emsdk built what.
  echo "emsdk $(emcc -dumpversion) profile $name$([ "$debug" -eq 1 ] && echo ' (debug)'): ${WASM_CODEGEN_FLAGS[*]}"
}
