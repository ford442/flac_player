import { describe, it, expect, beforeEach } from 'vitest';
import {
  readVisualizerPreference,
  persistVisualizerPreference,
  resolveVisualizerBackend,
  resolveVisualizerBackendAsync,
  clearVisualizerPreference,
} from '../src/visuals/rendererSelection';

describe('readVisualizerPreference', () => {
  beforeEach(() => {
    clearVisualizerPreference();
    delete window.DEBUG_VISUALIZER;
    window.history.replaceState({}, '', '/');
  });

  it('prefers window.DEBUG_VISUALIZER over URL and storage', () => {
    window.DEBUG_VISUALIZER = 'webgl2';
    window.history.replaceState({}, '', '/?visualizer=canvas2d');
    persistVisualizerPreference('canvas2d');
    expect(readVisualizerPreference()).toBe('webgl2');
  });

  it('reads ?visualizer= from the URL', () => {
    window.history.replaceState({}, '', '/?visualizer=webgl2');
    expect(readVisualizerPreference()).toBe('webgl2');
  });

  it('accepts ?renderer= as an alias', () => {
    window.history.replaceState({}, '', '/?renderer=canvas2d');
    expect(readVisualizerPreference()).toBe('canvas2d');
  });

  it('falls back to localStorage when URL is absent', () => {
    persistVisualizerPreference('webgl2');
    expect(readVisualizerPreference()).toBe('webgl2');
  });

  it('ignores invalid backend names', () => {
    window.history.replaceState({}, '', '/?visualizer=metal');
    expect(readVisualizerPreference()).toBeNull();
  });
});

describe('resolveVisualizerBackend', () => {
  beforeEach(() => {
    clearVisualizerPreference();
  });

  it('ignores an explicit canvas2d preference while fallback is disabled', () => {
    expect(resolveVisualizerBackend('canvas2d')).toBe('webgpu');
  });

  it('ignores an explicit webgl2 preference while fallback is disabled', () => {
    expect(resolveVisualizerBackend('webgl2')).toBe('webgpu');
  });

  it('defaults to webgpu when no preference is set and WebGPU exists', () => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: {},
    });
    expect(resolveVisualizerBackend(null)).toBe('webgpu');
    delete (navigator as Navigator & { gpu?: unknown }).gpu;
  });

  it('selects webgpu even when capability probing will fail later', () => {
    delete (navigator as Navigator & { gpu?: unknown }).gpu;
    expect(resolveVisualizerBackend(null)).toBe('webgpu');
  });

  it('keeps async selection fail-closed on webgpu', async () => {
    expect(await resolveVisualizerBackendAsync('webgl2')).toBe('webgpu');
  });
});
