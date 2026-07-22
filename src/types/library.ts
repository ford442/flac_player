export interface PlaylistTrack {
  id: string;
  name: string;
  title?: string;
  url: string;
  rating?: number;
  description?: string;
  author?: string;
  artist?: string;
  genre?: string;
  cover_url?: string;
  last_played?: string;
  type?: string;
  duration?: number;
  play_count?: number;
  tags?: string[];
  created_at?: string;
  generation_model?: string;
  version?: string;
  prompt?: string;
  /** ReplayGain track gain in dB (from file tags or API). */
  replaygain_track_db?: number;
  /** ReplayGain album gain in dB (from file tags or API). */
  replaygain_album_db?: number;
  /** ReplayGain track peak (linear 0–1+, from file tags or API). */
  replaygain_track_peak?: number;
  /** ReplayGain album peak (linear 0–1+, from file tags or API). */
  replaygain_album_peak?: number;
}

export interface ShareResponse {
  share_id: string;
  short_url: string;
  full_url: string;
  expires_at?: string;
}

export interface CloudPlaylist {
  id: string;
  title: string;
  description?: string;
  track_ids: string[];
  created_at?: string;
  updated_at?: string;
}

export interface LibraryStats {
  total_tracks: number;
  rated_4plus: number;
  total_duration_hours: number;
  total_play_count: number;
  untagged_count: number;
  trash_count: number;
  unique_tags: number;
  top_tags: { name: string; count: number }[];
}

export interface TagInfo {
  name: string;
  count: number;
}

export type SortBy = 'date' | 'rating' | 'name' | 'last_played' | 'genre' | 'play_count' | 'random';
