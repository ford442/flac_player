## Pull Request Checklist

### General
- [ ] `npm run typecheck` and `npm run lint` pass
- [ ] Related docs updated when behavior or contracts change

### Visualizer / ShaderGUI (when touching shaders or layout)
- [ ] Knob/LED positions changed only in `src/visuals/waveformContract.ts` (`WAVEFORM_LAYOUT`)
- [ ] Manual parity check: WebGPU (`?visualizer=webgpu`) and WebGL2 (`?visualizer=webgl2`) look aligned
- [ ] `Alt+D` debug modes work on **both** WebGPU and WebGL2 (`normal` → `uv` → `waveform-only` → `audio-bins` → `spectrum`)
- [ ] `npm run test:visualizer` passes

### Audio backends (when touching playback)
- [ ] Streaming default still starts promptly
- [ ] Buffered backends still decode/play if modified
