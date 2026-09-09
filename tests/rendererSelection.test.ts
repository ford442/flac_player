import { describe, it, expect, beforeEach } from 'vitest';
import {
  readVisualizerPreference,
  persistVisualizerPreference,
  resolveVisualizerBackend,
  resolveVisualizerBackendAsync,
  clearVisualizerPreference,
  setCompatibilityVisualizer,
  isCompatibilityVisualizerEnabled,
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
    delete window.DEBUG_VISUALIZER;
    window.history.replaceState({}, '', '/');
  });

  it('stays fail-closed on webgpu when no preference is set', () => {
    delete (navigator as Navigator & { gpu?: unknown }).gpu;
    expect(resolveVisualizerBackend(null)).toBe('webgpu');
  });

  it('honors an explicit webgl2 preference without requiring WebGPU', () => {
    expect(resolveVisualizerBackend('webgl2')).toBe('webgl2');
    window.history.replaceState({}, '', '/?visualizer=webgl2');
    expect(resolveVisualizerBackend()).toBe('webgl2');
  });

  it('ignores canvas2d URL/storage unless DEBUG_VISUALIZER is canvas2d', () => {
    expect(resolveVisualizerBackend('canvas2d')).toBe('webgpu');
    persistVisualizerPreference('canvas2d');
    expect(resolveVisualizerBackend()).toBe('webgpu');
    window.DEBUG_VISUALIZER = 'canvas2d';
    expect(resolveVisualizerBackend()).toBe('canvas2d');
  });

  it('keeps async selection aligned with the sync resolver', async () => {
    expect(await resolveVisualizerBackendAsync('webgl2')).toBe('webgl2');
    expect(await resolveVisualizerBackendAsync(null)).toBe('webgpu');
  });

  it('toggles compatibility visualizer via Settings helper', () => {
    expect(isCompatibilityVisualizerEnabled()).toBe(false);
    setCompatibilityVisualizer(true);
    expect(isCompatibilityVisualizerEnabled()).toBe(true);
    expect(resolveVisualizerBackend()).toBe('webgl2');
    setCompatibilityVisualizer(false);
    expect(isCompatibilityVisualizerEnabled()).toBe(false);
    expect(resolveVisualizerBackend()).toBe('webgpu');
  });
});
