// Utility functions for audio and playlist management

// =============================================================================
// Track Filtering & Sorting
// =============================================================================

export const FAST_STORAGE_HOST = 'storage.1ink.us';
export const PRIMARY_STORAGE_HOST = 'storage.noahcohn.com';

/** True when playback will try the DreamHost fast mirror first. */
export function isFastMirrorEligible(url?: string): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === FAST_STORAGE_HOST || host === PRIMARY_STORAGE_HOST;
  } catch {
    return false;
  }
}

export function getPreferredStorageUrls(url?: string): string[] {
  if (!url) return [];

  try {
    const parsed = new URL(url);
    if (parsed.hostname === FAST_STORAGE_HOST) {
      return [url];
    }
    if (parsed.hostname === PRIMARY_STORAGE_HOST) {
      const preferred = new URL(url);
      preferred.hostname = FAST_STORAGE_HOST;
      return [preferred.toString(), url];
    }
    return [url];
  } catch {
    return [url];
  }
}

// =============================================================================
// Playback Utilities
// =============================================================================

/** Format seconds as mm:ss string */
export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/** Fisher-Yates shuffle — uniform random permutation */
export function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
