import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootWebGPUWithRecovery,
  type RecoverableVisualizer,
} from '../src/visuals/webgpu/deviceLostRecovery';
import type {
  WebGPUProbeBreadcrumb,
  WebGPUProbeResult,
  WebGPUProbeSuccess,
} from '../src/visuals/webgpuProbe';

function crumb(status: WebGPUProbeBreadcrumb['status'], reason: string | null = null): WebGPUProbeBreadcrumb {
  return {
    status,
    reason,
    detail: null,
    browser: { brand: 'Google Chrome', version: '140', userAgent: 'test' },
    adapter: null,
    requestedVisualizer: null,
    powerPreference: 'high-performance',
    requestedFeatures: [],
    timestamp: 'now',
  };
}

function success(label: string): WebGPUProbeSuccess {
  return {
    ok: true,
    adapter: {} as GPUAdapter,
    device: { label, destroy: vi.fn() } as unknown as GPUDevice,
    context: {} as GPUCanvasContext,
    format: 'bgra8unorm',
    display: { colorSpace: 'srgb', formatOverride: null },
    breadcrumb: crumb('ready'),
  };
}

/** Mirrors WebGPUVisualizer: owns the probed device, forwards non-'destroyed' losses. */
class FakeVisualizer implements RecoverableVisualizer {
  device: GPUDevice | null = null;
  lostCb: ((reason: string) => void) | null = null;
  destroyed = false;
  setOnDeviceLost(cb: (reason: string) => void): void { this.lostCb = cb; }
  async initialize(_a: AnalyserNode, boot: WebGPUProbeSuccess): Promise<boolean> {
    this.device = boot.device;
    return true;
  }
  getDevice(): GPUDevice | null { return this.device; }
  destroy(): void { this.destroyed = true; }
  loseDevice(reason = 'unknown'): void {
    this.device = null;
    this.lostCb?.(reason);
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('WebGPU device-lost recovery', () => {
  let visualizers: FakeVisualizer[];
  let ready: Array<{ vis: FakeVisualizer; device: GPUDevice }>;
  let fatal: WebGPUProbeBreadcrumb[];
  let lost: FakeVisualizer[];

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    visualizers = [];
    ready = [];
    fatal = [];
    lost = [];
  });

  function boot(probe: () => Promise<WebGPUProbeResult>) {
    return bootWebGPUWithRecovery({
      probe,
      createVisualizer: () => {
        const v = new FakeVisualizer();
        visualizers.push(v);
        return v;
      },
      analyser: {} as AnalyserNode,
      cancelled: () => false,
      onReady: (vis, b) => ready.push({ vis, device: b.device }),
      onLost: (vis) => lost.push(vis),
      onFatal: (b) => fatal.push(b),
    });
  }

  it('re-probes once and configures a second device on the same canvas', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce(success('first'))
      .mockResolvedValueOnce(success('second'));
    await boot(probe);
    expect(ready).toHaveLength(1);

    visualizers[0].loseDevice('unknown');
    await flush();

    expect(probe).toHaveBeenCalledTimes(2);
    expect(lost).toEqual([visualizers[0]]);
    expect(visualizers[0].destroyed).toBe(true);
    expect(ready).toHaveLength(2);
    expect(ready[1].device.label).toBe('second');
    expect(fatal).toHaveLength(0);
  });

  it('shows the fatal panel when the re-probe fails (never a frozen ready canvas)', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce(success('first'))
      .mockResolvedValueOnce({ ok: false, breadcrumb: crumb('failed', 'webgpu-no-adapter') });
    await boot(probe);

    visualizers[0].loseDevice('unknown');
    await flush();

    expect(ready).toHaveLength(1);
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toMatchObject({
      status: 'failed',
      reason: 'webgpu-device-lost',
      detail: expect.stringContaining('webgpu-no-adapter'),
    });
  });

  it('recovers at most once per canvas session', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce(success('first'))
      .mockResolvedValueOnce(success('second'));
    await boot(probe);
    visualizers[0].loseDevice();
    await flush();
    visualizers[1].loseDevice();
    await flush();

    expect(probe).toHaveBeenCalledTimes(2);
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toMatchObject({ status: 'failed', reason: 'webgpu-device-lost' });
  });
});
