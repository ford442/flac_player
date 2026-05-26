// Queue storage management for localStorage persistence

import { PlaylistTrack } from '../audioLoader';

export type RepeatMode = 'off' | 'one' | 'all';

export const QUEUE_STORAGE_KEY = 'flac_player_queue';

export interface QueueState {
  tracks: PlaylistTrack[];
  currentIndex: number;
  shuffle: boolean;
  repeat: RepeatMode;
}

export function saveQueueToStorage(state: QueueState): void {
  try {
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Failed to save queue:', e);
  }
}

export function loadQueueFromStorage(): QueueState | null {
  try {
    const data = localStorage.getItem(QUEUE_STORAGE_KEY);
    if (data) {
      const parsed = JSON.parse(data) as Partial<QueueState>;
      if (!parsed || !Array.isArray(parsed.tracks)) return null;
      const repeat: RepeatMode = parsed.repeat === 'all' || parsed.repeat === 'one' ? parsed.repeat : 'off';
      const currentIndexRaw = typeof parsed.currentIndex === 'number' ? parsed.currentIndex : -1;
      const currentIndex = parsed.tracks.length === 0
        ? -1
        : Math.min(Math.max(Math.floor(currentIndexRaw), 0), parsed.tracks.length - 1);

      return {
        tracks: parsed.tracks,
        currentIndex,
        shuffle: !!parsed.shuffle,
        repeat
      };
    }
  } catch (e) {
    console.warn('Failed to load queue:', e);
  }
  return null;
}

export function clearQueueStorage(): void {
  localStorage.removeItem(QUEUE_STORAGE_KEY);
}
