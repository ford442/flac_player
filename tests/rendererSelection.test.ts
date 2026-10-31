import { describe, it, expect, beforeEach } from 'vitest';
import {
  readVisualizerPreference,
  persistVisualizerPreference,
  resolveVisualizerBackend,
  resolveVisualizerBackendAsync,
  clearVisualizerPreference,
  setCompatibilityVisualizer,
  isCompatibilityVisualizerEnabled,
  subscribeVisualizerPreference,
  getRendererLabel,
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

  it('reads the short ?webgl2=1 opt-in (and =true)', () => {
    window.history.replaceState({}, '', '/?webgl2=1');
    expect(readVisualizerPreference()).toBe('webgl2');
    window.history.replaceState({}, '', '/?webgl2=TRUE');
    expect(readVisualizerPreference()).toBe('webgl2');
  });

  it('does not treat other ?webgl2 values as an opt-in', () => {
    for (const q of ['?webgl2=0', '?webgl2=false', '?webgl2=', '?webgl2=yes']) {
      window.history.replaceState({}, '', `/${q}`);
      expect(readVisualizerPreference()).toBeNull();
    }
  });

  it('lets an explicit ?visualizer= win over ?webgl2=1', () => {
    window.history.replaceState({}, '', '/?visualizer=webgpu&webgl2=1');
    expect(readVisualizerPreference()).toBe('webgpu');
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

describe('getRendererLabel', () => {
  it('claims WebGPU only once a WebGPU visualizer is running', () => {
    expect(getRendererLabel('webgpu', 'ready').title).toBe('FLAC Player with WebGPU');
    expect(getRendererLabel('webgpu', 'pending').title).toBe('FLAC Player');
    expect(getRendererLabel('webgpu', 'failed').title).toBe('FLAC Player — WebGPU unavailable');
  });

  it('never badges the default WebGPU path', () => {
    for (const status of ['pending', 'ready', 'failed'] as const) {
      expect(getRendererLabel('webgpu', status).badge).toBeNull();
    }
  });

  it('titles and badges an opted-in WebGL2 renderer as not WebGPU', () => {
    const ready = getRendererLabel('webgl2', 'ready');
    expect(ready.title).toBe('FLAC Player with WebGL2 (compatibility renderer)');
    expect(ready.title).not.toMatch(/WebGPU/);
    expect(ready.badge).toBe('WebGL2 compatibility renderer — not WebGPU');
  });

  it('badges WebGL2 as soon as it is selected, before any renderer runs', () => {
    const pending = getRendererLabel('webgl2', 'pending');
    expect(pending.title).toBe('FLAC Player');
    expect(pending.badge).toBe('WebGL2 compatibility renderer — not WebGPU');
  });

  it('labels the Canvas2D debug renderer, and drops the badge when init failed', () => {
    expect(getRendererLabel('canvas2d', 'ready').badge).toBe('Canvas2D debug renderer — not WebGPU');
    const failed = getRendererLabel('webgl2', 'failed');
    expect(failed.title).toBe('FLAC Player — WebGL2 unavailable');
    expect(failed.badge).toBeNull();
  });
});

describe('subscribeVisualizerPreference', () => {
  it('has no automatic fallback trigger: a visualizer-fallback event does not change the backend', () => {
    clearVisualizerPreference();
    delete window.DEBUG_VISUALIZER;
    window.history.replaceState({}, '', '/');
    const seen: string[] = [];
    const unsubscribe = subscribeVisualizerPreference((b) => seen.push(b));
    window.dispatchEvent(new CustomEvent('visualizer-fallback', { detail: 'webgpu-no-adapter' }));
    expect(seen).toEqual([]);
    window.dispatchEvent(new Event('flac-player-visualizer-change'));
    expect(seen).toEqual(['webgpu']);
    unsubscribe();
  });
});
