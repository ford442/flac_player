// Whole-file audio bytes for buffered playback: offline cache first, then the network.

import { getOrFetchTrack } from '../storage/trackCache';

/** `gs://bucket/key` → its public HTTPS URL; other URLs unchanged. */
export function toFetchableUrl(url: string): string {
  return url.startsWith('gs://') ? url.replace('gs://', 'https://storage.googleapis.com/') : url;
}

/** Network fetch with a readable 404 (a directory URL is the usual mistake). */
export async function fetchAudioBytes(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const target = toFetchableUrl(url);
  let response: Response;
  try {
    response = await fetch(target, { mode: 'cors', credentials: 'omit', signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Failed to load audio from ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 404) {
    const lastSegment = target.split('/').pop() || '';
    if (target.endsWith('/') || lastSegment === '') {
      throw new Error(`File not found (404). The URL "${target}" appears to be a directory. Please specify a full file path (e.g., ending in .flac or .wav).`);
    }
    throw new Error(`File not found (404). The server could not locate the audio file at "${target}".`);
  }
  if (!response.ok) throw new Error(`Failed to load audio: ${response.status} ${response.statusText}`);
  return response.arrayBuffer();
}

/** Cached copy when there is one (and cache the download), else a plain fetch. */
export async function fetchTrackBytes(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  try {
    const response = await getOrFetchTrack(toFetchableUrl(url), signal);
    // Without the Cache API this is a bare fetch that does not check the status.
    if (!response.ok) throw new Error(`Network error: ${response.status}`);
    return await response.arrayBuffer();
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('Offline cache miss or error, falling back to network fetch:', err);
    return fetchAudioBytes(url, signal);
  }
}
