/** Shared service worker message types (main thread ↔ SW). */

export const TRACK_CACHE_NAME = 'flac-player-tracks-v1';
export const API_CACHE_NAME = 'flac-player-api-v1';
export const LIBRARY_CACHE_TTL_SECONDS = 60 * 60 * 24; // 24h – mirrors libraryCache.ts

export type SWClientMessage =
  | { type: 'SKIP_WAITING' }
  | { type: 'DOWNLOAD_TRACK'; url: string; requestId: string }
  | { type: 'CANCEL_DOWNLOAD'; requestId: string };

export type SWServerMessage =
  | { type: 'DOWNLOAD_PROGRESS'; requestId: string; url: string; progress: number }
  | { type: 'DOWNLOAD_COMPLETE'; requestId: string; url: string; size: number }
  | { type: 'DOWNLOAD_ERROR'; requestId: string; url: string; error: string };

export function isSWServerMessage(data: unknown): data is SWServerMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return typeof msg.type === 'string'
    && (msg.type === 'DOWNLOAD_PROGRESS'
      || msg.type === 'DOWNLOAD_COMPLETE'
      || msg.type === 'DOWNLOAD_ERROR');
}
