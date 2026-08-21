import type { VisualizerBackend } from './types';

const STORAGE_KEY = 'flac_player_visualizer';
const VALID_BACKENDS: ReadonlySet<VisualizerBackend> = new Set(['webgpu', 'webgl2', 'canvas2d']);

function parseBackend(value: string | null | undefined): VisualizerBackend | null {
  if (!value) return null;
  const normalized = value.toLowerCase() as VisualizerBackend;
  return VALID_BACKENDS.has(normalized) ? normalized : null;
}

/** Read preferred backend from URL `?visualizer=`, localStorage, or `window.DEBUG_VISUALIZER`. */
export function readVisualizerPreference(): VisualizerBackend | null {
  if (typeof window === 'undefined') return null;

  const fromGlobal = parseBackend(window.DEBUG_VISUALIZER);
  if (fromGlobal) return fromGlobal;

  const urlParam = parseBackend(new URLSearchParams(window.location.search).get('visualizer'));
  if (urlParam) return urlParam;

  // Alias: ?renderer= from sibling projects
  const rendererParam = parseBackend(new URLSearchParams(window.location.search).get('renderer'));
  if (rendererParam) return rendererParam;

  try {
    return parseBackend(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function persistVisualizerPreference(backend: VisualizerBackend): void {
  try {
    localStorage.setItem(STORAGE_KEY, backend);
  } catch {
    /* ignore */
  }
}

export function clearVisualizerPreference(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function isWebGPUAvailable(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.gpu);
}

/**
 * WebGPU is the only supported shader backend in this phase. Legacy explicit
 * WebGL2/Canvas2D preferences remain readable for diagnostics but are ignored.
 */
export function resolveVisualizerBackend(
  _preference: VisualizerBackend | null = readVisualizerPreference(),
): VisualizerBackend {
  void _preference;
  return 'webgpu';
}

export async function resolveVisualizerBackendAsync(
  preference: VisualizerBackend | null = readVisualizerPreference(),
): Promise<VisualizerBackend> {
  return resolveVisualizerBackend(preference);
}

export function subscribeVisualizerPreference(
  onChange: (backend: VisualizerBackend) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};

  const handler = () => onChange(resolveVisualizerBackend());

  window.addEventListener('storage', handler);
  window.addEventListener('flac-player-visualizer-change', handler);
  window.addEventListener('visualizer-fallback', handler);

  return () => {
    window.removeEventListener('storage', handler);
    window.removeEventListener('flac-player-visualizer-change', handler);
    window.removeEventListener('visualizer-fallback', handler);
  };
}

export function notifyVisualizerPreferenceChanged(): void {
  window.dispatchEvent(new Event('flac-player-visualizer-change'));
}

export function setVisualizerOverride(backend: VisualizerBackend): void {
  window.DEBUG_VISUALIZER = backend;
  persistVisualizerPreference(backend);
  notifyVisualizerPreferenceChanged();
}
