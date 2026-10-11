import type { CloudPlaylist, PlaylistTrack } from './library';

/** A named, editable playlist persisted in IndexedDB. Holds track ids only — never audio bytes. */
export interface LocalPlaylist {
  id: string;
  title: string;
  description: string;
  trackIds: string[];
  /** Epoch milliseconds of the last change (used for last-write-wins if cloud sync is enabled). */
  updatedAt: number;
  /** `local` was created here; `cloud` was copied from the library host's `/api/playlists`. */
  origin: 'local' | 'cloud';
}

export interface NewLocalPlaylist {
  title: string;
  description?: string;
  trackIds: string[];
  origin?: LocalPlaylist['origin'];
}

export type LocalPlaylistPatch = Partial<Pick<LocalPlaylist, 'title' | 'description' | 'trackIds'>>;

/** Everything the Playlists tab needs, passed as one object (see `usePlaylists`). */
export interface PlaylistsController {
  local: LocalPlaylist[];
  /** False when IndexedDB is unavailable (private mode, blocked storage); local playlists then can't be saved. */
  localAvailable: boolean;
  cloud: CloudPlaylist[];
  isLoadingCloud: boolean;
  refreshCloud: () => void;
  queueLength: number;
  createFromQueue: (title: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  moveTrack: (id: string, from: number, to: number) => Promise<void>;
  removeTrack: (id: string, index: number) => Promise<void>;
  /** Replace the playlist's tracks with the current queue. */
  overwriteWithQueue: (id: string) => Promise<void>;
  /** Resolve a playlist's track ids to tracks (library/queue first, then the API). Unknown ids are dropped. */
  resolveTracks: (trackIds: string[]) => Promise<PlaylistTrack[]>;
  playLocal: (id: string) => Promise<void>;
  playCloud: (id: string) => Promise<void>;
  saveCloudCopy: (playlist: CloudPlaylist) => Promise<void>;
}
