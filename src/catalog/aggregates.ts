// Albums and artists derived from every source's tracks. Rebuilt after a sync or
// scan; cheap next to the walk that precedes it.

import type { TrackSource } from '../types/track';
import type { CatalogAlbum, CatalogArtist, CatalogDb, CatalogTrack } from './db';

/** Case-, width- and whitespace-insensitive key for names. */
export function normalizeName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const trackArtist = (t: Pick<CatalogTrack, 'artist' | 'author'>) => (t.artist || t.author || '').trim();

export function albumKey(artist: string, album: string): string {
  return `${normalizeName(artist)}|${normalizeName(album)}`;
}

export function buildAggregates(tracks: Iterable<CatalogTrack>): { albums: CatalogAlbum[]; artists: CatalogArtist[] } {
  const albums = new Map<string, CatalogAlbum & { sourceSet: Set<TrackSource> }>();
  const artists = new Map<string, CatalogArtist & { albumIds: Set<string> }>();

  for (const track of tracks) {
    if (track.trashed) continue;
    const artist = trackArtist(track);
    const artistId = artist ? normalizeName(artist) : '';
    if (artistId) {
      const entry = artists.get(artistId) ?? { id: artistId, name: artist, trackCount: 0, albumCount: 0, albumIds: new Set() };
      entry.trackCount++;
      artists.set(artistId, entry);
    }
    if (!track.album?.trim()) continue;
    const id = albumKey(artist, track.album);
    const album = albums.get(id) ?? {
      id, title: track.album.trim(), artist, trackCount: 0, sources: [], sourceSet: new Set<TrackSource>(),
    };
    album.trackCount++;
    album.sourceSet.add(track.source);
    album.year ??= track.year;
    albums.set(id, album);
    artists.get(artistId)?.albumIds.add(id);
  }

  return {
    albums: [...albums.values()].map(({ sourceSet, ...a }) => ({ ...a, sources: [...sourceSet].sort() })),
    artists: [...artists.values()].map(({ albumIds, ...a }) => ({ ...a, albumCount: albumIds.size })),
  };
}

export async function rebuildAggregates(db: CatalogDb): Promise<void> {
  await db.transaction('rw', db.tracks, db.albums, db.artists, async () => {
    const { albums, artists } = buildAggregates(await db.tracks.toArray());
    await db.albums.clear();
    await db.artists.clear();
    await db.albums.bulkPut(albums);
    await db.artists.bulkPut(artists);
  });
}
