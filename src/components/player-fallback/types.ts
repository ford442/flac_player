import type { AudioOutputMode } from '../../types/audio';

/**
 * Audio engine choices. The transport bar and the Settings tab both render this
 * list, so every AudioOutputMode is offered in both places (Record keeps it
 * exhaustive at compile time).
 */
export const OUTPUT_MODE_LABELS: Readonly<Record<AudioOutputMode, string>> = {
  streaming: 'Streaming (recommended)',
  worklet: 'AudioWorklet (buffered)',
  'web-audio': 'Web Audio (buffered)',
  sdl: 'WASM engine',
};

export type ViewTab = 'library' | 'now-playing' | 'queue' | 'playlists' | 'generate' | 'convert' | 'settings';
export type LibraryViewMode = 'grid' | 'list';

/**
 * Listening-room summary for the fallback view. One prop on purpose: room
 * actions (copy link, resync, leave) live in ListeningRoomPanel.
 */
export interface RoomBadge {
  role: 'host' | 'guest' | null;
  driftMs: number | null;
  /** Start hosting with the current queue; absent when rooms are unavailable here. */
  onListenTogether?: () => void;
}
