/**
 * Optional features requested only when the adapter already exposes them.
 * - timestamp-query: ShaderGUI pass timings (`gpuTimeMs` in the 🎛 HUD).
 * - shader-f16: half-precision waveform glow path (f32 fallback otherwise).
 * Add storage-texture features (bgra8unorm-storage) only once a compute pass
 * actually binds a storage texture — gpu-chores uses GPUBuffers today. This list is intersect-only: probeWebGPU stays the single requestDevice() caller.
 */
export const OPTIONAL_DEVICE_FEATURES = [
  'timestamp-query',
  'shader-f16',
] as const;

export type OptionalDeviceFeature = (typeof OPTIONAL_DEVICE_FEATURES)[number];

/** Spec bit for GPUTextureUsage.RENDER_ATTACHMENT (0x10). Safe when the GPU enum is absent in tests. */
export const CANVAS_RENDER_ATTACHMENT: GPUTextureUsageFlags =
  typeof GPUTextureUsage !== 'undefined' ? GPUTextureUsage.RENDER_ATTACHMENT : 0x10;

export type FeatureSet = { has(feature: string): boolean };

/**
 * Default discrete GPU. `?gpu=low` selects the integrated / low-power adapter
 * on dual-GPU laptops (thermals).
 */
export function readGpuPowerPreference(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): GPUPowerPreference {
  const query = search.startsWith('?') ? search.slice(1) : search;
  return new URLSearchParams(query).get('gpu') === 'low' ? 'low-power' : 'high-performance';
}

/** Intersect adapter.features with OPTIONAL_DEVICE_FEATURES. Never require an unsupported feature. */
export function selectDeviceFeatures(adapter: { features: FeatureSet }): GPUFeatureName[] {
  return OPTIONAL_DEVICE_FEATURES.filter((feature) => adapter.features.has(feature));
}

export function buildDeviceDescriptor(adapter: { features: FeatureSet }): GPUDeviceDescriptor {
  const requiredFeatures = selectDeviceFeatures(adapter);
  return requiredFeatures.length > 0 ? { requiredFeatures } : {};
}

export type CanvasToneMappingMode = 'standard' | 'extended';

/** Display options resolved once per canvas session (feature-detected, sRGB/SDR default). */
export interface CanvasDisplayOptions {
  colorSpace: PredefinedColorSpace;
  /** Only set when `?hdr=1` and the browser exposes GPUCanvasConfiguration.toneMapping. */
  toneMapping?: CanvasToneMappingMode;
  /** Swapchain format override (rgba16float for extended HDR); null = preferred format. */
  formatOverride: GPUTextureFormat | null;
}

export const DEFAULT_CANVAS_DISPLAY: CanvasDisplayOptions = {
  colorSpace: 'srgb',
  formatOverride: null,
};

export interface CanvasDisplayEnvironment {
  search?: string;
  /** `matchMedia('(color-gamut: p3)').matches` */
  displayP3?: boolean;
  /** `matchMedia('(dynamic-range: high)').matches` */
  highDynamicRange?: boolean;
  /** GPUCanvasContext exposes getConfiguration() (ships with toneMapping in Chromium). */
  toneMappingSupported?: boolean;
}

function queryFlag(search: string, key: string): boolean {
  const query = search.startsWith('?') ? search.slice(1) : search;
  const params = new URLSearchParams(query);
  if (!params.has(key)) return false;
  const value = params.get(key);
  return value === '' || value === '1' || value === 'true' || value === 'yes';
}

function mediaMatches(query: string): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.(query).matches;
  } catch {
    return false;
  }
}

/** Live browser environment for resolveCanvasDisplay (tests pass explicit values). */
export function readCanvasDisplayEnvironment(): CanvasDisplayEnvironment {
  const ctor = (globalThis as { GPUCanvasContext?: { prototype: object } }).GPUCanvasContext;
  return {
    search: typeof window !== 'undefined' ? window.location.search : '',
    displayP3: mediaMatches('(color-gamut: p3)'),
    highDynamicRange: mediaMatches('(dynamic-range: high)'),
    toneMappingSupported: !!ctor && 'getConfiguration' in ctor.prototype,
  };
}

/**
 * display-p3 when the display reports a P3 gamut; sRGB otherwise.
 * Extended tone mapping (rgba16float swapchain) only behind `?hdr=1` and only when
 * the browser supports toneMapping — library listening on SDR laptops stays SDR.
 */
export function resolveCanvasDisplay(
  env: CanvasDisplayEnvironment = readCanvasDisplayEnvironment(),
): CanvasDisplayOptions {
  const colorSpace: PredefinedColorSpace = env.displayP3 ? 'display-p3' : 'srgb';
  const wantsHdr = queryFlag(env.search ?? '', 'hdr');
  if (wantsHdr && env.toneMappingSupported) {
    return { colorSpace, toneMapping: 'extended', formatOverride: 'rgba16float' };
  }
  return { colorSpace, formatOverride: null };
}

export interface CanvasConfigurationInput {
  device: GPUDevice;
  format: GPUTextureFormat;
  /** Omitted → sRGB, no toneMapping (unchanged SDR default). */
  display?: CanvasDisplayOptions;
}

/**
 * Single GPUCanvasConfiguration used by the boot probe, visualizer init, and resize.
 * Canvas swapchain usage stays RENDER_ATTACHMENT; compute jobs use dedicated GPUBuffers.
 * alphaMode stays opaque (ShaderGUI does not composite through the canvas).
 */
export function buildCanvasConfiguration(
  input: CanvasConfigurationInput,
): GPUCanvasConfiguration {
  const display = input.display ?? DEFAULT_CANVAS_DISPLAY;
  const config: GPUCanvasConfiguration & { toneMapping?: { mode: CanvasToneMappingMode } } = {
    device: input.device,
    format: input.format,
    alphaMode: 'opaque',
    colorSpace: display.colorSpace,
    usage: CANVAS_RENDER_ATTACHMENT,
  };
  if (display.toneMapping) config.toneMapping = { mode: display.toneMapping };
  return config;
}
