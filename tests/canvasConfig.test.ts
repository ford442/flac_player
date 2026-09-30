import { describe, expect, it } from 'vitest';
import {
  buildCanvasConfiguration,
  buildDeviceDescriptor,
  CANVAS_RENDER_ATTACHMENT,
  DEFAULT_CANVAS_DISPLAY,
  OPTIONAL_DEVICE_FEATURES,
  readGpuPowerPreference,
  resolveCanvasDisplay,
  selectDeviceFeatures,
} from '../src/visuals/webgpu/canvasConfig';
import {
  GpuPassTimer,
  smoothGpuTime,
  timestampDeltaMs,
} from '../src/visuals/webgpu/gpuPassTimer';
import { buildWaveformWGSL, waveformWGSL } from '../src/shaders/waveform';

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

  it('requests timestamp-query and shader-f16 together when both exist', () => {
    const both = { features: { has: (f: string) => f === 'timestamp-query' || f === 'shader-f16' } };
    expect(selectDeviceFeatures(both)).toEqual(['timestamp-query', 'shader-f16']);
    const f16Only = { features: { has: (f: string) => f === 'shader-f16' } };
    expect(buildDeviceDescriptor(f16Only)).toEqual({ requiredFeatures: ['shader-f16'] });
  });

  it('never requests features outside the optional allowlist', () => {
    const everything = { features: { has: () => true } };
    expect(selectDeviceFeatures(everything)).toEqual([...OPTIONAL_DEVICE_FEATURES]);
    expect(selectDeviceFeatures(everything)).not.toContain('bgra8unorm-storage');
  });

  it('keeps ?gpu=low independent of display flags', () => {
    expect(readGpuPowerPreference('?gpu=low&hdr=1')).toBe('low-power');
  });

  it('explicit default display is byte-identical to the legacy srgb config', () => {
    const device = {} as GPUDevice;
    expect(buildCanvasConfiguration({ device, format: 'bgra8unorm', display: DEFAULT_CANVAS_DISPLAY }))
      .toEqual(buildCanvasConfiguration({ device, format: 'bgra8unorm' }));
  });

  it('uses display-p3 only when the display reports a P3 gamut', () => {
    expect(resolveCanvasDisplay({ search: '', displayP3: false })).toEqual(DEFAULT_CANVAS_DISPLAY);
    const p3 = resolveCanvasDisplay({ search: '', displayP3: true });
    expect(p3).toEqual({ colorSpace: 'display-p3', formatOverride: null });
    const device = {} as GPUDevice;
    expect(buildCanvasConfiguration({ device, format: 'rgba8unorm', display: p3 })).toEqual({
      device,
      format: 'rgba8unorm',
      alphaMode: 'opaque',
      colorSpace: 'display-p3',
      usage: CANVAS_RENDER_ATTACHMENT,
    });
  });

  it('opts into extended tone mapping only behind ?hdr=1 with browser support', () => {
    expect(resolveCanvasDisplay({ search: '', toneMappingSupported: true, highDynamicRange: true }))
      .toEqual(DEFAULT_CANVAS_DISPLAY);
    expect(resolveCanvasDisplay({ search: '?hdr=1', toneMappingSupported: false }))
      .toEqual(DEFAULT_CANVAS_DISPLAY);
    expect(resolveCanvasDisplay({ search: '?hdr=0', toneMappingSupported: true }))
      .toEqual(DEFAULT_CANVAS_DISPLAY);

    const hdr = resolveCanvasDisplay({ search: '?hdr=1', toneMappingSupported: true });
    expect(hdr).toEqual({ colorSpace: 'srgb', toneMapping: 'extended', formatOverride: 'rgba16float' });
    const device = {} as GPUDevice;
    expect(buildCanvasConfiguration({ device, format: 'rgba16float', display: hdr })).toEqual({
      device,
      format: 'rgba16float',
      alphaMode: 'opaque',
      colorSpace: 'srgb',
      usage: CANVAS_RENDER_ATTACHMENT,
      toneMapping: { mode: 'extended' },
    });
  });
});

describe('gpu pass timer', () => {
  it('converts u64 ns timestamps to ms and rejects invalid pairs', () => {
    expect(timestampDeltaMs(1_000_000n, 3_500_000n)).toBeCloseTo(2.5, 10);
    expect(timestampDeltaMs(0n, 5n)).toBeNull();
    expect(timestampDeltaMs(10n, 5n)).toBeNull();
  });

  it('smooths samples exponentially', () => {
    expect(smoothGpuTime(null, 2)).toBe(2);
    expect(smoothGpuTime(2, 4, 0.5)).toBe(3);
  });

  it('is a no-op without timestamp-query', () => {
    const device = { features: new Set<string>() } as unknown as GPUDevice;
    const timer = new GpuPassTimer(device);
    expect(timer.supported).toBe(false);
    expect(timer.passTimestampWrites()).toBeUndefined();
    timer.afterSubmit();
    expect(timer.gpuTimeMs).toBeNull();
    timer.destroy();
  });
});

describe('waveform WGSL module', () => {
  it('injects every placeholder for f32 and f16 variants', () => {
    expect(waveformWGSL).not.toMatch(/\{\{/);
    expect(waveformWGSL).toContain('alias glow_t = f32;');
    expect(waveformWGSL).not.toMatch(/^enable f16;/m);
    const f16 = buildWaveformWGSL({ f16: true });
    expect(f16).not.toMatch(/\{\{/);
    expect(f16).toMatch(/^enable f16;/m);
    expect(f16).toContain('alias glow_t = f16;');
  });
});
