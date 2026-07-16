/**
 * Visual aesthetic mode: ShaderGUI hardware panel vs projectM milkdrop vs split view.
 */
export type VisualizerAesthetic = 'shadergui' | 'projectm' | 'split';

const STORAGE_KEY = 'flac_player_visualizer_aesthetic';

function readUrlAesthetic(): VisualizerAesthetic | null {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('aesthetic') ?? params.get('visualizer-aesthetic');
    if (raw === 'projectm' || raw === 'milkdrop') return 'projectm';
    if (raw === 'split') return 'split';
    if (raw === 'shadergui' || raw === 'hardware') return 'shadergui';
    if (params.get('projectm') === 'host') return 'projectm';
  } catch {
    // ignore
  }
  return null;
}

export function getInitialVisualizerAesthetic(): VisualizerAesthetic {
  const fromUrl = readUrlAesthetic();
  if (fromUrl) return fromUrl;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'projectm' || stored === 'split' || stored === 'shadergui') {
      return stored;
    }
  } catch {
    // ignore
  }
  return 'shadergui';
}

export function persistVisualizerAesthetic(mode: VisualizerAesthetic): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}

/** When true, ShaderGUI should avoid WebGPU to reduce GPU contention. */
export function shouldLimitShaderGpu(mode: VisualizerAesthetic): boolean {
  return mode === 'split';
}

/** When true, ShaderGUI WebGPU path is skipped entirely. */
export function shouldSkipShaderGui(mode: VisualizerAesthetic): boolean {
  return mode === 'projectm';
}

export const AESTHETIC_LABELS: Record<VisualizerAesthetic, string> = {
  shadergui: 'Hardware GUI',
  projectm: 'Milkdrop (projectM)',
  split: 'Split view',
};
