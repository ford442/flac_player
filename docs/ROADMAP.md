# Roadmap

Planning cycle: September 2026 (post-audit after #193–#202 foundation closure).

Earlier issues (#166–#185, then #193–#202) shipped the product surface and the audio/visual foundation: unified backends under `src/audio/backends/`, `usePlaybackController`, native-rate `AudioContext`, SDL3 ring-fed streaming, gpu-chores, and fail-closed WebGPU. The decode→playback harness (#196) and listening-rooms **design** (#197, formerly #185) are closed; rooms implementation lives on **#209**.

**Do foundation work before large features.** Do not start listening rooms (#209) until the WASM/C++ and AudioContext leftovers below land. Media Session (#208) is the better near-term product adapter after that.

| Issue | Title | Priority |
|-------|-------|----------|
| [#193](https://github.com/ford442/flac_player/issues/193) | Foundation: Relocate backends under `src/audio/backends/` + extract `PlaybackController` | **Done** |
| [#194](https://github.com/ford442/flac_player/issues/194) | Audio: Native sample-rate `AudioContext`, latency modes, recreate policy | **Done** |
| [#195](https://github.com/ford442/flac_player/issues/195) | SDL WASM: Ring-fed streaming decode + emcc memory/pthread audit | **Done (SDL3)** |
| [#196](https://github.com/ford442/flac_player/issues/196) | Testing: Real decode → playback → analyser integration harness | **Done** (`tests/browser/audioPipeline.test.ts`) |
| [#197](https://github.com/ford442/flac_player/issues/197) | Feature: Synced listening rooms MVP (design) | **Closed** — implement via [#209](https://github.com/ford442/flac_player/issues/209) |
| [#201](https://github.com/ford442/flac_player/issues/201) | Display: gpu-chores peak pyramid / RMS (Worker + adopted-device compute) | **Done** (PR #204) |
| [#202](https://github.com/ford442/flac_player/issues/202) | Visualizer: fail-closed WebGPU (no auto GL ladder) | **Done** — WebGL2 is now **opt-in** (`?visualizer=webgl2` / Compatibility toggle) |

## Open issues (do next)

Matches GitHub open issues as of 2026-09-23. The shared AudioContext / worklet graph (#218) is done: backends never suspend the shared context, processors are static modules, and `AudioBackendCapabilities` drives the UI.

| Issue | Title | Priority |
|-------|-------|----------|
| [#219](https://github.com/ford442/flac_player/issues/219) | Foundation: WASM source hash, C++ stream-seek ABI, SIMD DSP, SDL playback rate | **P0** |
| [#220](https://github.com/ford442/flac_player/issues/220) | Incomplete: #215 Hi-fi streaming seek, gapless splice, and soxr WASM resampler | **P0** — flips `seek` / `gapless` capabilities on the hi-fi path |
| [#217](https://github.com/ford442/flac_player/issues/217) | Agent task: scan wiped positive changes + audit every issue for implementation completeness | **P1** |
| [#208](https://github.com/ford442/flac_player/issues/208) | Feature: Media Session, lock-screen controls, and Remote Playback / Cast | **P1** — use `AudioBackendCapabilities` for seek/play |
| [#222](https://github.com/ford442/flac_player/issues/222) | Feature: Local-first playlists (IndexedDB) and cloud playlist CRUD contract | **P1** |
| [#221](https://github.com/ford442/flac_player/issues/221) | WebGPU: timestamp-query/shader-f16, HDR canvas, GPU FFT, WGSL modules | **P2** |
| [#223](https://github.com/ford442/flac_player/issues/223) | Feature: WebMIDI / HID hardware mapping for ShaderGUI knobs, EQ, and transport | **P2** |
| [#209](https://github.com/ford442/flac_player/issues/209) | Feature: Synced listening rooms MVP + later studio DSP (Rubber Band / LUFS) | **P2** — streaming-HTML clock for MVP |

## Foundation before features

1. **#219 / #220** finish WASM stream-seek and hi-fi seek/gapless; the capability flags then light up the seek bar on worklet/SDL.
2. **#208** Media Session reads `getCapabilities()`; Cast stays on the streaming `<audio>` backend until #220 lands.
3. **#209** rooms implement `LISTENING_ROOMS.md` on the streaming-HTML clock.

## Horizon (not yet ticketed)

Ideas validated by the September 2026 audit for a later cycle:

- **Installable offline hi-fi PWA** — full library mirror + gapless offline once #216 badges and #215 gapless land
- **projectM visual radio** — preset packs, beat-sync, shareable embeds (WASM host already optional)
- **SDL3-only playback WASM** — **shipped** (#212). projectM keeps a separate `USE_SDL=2` video host.
- **Shared `gpu-chores` package** — in-repo stub shipped (#201); extract when a second app needs it

## Documentation index

- [ARCHITECTURE.md](./ARCHITECTURE.md) — system diagram, four backends, visualizer chain
- [AUDIO_BACKENDS.md](./AUDIO_BACKENDS.md) — backend selection guide
- [API.md](./API.md) — REST + projectM embed contract
- [LISTENING_ROOMS.md](./LISTENING_ROOMS.md) — synced “listen together” rooms (design; implement via #209)
- [DEVELOPER_CONTEXT.md](./DEVELOPER_CONTEXT.md) — WASM memory, PCM bridge, shader/CSS coupling

## Suggested reading order for new contributors

1. [AUDIO_BACKENDS.md](./AUDIO_BACKENDS.md) — pick a playback path
2. [ARCHITECTURE.md](./ARCHITECTURE.md) — see how pieces connect
3. `AGENTS.md` / `CLAUDE.md` — API URL invariants and build commands
4. This roadmap — what is planned vs shipped
