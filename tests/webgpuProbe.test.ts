import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  identifyBrowser,
  probeWebGPU,
  type BrowserIdentity,
} from '../src/visuals/webgpuProbe';

const chrome: BrowserIdentity = {
  brand: 'Google Chrome',
  version: '130',
  userAgent: 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36',
};

function adapterInfo() {
  return {
    vendor: 'test-vendor',
    architecture: 'test-architecture',
    device: 'test-device',
    description: 'Test GPU',
    isFallbackAdapter: false,
  };
}

function fakeGpu(adapter: GPUAdapter | null) {
  return {
    requestAdapter: vi.fn(async () => adapter),
    getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm' as GPUTextureFormat),
  } as unknown as GPU;
}

describe('WebGPU boot probe', () => {
  beforeEach(() => {
    delete window.webgpuProbe;
    vi.restoreAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  it('distinguishes Edge from Chrome in adapter-failure JSON', async () => {
    const canvas = { getContext: vi.fn() } as unknown as HTMLCanvasElement;
    const edge = identifyBrowser({
      userAgent: 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    });
    const detectedChrome = identifyBrowser({
      userAgent: chrome.userAgent,
    });

    const edgeResult = await probeWebGPU(canvas, {
      gpu: fakeGpu(null),
      browser: edge,
    });
    expect(edgeResult.ok).toBe(false);
    expect(window.webgpuProbe).toMatchObject({
      status: 'failed',
      reason: 'webgpu-no-adapter',
      browser: { brand: 'Microsoft Edge' },
      adapter: null,
    });

    const chromeResult = await probeWebGPU(canvas, {
      gpu: fakeGpu(null),
      browser: detectedChrome,
    });
    expect(chromeResult.ok).toBe(false);
    expect(window.webgpuProbe).toMatchObject({
      status: 'failed',
      reason: 'webgpu-no-adapter',
      browser: { brand: 'Google Chrome' },
      adapter: null,
    });
  });

  it('does not retry device creation after a failed device request', async () => {
    const requestDevice = vi.fn(async () => {
      throw new Error('device rejected');
    });
    const adapter = {
      info: adapterInfo(),
      requestDevice,
    } as unknown as GPUAdapter;
    const getContext = vi.fn();

    const result = await probeWebGPU(
      { getContext } as unknown as HTMLCanvasElement,
      { gpu: fakeGpu(adapter), browser: chrome },
    );

    expect(result.ok).toBe(false);
    expect(requestDevice).toHaveBeenCalledOnce();
    expect(getContext).not.toHaveBeenCalled();
    expect(window.webgpuProbe).toMatchObject({
      reason: 'webgpu-device-request-failed',
      adapter: { description: 'Test GPU' },
    });
  });

  it('destroys the probed device when the visualizer canvas has no WebGPU context', async () => {
    const destroy = vi.fn();
    const device = { destroy } as unknown as GPUDevice;
    const requestDevice = vi.fn(async () => device);
    const adapter = {
      info: adapterInfo(),
      requestDevice,
    } as unknown as GPUAdapter;
    const getContext = vi.fn(() => null);

    const result = await probeWebGPU(
      { getContext } as unknown as HTMLCanvasElement,
      { gpu: fakeGpu(adapter), browser: chrome },
    );

    expect(result.ok).toBe(false);
    expect(requestDevice).toHaveBeenCalledOnce();
    expect(getContext).toHaveBeenCalledWith('webgpu');
    expect(destroy).toHaveBeenCalledOnce();
    expect(window.webgpuProbe?.reason).toBe('webgpu-no-context');
  });

  it('destroys the probed device when requesting the WebGPU canvas context throws', async () => {
    const destroy = vi.fn();
    const device = { destroy } as unknown as GPUDevice;
    const adapter = {
      info: adapterInfo(),
      requestDevice: vi.fn(async () => device),
    } as unknown as GPUAdapter;

    const result = await probeWebGPU(
      {
        getContext: vi.fn(() => {
          throw new Error('context blocked');
        }),
      } as unknown as HTMLCanvasElement,
      { gpu: fakeGpu(adapter), browser: chrome },
    );

    expect(result.ok).toBe(false);
    expect(destroy).toHaveBeenCalledOnce();
    expect(window.webgpuProbe).toMatchObject({
      reason: 'webgpu-context-request-failed',
      detail: 'context blocked',
    });
  });

  it('returns the same adapter, device, and context configured for the visualizer', async () => {
    const device = { destroy: vi.fn() } as unknown as GPUDevice;
    const adapter = {
      info: adapterInfo(),
      requestDevice: vi.fn(async () => device),
    } as unknown as GPUAdapter;
    const context = { configure: vi.fn() } as unknown as GPUCanvasContext;
    const gpu = fakeGpu(adapter);

    const result = await probeWebGPU(
      { getContext: vi.fn(() => context) } as unknown as HTMLCanvasElement,
      { gpu, browser: chrome, requestedVisualizer: 'webgl2' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected successful WebGPU probe');
    expect(result.adapter).toBe(adapter);
    expect(result.device).toBe(device);
    expect(result.context).toBe(context);
    expect(context.configure).toHaveBeenCalledWith({
      device,
      format: 'bgra8unorm',
      alphaMode: 'opaque',
    });
    expect(result.breadcrumb).toMatchObject({
      status: 'ready',
      requestedVisualizer: 'webgl2',
      adapter: { description: 'Test GPU' },
    });
  });
});
