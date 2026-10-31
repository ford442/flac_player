// Response schemas for the library host. Lenient on purpose: a mistyped optional
// field becomes undefined and an invalid row is dropped, so one bad record never
// hides the rest of the library.

import * as v from 'valibot';
import type { CloudPlaylist, ShareResponse } from '../types/library';

/** Optional field: missing, null or mistyped all read as undefined. */
const maybe = <T>(schema: v.GenericSchema<unknown, T>) => v.fallback(v.optional(schema), undefined);

/** Array whose invalid items are dropped instead of failing the whole response. */
export function lenientArray<T>(item: v.GenericSchema<unknown, T>) {
  return v.pipe(
    v.array(v.unknown()),
    v.transform((items): T[] => items.flatMap((raw) => {
      const parsed = v.safeParse(item, raw);
      return parsed.success ? [parsed.output] : [];
    })),
  );
}

/** A catalog row; unknown keys are kept. `url` is resolved by the caller. */
export const CatalogSongSchema = v.looseObject({
  id: v.string(),
  name: v.string(),
  url: maybe(v.string()),
  title: maybe(v.string()),
  rating: maybe(v.number()),
  description: maybe(v.string()),
  author: maybe(v.string()),
  artist: maybe(v.string()),
  genre: maybe(v.string()),
  cover_url: maybe(v.string()),
  last_played: maybe(v.string()),
  type: maybe(v.string()),
  duration: maybe(v.number()),
  play_count: maybe(v.number()),
  tags: maybe(v.array(v.string())),
  created_at: maybe(v.string()),
  generation_model: maybe(v.string()),
  version: maybe(v.string()),
  prompt: maybe(v.string()),
  replaygain_track_db: maybe(v.number()),
  replaygain_album_db: maybe(v.number()),
  replaygain_track_peak: maybe(v.number()),
  replaygain_album_peak: maybe(v.number()),
});
export type CatalogSong = v.InferOutput<typeof CatalogSongSchema>;

export const SongListSchema = lenientArray(CatalogSongSchema);

export const SharedPlaylistSchema = v.object({
  title: v.fallback(v.string(), 'Shared Playlist'),
  tracks: SongListSchema,
});

export const ShareResponseSchema: v.GenericSchema<unknown, ShareResponse> = v.object({
  share_id: v.string(),
  short_url: v.fallback(v.string(), ''),
  full_url: v.string(),
  expires_at: maybe(v.string()),
});

export const SuggestTagsSchema = v.object({
  suggestions: v.fallback(v.array(v.string()), []),
  source: v.fallback(v.string(), 'unknown'),
});

export const MusicBrainzSearchSchema = v.looseObject({
  found: v.fallback(v.boolean(), false),
  data: maybe(v.looseObject({
    title: v.fallback(v.nullish(v.string()), null),
    artist: v.fallback(v.nullish(v.string()), null),
    genre: v.fallback(v.nullish(v.string()), null),
    tags: v.fallback(v.array(v.string()), []),
    description: v.fallback(v.nullish(v.string()), null),
    year: v.fallback(v.nullish(v.number()), null),
  })),
});

export const CloudPlaylistSchema: v.GenericSchema<unknown, CloudPlaylist> = v.object({
  id: v.union([v.string(), v.pipe(v.number(), v.transform(String))]),
  title: v.fallback(v.string(), 'Untitled playlist'),
  description: maybe(v.string()),
  track_ids: v.fallback(v.array(v.string()), []),
  created_at: maybe(v.string()),
  updated_at: maybe(v.string()),
});

export const CloudPlaylistListSchema = lenientArray(CloudPlaylistSchema);

export const PlaylistTrackIdsSchema = v.pipe(
  v.looseObject({ track_ids: v.fallback(v.array(v.string()), []) }),
  v.transform((body): string[] => body.track_ids),
);

export const PlaylistHealthSchema = v.looseObject({ writable: v.fallback(v.boolean(), false) });
