import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GpuDeviceService } from '../src/visuals/webgpu/deviceService';
import { probeWebGPU } from '../src/visuals/webgpuProbe';
import { WebGPUVisualizer } from '../src/visuals/webgpuVisualizer';
import { fakeAdapter, fakeDevice, fakeGpu, installGpuEnums } from './helpers/fakeGpu';

const flush = () => new Promise((r) => setTimeout(r, 0));

function canvas(): HTMLCanvasElement {
  const el = document.createElement('canvas');
  const context = { configure: vi.fn(), unconfigure: vi.fn(), getCurrentTexture: vi.fn(() => ({ createView: vi.fn() })) };
  vi.spyOn(el, 'getContext').mockImplementation(((kind: string) => (kind === 'webgpu' ? context : null)) as never);
  return el;
}

function analyserAt(sampleRate: number): AnalyserNode {
  return { context: { sampleRate }, frequencyBinCount: 1024 } as unknown as AnalyserNode;
}

describe('GpuDeviceService (#259 W1/W2)', () => {
  let restoreEnums: () => void;
  beforeEach(() => {
    restoreEnums = installGpuEnums();
    delete window.webgpuProbe;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    restoreEnums();
    vi.restoreAllMocks();
  });

  it('requests the adapter and device once for concurrent and later borrowers', async () => {
    const dev = fakeDevice();
    const adapter = fakeAdapter(() => dev.device);
    const gpu = fakeGpu({ core: adapter });
    const service = new GpuDeviceService({ gpu: () => gpu, lendToChores: false });

    const [a, b] = await Promise.all([service.acquire(), service.acquire()]);
    const c = await service.acquire();
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(adapter.requestDevice).toHaveBeenCalledOnce();
    expect(service.stats).toEqual({ adapterRequests: 1, deviceRequests: 1, deviceLosses: 0 });
  });

  it('retries requestAdapter with featureLevel "compatibility"', async () => {
    const dev = fakeDevice();
    const gpu = fakeGpu({ core: null, compatibility: fakeAdapter(() => dev.device) });
    const service = new GpuDeviceService({ gpu: () => gpu, lendToChores: false });

    const result = await service.acquire({ powerPreference: 'high-performance' });
    expect(result).toMatchObject({ ok: true, featureLevel: 'compatibility' });
    expect(gpu.requestAdapter).toHaveBeenLastCalledWith({ powerPreference: 'high-performance', featureLevel: 'compatibility' });
  });

  it('refuses a fallback (software) adapter unless ?webgpu=fallback-ok', async () => {
    const dev = fakeDevice();
    const adapter = fakeAdapter(() => dev.device, { isFallbackAdapter: true });
    const gpu = fakeGpu({ core: adapter });

    const strict = new GpuDeviceService({ gpu: () => gpu, lendToChores: false, allowFallbackAdapter: () => false });
    expect(await strict.acquire()).toMatchObject({
      ok: false,
      reason: 'webgpu-fallback-adapter',
      adapterSummary: { isFallbackAdapter: true },
    });
    expect(adapter.requestDevice).not.toHaveBeenCalled();

    const optedIn = new GpuDeviceService({ gpu: () => gpu, lendToChores: false, allowFallbackAdapter: () => true });
    expect(await optedIn.acquire()).toMatchObject({ ok: true });
  });

  it('replaces a lost device on the next acquire and tells listeners', async () => {
    const first = fakeDevice();
    const second = fakeDevice();
    const devices = [first.device, second.device];
    const adapter = fakeAdapter(() => devices.shift()!);
    const service = new GpuDeviceService({ gpu: () => fakeGpu({ core: adapter }), lendToChores: false });
    const onLost = vi.fn();
    service.onLost(onLost);

    const a = await service.acquire();
    first.lose('unknown');
    await flush();
    const b = await service.acquire();

    expect(onLost).toHaveBeenCalledWith('unknown');
    expect(a.ok && b.ok && a.device !== b.device).toBe(true);
    expect(service.stats).toMatchObject({ deviceRequests: 2, deviceLosses: 1 });
  });

  it('keeps the same GPUDevice when the analyser is replaced (sample-rate change)', async () => {
    const dev = fakeDevice();
    const adapter = fakeAdapter(() => dev.device);
    const service = new GpuDeviceService({ gpu: () => fakeGpu({ core: adapter }), lendToChores: false });
    const el = canvas();

    const boot = await probeWebGPU(el, { deviceService: service, browser: { brand: 'x', version: null, userAgent: '' } });
    if (!boot.ok) throw new Error(boot.breadcrumb.reason ?? 'probe failed');
    const visualizer = new WebGPUVisualizer(el);
    await visualizer.initialize(analyserAt(44_100), boot);

    // Graph rebuilt at 96 kHz: the visualizer gets the new analyser, nothing GPU-side changes.
    visualizer.setAnalyser(analyserAt(96_000));
    expect(visualizer.getDevice()).toBe(dev.device);
    expect(adapter.requestDevice).toHaveBeenCalledOnce();
    expect(window.webgpuProbe).toMatchObject({ status: 'ready', deviceRequests: 1 });
    expect(boot.context.configure).toHaveBeenCalledOnce();

    // A remount on a fresh canvas borrows the same device too.
    const again = await probeWebGPU(canvas(), { deviceService: service, browser: { brand: 'x', version: null, userAgent: '' } });
    expect(again.ok && again.device).toBe(dev.device);
    expect(window.webgpuProbe?.deviceRequests).toBe(1);

    visualizer.resize();
    expect(boot.context.configure).toHaveBeenCalledOnce();
    visualizer.destroy();
    expect(dev.destroy).not.toHaveBeenCalled();
  });

  it('removes its window listeners on destroy', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const visualizer = new WebGPUVisualizer(canvas());
    visualizer.destroy();
    for (const type of ['mousemove', 'mouseup']) {
      const handler = add.mock.calls.find(([t]) => t === type)?.[1];
      expect(handler).toBeDefined();
      expect(remove).toHaveBeenCalledWith(type, handler);
    }
  });
});

