import { describe, expect, it } from 'vitest';
import {
  buildCanvasConfiguration,
  buildDeviceDescriptor,
  CANVAS_RENDER_ATTACHMENT,
  readGpuPowerPreference,
  selectDeviceFeatures,
} from '../src/visuals/webgpu/canvasConfig';

describe('gpu canvas policy', () => {
  it('defaults to high-performance and honors ?gpu=low', () => {
    expect(readGpuPowerPreference('')).toBe('high-performance');
    expect(readGpuPowerPreference('?aesthetic=shadergui')).toBe('high-performance');
    expect(readGpuPowerPreference('?gpu=low')).toBe('low-power');
    expect(readGpuPowerPreference('gpu=low')).toBe('low-power');
  });

  it('intersects optional features and never requires unsupported ones', () => {
    const none = { features: { has: () => false } };
    expect(selectDeviceFeatures(none)).toEqual([]);
    expect(buildDeviceDescriptor(none)).toEqual({});

    const some = { features: { has: (f: string) => f === 'timestamp-query' } };
    expect(selectDeviceFeatures(some)).toEqual(['timestamp-query']);
    expect(buildDeviceDescriptor(some)).toEqual({
      requiredFeatures: ['timestamp-query'],
    });
  });

  it('builds a shared opaque srgb canvas configuration', () => {
    const device = {} as GPUDevice;
    expect(buildCanvasConfiguration({ device, format: 'bgra8unorm' })).toEqual({
      device,
      format: 'bgra8unorm',
      alphaMode: 'opaque',
      colorSpace: 'srgb',
      usage: CANVAS_RENDER_ATTACHMENT,
    });
  });
});
