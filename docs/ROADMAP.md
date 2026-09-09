# Roadmap

Planning cycle: July 2026 (post-audit after #166–#185 closure).

Earlier issues (#166–#185) shipped a lot of product surface (unified backend interface, gapless, ReplayGain, waveform contract, PWA scaffolding, listening-rooms **design**). A July 27 audit found several **foundation items still incomplete** — backends were relocated under `src/audio/backends/` and `usePlaybackController` extracted from `Player.tsx` in #193. Native-rate `AudioContext` (#194) and SDL3 ring-fed streaming (#195) are now in tree; remaining gaps include expanding the decode→playback harness (#196) and SDL2 streaming (Phase 2 of #195).

**Do foundation work before large features.** Listening rooms (#197) depends on a stable playback controller and trustworthy tests.

| Issue | Title | Priority |
|-------|-------|----------|
| [#193](https://github.com/ford442/flac_player/issues/193) | Foundation: Relocate backends under `src/audio/backends/` + extract `PlaybackController` | **Done** |
| [#194](https://github.com/ford442/flac_player/issues/194) | Audio: Native sample-rate `AudioContext`, latency modes, recreate policy | **Done** |
| [#196](https://github.com/ford442/flac_player/issues/196) | Testing: Real decode → playback → analyser integration harness | **P0 — do first** |
| [#195](https://github.com/ford442/flac_player/issues/195) | SDL WASM: Ring-fed streaming decode + emcc memory/pthread audit | **Done (SDL3)** — SDL2 streaming / common C++ extract is Phase 2 |
| [#197](https://github.com/ford442/flac_player/issues/197) | Feature: Synced listening rooms MVP (`LISTENING_ROOMS.md`) | P2 — large |
| [#201](https://github.com/ford442/flac_player/issues/201) | Display: gpu-chores peak pyramid / RMS (Worker + adopted-device compute) | **Done** (PR #204) |
| [#202](https://github.com/ford442/flac_player/issues/202) | Visualizer: fail-closed WebGPU (no auto GL ladder) | **Done** — WebGL2 is now **opt-in** (`?visualizer=webgl2` / Compatibility toggle) |

## Foundation before features

Ship **#196** before implementing listening rooms (#197). SDL3 ring-fed streaming (#195) is in tree; SDL2 still full-buffer.

## Horizon (not yet ticketed)

Ideas validated by the audit for a later cycle:

- **Media Session / lock-screen controls** — no `navigator.mediaSession` usage today; pairs with listening rooms and PWA install
- **Studio DSP suite** — optional WASM Rubber Band (timestretch), SpeexDSP/soxr resampler, real-time LUFS meter; builds on native-rate context (#194)
- **SDL2 retirement** — consolidate on SDL3 once ring streaming is solid on SDL2-compat (Phase 2: shared `audio_engine_common`; Phase 3: drop SDL2 playback; keep SDL2 only if projectM needs it)
- **Deploy hygiene** — remove hardcoded tokens from `deploy.py` / delete `deploy_old.py`

## Documentation index

- [ARCHITECTURE.md](./ARCHITECTURE.md) — system diagram, five backends, visualizer chain
- [AUDIO_BACKENDS.md](./AUDIO_BACKENDS.md) — backend selection guide
- [API.md](./API.md) — REST + projectM embed contract
- [LISTENING_ROOMS.md](./LISTENING_ROOMS.md) — synced “listen together” rooms (design; implement via #197)
- [DEVELOPER_CONTEXT.md](./DEVELOPER_CONTEXT.md) — WASM memory, PCM bridge, shader/CSS coupling

## Suggested reading order for new contributors

1. [AUDIO_BACKENDS.md](./AUDIO_BACKENDS.md) — pick a playback path
2. [ARCHITECTURE.md](./ARCHITECTURE.md) — see how pieces connect
3. `AGENTS.md` / `CLAUDE.md` — API URL invariants and build commands
4. This roadmap — what is planned vs shipped
