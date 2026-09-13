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

Foundation leftovers, then finish existing library surface, then OS/social adapters. SDL2 is still full-buffer; EQ/ReplayGain still skip SDL speakers.

| Issue | Title | Priority |
|-------|-------|----------|
| [#212](https://github.com/ford442/flac_player/issues/212) | Foundation: WASM compile audit, C++ error reporting, and SDL2 retirement | **P0** — compile flags, `configure_stream` errors, retire or slim SDL2 |
| [#213](https://github.com/ford442/flac_player/issues/213) | Foundation: Finish AudioContext — output device, channels, latency telemetry, DSP on SDL | **P0** — leftover #194; EQ/RG must hit SDL speakers before #209 DSP |
| [#214](https://github.com/ford442/flac_player/issues/214) | Hygiene: dead TypeScript, docs drift, PlayerFallbackView split, deploy secrets | **P0** — unblocks agents; remove hardcoded deploy token |
| [#216](https://github.com/ford442/flac_player/issues/216) | Feature: Finish library product — offline, pagination, accessibility, MusicBrainz | **P1** — wire surfaces that already exist |
| [#208](https://github.com/ford442/flac_player/issues/208) | Feature: Media Session, lock-screen controls, and Remote Playback / Cast | **P1** — after honest clock; Cast after streaming seek |
| [#215](https://github.com/ford442/flac_player/issues/215) | Feature: Hi-fi streaming transport — seek and gapless on SDL3/worklet, soxr WASM | **P2** — after #212/#213; unblocks hi-fi seek bar |
| [#209](https://github.com/ford442/flac_player/issues/209) | Feature: Synced listening rooms MVP + later studio DSP (Rubber Band / LUFS) | **P2** — after #212/#213; Rubber Band after #213 speaker DSP |

## Foundation before features

1. Ship **#212** (WASM/C++ flags and errors) and **#213** (AudioContext sink + SDL DSP) before depending on SDL/worklet clocks in rooms or Cast.
2. Ship **#214** in parallel (docs, dead code, `deploy.py` secrets, split `PlayerFallbackView` so #208/#209 do not grow the prop dump).
3. **#216** is the next user-facing work (offline badges, pagination, a11y) — unfinished wiring, not a new product.
4. **#208** Media Session after the clock is honest; Cast after #215 seek or stay on the streaming `<audio>` backend.
5. **#209** rooms implement `LISTENING_ROOMS.md` (streaming-HTML clock for MVP). Studio DSP (Rubber Band / LUFS) is Phase 3 of #209; soxr resampler for rate mismatch is #215 Phase 3.

## Horizon (not yet ticketed)

Ideas validated by the September 2026 audit for a later cycle:

- **Installable offline hi-fi PWA** — full library mirror + gapless offline once #216 badges and #215 gapless land
- **projectM visual radio** — preset packs, beat-sync, shareable embeds (WASM host already optional)
- **SDL3-only WASM** — after #212 Phase 3 retirement; keep SDL2 only if projectM needs it
- **Shared `gpu-chores` package** — in-repo stub shipped (#201); extract when a second app needs it

## Documentation index

- [ARCHITECTURE.md](./ARCHITECTURE.md) — system diagram, five backends, visualizer chain
- [AUDIO_BACKENDS.md](./AUDIO_BACKENDS.md) — backend selection guide
- [API.md](./API.md) — REST + projectM embed contract
- [LISTENING_ROOMS.md](./LISTENING_ROOMS.md) — synced “listen together” rooms (design; implement via #209)
- [DEVELOPER_CONTEXT.md](./DEVELOPER_CONTEXT.md) — WASM memory, PCM bridge, shader/CSS coupling

## Suggested reading order for new contributors

1. [AUDIO_BACKENDS.md](./AUDIO_BACKENDS.md) — pick a playback path
2. [ARCHITECTURE.md](./ARCHITECTURE.md) — see how pieces connect
3. `AGENTS.md` / `CLAUDE.md` — API URL invariants and build commands
4. This roadmap — what is planned vs shipped
