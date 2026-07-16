import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  readVisualizerPreference,
  persistVisualizerPreference,
  resolveVisualizerBackend,
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

  it('honors an explicit canvas2d preference', () => {
    expect(resolveVisualizerBackend('canvas2d')).toBe('canvas2d');
  });

  it('falls back from webgl2 to canvas2d when WebGL2 is unavailable', () => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(resolveVisualizerBackend('webgl2')).toBe('canvas2d');
    HTMLCanvasElement.prototype.getContext = getContext;
  });

  it('defaults to webgpu when no preference is set and WebGPU exists', () => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: {},
    });
    expect(resolveVisualizerBackend(null)).toBe('webgpu');
    delete (navigator as Navigator & { gpu?: unknown }).gpu;
  });

  it('falls back when WebGPU is unavailable', () => {
    delete (navigator as Navigator & { gpu?: unknown }).gpu;
    const backend = resolveVisualizerBackend(null);
    expect(['webgl2', 'canvas2d']).toContain(backend);
  });
});
