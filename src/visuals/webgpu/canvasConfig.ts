/** Optional features requested only when the adapter already exposes them. */
export const OPTIONAL_DEVICE_FEATURES = ['timestamp-query', 'shader-f16'] as const;

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

export interface CanvasConfigurationInput {
  device: GPUDevice;
  format: GPUTextureFormat;
}

/**
 * Single GPUCanvasConfiguration used by the boot probe, visualizer init, and resize.
 * Canvas swapchain usage stays RENDER_ATTACHMENT; compute jobs use dedicated GPUBuffers.
 */
export function buildCanvasConfiguration(
  input: CanvasConfigurationInput,
): GPUCanvasConfiguration {
  return {
    device: input.device,
    format: input.format,
    alphaMode: 'opaque',
    colorSpace: 'srgb',
    usage: CANVAS_RENDER_ATTACHMENT,
  };
}
