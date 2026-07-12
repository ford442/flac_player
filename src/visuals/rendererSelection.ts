import type { VisualizerBackend } from './types';

const STORAGE_KEY = 'flac_player_visualizer';
const WEBGPU_PROBE_CACHE_KEY = 'flac_player_webgpu_adapter_ok';
const VALID_BACKENDS: ReadonlySet<VisualizerBackend> = new Set(['webgpu', 'webgl2', 'canvas2d']);

let webgpuAutoFallbackApplied = false;
let webgpuAdapterProbePromise: Promise<boolean> | null = null;

function parseBackend(value: string | null | undefined): VisualizerBackend | null {
  if (!value) return null;
  const normalized = value.toLowerCase() as VisualizerBackend;
  return VALID_BACKENDS.has(normalized) ? normalized : null;
}

function readWebGPUProbeCache(): boolean | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const cached = sessionStorage.getItem(WEBGPU_PROBE_CACHE_KEY);
    if (cached === '1') return true;
    if (cached === '0') return false;
  } catch {
    /* private browsing / blocked storage */
  }
  return null;
}

function writeWebGPUProbeCache(ok: boolean): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(WEBGPU_PROBE_CACHE_KEY, ok ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function fallbackAfterWebGPU(): VisualizerBackend {
  return isWebGL2Available() ? 'webgl2' : 'canvas2d';
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
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

export function isWebGL2Available(): boolean {
  if (typeof document === 'undefined') return false;
  const canvas = document.createElement('canvas');
  return !!canvas.getContext('webgl2');
}

export async function probeWebGPUAdapter(): Promise<boolean> {
  if (!isWebGPUAvailable()) {
    writeWebGPUProbeCache(false);
    return false;
  }

  const cached = readWebGPUProbeCache();
  if (cached !== null) return cached;

  if (!webgpuAdapterProbePromise) {
    webgpuAdapterProbePromise = (async () => {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        const ok = adapter != null;
        writeWebGPUProbeCache(ok);
        return ok;
      } catch {
        writeWebGPUProbeCache(false);
        return false;
      } finally {
        webgpuAdapterProbePromise = null;
      }
    })();
  }

  return webgpuAdapterProbePromise;
}

export function resolveVisualizerBackend(
  preference: VisualizerBackend | null = readVisualizerPreference(),
): VisualizerBackend {
  const want = preference ?? 'webgpu';

  if (want === 'canvas2d') return 'canvas2d';

  if (want === 'webgl2') {
    return isWebGL2Available() ? 'webgl2' : 'canvas2d';
  }

  if (!isWebGPUAvailable()) {
    return fallbackAfterWebGPU();
  }

  if (preference === null) {
    const cachedProbe = readWebGPUProbeCache();
    if (cachedProbe === false) {
      return fallbackAfterWebGPU();
    }
  }

  return 'webgpu';
}

export async function resolveVisualizerBackendAsync(
  preference: VisualizerBackend | null = readVisualizerPreference(),
): Promise<VisualizerBackend> {
  const want = preference ?? 'webgpu';

  if (want === 'canvas2d') return 'canvas2d';

  if (want === 'webgl2') {
    return isWebGL2Available() ? 'webgl2' : 'canvas2d';
  }

  if (!isWebGPUAvailable()) {
    return fallbackAfterWebGPU();
  }

  if (preference !== null) {
    return 'webgpu';
  }

  const adapterOk = await probeWebGPUAdapter();
  if (!adapterOk) {
    return fallbackAfterWebGPU();
  }

  return 'webgpu';
}

export function applyWebGPUFallback(reason: string): VisualizerBackend {
  const fallback = fallbackAfterWebGPU();
  if (!webgpuAutoFallbackApplied) {
    webgpuAutoFallbackApplied = true;
    console.warn(`[Visualizer] WebGPU unavailable (${reason}); falling back to ${fallback}`);
    persistVisualizerPreference(fallback);
    window.DEBUG_VISUALIZER = fallback;
    notifyVisualizerPreferenceChanged();
  }
  return fallback;
}

export function hasWebGPUAutoFallbackApplied(): boolean {
  return webgpuAutoFallbackApplied;
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
  if (backend === 'webgpu') {
    webgpuAutoFallbackApplied = false;
  }
  window.DEBUG_VISUALIZER = backend;
  persistVisualizerPreference(backend);
  notifyVisualizerPreferenceChanged();
}
