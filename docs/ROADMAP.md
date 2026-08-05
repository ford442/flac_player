# Roadmap

Planning cycle: July 2026 (post-audit after #166–#185 closure).

Earlier issues (#166–#185) shipped a lot of product surface (unified backend interface, gapless, ReplayGain, waveform contract, PWA scaffolding, listening-rooms **design**). A July 27 audit found several **foundation items still incomplete** — backends were relocated under `src/audio/backends/` and `usePlaybackController` extracted from `Player.tsx` in #193; remaining gaps include hardcoded 44.1 kHz `AudioContext`, SDL full-buffer PCM in C++, and `test:streaming` echo stub.

**Do foundation work before large features.** Listening rooms (#197) depends on a stable playback controller and trustworthy tests.

| Issue | Title | Priority |
|-------|-------|----------|
| [#193](https://github.com/ford442/flac_player/issues/193) | Foundation: Relocate backends under `src/audio/backends/` + extract `PlaybackController` | **Done** |
| [#194](https://github.com/ford442/flac_player/issues/194) | Audio: Native sample-rate `AudioContext`, latency modes, recreate policy | **P0 — do first** |
| [#196](https://github.com/ford442/flac_player/issues/196) | Testing: Real decode → playback → analyser integration harness | **P0 — do first** |
| [#195](https://github.com/ford442/flac_player/issues/195) | SDL WASM: Ring-fed streaming decode + emcc memory/pthread audit | P1 |
| [#197](https://github.com/ford442/flac_player/issues/197) | Feature: Synced listening rooms MVP (`LISTENING_ROOMS.md`) | P2 — large |

## Foundation before features

Ship **#194, #196** before implementing listening rooms (#197). SDL streaming (#195) can proceed in parallel now that backends live under `src/audio/backends/`.

## Horizon (not yet ticketed)

Ideas validated by the audit for a later cycle:

- **Media Session / lock-screen controls** — no `navigator.mediaSession` usage today; pairs with listening rooms and PWA install
- **Studio DSP suite** — optional WASM Rubber Band (timestretch), SpeexDSP/soxr resampler, real-time LUFS meter; builds on native-rate context (#194)
- **SDL2 retirement** — consolidate on SDL3 once ring streaming (#195) is solid
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
