# gpu-chores (display analysis)

Last updated: August 2026

Local stub of a future shared `gpu-chores` package. **Display-only** reduce jobs over decoded PCM: scrubber peak/min-max pyramid, RMS / loudness peek, optional HUD spectrum bins.

Decoder (`@wasm-audio-decoders/flac`), playlist, projectM, and waveform **shaders** (#182) are unchanged. Sample-accurate DSP does not move onto the GPU.

## Job API

```ts
import { runChore } from '../gpu-chores';

await runChore({
  kind: 'peak_pyramid', // or 'reduce_minmax' | 'reduce_rms' | 'spectrum_bins' | 'fft_spectrum'
  pcm,                  // Float32Array (interleaved or mono)
  channels: 2,
  prefer: 'auto',
});
```

Call from UI/overview code only — **never inside an audio callback**. File overview runs on load (and after a track change). Live meters sample the `AnalyserNode` at ≤ 30 Hz.

## Spectrum kinds

| Kind | Definition | GPU path |
|------|------------|----------|
| `spectrum_bins` | Toy HUD binning: one Hann window of ≤ 2048 frames, magnitudes normalized to **their own max** (always 0–1, not comparable across calls) | CPU / Worker only |
| `fft_spectrum` | Mono mixdown → non-overlapping `fftSize` segments (default 2048, pow2 64–16384) → symmetric Hann → \|X[k]\|·2/Σw → mean over segments → linear-average into `binCount` bins. **Absolute amplitude**: a bin-centered sine of amplitude A reads ≈ A | WebGPU Stockham radix-2 (`src/gpu-chores/fft.wgsl`) |

`fft_spectrum` CPU golden: `reduceFftSpectrum` (`src/gpu-chores/fft.ts`). The WGSL `stage_main` kernel is mirrored line-for-line by `stockhamFftReference` so the algorithm is unit-tested without a GPU. Twiddles and the Hann window are f64 tables uploaded as f32 — WGSL only guarantees `cos`/`sin` to 2⁻¹¹ absolute, which alone would exceed the epsilon.

**Epsilon:** `FFT_GPU_EPSILON = 1e-4` absolute (0–1 amplitude scale), GPU vs CPU golden, per FFT line and per HUD bin. Verified on a real adapter (SwiftShader) by `tests/browser/gpuFft.test.ts` (skips when the browser exposes no WebGPU adapter).

The `auto` break-even below applies unchanged; small live windows go CPU unless the caller passes `prefer: 'webgpu'`.

**Live ShaderGUI (opt-in `?gpu_fft=1`):** `useLiveGpuSpectrum` reads the analyser's time-domain window at ≤ `METER_HZ` (30 Hz, main thread, never the audio callback), runs `fft_spectrum` with `prefer: 'webgpu'`, and compares against the CPU golden at ~1 Hz. The result is shown in the 🎛 HUD only. `AnalyserNode` still feeds the shader until the goldens are trusted. The worklet `setPCMCallback` tap is the better input source; it is left for after the shared-graph pause fix.

## Backend order (`prefer: 'auto'`)

1. **WebGPU compute** if the ShaderGUI visualizer already owns a `GPUDevice` (adopt it — **no second `requestDevice()`**)
2. **Worker TS** reduce (chunked copies so playback PCM is never transferred)
3. **Main-thread CPU** last (the golden used by unit tests)

WebGL2 compute-via-FBO is **not** used. GLSL is an **opt-in** ShaderGUI render path (`?visualizer=webgl2`); it never shares a canvas or `GPUDevice` with WebGPU. Dual-hot GL + WebGPU on the same PCM working set is avoided by never allocating a second device and by skipping the WebGPU probe on the GL canvas.

Chrome vs Edge WebGPU flakes must not take down playback: compute failures fall through to Worker/CPU. Visualizer probe failure already leaves audio running.

## Kill switch and breadcrumbs

- URL: `?no_gpu_compute` — skips WebGPU compute chores only
- Telemetry: `window.__gpuChores.last` / `.history` (`backend` + `reason`)
- ShaderGUI debug panel (🎛) shows the latest chore breadcrumb next to `window.webgpuProbe`

## Break-even (documented)

| Constant | Value | Meaning |
|----------|-------|---------|
| `GPU_BREAK_EVEN_SAMPLES` | `1_048_576` | Auto skips GPU below this (~12 s mono / ~6 s stereo @ 44.1 kHz) |
| `GPU_MAX_UPLOAD_SAMPLES` | `4_194_304` | Auto stays on Worker above this (~16 MiB f32) to cap VRAM |
| `WORKER_MIN_SAMPLES` | `262_144` | Auto uses main-thread CPU below this (<2 ms typical) |

CPU golden `reduceMinMax` of 1M samples is typically 2–8 ms. Uploading ~4 MiB to GPU plus `mapAsync` of an 8–32 KiB overview is often slower, so short clips stay on CPU/Worker.

Output is 1–4k min/max pairs for the scrubber plus a few floats for meters — never `mapAsync` of the PCM itself. Workgroups: `@workgroup_size(64)`.

## Wiring

| Piece | Role |
|-------|------|
| `src/gpu-chores/` | Types, CPU goldens, dispatcher, Worker, WebGPU reduce |
| `ConfigurableAudioBackend.getDecodedPcm()` | Zero-copy view after buffered decode (streaming native path returns `null`) |
| `useGpuChoresOverview` | Runs `peak_pyramid` after load, aborting on track change |
| `WaveformOverview` | Scrubber peaks + live RMS/peak from the analyser |

Streaming library playback has no full-file PCM, so the scrubber stays a progress strip until a buffered backend (local file / web-audio / worklet / SDL) provides a buffer.

## Tests

```bash
npm run test:gpu-chores
# also included in npm run test:unit
```

CI does not need a GPU. Goldens live in `tests/gpuChores.reduce.test.ts` and `tests/gpuChores.fft.test.ts`. The real-device FFT comparison is `tests/browser/gpuFft.test.ts` (`npm run test:streaming` runs Chromium with the SwiftShader WebGPU adapter).
