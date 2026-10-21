import type { VisualizerBackend } from './types';
import { debug } from '../utils/debug';
import {
  buildCanvasConfiguration,
  DEFAULT_CANVAS_DISPLAY,
  readGpuPowerPreference,
  resolveCanvasDisplay,
  type CanvasDisplayOptions,
} from './webgpu/canvasConfig';
import {
  GpuDeviceService,
  gpuDeviceService,
  type GpuAdapterSummary,
  type GpuFeatureLevel,
} from './webgpu/deviceService';

export interface BrowserIdentity {
  brand: string;
  version: string | null;
  userAgent: string;
}

export type WebGPUAdapterSummary = GpuAdapterSummary;

export type WebGPUProbeStatus = 'probing' | 'ready' | 'failed';

export interface WebGPUProbeBreadcrumb {
  status: WebGPUProbeStatus;
  reason: string | null;
  detail: string | null;
  browser: BrowserIdentity;
  adapter: WebGPUAdapterSummary | null;
  requestedVisualizer: VisualizerBackend | null;
  powerPreference: GPUPowerPreference;
  requestedFeatures: GPUFeatureName[];
  /** Canvas color space / tone mapping actually configured (ready only). */
  display?: CanvasDisplayOptions;
  /** Smoothed ShaderGUI GPU pass time (timestamp-query); null until measured / unsupported. */
  gpuTimeMs?: number | null;
  /** Count of `uncapturederror` events on the visualizer device (validation / OOM / internal). */
  uncapturedErrors?: number;
  /** Message of the first uncaptured GPU error (later ones only bump the count). */
  firstUncapturedError?: string | null;
  /** Successful device-lost re-probes on this canvas session (0 or 1). */
  deviceLostRecoveries?: number;
  /** 'compatibility' when only a GL / D3D11-class adapter was available. */
  featureLevel?: GpuFeatureLevel | null;
  /**
   * GpuDeviceService counters at probe time. `deviceRequests` stays 1 across
   * sample-rate changes (the analyser is swapped, the device is kept).
   */
  adapterRequests?: number;
  deviceRequests?: number;
  deviceLosses?: number;
  /** WebGL2 opt-in: attributes the browser granted (requested ones on failure). */
  glAttributes?: WebGLContextAttributes;
  timestamp: string;
}

export interface WebGPUProbeSuccess {
  ok: true;
  adapter: GPUAdapter;
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  display: CanvasDisplayOptions;
  breadcrumb: WebGPUProbeBreadcrumb;
}

export interface WebGPUProbeFailure {
  ok: false;
  breadcrumb: WebGPUProbeBreadcrumb;
}

export type WebGPUProbeResult = WebGPUProbeSuccess | WebGPUProbeFailure;

export interface BrowserIdentityInput {
  userAgent?: string;
  brands?: Array<{ brand: string; version: string }>;
}

export interface WebGPUProbeOptions {
  gpu?: GPU | null;
  browser?: BrowserIdentity;
  requestedVisualizer?: VisualizerBackend | null;
  publish?: boolean;
  powerPreference?: GPUPowerPreference;
  /** Defaults to resolveCanvasDisplay() (sRGB; P3 only with ?p3=1, HDR only with ?hdr=1). */
  display?: CanvasDisplayOptions;
  /**
   * Where the device comes from. Default: the app-wide {@link gpuDeviceService},
   * or — when `gpu` is injected (tests) — a private service whose device is
   * destroyed if the canvas cannot be configured.
   */
  deviceService?: GpuDeviceService;
}

declare global {
  interface Window {
    webgpuProbe?: WebGPUProbeBreadcrumb;
  }
}

function userAgentBrands(): Array<{ brand: string; version: string }> {
  const nav = navigator as Navigator & {
    userAgentData?: { brands?: Array<{ brand: string; version: string }> };
  };
  return nav.userAgentData?.brands ?? [];
}

/** Produce a stable browser brand for Chrome-vs-Edge probe diagnostics. */
export function identifyBrowser(input: BrowserIdentityInput = {}): BrowserIdentity {
  const userAgent = input.userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const brands = input.brands ?? (typeof navigator === 'undefined' ? [] : userAgentBrands());
  const edgeBrand = brands.find(({ brand }) => /Microsoft Edge/i.test(brand));
  const chromeBrand = brands.find(({ brand }) => /Google Chrome/i.test(brand));
  const chromiumBrand = brands.find(({ brand }) => /^Chromium$/i.test(brand));

  if (edgeBrand || /Edg\//.test(userAgent)) {
    return {
      brand: 'Microsoft Edge',
      version: edgeBrand?.version ?? userAgent.match(/Edg\/([\d.]+)/)?.[1] ?? null,
      userAgent,
    };
  }
  if (chromeBrand || /Chrome\//.test(userAgent)) {
    return {
      brand: 'Google Chrome',
      version: chromeBrand?.version ?? userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? null,
      userAgent,
    };
  }
  if (chromiumBrand || /Chromium\//.test(userAgent)) {
    return {
      brand: 'Chromium',
      version: chromiumBrand?.version ?? userAgent.match(/Chromium\/([\d.]+)/)?.[1] ?? null,
      userAgent,
    };
  }
  return { brand: 'Unknown', version: null, userAgent };
}

