# Roadmap

Planning cycle: July 2026 (post #166–#175 closure).

Previous foundation issues (#166–#175) are **closed**. The items below are the active backlog.

| Issue | Title | Priority |
|-------|-------|----------|
| [#176](https://github.com/ford442/flac_player/issues/176) | Foundation: Consolidate five audio backends under `src/audio/backends/` | **P0 — do first** |
| [#177](https://github.com/ford442/flac_player/issues/177) | Architecture: Decompose `Player.tsx` and unify ShaderGUI / Fallback UI | **P0 — do first** |
| [#180](https://github.com/ford442/flac_player/issues/180) | Testing: Real audio pipeline integration harness | **P0 — do first** |
| [#181](https://github.com/ford442/flac_player/issues/181) | Dependencies: Replace `music-metadata-browser`, npm audit | P1 — in progress (see PR) |
| [#179](https://github.com/ford442/flac_player/issues/179) | Audio: Dynamic sample rate and latency hints | P1 |
| [#178](https://github.com/ford442/flac_player/issues/178) | SDL WASM: Streaming decode without full-file C++ buffer | P1 |
| [#182](https://github.com/ford442/flac_player/issues/182) | Visualizer: Unify WGSL and GLSL waveform shaders | P2 |
| [#183](https://github.com/ford442/flac_player/issues/183) | Feature: Gapless playback and queue continuity | P2 |
| [#184](https://github.com/ford442/flac_player/issues/184) | Feature: ReplayGain / loudness normalization | P2 |
| [#185](https://github.com/ford442/flac_player/issues/185) | Feature: Synced listening rooms | P3 — large |

## Foundation before features

Ship **#176, #177, #180** before gapless (#183), ReplayGain (#184), or listening rooms (#185). SDL streaming (#178) and sample-rate work (#179) should follow backend consolidation.

## Documentation index

- [ARCHITECTURE.md](./ARCHITECTURE.md) — system diagram, five backends, visualizer chain
- [AUDIO_BACKENDS.md](./AUDIO_BACKENDS.md) — backend selection guide
- [API.md](./API.md) — REST + projectM embed contract
- [DEVELOPER_CONTEXT.md](./DEVELOPER_CONTEXT.md) — WASM memory, PCM bridge, shader/CSS coupling

## Suggested reading order for new contributors

1. [AUDIO_BACKENDS.md](./AUDIO_BACKENDS.md) — pick a playback path
2. [ARCHITECTURE.md](./ARCHITECTURE.md) — see how pieces connect
3. `AGENTS.md` / `CLAUDE.md` — API URL invariants and build commands
4. This roadmap — what is planned vs shipped
