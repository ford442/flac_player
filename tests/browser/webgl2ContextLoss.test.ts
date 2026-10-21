// #259 G1/G2: the WebGL2 renderer survives a context loss (WEBGL_lose_context)
// and comes back on restore; destroy() releases the context, and a new
// visualizer on the same canvas restores it instead of failing.
import { describe, expect, it } from 'vitest';
import { WebGL2Visualizer } from '../../src/visuals/webgl2/WebGL2Visualizer';
import { DEFAULT_WAVEFORM_UNIFORMS } from '../../src/visuals/waveformContract';

const analyser = {
  frequencyBinCount: 64,
  getByteFrequencyData: (a: Uint8Array) => a.fill(200),
} as unknown as AnalyserNode;

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  document.body.appendChild(canvas);
  return canvas;
}

function frame(vis: WebGL2Visualizer): void {
  vis.setUniforms({ ...DEFAULT_WAVEFORM_UNIFORMS, resolution: [128, 64], audioLevel: 0.8, isPlaying: 1 });
  vis.setAudioData(new Uint8Array(1024).fill(200));
  vis.renderGUI();
}

function litPixels(pixels: Uint8Array | null): number {
  if (!pixels) return 0;
  let lit = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! + pixels[i + 1]! + pixels[i + 2]! > 0) lit++;
  return lit;
}

function once(target: EventTarget, type: string): Promise<Event> {
  return new Promise((resolve) => target.addEventListener(type, resolve, { once: true }));
}

/** Next task: Chrome allows restoreContext() only after the lost event's dispatch returns. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('WebGL2Visualizer context lifecycle', () => {
  it('requests no depth/stencil, srgb, not desynchronized', () => {
    const canvas = makeCanvas();
    const vis = new WebGL2Visualizer(canvas);
    expect(vis.initialize(analyser)).toBe(true);
    const attrs = vis.getContextAttributes()!;
    expect(attrs.depth).toBe(false);
    expect(attrs.stencil).toBe(false);
    expect(attrs.desynchronized ?? false).toBe(false);
    expect(attrs.preserveDrawingBuffer).toBe(false);
    const gl = canvas.getContext('webgl2')!;
    if ('drawingBufferColorSpace' in gl) expect(gl.drawingBufferColorSpace).toBe('srgb');
    vis.destroy();
    canvas.remove();
  });

  it('readPixels returns the current frame without preserveDrawingBuffer', async () => {
    const canvas = makeCanvas();
    const vis = new WebGL2Visualizer(canvas);
    expect(vis.initialize(analyser)).toBe(true);
    frame(vis);
    // Let the frame composite (the drawing buffer is cleared afterwards).
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    expect(litPixels(vis.readPixels())).toBeGreaterThan(0);
    vis.destroy();
    canvas.remove();
  });

  it('stops on webglcontextlost and renders again after webglcontextrestored', async () => {
    const canvas = makeCanvas();
    const vis = new WebGL2Visualizer(canvas);
    expect(vis.initialize(analyser)).toBe(true);
    frame(vis);
    expect(litPixels(vis.readPixels())).toBeGreaterThan(0);

    const gl = canvas.getContext('webgl2')!;
    const ext = gl.getExtension('WEBGL_lose_context')!;
    const lost = once(canvas, 'webglcontextlost');
    ext.loseContext();
    await lost;
    expect(vis.isContextLost()).toBe(true);
    expect(() => frame(vis)).not.toThrow();
    expect(vis.readPixels()).toBeNull();

    // What the browser does after a GPU reset when the lost event was cancelled.
    await nextTask();
    const restored = once(canvas, 'webglcontextrestored');
    ext.restoreContext();
    await restored;
    await expect.poll(() => vis.isContextLost()).toBe(false);
    frame(vis);
    expect(litPixels(vis.readPixels())).toBeGreaterThan(0);
    vis.destroy();
    canvas.remove();
  });

  it('destroy releases the context; the next visualizer on the canvas restores it', async () => {
    const canvas = makeCanvas();
    const first = new WebGL2Visualizer(canvas);
    expect(first.initialize(analyser)).toBe(true);
    first.destroy();
    expect(canvas.getContext('webgl2')!.isContextLost()).toBe(true);

    // Same task, as in ShaderGUI's destroyAllVisualizers → initVisualizer.
    const second = new WebGL2Visualizer(canvas);
    expect(second.initialize(analyser)).toBe(true);
    await expect.poll(() => second.isContextLost(), { timeout: 5000 }).toBe(false);
    frame(second);
    expect(litPixels(second.readPixels())).toBeGreaterThan(0);
    second.destroy();
    canvas.remove();
  });
});
