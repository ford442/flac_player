import type { AudioOutputMode } from '../types/audio';
import { sharedPlayRingSupported } from './worklets/playRingSAB';

/**
 * Why `mode` cannot run on this page, or null when it can. The WASM engine is a `-pthread`
 * build: without cross-origin isolation (COOP/COEP) there is no SharedArrayBuffer
 * and the module cannot start, so the pickers disable it instead of failing later.
 */
export function outputModeUnavailableReason(mode: AudioOutputMode): string | null {
  if (mode === 'sdl' && !sharedPlayRingSupported()) {
    return 'needs cross-origin isolation (COOP/COEP)';
  }
  return null;
}
