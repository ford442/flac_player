import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_RECOVERY_WINDOW_MS,
  MAX_DEVICE_RECOVERIES,
  startWebGPUSession,
  type SessionVisualizer,
} from '../src/visuals/webgpuSession';
import type {
  WebGPUProbeBreadcrumb,
  WebGPUProbeResult,
  WebGPUProbeSuccess,
} from '../src/visuals/webgpuProbe';

const analyser = {} as AnalyserNode;
const canvas = {} as HTMLCanvasElement;

function breadcrumb(overrides: Partial<WebGPUProbeBreadcrumb> = {}): WebGPUProbeBreadcrumb {
  return {
    status: 'ready',
    reason: null,
    detail: null,
    browser: { brand: 'Google Chrome', version: '130', userAgent: 'test' },
    adapter: null,
    requestedVisualizer: null,
    powerPreference: 'high-performance',
    requestedFeatures: [],
    timestamp: new Date(0).toISOString(),
    ...overrides,
  };
}

function probeSuccess(): WebGPUProbeSuccess {
  return {
    ok: true,
    adapter: {} as GPUAdapter,
    device: { destroy: vi.fn() } as unknown as GPUDevice,
    context: {} as GPUCanvasContext,
    format: 'bgra8unorm',
    display: { colorSpace: 'srgb', formatOverride: null },
    breadcrumb: breadcrumb(),
  };
}

class FakeVisualizer implements SessionVisualizer {
  static instances: FakeVisualizer[] = [];
  static initializeError: Error | null = null;
  device: GPUDevice | null = null;
  destroyed = false;
  private onLost: (reason: string) => void = () => {};
  /** Resolves initialize(); defaults to immediate. */
  gate: Promise<void> = Promise.resolve();

  constructor() {
    FakeVisualizer.instances.push(this);
  }

  setOnDeviceLost(cb: (reason: string) => void): void {
    this.onLost = cb;
  }

  async initialize(_analyser: AnalyserNode, boot: WebGPUProbeSuccess): Promise<boolean> {
    this.device = boot.device;
    await this.gate;
    if (FakeVisualizer.initializeError) throw FakeVisualizer.initializeError;
    return true;
  }

  getDevice(): GPUDevice | null {
    return this.device;
  }

  destroy(): void {
    this.destroyed = true;
    this.device = null;
  }

  /** Mirrors WebGPUVisualizer: a loss we did not cause reaches the callback. */
  lose(reason: string): void {
    this.device = null;
    if (!this.destroyed) this.onLost(reason);
  }
}

