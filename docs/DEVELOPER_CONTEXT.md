# DEVELOPER CONTEXT

Last updated: August 2026

## 1. High-Level Architecture & Intent

*   **Core Purpose:** High-performance in-browser audio player for FLAC/WAV and library-backed streaming. Features a **five-backend audio engine** (streaming, Web Audio, AudioWorklet, SDL3 WASM, SDL2 WASM), a fail-closed WebGPU ShaderGUI, and an optional projectM Milkdrop host.
*   **Tech Stack:**
    *   **Frontend:** React 18, TypeScript, CSS3.
    *   **Build:** Webpack 5, Babel, lazy dynamic imports for WASM backends.
    *   **Audio Engines:** See [AUDIO_BACKENDS.md](./AUDIO_BACKENDS.md). Default is `StreamingAudioPlayer` (HTMLAudio + range requests).
    *   **Visualization:** WebGPU is required for ShaderGUI. `src/visuals/webgpuProbe.ts` validates the adapter, device, and canvas context; failure produces a fatal visualizer panel without blocking audio. WebGL2/Canvas2D fallback is disabled pending a later issue; projectM WASM remains optional.
    *   **Backend API:** FastAPI (`app.py`); production at `storage.noahcohn.com`.
*   **Design Patterns:**
    *   **Strategy Pattern:** `createAudioBackend(mode)` returns a `ConfigurableAudioBackend` implementation.
    *   **Observer Pattern:** Players call `setStateChangeCallback` for UI updates.
    *   **Shared context:** `AudioContextManager` owns one `AudioContext`, EQ chain, and analyser routing.

## 2. Feature Map

| Feature | Entry point |
|---------|-------------|
| Player orchestration | `src/components/Player.tsx` |
| Playback controller | `src/hooks/usePlaybackController.ts` |
| Backend factory | `src/audio/createAudioBackend.ts` |
| Streaming (default) | `src/audio/backends/StreamingAudioPlayer.ts` |
| Buffered Web Audio | `src/audio/backends/WebAudioPlayer.ts` |
| AudioWorklet + PCM tap | `src/audio/backends/WorkletAudioPlayer.ts` |
| SDL3 / SDL2 WASM | `src/audio/backends/Sdl3AudioPlayer.ts`, `Sdl2AudioPlayer.ts` |
| SDL → analyser bridge | `src/audio/SdlPcmBridge.ts`, `src/sdl/pcm_ring.h` |
| Library / API client | `src/api/songApi.ts`, `src/audioLoader.ts` |
| Offline cache | `src/storage/trackCache.ts`, `src/components/OfflineCache.tsx` |
| Queue persistence | `src/storage/queueStorage.ts` |
| Playlist share (static) | `src/api/songApi.ts` (`createShare`, `fetchSharedPlaylist`) |
| Listening rooms (planned) | [LISTENING_ROOMS.md](./LISTENING_ROOMS.md) — `useListeningRoom`, `/room/{id}` |
| EQ / crossfade settings | `src/audio/EQChain.ts`, `src/hooks/useAudioSettings.ts` |
| Visualizer shell | `src/components/VisualizerShell.tsx` |
| ShaderGUI | `src/components/ShaderGUI/ShaderGUI.tsx` |
| projectM host | `src/components/ProjectMHost.tsx`, `src/projectm/ProjectMEngine.ts` |
| Renderer selection | `src/visuals/rendererSelection.ts` |

## 3. Complexity Hotspots

*   **WASM memory interop (`Sdl3AudioPlayer.ts`, `Sdl2AudioPlayer.ts` under `src/audio/backends/`):**
    *   Manual `malloc`, HEAP views, channel interleaving. PTHREADS builds expose memory differently (`wasmMemory.buffer` vs `HEAPU8.buffer`).
*   **SDL PCM ring → AudioWorklet (`SdlPcmBridge.ts`):**
    *   C++ ring buffer written in the SDL audio callback; JS worklet reads and feeds `AnalyserNode`. Required for visualization when SDL owns speaker output.
*   **Cross-origin isolation (`webpack.config.js`, hosting headers):**
    *   COOP/COEP required for AudioWorklet, SharedArrayBuffer, SDL pthreads, projectM WASM.
*   **WebGPU lifecycle (`webgpuVisualizer.ts`):**
    *   `webgpuProbe.ts` acquires the exact adapter/device/context consumed by `WebGPUVisualizer`; the visualizer must not request a second device.
    *   Manual resource cleanup in `destroy()`; 60 fps rAF loop. Probe/init/device-loss failures remain local to the GPU surface.
*   **ShaderGUI layout contract (`src/visuals/waveformContract.ts`):**
    *   Knob/LED glow UVs, palette colors, and intensity scales live in `WAVEFORM_LAYOUT`.
    *   Both WGSL (`src/shaders/waveform.ts`) and GLSL (`src/visuals/webgl2/shaders/waveform.ts`) inject these constants — change positions in **one** place.
    *   `Alt+D` debug modes (`uv`, `waveform-only`, `audio-bins`, `spectrum`) remain available for the active WebGPU shader. GLSL parity code is dormant while fallback is disabled.
    *   Guard: `npm run test:visualizer` asserts layout injection parity + debug mode helpers.

## 4. Inherent Limitations & "Here be Dragons"

*   **Streaming vs buffered:** Streaming cannot load raw ArrayBuffers; buffered backends cannot crossfade. Mode switch resets playback.
*   **Test coverage:** Playwright smoke tests exist; no full audio pipeline integration suite yet ([#172](https://github.com/ford442/flac_player/issues/172)).
*   **Deploy credentials:** `deploy.py` contains environment-specific SFTP config.
*   **HTTPS + isolation:** App requires secure context with COOP/COEP for worklet/SDL/projectM paths.
*   **WebGPU fail-closed phase:** ShaderGUI never creates WebGL2 or Canvas2D after a failed probe. Legacy `?visualizer=`, local-storage, and `DEBUG_VISUALIZER` GL/2D preferences are diagnostic breadcrumbs only. Inspect `window.webgpuProbe` for reason, browser brand, and adapter data; audio playback is independent.

## 5. Key Flows

**Load and play (streaming — default)**

1. User selects track → `Player.tsx` → `audioLoader` resolves URL from API.
2. `createAudioBackend('streaming')` → `StreamingAudioPlayer.loadFromURL(url)`.
3. `<audio src>` + `MediaElementAudioSourceNode` → `AudioContextManager` → EQ → analyser → visualizer.
4. Optional: `preloadNextTrack` + crossfade 3 s before track end.

**Load and play (worklet — projectM PCM)**

1. `fetch` → decode → `AudioWorkletPlayer` ring buffer.
2. `createProjectMPCMFeed(player)` wires `setPCMCallback` → `projectMBridge` → in-app `ProjectMHost` or external embed.

**Library fetch**

1. `songApi.fetchSongs()` → `GET /api/songs` on `REACT_APP_API_URL` (default `storage.noahcohn.com`).
2. Response cached in `libraryCache.ts` (TTL). Each item includes absolute `https://` `url`.

## 6. Debug logging

Set `REACT_APP_DEBUG=true` in `.env`. Central helper: `src/utils/debug.ts` (used by `audioLoader.ts`, `api/songApi.ts`). **Off by default** in production builds.

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
