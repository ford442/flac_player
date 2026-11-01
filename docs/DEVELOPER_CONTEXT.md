# DEVELOPER CONTEXT

Last updated: September 2026

## 1. High-Level Architecture & Intent

*   **Core Purpose:** High-performance in-browser audio player for FLAC/WAV and library-backed streaming. Features a **four-backend audio engine** (streaming, Web Audio, AudioWorklet, SDL-free C++ WASM engine), a fail-closed WebGPU ShaderGUI, and an optional projectM Milkdrop host.
*   **Tech Stack:**
    *   **Frontend:** React 18, TypeScript, CSS3.
    *   **Build:** Webpack 5, Babel, lazy dynamic imports for WASM backends.
    *   **Audio Engines:** See [AUDIO_BACKENDS.md](./AUDIO_BACKENDS.md). Default is `StreamingAudioPlayer` (HTMLAudio + range requests).
    *   **Visualization:** WebGPU is required for ShaderGUI. `src/visuals/webgpuProbe.ts` validates the adapter, device, and canvas context; failure produces a fatal visualizer panel without blocking audio. WebGL2 is an **opt-in** fallback (`?visualizer=webgl2` / Compatibility toggle) and is never selected automatically; projectM WASM remains optional.
    *   **Backend API:** FastAPI (`server/app.py`); production at `storage.noahcohn.com`.
*   **Design Patterns:**
    *   **Strategy Pattern:** `createAudioBackend(mode)` returns a `ConfigurableAudioBackend` implementation.
    *   **Observer Pattern:** Players call `setStateChangeCallback` for UI updates.
    *   **Shared context:** `AudioContextManager` owns one `AudioContext`, EQ chain, and analyser routing.

## 2. Feature Map

| Feature | Entry point |
|---------|-------------|
| Player orchestration | `src/components/Player.tsx` |
| Playback engine + store | `src/player/PlaybackEngine.ts`, `src/player/playerStore.ts`, `src/player/selectors.ts` |
| Backend factory | `src/audio/createAudioBackend.ts` |
| Streaming (default) | `src/audio/backends/StreamingAudioPlayer.ts` |
| Buffered Web Audio | `src/audio/backends/WebAudioPlayer.ts` |
| AudioWorklet + PCM tap | `src/audio/backends/worklet/WorkletAudioPlayer.ts`, processor `src/audio/worklets/flacProcessor.ts`, SAB ring `src/audio/worklets/playRingSAB.ts` |
| WASM engine (legacy mode `sdl`) | `src/audio/backends/Sdl3AudioPlayer.ts`, `src/audio/worklets/sdlEngineProcessor.js` |
| WASM engine state and play ring | `src/sdl/engine_state.h`, `src/sdl/play_ring.h`, `src/audio/playRingBackpressure.ts` |
| Library / API client | `src/api/http.ts`, `src/api/songApi.ts`, `src/api/library.ts` (TanStack Query) |
| Offline cache | `src/storage/trackCache.ts`, `src/components/OfflineCache.tsx` |
| Queue persistence | `src/storage/queueStorage.ts` |
| Playlist share (static) | `src/api/songApi.ts` (`createShare`, `fetchSharedPlaylist`) |
| Listening rooms (planned) | [LISTENING_ROOMS.md](./LISTENING_ROOMS.md) — `useListeningRoom`, `/room/{id}` |
| EQ / crossfade settings | `src/audio/EQChain.ts`, `src/hooks/useAudioSettings.ts` |
| Visualizer shell | `src/components/VisualizerShell.tsx` |
| ShaderGUI | `src/components/ShaderGUI/ShaderGUI.tsx` |
| gpu-chores (peaks / RMS) | `src/gpu-chores/`, `src/hooks/useGpuChoresOverview.ts` |
| projectM host | `src/components/ProjectMHost.tsx`, `src/projectm/ProjectMEngine.ts` |
| Renderer selection | `src/visuals/rendererSelection.ts` |

