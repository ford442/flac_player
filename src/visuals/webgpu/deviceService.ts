import { adoptVisualizerDevice, releaseVisualizerDevice } from '../../gpu-chores/device';
import { buildDeviceDescriptor, readGpuPowerPreference, selectDeviceFeatures } from './canvasConfig';

/**
 * GpuDeviceService — the app's one long-lived GPUDevice (#259 W1).
 *
 * The adapter and device are requested once and lent to ShaderGUI's
 * WebGPUVisualizer, gpu-chores (fft_spectrum / reduce, which also feed the
 * waveform overview) and anything else that renders with WebGPU. Borrowers
 * never destroy the device: a new analyser (sample-rate change), a renderer
 * switch or a canvas remount reuses it. Only a real `device.lost` drops it;
 * the next {@link GpuDeviceService.acquire} then requests a replacement
 * (bootWebGPUWithRecovery bounds how often that happens per canvas session).
 *
 * Adapter policy:
 * - `requestAdapter({ powerPreference })`, then once more with
 *   `featureLevel: 'compatibility'` so GL / D3D11-only devices still get WebGPU.
 * - A fallback adapter (`adapter.info.isFallbackAdapter`, e.g. SwiftShader) is a
 *   CPU-rendered fullscreen shader: refused (`webgpu-fallback-adapter`, static UI)
 *   unless the page opts in with `?webgpu=fallback-ok`.
 */

export type GpuFeatureLevel = 'core' | 'compatibility';

export interface GpuAdapterSummary {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  isFallbackAdapter: boolean;
}

export interface GpuDeviceGrant {
  ok: true;
  adapter: GPUAdapter;
  device: GPUDevice;
  adapterSummary: GpuAdapterSummary;
  requestedFeatures: GPUFeatureName[];
  powerPreference: GPUPowerPreference;
  featureLevel: GpuFeatureLevel;
}

export interface GpuDeviceDenial {
  ok: false;
  reason: string;
  detail: string;
  adapterSummary: GpuAdapterSummary | null;
  requestedFeatures: GPUFeatureName[];
  powerPreference: GPUPowerPreference;
  featureLevel: GpuFeatureLevel | null;
}

export type GpuDeviceResult = GpuDeviceGrant | GpuDeviceDenial;

/** Request/loss counters, published on `window.webgpuProbe` and the HUD. */
export interface GpuDeviceStats {
  adapterRequests: number;
  deviceRequests: number;
  deviceLosses: number;
}

export interface GpuDeviceServiceOptions {
  /** navigator.gpu by default; tests inject a fake. */
  gpu?: () => GPU | null | undefined;
  /** Lend granted devices to gpu-chores (default true for the shared service). */
  lendToChores?: boolean;
  /** `?webgpu=fallback-ok` by default. */
  allowFallbackAdapter?: () => boolean;
}

export interface AcquireOptions {
  powerPreference?: GPUPowerPreference;
}

/** `?webgpu=fallback-ok` accepts a software (fallback) adapter. */
export function readFallbackAdapterOptIn(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): boolean {
  const query = search.startsWith('?') ? search.slice(1) : search;
  return new URLSearchParams(query).get('webgpu') === 'fallback-ok';
}

