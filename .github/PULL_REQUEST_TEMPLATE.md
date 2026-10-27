Fixes #

<!-- One `Fixes #N` per issue this PR completes. Issues closed as "completed" without a
     merged PR or a commit on main are reopened by .github/workflows/issue-close-guard.yml.
     Use `Refs #N` for partial work. -->

## Pull Request Checklist

### General
- [ ] `npm run lint -- --max-warnings 0` and `npm run typecheck` pass
- [ ] `npm run test:unit` and `npm run test:decoder` pass
- [ ] `npm run test:streaming` and `npm run test:e2e` pass (when touching playback or UI)
- [ ] `npm run verify:wasm` passes; WASM artifacts were rebuilt with the pinned emsdk (`scripts/emsdk-version`), never merged textually
- [ ] Related docs updated when behavior or contracts change

### Visualizer / ShaderGUI (when touching shaders or layout)
- [ ] Knob/LED positions changed only in `src/visuals/waveformContract.ts` (`WAVEFORM_LAYOUT`)
- [ ] Manual parity check: WebGPU (`?visualizer=webgpu`) and WebGL2 (`?webgl2=1`) look aligned
- [ ] `Alt+D` debug modes work on **both** WebGPU and WebGL2 (`normal` → `uv` → `waveform-only` → `audio-bins` → `spectrum`)
- [ ] `npm run test:visualizer` passes

### Audio backends (when touching playback)
- [ ] Streaming default still starts promptly
- [ ] streaming, web-audio, worklet and SDL3 each play a 44.1 kHz and a 96 kHz FLAC
- [ ] The backend is not recreated on queue edits (`tests/backendLifecycle.test.ts`)

### Deploy (when touching paths, the service worker or the manifest)
- [ ] `PUBLIC_PATH=/flac-player/ npm run build` served under `/flac-player/`: SW scope, manifest and Media Session artwork resolve there
