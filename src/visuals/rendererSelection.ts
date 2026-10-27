import type { VisualizerBackend } from './types';

const STORAGE_KEY = 'flac_player_visualizer';
const VALID_BACKENDS: ReadonlySet<VisualizerBackend> = new Set(['webgpu', 'webgl2', 'canvas2d']);

function parseBackend(value: string | null | undefined): VisualizerBackend | null {
  if (!value) return null;
  const normalized = value.toLowerCase() as VisualizerBackend;
  return VALID_BACKENDS.has(normalized) ? normalized : null;
}

/** `?webgl2=1` (or `=true`): the short WebGL2 opt-in. Anything else is not an opt-in. */
function isWebGL2Flag(value: string | null): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

/** Read preferred backend from URL `?visualizer=` / `?webgl2=1`, localStorage, or `window.DEBUG_VISUALIZER`. */
export function readVisualizerPreference(): VisualizerBackend | null {
  if (typeof window === 'undefined') return null;

  const fromGlobal = parseBackend(window.DEBUG_VISUALIZER);
  if (fromGlobal) return fromGlobal;

  const urlParam = parseBackend(new URLSearchParams(window.location.search).get('visualizer'));
  if (urlParam) return urlParam;

  // Alias: ?renderer= from sibling projects
  const rendererParam = parseBackend(new URLSearchParams(window.location.search).get('renderer'));
  if (rendererParam) return rendererParam;

  if (isWebGL2Flag(new URLSearchParams(window.location.search).get('webgl2'))) return 'webgl2';

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

export type RendererStatus = 'pending' | 'ready' | 'failed';

export interface RendererLabel {
  /** document.title for the renderer actually in use. */
  title: string;
  /** Loud on-screen badge for opt-in renderers; null for the default WebGPU path. */
  badge: string | null;
}

const RENDERER_NAMES: Record<VisualizerBackend, string> = {
  webgpu: 'WebGPU',
  webgl2: 'WebGL2',
  canvas2d: 'Canvas2D',
};

/**
 * Title and badge text for a renderer. The title never claims WebGPU unless a WebGPU
 * visualizer is actually running; a non-WebGPU renderer is badged from the moment it is selected.
 */
export function getRendererLabel(backend: VisualizerBackend, status: RendererStatus): RendererLabel {
  const name = RENDERER_NAMES[backend];
  const kind = backend === 'webgl2' ? 'compatibility renderer' : 'debug renderer';
  const optInBadge = backend === 'webgpu' ? null : `${name} ${kind} — not WebGPU`;
  if (status === 'pending') return { title: 'FLAC Player', badge: optInBadge };
  if (status === 'failed') return { title: `FLAC Player — ${name} unavailable`, badge: null };
  if (backend === 'webgpu') return { title: 'FLAC Player with WebGPU', badge: null };
  return { title: `FLAC Player with ${name} (${kind})`, badge: optInBadge };
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

  return () => {
    window.removeEventListener('storage', handler);
    window.removeEventListener('flac-player-visualizer-change', handler);
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