export function summarizeAdapter(adapter: GPUAdapter): GpuAdapterSummary {
  try {
    const info = adapter.info;
    return {
      vendor: info.vendor || 'unknown',
      architecture: info.architecture || 'unknown',
      device: info.device || 'unknown',
      description: info.description || 'unknown',
      isFallbackAdapter: !!info.isFallbackAdapter,
    };
  } catch {
    return {
      vendor: 'unknown',
      architecture: 'unknown',
      device: 'unknown',
      description: 'unavailable',
      isFallbackAdapter: false,
    };
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type AdapterRequest = GPURequestAdapterOptions & { featureLevel?: GpuFeatureLevel };

export class GpuDeviceService {
  private readonly gpu: () => GPU | null | undefined;
  private readonly lendToChores: boolean;
  private readonly allowFallbackAdapter: () => boolean;
  private grant: GpuDeviceGrant | null = null;
  private pending: Promise<GpuDeviceResult> | null = null;
  private readonly lostListeners = new Set<(reason: string) => void>();
  private readonly counters: GpuDeviceStats = { adapterRequests: 0, deviceRequests: 0, deviceLosses: 0 };

  constructor(options: GpuDeviceServiceOptions = {}) {
    this.gpu = options.gpu ?? (() => (typeof navigator === 'undefined' ? null : navigator.gpu));
    this.lendToChores = options.lendToChores ?? true;
    this.allowFallbackAdapter = options.allowFallbackAdapter ?? (() => readFallbackAdapterOptIn());
  }

  get stats(): GpuDeviceStats {
    return { ...this.counters };
  }

  /** The live device, if one has been granted and not lost. */
  get device(): GPUDevice | null {
    return this.grant?.device ?? null;
  }

  /**
   * The shared device, requesting it on first use. Concurrent callers share one
   * request. A denial is not cached: the next call (a remount or preference
   * change) asks again.
   */
  acquire(options: AcquireOptions = {}): Promise<GpuDeviceResult> {
    if (this.grant) return Promise.resolve(this.grant);
    if (!this.pending) {
      const request = this.request(options.powerPreference ?? readGpuPowerPreference());
      this.pending = request;
      void request.finally(() => {
        if (this.pending === request) this.pending = null;
      });
    }
    return this.pending;
  }

  /** Called with the loss reason when the shared device is lost (never for `destroy()`). */
  onLost(listener: (reason: string) => void): () => void {
    this.lostListeners.add(listener);
    return () => {
      this.lostListeners.delete(listener);
    };
  }

  /** Destroy the device (tests, or a transient probe whose canvas failed). */
  destroy(): void {
    const grant = this.grant;
    this.grant = null;
    if (!grant) return;
    if (this.lendToChores) releaseVisualizerDevice(grant.device);
    try {
      grant.device.destroy();
    } catch {
      /* already destroyed */
    }
  }

  private async request(powerPreference: GPUPowerPreference): Promise<GpuDeviceResult> {
    const deny = (
      reason: string,
      detail: string,
      adapterSummary: GpuAdapterSummary | null = null,
      requestedFeatures: GPUFeatureName[] = [],
      featureLevel: GpuFeatureLevel | null = null,
    ): GpuDeviceDenial => ({
      ok: false, reason, detail, adapterSummary, requestedFeatures, powerPreference, featureLevel,
    });

    const gpu = this.gpu();
    if (!gpu) return deny('webgpu-unsupported', 'navigator.gpu is unavailable');

    let adapter: GPUAdapter | null = null;
    let featureLevel: GpuFeatureLevel = 'core';
    try {
      this.counters.adapterRequests += 1;
      adapter = await gpu.requestAdapter({ powerPreference });
      if (!adapter) {
        // GL / D3D11-only devices only expose a compatibility adapter.
        this.counters.adapterRequests += 1;
        featureLevel = 'compatibility';
        adapter = await gpu.requestAdapter({ powerPreference, featureLevel } as AdapterRequest);
      }
    } catch (error) {
      return deny('webgpu-adapter-request-failed', errorDetail(error), null, [], featureLevel);
    }
    if (!adapter) {
      return deny('webgpu-no-adapter', 'navigator.gpu.requestAdapter() returned null', null, [], null);
    }

    const adapterSummary = summarizeAdapter(adapter);
    if (adapterSummary.isFallbackAdapter && !this.allowFallbackAdapter()) {
      return deny(
        'webgpu-fallback-adapter',
        'Only a software (fallback) adapter is available; the visualizer would render on the CPU. '
          + 'Add ?webgpu=fallback-ok to use it anyway.',
        adapterSummary,
        [],
        featureLevel,
      );
    }

    const requestedFeatures = selectDeviceFeatures(adapter);
    let device: GPUDevice;
    try {
      this.counters.deviceRequests += 1;
      device = await adapter.requestDevice(buildDeviceDescriptor(adapter));
    } catch (error) {
      return deny('webgpu-device-request-failed', errorDetail(error), adapterSummary, requestedFeatures, featureLevel);
    }

    const grant: GpuDeviceGrant = {
      ok: true, adapter, device, adapterSummary, requestedFeatures, powerPreference, featureLevel,
    };
    this.grant = grant;
    // Registered before any borrower's handler, so the grant is gone by the time a
    // borrower reacts to the loss and re-acquires.
    void device.lost?.then((info) => {
      if (this.grant === grant) this.grant = null;
      if (this.lendToChores) releaseVisualizerDevice(device);
      if (info.reason === 'destroyed') return;
      this.counters.deviceLosses += 1;
      console.warn('[GpuDeviceService] device lost:', info.reason, info.message);
      for (const listener of this.lostListeners) {
        try {
          listener(info.reason);
        } catch (err) {
          console.warn('[GpuDeviceService] lost listener threw', err);
        }
      }
    });
    if (this.lendToChores) adoptVisualizerDevice(device);
    return grant;
  }
}

/** The app-wide service (ShaderGUI probe, gpu-chores). */
export const gpuDeviceService = new GpuDeviceService();
