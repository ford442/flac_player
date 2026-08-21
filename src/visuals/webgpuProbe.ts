import type { VisualizerBackend } from './types';

export interface BrowserIdentity {
  brand: string;
  version: string | null;
  userAgent: string;
}

export interface WebGPUAdapterSummary {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  isFallbackAdapter: boolean;
}

export type WebGPUProbeStatus = 'probing' | 'ready' | 'failed';

export interface WebGPUProbeBreadcrumb {
  status: WebGPUProbeStatus;
  reason: string | null;
  detail: string | null;
  browser: BrowserIdentity;
  adapter: WebGPUAdapterSummary | null;
  requestedVisualizer: VisualizerBackend | null;
  timestamp: string;
}

export interface WebGPUProbeSuccess {
  ok: true;
  adapter: GPUAdapter;
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
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

function summarizeAdapter(adapter: GPUAdapter): WebGPUAdapterSummary {
  try {
    const info = adapter.info;
    return {
      vendor: info.vendor || 'unknown',
      architecture: info.architecture || 'unknown',
      device: info.device || 'unknown',
      description: info.description || 'unknown',
      isFallbackAdapter: info.isFallbackAdapter,
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

function breadcrumb(
  status: WebGPUProbeStatus,
  browser: BrowserIdentity,
  requestedVisualizer: VisualizerBackend | null,
  adapter: WebGPUAdapterSummary | null,
  reason: string | null = null,
  detail: string | null = null,
): WebGPUProbeBreadcrumb {
  return {
    status,
    reason,
    detail,
    browser,
    adapter,
    requestedVisualizer,
    timestamp: new Date().toISOString(),
  };
}

export function publishWebGPUProbe(value: WebGPUProbeBreadcrumb): WebGPUProbeBreadcrumb {
  if (typeof window !== 'undefined') window.webgpuProbe = value;
  console.info('[webgpuProbe]', JSON.stringify(value));
  return value;
}

function failure(
  reason: string,
  detail: string | null,
  browser: BrowserIdentity,
  requestedVisualizer: VisualizerBackend | null,
  adapter: WebGPUAdapterSummary | null,
  publish: boolean,
): WebGPUProbeFailure {
  const value = breadcrumb('failed', browser, requestedVisualizer, adapter, reason, detail);
  if (publish) publishWebGPUProbe(value);
  return { ok: false, breadcrumb: value };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function destroyDevice(device: GPUDevice): void {
  try {
    device.destroy();
  } catch {
    // The probe is already failing; cleanup must not hide the original reason.
  }
}

/**
 * Acquire and validate the exact WebGPU adapter, device, and canvas context used
 * by the WGSL visualizer. A failed result never falls through to another renderer.
 */
export async function probeWebGPU(
  canvas: HTMLCanvasElement,
  options: WebGPUProbeOptions = {},
): Promise<WebGPUProbeResult> {
  const browser = options.browser ?? identifyBrowser();
  const requestedVisualizer = options.requestedVisualizer ?? null;
  const shouldPublish = options.publish !== false;
  const gpu = options.gpu === undefined
    ? (typeof navigator === 'undefined' ? null : navigator.gpu)
    : options.gpu;

  if (shouldPublish) {
    publishWebGPUProbe(breadcrumb('probing', browser, requestedVisualizer, null));
  }
  if (!gpu) {
    return failure(
      'webgpu-unsupported',
      'navigator.gpu is unavailable',
      browser,
      requestedVisualizer,
      null,
      shouldPublish,
    );
  }

  let adapter: GPUAdapter | null;
  try {
    adapter = await gpu.requestAdapter();
  } catch (error) {
    return failure(
      'webgpu-adapter-request-failed',
      errorDetail(error),
      browser,
      requestedVisualizer,
      null,
      shouldPublish,
    );
  }
  if (!adapter) {
    return failure(
      'webgpu-no-adapter',
      'navigator.gpu.requestAdapter() returned null',
      browser,
      requestedVisualizer,
      null,
      shouldPublish,
    );
  }

  const adapterSummary = summarizeAdapter(adapter);
  let device: GPUDevice;
  try {
    device = await adapter.requestDevice();
  } catch (error) {
    return failure(
      'webgpu-device-request-failed',
      errorDetail(error),
      browser,
      requestedVisualizer,
      adapterSummary,
      shouldPublish,
    );
  }

  let context: GPUCanvasContext | null;
  try {
    context = canvas.getContext('webgpu') as GPUCanvasContext | null;
  } catch (error) {
    destroyDevice(device);
    return failure(
      'webgpu-context-request-failed',
      errorDetail(error),
      browser,
      requestedVisualizer,
      adapterSummary,
      shouldPublish,
    );
  }
  if (!context) {
    destroyDevice(device);
    return failure(
      'webgpu-no-context',
      "visualizerCanvas.getContext('webgpu') returned null",
      browser,
      requestedVisualizer,
      adapterSummary,
      shouldPublish,
    );
  }

  let format: GPUTextureFormat;
  try {
    format = gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
  } catch (error) {
    destroyDevice(device);
    return failure(
      'webgpu-context-configure-failed',
      errorDetail(error),
      browser,
      requestedVisualizer,
      adapterSummary,
      shouldPublish,
    );
  }

  const ready = breadcrumb('ready', browser, requestedVisualizer, adapterSummary);
  if (shouldPublish) publishWebGPUProbe(ready);
  return { ok: true, adapter, device, context, format, breadcrumb: ready };
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
