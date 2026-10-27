// Real-Chromium checks for the SDL-free projectM host (#259 G3/G4/G5): the
// committed public/projectm build gets a WebGL2 context on the engine canvas,
// leaves keyboard events alone, reports preset parse failures, and keeps
// rendering when the canvas moves to another host container.
import { afterAll, describe, expect, it } from 'vitest';
import { ProjectMEngine, type ProjectMWasmModule } from '../../src/projectm/ProjectMEngine';
import { WASM_ASSETS, loadWasmScript } from '../../src/audio/wasmLoader';

const LINE_PRESET = `[preset00]
fdecay=0
warp=0
nWaveMode=6
fWaveScale=1
fwavesmoothing=0.01
wave_r=1.0
wave_g=1.0
wave_b=1.0
wave_x=0.5
wave_y=0.5
`;

// projectm-eval rejects this per-pixel code; projectM reports a switch failure.
const BROKEN_PRESET = `${LINE_PRESET}per_pixel_1=zoom = (;\n`;

const PACK = { name: 'test', bases: ['https://presets.invalid/'], presets: ['A/line.milk', 'B/broken.milk'] };

function nextFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(count);
  });
}

/** Max channel value of the canvas as composited (drawImage reads the presented frame). */
function brightness(canvas: HTMLCanvasElement): number {
  // Full resolution: the test preset is a 1 px waveform line, lost by downscaling.
  const probe = document.createElement('canvas');
  probe.width = canvas.width;
  probe.height = canvas.height;
  const ctx = probe.getContext('2d')!;
  ctx.drawImage(canvas, 0, 0);
  const { data } = ctx.getImageData(0, 0, probe.width, probe.height);
  let max = 0;
  for (let i = 0; i < data.length; i += 4) max = Math.max(max, data[i]!, data[i + 1]!, data[i + 2]!);
  return max;
}

/**
 * requestAnimationFrame registrations by other code per frame over `frames`
 * frames: one Emscripten main loop (fps 0 = rAF scheduler) registers ~1 per frame.
 */
async function foreignRafPerFrame(frames: number): Promise<number> {
  const original = window.requestAnimationFrame;
  let foreign = 0;
  let own = 0;
  window.requestAnimationFrame = (cb) => {
    foreign += 1;
    return original.call(window, cb);
  };
  try {
    await new Promise<void>((resolve) => {
      const step = () => {
        own += 1;
        if (own >= frames) resolve();
        else original.call(window, step);
      };
      original.call(window, step);
    });
  } finally {
    window.requestAnimationFrame = original;
  }
  return foreign / frames;
}

function container(): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = 'width:320px;height:180px';
  document.body.appendChild(el);
  return el;
}

describe('projectM host (committed WASM)', () => {
  let moduleLoads = 0;
  let module: ProjectMWasmModule | null = null;
  const engine = new ProjectMEngine({
    loadModule: async (canvas) => {
      moduleLoads += 1;
      await loadWasmScript(WASM_ASSETS.projectmHost);
      module = await window.createProjectMModule({ canvas });
      return module;
    },
    loadManifest: async () => PACK,
    fetchImpl: async (input) => new Response(String(input).includes('broken') ? BROKEN_PRESET : LINE_PRESET),
    initialPreset: () => 'A/line.milk',
    random: () => 0,
  });

  afterAll(() => engine.destroy());

  it('loads once for concurrent hosts and renders on the engine canvas', async () => {
    const a = container();
    const detachA = engine.attach(a);
    const [okA, okB] = await Promise.all([engine.load(), engine.load()]);
    expect(okA && okB).toBe(true);
    expect(moduleLoads).toBe(1);
    const canvas = engine.getCanvas();
    expect(canvas.parentNode).toBe(a);
    expect(canvas.getContext('webgl2')).not.toBeNull();
    await expect.poll(() => engine.getPresetState().current, { timeout: 5000 }).toBe('A/line.milk');
    await nextFrames(10);
    expect(brightness(canvas)).toBeGreaterThan(0);
    detachA();
  });

  it('keeps one canvas and keeps drawing after projectm → split → projectm', async () => {
    const canvas = engine.getCanvas();
    for (let i = 0; i < 3; i++) {
      const slot = container();
      const detach = engine.attach(slot);
      expect(canvas.parentNode).toBe(slot);
      expect(slot.querySelectorAll('canvas')).toHaveLength(1);
      engine.resize(320 + i * 16, 180, 1);
      expect(canvas.width).toBe(320 + i * 16);
      await nextFrames(6);
      expect(brightness(canvas)).toBeGreaterThan(0);
      detach();
      slot.remove();
    }
    expect(document.querySelectorAll('canvas.projectm-host__canvas')).toHaveLength(0);
    expect(moduleLoads).toBe(1);
  });

  it('runs exactly one main loop while attached and none while detached', async () => {
    expect(await foreignRafPerFrame(30)).toBe(0);
    const a = container();
    const b = container();
    const detachA = engine.attach(a);
    // Strict-mode style overlap: the next host attaches before the old one detaches.
    const detachB = engine.attach(b);
    detachA();
    const perFrame = await foreignRafPerFrame(30);
    expect(perFrame).toBeGreaterThan(0.8);
    expect(perFrame).toBeLessThan(1.2);
    expect(engine.getCanvas().parentNode).toBe(b);
    detachB();
    a.remove();
    b.remove();
    // The loop's last scheduled frame may still land; after that it stays quiet.
    await nextFrames(2);
    expect(await foreignRafPerFrame(30)).toBe(0);
  });

  it('does not swallow Tab or Ctrl+key while loaded', async () => {
    const slot = container();
    const detach = engine.attach(slot);
    for (const init of [
      { key: 'Tab', code: 'Tab' },
      { key: 'f', code: 'KeyF', ctrlKey: true },
      { key: 'c', code: 'KeyC', ctrlKey: true },
      { key: 'ArrowDown', code: 'ArrowDown' },
      { key: 'Backspace', code: 'Backspace' },
    ]) {
      for (const target of [window, document.body, engine.getCanvas()]) {
        const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
        target.dispatchEvent(event);
        expect(event.defaultPrevented, `${init.key} on ${target === window ? 'window' : (target as Element).tagName}`).toBe(false);
      }
    }
    detach();
    slot.remove();
  });

  it('pm_load_preset_data reports projectM parse failures', async () => {
    expect(engine.loadPresetMilk(LINE_PRESET)).toBe(true);
    expect(engine.loadPresetMilk(BROKEN_PRESET)).toBe(false);
    // A rejected pack preset is skipped, and the engine stays usable.
    expect(await engine.showPreset('B/broken.milk')).toBe(false);
    expect(engine.getPresetState().current).toBe('A/line.milk');
    expect(engine.getPresetState().error).toMatch(/could not be parsed/);
    expect(module).not.toBeNull();
  });
});
