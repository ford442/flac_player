// A canvas keeps its GL context for life, so the context is released when the canvas is
// retired: the WebGPU probe on the replacement canvas must not run with a GL context left behind.

import { StrictMode, act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebGL2Visualizer } from '../src/visuals/webgl2/WebGL2Visualizer';
import { loseCanvasGlContext, loseGlContext, retireGlHost } from '../src/visuals/webgl2/glContext';
import { notifyVisualizerPreferenceChanged } from '../src/visuals/rendererSelection';
import { ShaderGUI } from '../src/components/ShaderGUI/ShaderGUI';

const order: string[] = [];

interface FakeGl {
  gl: WebGL2RenderingContext;
  lost: () => boolean;
  loseContext: ReturnType<typeof vi.fn>;
}

/** Any GL call succeeds; only context loss is modelled. */
function fakeGl(): FakeGl {
  let lost = false;
  const loseContext = vi.fn(() => {
    lost = true;
    order.push('loseContext');
  });
  const target: Record<string, unknown> = {
    isContextLost: () => lost,
    getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
  };
  const gl = new Proxy(target, {
    get: (t, prop) => {
      if (typeof prop !== 'string' || prop in t) return t[prop as string];
      return /^[A-Z0-9_]+$/.test(prop) ? 1 : vi.fn(() => ({}));
    },
  }) as unknown as WebGL2RenderingContext;
  return { gl, lost: () => lost, loseContext };
}

function fakeCanvas(gl: FakeGl | null, connected = true): HTMLCanvasElement {
  return {
    width: 640,
    height: 160,
    isConnected: connected,
    getContext: vi.fn((type: string) => (type === 'webgl2' ? gl?.gl ?? null : null)),
  } as unknown as HTMLCanvasElement;
}

const analyser = {
  frequencyBinCount: 32,
  fftSize: 64,
  getByteFrequencyData: () => {},
  getFloatTimeDomainData: () => {},
} as unknown as AnalyserNode;

describe('loseGlContext', () => {
  it('loses a live context once and reports it', () => {
    const gl = fakeGl();
    expect(loseGlContext(gl.gl)).toBe(true);
    expect(gl.lost()).toBe(true);
    expect(loseGlContext(gl.gl)).toBe(false);
    expect(gl.loseContext).toHaveBeenCalledOnce();
  });

  it('tolerates a missing context or extension', () => {
    expect(loseGlContext(null)).toBe(false);
    const noExt = { isContextLost: () => false, getExtension: () => null } as unknown as WebGL2RenderingContext;
    expect(loseGlContext(noExt)).toBe(true);
  });

  it('looks up webgl2, then webgl, on a canvas a module initialised', () => {
    const gl = fakeGl();
    const canvas = {
      getContext: vi.fn((type: string) => (type === 'webgl' ? gl.gl : null)),
    } as unknown as HTMLCanvasElement;
    expect(loseCanvasGlContext(canvas)).toBe(true);
    expect(gl.lost()).toBe(true);
  });
});

describe('WebGL2Visualizer context lifetime', () => {
  beforeEach(() => {
    order.length = 0;
  });

  it('keeps the context across destroy() so the same canvas can initialize again', () => {
    const gl = fakeGl();
    const canvas = fakeCanvas(gl);
    const visualizer = new WebGL2Visualizer(canvas);
    expect(visualizer.initialize(analyser)).toBe(true);
    visualizer.destroy();
    expect(gl.lost()).toBe(false);

    const next = new WebGL2Visualizer(canvas);
    expect(next.initialize(analyser)).toBe(true);
    expect(gl.lost()).toBe(false);
  });

  it('loses the context on releaseContext() and forgets it', () => {
    const gl = fakeGl();
    const visualizer = new WebGL2Visualizer(fakeCanvas(gl));
    visualizer.initialize(analyser);
    visualizer.releaseContext();
    expect(gl.lost()).toBe(true);
    visualizer.releaseContext();
    expect(gl.loseContext).toHaveBeenCalledOnce();
  });

  it('releases the context of a visualizer whose init failed', () => {
    const gl = fakeGl();
    (gl.gl as unknown as { getProgramParameter: () => boolean }).getProgramParameter = () => false;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const visualizer = new WebGL2Visualizer(fakeCanvas(gl));
    expect(visualizer.initialize(analyser)).toBe(false);
    visualizer.releaseContext();
    expect(gl.lost()).toBe(true);
  });
});

