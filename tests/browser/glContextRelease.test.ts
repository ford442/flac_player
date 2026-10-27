import { describe, expect, it } from 'vitest';
import { WebGL2Visualizer } from '../../src/visuals/webgl2/WebGL2Visualizer';
import { loseCanvasGlContext } from '../../src/visuals/webgl2/glContext';
import { probeWebGPU } from '../../src/visuals/webgpuProbe';

/**
 * Real-browser check of the WebGL2 teardown contract: destroy() keeps the canvas's context for
 * re-init, releaseContext() loses it for good, and a probe on the replacement canvas still works.
 */
const analyser = {
  frequencyBinCount: 32,
  getByteFrequencyData: () => {},
} as unknown as AnalyserNode;

function hasWebGL2(): boolean {
  return document.createElement('canvas').getContext('webgl2') !== null;
}

describe('WebGL2 context release', () => {
  it.skipIf(!hasWebGL2())('keeps the context across destroy() and loses it on releaseContext()', () => {
    const canvas = document.createElement('canvas');
    const first = new WebGL2Visualizer(canvas);
    expect(first.initialize(analyser)).toBe(true);
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext;

    first.destroy();
    expect(gl.isContextLost()).toBe(false);
    const second = new WebGL2Visualizer(canvas);
    expect(second.initialize(analyser)).toBe(true);
    expect(gl.isContextLost()).toBe(false);

    second.releaseContext();
    expect(gl.isContextLost()).toBe(true);
    // The canvas is spent: it hands back the same lost context and can never host WebGPU.
    expect(canvas.getContext('webgl2')).toBe(gl);
    expect(canvas.getContext('webgpu')).toBeNull();
  });

  it.skipIf(!hasWebGL2())('loses the context a module created on a canvas', () => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext;
    expect(loseCanvasGlContext(canvas)).toBe(true);
    expect(gl.isContextLost()).toBe(true);
  });

  it.skipIf(!hasWebGL2() || !('gpu' in navigator))('probes a replacement canvas after the GL one was released', async () => {
    const glCanvas = document.createElement('canvas');
    const visualizer = new WebGL2Visualizer(glCanvas);
    visualizer.initialize(analyser);
    visualizer.releaseContext();

    const gpuCanvas = document.createElement('canvas');
    const probe = await probeWebGPU(gpuCanvas, { publish: false });
    // No adapter in some headless setups; the point is that a GL leftover is not the reason.
    if (probe.ok) {
      probe.device.destroy();
    } else {
      expect(probe.breadcrumb.reason).not.toBe('webgpu-no-context');
    }
  });
});
