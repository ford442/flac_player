# Roadmap

Tracked GitHub issues for ongoing architecture work (July 2026).

| Issue | Title | Status |
|-------|-------|--------|
| [#166](https://github.com/ford442/flac_player/issues/166) | Foundation: Unified AudioBackend interface and shared AudioContext lifecycle | Open |
| [#167](https://github.com/ford442/flac_player/issues/167) | SDL WASM backends: volume scaling and real AnalyserNode bridge for visualizer | Open — PCM bridge landed; tracking cleanup |
| [#168](https://github.com/ford442/flac_player/issues/168) | Feature: In-app AI track generation workflow (MusicGen / Minimax → library) | Open |
| [#169](https://github.com/ford442/flac_player/issues/169) | TypeScript strict mode: incremental rollout with shared types and lint enforcement | Open |
| [#170](https://github.com/ford442/flac_player/issues/170) | projectM integration: embed SDK, preset browser, and dual-visualizer layout | Open — Phase 1 in-app host shipped |
| [#171](https://github.com/ford442/flac_player/issues/171) | Build pipeline: unify SDL2/SDL3 WASM builds, CI integration, and lazy-load WASM assets | Open — unified `scripts/build-wasm.sh` landed |
| [#172](https://github.com/ford442/flac_player/issues/172) | Testing: replace DOM-mock e2e tests with real component and audio pipeline tests | Open |
| [#173](https://github.com/ford442/flac_player/issues/173) | Docs and DX: refresh architecture docs, centralize debug logging, update stale README | Open — this doc refresh |
| [#174](https://github.com/ford442/flac_player/issues/174) | PWA: Service Worker + offline playback using existing trackCache infrastructure | Open |
| [#175](https://github.com/ford442/flac_player/issues/175) | Audio pipeline: complete FLAC streaming decode via AudioWorklet ring buffer | Open |

## Documentation index

After [#173](https://github.com/ford442/flac_player/issues/173):

- [ARCHITECTURE.md](./ARCHITECTURE.md) — full system diagram (Mermaid), five backends, visualizer chain
- [AUDIO_BACKENDS.md](./AUDIO_BACKENDS.md) — backend selection guide for new contributors
- [API.md](./API.md) — REST + projectM embed contract
- [DEVELOPER_CONTEXT.md](./DEVELOPER_CONTEXT.md) — agent complexity hotspots

## Suggested reading order for new contributors

1. [AUDIO_BACKENDS.md](./AUDIO_BACKENDS.md) — pick a playback path
2. [ARCHITECTURE.md](./ARCHITECTURE.md) — see how pieces connect
3. `AGENTS.md` / `CLAUDE.md` — API URL invariants and build commands
4. This roadmap — what is planned vs shipped
