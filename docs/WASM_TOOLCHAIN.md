# WASM toolchain and compile commands

Every `public/*.wasm` is committed and rebuilt only by `npm run build:wasm*` /
`npm run build:projectm`. Those scripts compile with one pinned Emscripten
release, so an unchanged source tree rebuilds byte-identically and CI's
`wasm-build` job can diff the bytes.

## Pinned Emscripten

`scripts/emsdk-version`: **6.0.11**

```
emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.11 (a0014542110d6078c3a1a7941fa1ddb3a2281f16)
clang version 24.0.0git (https:/github.com/llvm/llvm-project f718ebe873411a562ef6e5c27da36d75b7aaec98)
Target: wasm32-unknown-emscripten
Thread model: posix
```

6.0.11 is the release that produced the committed `sdl-audio.wasm` and
`dsp-chain.wasm` (#249). Rebuilding both with it reproduces the committed files
byte for byte; 6.0.9 does not (`dsp-chain.wasm` differs at byte 112). Before the
pin, CI ran `emsdk install latest`, so a comment-only C++ change could fail the
artifact diff because LLVM moved.

### Install

```bash
git clone https://github.com/emscripten-core/emsdk.git   # in the repo root; ./emsdk is gitignored
cd emsdk && ./emsdk install 6.0.11 && ./emsdk activate 6.0.11
```

`scripts/emsdk-env.sh` (sourced by every build script) looks in `$EMSDK`,
`$PROJECT_ROOT/emsdk`, `./emsdk`, `../emsdk`, `../../emsdk` and uses the first
whose release is the pin, so a stale global `$EMSDK` does not shadow `./emsdk`.
It refuses to build when:

- no candidate (or `emcc` on `PATH`) is the pinned release, or
- `EMSDK_VERSION` is set to anything but the pin (CI exports it from the pin file).

`WASM_ALLOW_EMSDK_MISMATCH=1` builds with whatever `emcc` it finds, for throwaway
experiments only. Do not commit artifacts built that way.

### Bumping the pin

1. Edit `scripts/emsdk-version`; install and activate the new release.
2. Rebuild every graph: `npm run build:wasm && npm run build:wasm:dsp && npm run build:wasm:resampler && npm run build:projectm`.
3. Commit all rebuilt `public/` artifacts and `*.sha256` files, and update the
   `emcc -v` block above and in `.github/workflows/ci.yml`.

Every source hash includes `scripts/emsdk-version`, so `npm run verify:wasm`
fails until step 3 is done. Never bump the pin in the same PR as `-flto`.

## Compile commands

| Graph | Script | Output | Optimization | Heap |
|---|---|---|---|---|
| SDL playback (the template) | `scripts/build-wasm.sh` | `public/sdl-audio.*` | `-O3 -DNDEBUG -msimd128` | 64 MiB initial, growth, **512 MiB max** |
| Speaker DSP + FFT golden | `scripts/build-dsp-wasm.sh` | `public/dsp-chain.*` | `-O3 -DNDEBUG -msimd128` | 1 MiB fixed (`STANDALONE_WASM`, no growth) |
| SpeexDSP resampler | `scripts/build-resampler-wasm.sh` | `public/speex-resampler.*` | `-O3 -DNDEBUG` | 4 MiB initial, growth, **32 MiB max** |
| projectM host | `scripts/build-projectm-wasm.sh` | `public/projectm/projectm-host.*` | `-O2` | 16 MiB initial (default), growth, **256 MiB max** |

Why every growable heap has a `MAXIMUM_MEMORY`: without one, Emscripten lets
growth reach 2 GiB (and with `-pthread` reserves a 2 GiB SharedArrayBuffer
maximum). #212 fixed that for playback; the resampler and projectM had the same
footgun until #268.

- **SDL playback.** `-pthread` makes `wasmMemory` a SharedArrayBuffer so the
  play ring can be read with `Atomics`; it does not move audio off the main
  thread (see `docs/AUDIO_BACKENDS.md`). Keep `-msimd128`: `dsp_chain.h` /
  `dsp_fft.h` must compile to the same lanes here and in `dsp-chain.wasm`.
- **DSP chain.** Same headers as SDL, same `-msimd128`. `npm run test:dsp-golden`
  checks scalar vs SIMD bit-identity and runs in `wasm-build` whenever the
  headers or `tests/native/` change.
- **Resampler.** `src/audio/resampler.ts` stages at most 16384 frames
  (512 KiB at 8 ch) each way per `rs_process` slice, so a whole buffered track
  resamples inside the 32 MiB cap (`tests/resampler.test.ts` resamples 42 MB of
  8-channel input with the capped module).
- **projectM.** `USE_SDL=2` video host, WebGL2, `FULL_ES2` only: `FULL_ES3`
  implies `FULL_ES2` and only adds emulation for `glMapBufferRange`,
  `glGetBufferSubData` and client-side u32 indices, none of which libprojectM
  v4.1.6 calls (it draws from VAOs/VBOs). Measured heap with the bundled presets:
  16.4 MiB, flat across PCM input and hard-cut preset changes
  (`tests/browser/projectmHeap.test.ts`, which also checks that growing past
  256 MiB is refused). `-O2`, not `-O3`, until someone measures size and frame
  time. `public/projectm/projectm-source.sha256` covers the host source, the
  build script (which pins `PROJECTM_TAG`) and the emsdk pin.

Kept off until a follow-up, after the pin is confirmed byte-stable:

- `-flto`: LTO codegen is not reproducible across LLVM releases.
- `--closure 1`: breaks the pthread + `MODULARIZE` glue.

## CI

`.github/workflows/ci.yml`:

- `lint-and-build` runs `npm run verify:wasm` (source hashes, including the pin).
- `wasm-build` (pull requests) rebuilds each graph whose inputs changed (a
  change to `scripts/emsdk-env.sh` or the pin rebuilds SDL, DSP and the
  resampler; projectM rebuilds on its own inputs or a pin bump), runs
  `npm run test:dsp-golden` for DSP changes, and fails if any committed artifact
  differs.
