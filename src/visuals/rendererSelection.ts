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

export function resolveVisualizerBackend(
  preference: VisualizerBackend | null = readVisualizerPreference(),
): VisualizerBackend {
  if (preference === 'webgl2') return 'webgl2';
  if (preference === 'canvas2d' && typeof window !== 'undefined' && window.DEBUG_VISUALIZER === 'canvas2d') {
    return 'canvas2d';
  }
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

/** Settings “Compatibility visualizer” — WebGL2 ShaderGUI without auto-fallthrough. */
export function setCompatibilityVisualizer(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  if (enabled) {
    setVisualizerOverride('webgl2');
    return;
  }
  window.DEBUG_VISUALIZER = 'webgpu';
  persistVisualizerPreference('webgpu');
  notifyVisualizerPreferenceChanged();
}

export function isCompatibilityVisualizerEnabled(
  preference: VisualizerBackend | null = readVisualizerPreference(),
): boolean {
  return resolveVisualizerBackend(preference) === 'webgl2';
}