function breadcrumb(
  status: WebGPUProbeStatus,
  browser: BrowserIdentity,
  requestedVisualizer: VisualizerBackend | null,
  adapter: WebGPUAdapterSummary | null,
  reason: string | null = null,
  detail: string | null = null,
  powerPreference: GPUPowerPreference = 'high-performance',
  requestedFeatures: GPUFeatureName[] = [],
): WebGPUProbeBreadcrumb {
  return {
    status,
    reason,
    detail,
    browser,
    adapter,
    requestedVisualizer,
    powerPreference,
    requestedFeatures,
    timestamp: new Date().toISOString(),
  };
}

export function publishWebGPUProbe(value: WebGPUProbeBreadcrumb): WebGPUProbeBreadcrumb {
  if (typeof window !== 'undefined') window.webgpuProbe = value;
  debug.log('webgpuProbe', JSON.stringify(value));
  return value;
}

function failure(
  reason: string,
  detail: string | null,
  browser: BrowserIdentity,
  requestedVisualizer: VisualizerBackend | null,
  adapter: WebGPUAdapterSummary | null,
  publish: boolean,
  powerPreference: GPUPowerPreference = 'high-performance',
  requestedFeatures: GPUFeatureName[] = [],
): WebGPUProbeFailure {
  const value = breadcrumb(
    'failed',
    browser,
    requestedVisualizer,
    adapter,
    reason,
    detail,
    powerPreference,
    requestedFeatures,
  );
  if (publish) publishWebGPUProbe(value);
  return { ok: false, breadcrumb: value };
}

const watchedDevices = new WeakSet<GPUDevice>();

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Borrow the shared WebGPU device (GpuDeviceService) and configure the visualizer
 * canvas with it — the canvas's only `configure()`. A failed result never falls
 * through to another renderer.
 */
export async function probeWebGPU(
  canvas: HTMLCanvasElement,
  options: WebGPUProbeOptions = {},
): Promise<WebGPUProbeResult> {
  const browser = options.browser ?? identifyBrowser();
  const requestedVisualizer = options.requestedVisualizer ?? null;
  const shouldPublish = options.publish !== false;
  const powerPreference = options.powerPreference ?? readGpuPowerPreference();
  const ownsService = !options.deviceService && options.gpu !== undefined;
  const service = options.deviceService
    ?? (ownsService ? new GpuDeviceService({ gpu: () => options.gpu, lendToChores: false }) : gpuDeviceService);

  if (shouldPublish) {
    publishWebGPUProbe(breadcrumb(
      'probing', browser, requestedVisualizer, null, null, null, powerPreference,
    ));
  }

  const granted = await service.acquire({ powerPreference });
  if (!granted.ok) {
    const failed = failure(
      granted.reason,
      granted.detail,
      browser,
      requestedVisualizer,
      granted.adapterSummary,
      false,
      powerPreference,
      granted.requestedFeatures,
    );
    Object.assign(failed.breadcrumb, { featureLevel: granted.featureLevel }, service.stats);
    if (shouldPublish) publishWebGPUProbe(failed.breadcrumb);
    return failed;
  }
  const { adapter, device, adapterSummary, requestedFeatures, featureLevel } = granted;
  // A shared device outlives this canvas; only a private (test) service's device dies with it.
  const releaseDevice = () => {
    if (ownsService) service.destroy();
  };
  const fail = (reason: string, detail: string): WebGPUProbeFailure => {
    releaseDevice();
    const failed = failure(
      reason, detail, browser, requestedVisualizer, adapterSummary, false, powerPreference, requestedFeatures,
    );
    Object.assign(failed.breadcrumb, { featureLevel }, service.stats);
    if (shouldPublish) publishWebGPUProbe(failed.breadcrumb);
    return failed;
  };

  let context: GPUCanvasContext | null;
  try {
    context = canvas.getContext('webgpu') as GPUCanvasContext | null;
  } catch (error) {
    return fail('webgpu-context-request-failed', errorDetail(error));
  }
  if (!context) {
    return fail('webgpu-no-context', "visualizerCanvas.getContext('webgpu') returned null");
  }

  const gpu = options.gpu ?? (typeof navigator === 'undefined' ? null : navigator.gpu);
  const preferredFormat = (): GPUTextureFormat => gpu?.getPreferredCanvasFormat() ?? 'bgra8unorm';
  let format: GPUTextureFormat;
  let display = options.display ?? resolveCanvasDisplay();
  try {
    format = display.formatOverride ?? preferredFormat();
    try {
      context.configure(buildCanvasConfiguration({ device, format, display }));
    } catch (displayError) {
      // P3 / HDR are cosmetic opt-ins: retry the plain sRGB swapchain before failing closed.
      if (display === DEFAULT_CANVAS_DISPLAY) throw displayError;
      console.warn('[webgpuProbe] display config rejected, using sRGB:', errorDetail(displayError));
      display = DEFAULT_CANVAS_DISPLAY;
      format = preferredFormat();
      context.configure(buildCanvasConfiguration({ device, format, display }));
    }
  } catch (error) {
    return fail('webgpu-context-configure-failed', errorDetail(error));
  }

  const ready = breadcrumb(
    'ready',
    browser,
    requestedVisualizer,
    adapterSummary,
    null,
    null,
    powerPreference,
    requestedFeatures,
  );
  ready.display = display;
  ready.featureLevel = featureLevel;
  Object.assign(ready, service.stats);
  ready.gpuTimeMs = null;
  ready.uncapturedErrors = 0;
  ready.firstUncapturedError = null;
  if (shouldPublish) publishWebGPUProbe(ready);
  // Report into whatever breadcrumb is live when the error fires (re-probes replace it).
  // The device is shared across probes, so it is watched once.
  if (!watchedDevices.has(device)) {
    watchedDevices.add(device);
    watchUncapturedErrors(device, () =>
      (shouldPublish && typeof window !== 'undefined' ? window.webgpuProbe : ready));
  }
  return { ok: true, adapter, device, context, format, display, breadcrumb: ready };
}