function harness(extra: { probes?: WebGPUProbeResult[]; now?: () => number } = {}) {
  const probes = extra.probes ?? [];
  const probe = vi.fn(async () => probes.shift() ?? probeSuccess());
  const events = {
    ready: vi.fn<(v: FakeVisualizer, boot: WebGPUProbeSuccess) => void>(),
    lost: vi.fn<(v: FakeVisualizer) => void>(),
    fatal: vi.fn<(b: WebGPUProbeBreadcrumb) => void>(),
  };
  const adoptDevice = vi.fn();
  const releaseDevice = vi.fn();
  let cancelled = false;
  const start = () => startWebGPUSession({
    canvas,
    analyser,
    requestedVisualizer: 'webgpu',
    isCancelled: () => cancelled,
    createVisualizer: () => new FakeVisualizer(),
    onReady: events.ready,
    onLost: events.lost,
    onFatal: events.fatal,
    deps: { probe: probe as never, adoptDevice, releaseDevice, now: extra.now },
  });
  return {
    probe, events, adoptDevice, releaseDevice, start,
    cancel: () => { cancelled = true; },
    visualizer: (i: number) => FakeVisualizer.instances[i],
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('WebGPU device loss', () => {
  beforeEach(() => {
    FakeVisualizer.instances = [];
    FakeVisualizer.initializeError = null;
    delete window.webgpuProbe;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adopts the probed device on first boot', async () => {
    const h = harness();
    await h.start();
    expect(h.probe).toHaveBeenCalledOnce();
    expect(h.adoptDevice).toHaveBeenCalledWith(h.visualizer(0).device);
    expect(h.events.ready).toHaveBeenCalledOnce();
    expect(h.events.fatal).not.toHaveBeenCalled();
  });

  it('re-requests the device through the probe and rebinds visualizer and gpu-chores', async () => {
    const h = harness();
    await h.start();
    const first = h.visualizer(0);
    const firstDevice = first.device;

    first.lose('unknown');
    await settle();

    expect(h.probe).toHaveBeenCalledTimes(2);
    // Same canvas, same visualizer options: the probe is the only way to get a device.
    expect(h.probe).toHaveBeenLastCalledWith(canvas, { requestedVisualizer: 'webgpu' });
    expect(h.releaseDevice).toHaveBeenCalledWith(firstDevice);
    expect(h.events.lost).toHaveBeenCalledWith(first);
    expect(first.destroyed).toBe(true);

    const second = h.visualizer(1);
    expect(second).not.toBe(first);
    expect(h.events.ready).toHaveBeenCalledTimes(2);
    expect(h.events.ready.mock.calls[1][0]).toBe(second);
    expect(h.adoptDevice).toHaveBeenLastCalledWith(second.device);
    expect(second.device).not.toBe(firstDevice);
    expect(h.events.fatal).not.toHaveBeenCalled();
  });

  it('stays on the fatal panel without retrying when the device was destroyed', async () => {
    const h = harness();
    await h.start();
    h.visualizer(0).lose('destroyed');
    await settle();

    expect(h.probe).toHaveBeenCalledOnce();
    expect(h.events.ready).toHaveBeenCalledOnce();
    expect(h.events.fatal).toHaveBeenCalledOnce();
    expect(h.events.fatal.mock.calls[0][0]).toMatchObject({
      status: 'failed',
      reason: 'webgpu-device-lost',
      detail: 'destroyed',
    });
    expect(h.releaseDevice).toHaveBeenCalled();
  });

  it('ignores the loss caused by its own destroy()', async () => {
    const h = harness();
    await h.start();
    h.visualizer(0).destroy();
    h.visualizer(0).lose('destroyed');
    await settle();
    expect(h.probe).toHaveBeenCalledOnce();
    expect(h.events.fatal).not.toHaveBeenCalled();
  });

  it('gives up after a burst of losses, then recovers again once the window has passed', async () => {
    let clock = 1_000;
    const h = harness({ now: () => clock });
    await h.start();

    for (let i = 0; i < MAX_DEVICE_RECOVERIES; i += 1) {
      h.visualizer(i).lose('unknown');
      await settle();
    }
    expect(h.probe).toHaveBeenCalledTimes(1 + MAX_DEVICE_RECOVERIES);
    expect(h.events.fatal).not.toHaveBeenCalled();

    h.visualizer(MAX_DEVICE_RECOVERIES).lose('unknown');
    await settle();
    expect(h.probe).toHaveBeenCalledTimes(1 + MAX_DEVICE_RECOVERIES);
    expect(h.events.fatal).toHaveBeenCalledOnce();
    expect(h.events.fatal.mock.calls[0][0]).toMatchObject({ reason: 'webgpu-device-lost' });
    expect(h.events.fatal.mock.calls[0][0].detail).toContain('gave up');
  });

  it('forgets recoveries older than the window', async () => {
    let clock = 1_000;
    const h = harness({ now: () => clock });
    await h.start();
    for (let i = 0; i < MAX_DEVICE_RECOVERIES; i += 1) {
      h.visualizer(i).lose('unknown');
      await settle();
    }
    clock += DEVICE_RECOVERY_WINDOW_MS + 1;
    h.visualizer(MAX_DEVICE_RECOVERIES).lose('unknown');
    await settle();
    expect(h.probe).toHaveBeenCalledTimes(2 + MAX_DEVICE_RECOVERIES);
    expect(h.events.fatal).not.toHaveBeenCalled();
  });

  it('reports a failed re-request as a device loss, not a silent blank canvas', async () => {
    const failure: WebGPUProbeResult = {
      ok: false,
      breadcrumb: breadcrumb({ status: 'failed', reason: 'webgpu-no-adapter' }),
    };
    const h = harness({ probes: [probeSuccess(), failure] });
    await h.start();
    h.visualizer(0).lose('unknown');
    await settle();

    expect(h.events.fatal).toHaveBeenCalledOnce();
    expect(h.events.fatal.mock.calls[0][0]).toMatchObject({
      reason: 'webgpu-device-lost',
      detail: 'unknown; re-request failed: webgpu-no-adapter',
    });
  });

  it('keeps the first-boot probe failure as is', async () => {
    const failure: WebGPUProbeResult = {
      ok: false,
      breadcrumb: breadcrumb({ status: 'failed', reason: 'webgpu-unsupported' }),
    };
    const h = harness({ probes: [failure] });
    await h.start();
    expect(h.events.fatal).toHaveBeenCalledWith(failure.breadcrumb);
    expect(h.adoptDevice).not.toHaveBeenCalled();
  });

  it('destroys a device re-requested after the session was cancelled', async () => {
    const recovered = probeSuccess();
    const h = harness({ probes: [probeSuccess(), recovered] });
    await h.start();
    h.probe.mockImplementationOnce(async () => {
      h.cancel();
      return recovered;
    });
    h.visualizer(0).lose('unknown');
    await settle();

    expect(recovered.device.destroy).toHaveBeenCalledOnce();
    expect(h.events.ready).toHaveBeenCalledOnce();
    expect(FakeVisualizer.instances).toHaveLength(1);
  });

  it('replays a loss that lands while initialize() is still running', async () => {
    const h = harness();
    const original = FakeVisualizer.prototype.initialize;
    let release: () => void = () => {};
    vi.spyOn(FakeVisualizer.prototype, 'initialize').mockImplementationOnce(async function (
      this: FakeVisualizer,
      a: AnalyserNode,
      boot: WebGPUProbeSuccess,
    ) {
      this.gate = new Promise<void>((resolve) => { release = resolve; });
      return original.call(this, a, boot);
    });
    const started = h.start();
    await settle();
    h.visualizer(0).lose('unknown');
    release();
    await started;
    await settle();

    expect(h.events.ready).toHaveBeenCalledOnce();
    expect(h.probe).toHaveBeenCalledTimes(2);
    expect(h.adoptDevice).toHaveBeenCalledOnce();
    expect(h.adoptDevice).toHaveBeenCalledWith(h.visualizer(1).device);
  });

  it('reports initialize() failure as such, not as a device loss', async () => {
    FakeVisualizer.initializeError = new Error('shader compile failed');
    const h = harness();
    await h.start();
    await settle();
    expect(h.events.fatal).toHaveBeenCalledOnce();
    expect(h.events.fatal.mock.calls[0][0]).toMatchObject({
      reason: 'webgpu-visualizer-initialize-failed',
      detail: 'shader compile failed',
    });
    expect(h.visualizer(0).destroyed).toBe(true);
  });
});

describe('single GPUDevice', () => {
  const srcRoot = path.resolve(__dirname, '../src');

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'build' ? [] : sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });
  }

  it('requests adapters and devices only in webgpuProbe.ts', () => {
    const offenders = sourceFiles(srcRoot).filter((file) => {
      if (file.endsWith(path.join('visuals', 'webgpuProbe.ts'))) return false;
      return fs.readFileSync(file, 'utf8').split('\n').some((line) => {
        const code = line.trim();
        if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return false;
        return /\.request(Device|Adapter)\s*\(/.test(code);
      });
    });
    expect(offenders.map((file) => path.relative(srcRoot, file))).toEqual([]);
  });
});
