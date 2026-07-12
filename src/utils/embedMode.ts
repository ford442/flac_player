/**
 * Project-M embed / audio-only mode detection.
 *
 * Evaluated once at module load. Activated by:
 *   - `?projectm=1` (or a bare `?projectm`) query param, or
 *   - being opened with `window.name === 'flac-player'` (the target name the
 *     Project-M host uses when launching this player as a popup/iframe).
 *
 * In this mode the FLAC player acts purely as a PCM decoder/feeder for the
 * Project-M visualizer: the standalone WebGPU spectrum/pattern view (ShaderGUI)
 * is never mounted — freeing the GPU budget for the host — and a compact
 * transport-only UI is shown instead. The PCM bridge in projectMBridge.ts wires
 * up independently inside the Player engine effect whenever an opener/parent is
 * present, so audio forwarding does not depend on this flag.
 */
function detectProjectMEmbed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('projectm') === '1' || params.has('projectm')) return true;
  } catch {
    // location/search unavailable; fall through to window.name check
  }
  return window.name === 'flac-player';
}

export const IS_PROJECTM_EMBED = detectProjectMEmbed();