/**
 * Per-frame GPU timing update. Mutates the published breadcrumb in place (no
 * console line) so `window.webgpuProbe.gpuTimeMs` stays live for the HUD.
 */
export function updateWebGPUTiming(gpuTimeMs: number | null): void {
  if (typeof window === 'undefined' || !window.webgpuProbe) return;
  if (window.webgpuProbe.status !== 'ready') return;
  window.webgpuProbe.gpuTimeMs = gpuTimeMs;
}

/**
 * Surface GPU validation / OOM / internal errors that nothing captured with
 * pushErrorScope. Logs the first one to the console; later ones only bump
 * `window.webgpuProbe.uncapturedErrors` so a per-frame error cannot flood the log.
 * Returns an unsubscribe.
 */
export function watchUncapturedErrors(
  device: GPUDevice,
  target: () => WebGPUProbeBreadcrumb | undefined = () =>
    (typeof window === 'undefined' ? undefined : window.webgpuProbe),
): () => void {
  if (typeof device.addEventListener !== 'function') return () => {};
  let logged = false;
  const onError = (event: Event) => {
    const error = (event as GPUUncapturedErrorEvent).error;
    const message = `${error?.constructor?.name ?? 'GPUError'}: ${error?.message ?? 'unknown'}`;
    const crumb = target();
    if (crumb) {
      crumb.uncapturedErrors = (crumb.uncapturedErrors ?? 0) + 1;
      if (!crumb.firstUncapturedError) crumb.firstUncapturedError = message;
    }
    if (!logged) {
      logged = true;
      console.error('[webgpuProbe] uncaptured GPU error (further ones counted on window.webgpuProbe):', message);
    }
  };
  device.addEventListener('uncapturederror', onError);
  return () => device.removeEventListener('uncapturederror', onError);
}

export function recordWebGPUFailure(
  previous: WebGPUProbeBreadcrumb,
  reason: string,
  detail: string | null = null,
): WebGPUProbeBreadcrumb {
  return publishWebGPUProbe({
    ...previous,
    status: 'failed',
    reason,
    detail,
    timestamp: new Date().toISOString(),
  });
}

/** Fatal visualizer breadcrumb for opt-in WebGL2 / Canvas2D init failures (no WebGPU probe). */
export function createVisualizerBootFailure(
  reason: string,
  detail: string | null,
  requestedVisualizer: VisualizerBackend | null,
  glAttributes?: WebGLContextAttributes,
): WebGPUProbeBreadcrumb {
  const value = breadcrumb(
    'failed',
    identifyBrowser(),
    requestedVisualizer,
    null,
    reason,
    detail,
    readGpuPowerPreference(),
  );
  if (glAttributes) value.glAttributes = glAttributes;
  return publishWebGPUProbe(value);
}

/** Ready breadcrumb for the opt-in WebGL2 backend (records granted context attributes). */
export function createVisualizerBootReady(
  requestedVisualizer: VisualizerBackend | null,
  glAttributes: WebGLContextAttributes | null,
): WebGPUProbeBreadcrumb {
  const value = breadcrumb(
    'ready',
    identifyBrowser(),
    requestedVisualizer,
    null,
    null,
    null,
    readGpuPowerPreference(),
  );
  if (glAttributes) value.glAttributes = glAttributes;
  return publishWebGPUProbe(value);
}