describe('retireGlHost', () => {
  function host(canvas: HTMLCanvasElement) {
    return { getCanvas: () => canvas, releaseContext: vi.fn() };
  }

  it('keeps the context while the host still serves the current canvas', () => {
    const canvas = fakeCanvas(null);
    const h = host(canvas);
    expect(retireGlHost(h, canvas)).toBe(h);
    expect(h.releaseContext).not.toHaveBeenCalled();
  });

  it('releases it once the canvas was replaced', () => {
    const h = host(fakeCanvas(null));
    expect(retireGlHost(h, fakeCanvas(null))).toBeNull();
    expect(h.releaseContext).toHaveBeenCalledOnce();
  });

  it('releases it when there is no canvas any more (controls-only, unmount)', () => {
    const h = host(fakeCanvas(null, false));
    expect(retireGlHost(h, null)).toBeNull();
    expect(h.releaseContext).toHaveBeenCalledOnce();
  });

  it('keeps it for a simulated unmount that leaves the canvas attached (StrictMode)', () => {
    const h = host(fakeCanvas(null, true));
    expect(retireGlHost(h, null)).toBe(h);
    expect(h.releaseContext).not.toHaveBeenCalled();
  });

  it('has nothing to do without a host', () => {
    expect(retireGlHost(null, fakeCanvas(null))).toBeNull();
  });
});

describe('ShaderGUI visualizer switch', () => {
  let container: HTMLDivElement;
  let root: Root;
  let gl: FakeGl;
  let requestDevice: ReturnType<typeof vi.fn>;

  const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  const props = {
    analyser,
    currentTrack: null,
    queue: [],
    queueCurrentIndex: -1,
    isPlaying: false,
    duration: 0,
    volume: 1,
    onPlay: () => {},
    onStop: () => {},
    onTrackClick: () => {},
    onVolumeChange: () => {},
  };

  beforeEach(() => {
    order.length = 0;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    gl = fakeGl();
    requestDevice = vi.fn(async () => {
      order.push('requestDevice');
      return { destroy: vi.fn(), lost: new Promise(() => {}) } as unknown as GPUDevice;
    });
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: {
        getPreferredCanvasFormat: () => 'bgra8unorm',
        requestAdapter: async () => ({
          info: { vendor: 'v', architecture: 'a', device: 'd', description: 'fake', isFallbackAdapter: false },
          features: { has: () => false },
          requestDevice,
        }),
      },
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
      type: string,
    ) {
      if (type === 'webgl2') return gl.gl as never;
      if (type === 'webgpu') {
        order.push('getContext(webgpu)');
        return { configure: () => {} } as never;
      }
      return null;
    } as never);
    window.DEBUG_VISUALIZER = 'webgl2';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (navigator as { gpu?: unknown }).gpu;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loses the WebGL2 context before the WebGPU probe runs on the replacement canvas', async () => {
    await act(async () => { root.render(createElement(ShaderGUI, props)); });
    await flush();
    const webglCanvas = container.querySelector('canvas.top-screen-canvas');
    expect(webglCanvas?.getAttribute('data-visualizer')).toBe('webgl2');
    expect(gl.lost()).toBe(false);

    window.DEBUG_VISUALIZER = 'webgpu';
    await act(async () => { notifyVisualizerPreferenceChanged(); });
    await flush();

    const gpuCanvas = container.querySelector('canvas.top-screen-canvas');
    expect(gpuCanvas?.getAttribute('data-visualizer')).toBe('webgpu');
    expect(gpuCanvas).not.toBe(webglCanvas);
    expect(gl.lost()).toBe(true);
    expect(requestDevice).toHaveBeenCalledOnce();
    expect(order.indexOf('loseContext')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('loseContext')).toBeLessThan(order.indexOf('requestDevice'));
  });

  it('loses the context when ShaderGUI unmounts', async () => {
    await act(async () => { root.render(createElement(ShaderGUI, props)); });
    await flush();
    expect(gl.lost()).toBe(false);

    act(() => root.unmount());
    expect(gl.lost()).toBe(true);
    root = createRoot(container);
  });

  it('keeps the context across StrictMode\'s simulated unmount', async () => {
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(ShaderGUI, props)));
    });
    await flush();
    expect(gl.lost()).toBe(false);
    expect(container.querySelector('[data-webgpu-failure]')).toBeNull();
  });
});
