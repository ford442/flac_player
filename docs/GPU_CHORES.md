# gpu-chores (display analysis)

Last updated: August 2026

Local stub of a future shared `gpu-chores` package. **Display-only** reduce jobs over decoded PCM: scrubber peak/min-max pyramid, RMS / loudness peek, optional HUD spectrum bins.

Decoder (`@wasm-audio-decoders/flac`), playlist, projectM, and waveform **shaders** (#182) are unchanged. Sample-accurate DSP does not move onto the GPU.

## Job API

```ts
import { runChore } from '../gpu-chores';

await runChore({
  kind: 'peak_pyramid', // or 'reduce_minmax' | 'reduce_rms' | 'spectrum_bins'
  pcm,                  // Float32Array (interleaved or mono)
  channels: 2,
  prefer: 'auto',
});
```

Call from UI/overview code only — **never inside an audio callback**. File overview runs on load (and after a track change). Live meters sample the `AnalyserNode` at ≤ 30 Hz.

## Backend order (`prefer: 'auto'`)

1. **WebGPU compute** if the ShaderGUI visualizer already owns a `GPUDevice` (adopt it — **no second `requestDevice()`**)
2. **Worker TS** reduce (chunked copies so playback PCM is never transferred)
3. **Main-thread CPU** last (the golden used by unit tests)

WebGL2 compute-via-FBO is **not** used. GLSL remains a render fallback only (when/if #182 restore it). Dual-hot GL + WebGPU on the same PCM working set is avoided by never allocating a second device.

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

CI does not need a GPU. Goldens live in `tests/gpuChores.reduce.test.ts`.