describe('WebGPUVisualizer pipeline errors (#259 W4)', () => {
  let restoreEnums: () => void;
  beforeEach(() => {
    restoreEnums = installGpuEnums();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    restoreEnums();
    vi.restoreAllMocks();
  });

  async function boot(dev: ReturnType<typeof fakeDevice>) {
    const service = new GpuDeviceService({ gpu: () => fakeGpu({ core: fakeAdapter(() => dev.device) }), lendToChores: false });
    const el = canvas();
    const result = await probeWebGPU(el, { deviceService: service, publish: false });
    if (!result.ok) throw new Error('probe failed');
    return { el, result };
  }

  it('rejects initialize on a GPUPipelineError instead of reporting ready', async () => {
    const dev = fakeDevice({ failPipeline: /^gui/ });
    const { el, result } = await boot(dev);
    await expect(new WebGPUVisualizer(el).initialize(null, result)).rejects.toThrow(/webgpu-pipeline-error: gui/);
    expect(dev.scopeDepth()).toBe(0);
  });

  it('rejects initialize on a validation error in resource creation', async () => {
    const dev = fakeDevice({ scopeError: 'Binding size mismatch' });
    const { el, result } = await boot(dev);
    await expect(new WebGPUVisualizer(el).initialize(null, result)).rejects.toThrow(/webgpu-validation-error: .*Binding size mismatch/);
    expect(dev.scopeDepth()).toBe(0);
  });

  it('builds the cube pipeline only on first 3D use', async () => {
    const dev = fakeDevice();
    const { el, result } = await boot(dev);
    const visualizer = new WebGPUVisualizer(el);
    await visualizer.initialize(null, result);
    const create = dev.device.createRenderPipelineAsync as unknown as ReturnType<typeof vi.fn>;
    const labels = () => create.mock.calls.map(([d]) => (d as GPURenderPipelineDescriptor).label);
    expect(labels()).not.toContain('cube');
    visualizer.setMode('3D');
    await flush();
    expect(labels()).toContain('cube');
  });
});
