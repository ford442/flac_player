// projectM host (public/projectm/projectm-host.*) under its build caps
// (scripts/build-projectm-wasm.sh): the heap stays inside MAXIMUM_MEMORY while
// presets load, hard-cut and render with PCM, and the GL host renders with
// FULL_ES2 only. Logs the measured heap so the cap can be re-justified
// (docs/WASM_TOOLCHAIN.md).
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectMEngine, type ProjectMWasmModule } from '../../src/projectm/ProjectMEngine';

const MAXIMUM_MEMORY = 256 * 1024 * 1024;

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

describe('projectM host heap', () => {
  let engine: ProjectMEngine | null = null;
  let canvas: HTMLCanvasElement | null = null;

  afterEach(() => {
    engine?.destroy();
    canvas?.remove();
    engine = null;
    canvas = null;
  });

  it('renders and cycles presets inside the capped heap', async () => {
    canvas = document.createElement('canvas');
    canvas.id = 'canvas';
    canvas.style.width = '640px';
    canvas.style.height = '360px';
    document.body.appendChild(canvas);
    engine = new ProjectMEngine();
    const errors: string[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.message);
    window.addEventListener('error', onError);
    try {
      expect(await engine.load(canvas)).toBe(true);
      const module = (engine as unknown as { module: ProjectMWasmModule }).module;
      const heap = () => module.wasmMemory!.buffer.byteLength;
      const initial = heap();

      const pcm = new Float32Array(512 * 2);
      let peak = initial;
      for (let i = 0; i < 180; i++) {
        for (let n = 0; n < 512; n++) {
          const v = 0.6 * Math.sin((2 * Math.PI * 110 * (i * 512 + n)) / 44100) * (n % 64 < 8 ? 1 : 0.3);
          pcm[2 * n] = v;
          pcm[2 * n + 1] = v;
        }
        engine.addPCM(pcm, 2);
        if (i % 30 === 29) engine.nextPreset(true);
        await frame();
        peak = Math.max(peak, heap());
      }

      console.log(`projectM heap: initial ${(initial / 2 ** 20).toFixed(1)} MiB, peak ${(peak / 2 ** 20).toFixed(1)} MiB`);
      expect(engine.getStatus()).toBe('ready');
      expect(errors).toEqual([]);
      expect(peak).toBeLessThanOrEqual(MAXIMUM_MEMORY);
      // The Memory's declared maximum is the cap, not Emscripten's 2 GiB default:
      // growing one page past it is refused without allocating anything.
      const pastCap = MAXIMUM_MEMORY / 65536 - heap() / 65536 + 1;
      expect(() => module.wasmMemory!.grow(pastCap)).toThrow(RangeError);
    } finally {
      window.removeEventListener('error', onError);
    }
  });
});
