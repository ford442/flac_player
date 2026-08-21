/**
 * Kill switch: `?no_gpu_compute` skips WebGPU compute chores.
 * Visualizer rendering and audio playback are unaffected.
 */

export function isGpuComputeDisabled(
  search: string | null | undefined = typeof window === 'undefined' ? '' : window.location.search,
): boolean {
  if (!search) return false;
  try {
    const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    if (!params.has('no_gpu_compute')) return false;
    const value = params.get('no_gpu_compute');
    if (value === null || value === '' || value === '1' || value === 'true' || value === 'yes') {
      return true;
    }
    if (value === '0' || value === 'false' || value === 'no') return false;
    return true;
  } catch {
    return false;
  }
}