## 3. Complexity Hotspots

*   **WASM memory interop (`Sdl3AudioPlayer.ts` under `src/audio/backends/`):**
    *   Manual `malloc`, shared-memory views, and channel interleaving. `heapF32()` refreshes its view after WASM memory growth.
    *   The WASM heap is capped at 512 MiB. Streaming uses `play_ring.h`; buffered `_create_audio_buffer` rejects more than 384 MiB of f32 PCM.
    *   **Toolchain pin:** every WASM artifact is built with the emsdk in `scripts/emsdk-version` (`scripts/emsdk-env.sh` refuses another emcc). The C++ engine uses `-fno-exceptions -fno-rtti`; allocation failure is returned to JavaScript instead of aborting.
    *   **Other WASM heaps:** SpeexDSP resampler: 4 MiB initial, **16 MiB `MAXIMUM_MEMORY`**, `-msimd128`, no pthread; `resampler.ts` feeds `rs_process` in ~1 MiB slices so whole-file conversion never stages the file in the heap, and `rs_create` rejects > 8 channels (→ linear fallback). projectM host: default 16 MiB initial, **256 MiB `MAXIMUM_MEMORY`** (measured: stays at 16 MiB rendering at 4K with preset switching), no SDL (WebGL2 context via `emscripten_webgl_create_context`), exception catching on (libprojectM throws on bad presets), WebGL2-only (`FULL_ES3`, which implies `FULL_ES2`), `-O2`, no pthread; hashed in `public/projectm/projectm-source.sha256`.
    *   **Keep `-pthread`:** it enables the shared WASM memory used by the main-thread producer and AudioWorklet consumer. The audio callback is not part of this engine.
*   **WASM engine → AudioWorklet (`sdlEngineProcessor.js`):**
    *   The processor reads the play ring and feeds the shared Web Audio graph; speaker DSP and the analysis tap run in the `dsp-chain` worklet.
    *   Decoder high-water: pause JS decode when play-ring fill &gt; 75% (`src/audio/playRingBackpressure.ts`).
*   **Cross-origin isolation (`webpack.config.js`, hosting headers):**
    *   COOP/COEP is required for SharedArrayBuffer and the `sdl` WASM engine; other AudioWorklet paths can fall back to message transport. Per-host header blocks: `docs/DEPLOYMENT.md`.
*   **WebGPU lifecycle (`src/visuals/webgpuVisualizer.ts`):**
    *   `GpuDeviceService` (`src/visuals/webgpu/deviceService.ts`) requests the adapter (compatibility-mode retry; fallback adapters refused unless `?webgpu=fallback-ok`) and device **once** per session and lends it to `WebGPUVisualizer` and gpu-chores. Borrowers never destroy it; only `device.lost` drops it (`deviceLostRecovery.ts`). A new analyser reaches the live visualizer through `setAnalyser()`, so sample-rate or graph changes keep the device. `window.webgpuProbe.deviceRequests` counts requests.
    *   gpu-chores **adopts** that same device for peak/RMS compute and never calls `requestDevice()`. Kill switch: `?no_gpu_compute`.
    *   Manual resource cleanup in `destroy()`; 60 fps rAF loop. Probe/init/device-loss failures remain local to the GPU surface.
*   **ShaderGUI layout contract (`src/visuals/waveformContract.ts`):**
    *   Knob/LED glow UVs, palette colors, and intensity scales live in `WAVEFORM_LAYOUT`.
    *   Both WGSL (`src/shaders/waveform.wgsl`, injected by `waveform.ts`) and GLSL (`src/visuals/webgl2/shaders/waveform.ts`) inject these constants — change positions in **one** place.
    *   `Alt+D` debug modes (`uv`, `waveform-only`, `audio-bins`, `spectrum`) remain available for the active WebGPU or WebGL2 shader.
    *   Guard: `npm run test:visualizer` asserts layout injection parity + debug mode helpers.

## 4. Inherent Limitations & "Here be Dragons"

*   **Streaming vs buffered:** Streaming cannot load raw ArrayBuffers; buffered backends cannot crossfade. Mode switch resets playback.
*   **Test coverage:** Playwright smoke tests plus a real decode→playback→analyser integration harness (`tests/browser/audioPipeline.test.ts`, shipped via [#196](https://github.com/ford442/flac_player/issues/196)).
*   **Deploy credentials:** `scripts/deploy.py` contains environment-specific SFTP config.
*   **HTTPS + isolation:** App requires secure context with COOP/COEP for worklet/SDL/projectM paths.
*   **WebGPU fail-closed default:** ShaderGUI probes WebGPU unless the user opts into WebGL2 (`?visualizer=webgl2` or Settings → Compatibility visualizer). Failed probes do not auto-start GL. Canvas2D is `DEBUG_VISUALIZER=canvas2d` only. Inspect `window.webgpuProbe` for reason, `powerPreference`, `requestedFeatures`, browser brand, and adapter data; audio playback is independent.

## 5. Key Flows

**Load and play (streaming — default)**

1. User selects track → `useActions().playTrack` → `PlaybackEngine.load(track)` (URL already resolved by `resolveTrackUrl`).
2. Backend built once per mode by `createAudioBackend('streaming')` → `StreamingAudioPlayer.loadFromURL(url)`.
3. `<audio src>` + `MediaElementAudioSourceNode` → `AudioContextManager` → EQ → analyser → visualizer.
4. Optional: `preloadNextTrack` + crossfade 3 s before track end.

**Load and play (worklet — projectM PCM)**

1. `fetch` → decode → `AudioWorkletPlayer` ring buffer (SharedArrayBuffer under COOP/COEP, `chunk` messages otherwise).
2. `createProjectMPCMFeed(player)` wires `setPCMCallback` → `projectMBridge` → in-app `ProjectMHost` or external embed.

**Library fetch**

1. `songApi.fetchSongs()` → `GET /api/songs` on `REACT_APP_API_URL` (default `storage.noahcohn.com`).
2. Every page is synced into the IndexedDB catalog (`src/catalog/`); the library view reads from it. Each item includes absolute `https://` `url`.

## 6. Debug logging

Set `REACT_APP_DEBUG=true` in `.env`. Central helper: `src/utils/debug.ts` (used by `api/http.ts`, `api/songApi.ts`). **Off by default** in production builds.

## 7. Related docs

- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [AUDIO_BACKENDS.md](./AUDIO_BACKENDS.md)
- [ROADMAP.md](./ROADMAP.md)

## 8. Audio pipeline test fixtures and commands

Audio fixtures under `tests/fixtures/` must be synthetic, original, or otherwise
clearly licensed for repository use. Keep them short and small so pull-request
tests remain fast. Fixture sample rate and channel layout are part of the test
contract: prefer 44.1 kHz stereo and do not change either without updating the
assertions and documenting why a different layout is needed. Analyser fixtures
must contain intentional, non-silent signal; silence cannot prove graph routing.

ReplayGain fixtures must retain explicit track and album metadata. In particular,
`replaygain-loud.flac` is expected to expose `REPLAYGAIN_TRACK_GAIN=-6.5 dB` plus
album gain and peak metadata. The deterministic graph test parses those real tags,
applies the same application helper used by playback, and records the resulting
gain and limiter node settings.

Run the audio validation layers with:

```bash
npm run test:decoder    # committed FLAC bytes through the WASM decoder
npm run test:unit       # deterministic jsdom graph, scheduling, and helper tests
npm run test:streaming  # native Web Audio and AudioWorklet in headless Chromium
```

The browser-audio suite uses Vitest's own local server and imports
`createAudioBackend()` directly. It does not require the remote API, a local
FastAPI process, physical speakers, WebGPU, or the React application UI.
Chromium is authoritative for the native Web Audio graph, AudioWorklet execution,
and analyser DSP; jsdom is used only for deterministic graph and scheduling
assertions.
