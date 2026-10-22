// Library filters, sort, tags and stats over catalog rows. Filter semantics follow the
// hosts' `GET /api/songs` (rating_gte, any-of tags, untagged, substring search), so the
// view is the same online and offline.

import type { LibraryStats, PlaylistTrack, SortBy, TagInfo } from '../types/library';
import type { CatalogTrack } from './db';

export interface LibraryFilters {
  search: string;
  minRating: number;
  tags: string[];
  untaggedOnly: boolean;
  sortBy: SortBy;
}

export const DEFAULT_LIBRARY_FILTERS: LibraryFilters = {
  search: '', minRating: 0, tags: [], untaggedOnly: false, sortBy: 'date',
};

export const EMPTY_STATS: LibraryStats = {
  total_tracks: 0, rated_4plus: 0, total_duration_hours: 0,
  total_play_count: 0, untagged_count: 0, trash_count: 0, unique_tags: 0, top_tags: [],
};

/** The app-facing track for a row (drops catalog bookkeeping). */
export function fromCatalogTrack(row: CatalogTrack): PlaylistTrack {
  const { sourceId: _sourceId, remoteSig: _sig, ...track } = row as CatalogTrack & { remoteSig?: string };
  void _sourceId; void _sig;
  return track;
}

function matchesSearch(t: CatalogTrack, needle: string): boolean {
  return [t.name, t.title, t.author, t.artist, t.description].some((s) => s?.toLowerCase().includes(needle))
    || (t.tags ?? []).some((tag) => tag.toLowerCase().includes(needle));
}

export function filterTracks(rows: readonly CatalogTrack[], f: LibraryFilters): CatalogTrack[] {
  const needle = f.search.trim().toLowerCase();
  return rows.filter((t) => !t.trashed
    && (f.minRating <= 0 || (t.rating ?? 0) >= f.minRating)
    && (f.tags.length === 0 || f.tags.some((tag) => t.tags?.includes(tag)))
    && (!f.untaggedOnly || !t.tags?.length)
    && (!needle || matchesSearch(t, needle)));
}

/** Deterministic per-id shuffle key, so "random" is stable until the seed changes. */
function shuffleKey(id: string, seed: number): number {
  let h = seed ^ 0x9e3779b9;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x85ebca6b);
  return (h ^ (h >>> 13)) >>> 0;
}

const byString = (pick: (t: CatalogTrack) => string | undefined) =>
  (a: CatalogTrack, b: CatalogTrack) => (pick(a) ?? '').localeCompare(pick(b) ?? '');
const byNumber = (pick: (t: CatalogTrack) => number | undefined) =>
  (a: CatalogTrack, b: CatalogTrack) => (pick(a) ?? 0) - (pick(b) ?? 0);

/** Descending, like the hosts' default `sort_desc=true`; `name` sorts A→Z. */
export function sortTracks(rows: CatalogTrack[], sortBy: SortBy, seed = 0): CatalogTrack[] {
  const out = [...rows];
  switch (sortBy) {
    case 'name': return out.sort(byString((t) => t.name.toLowerCase()));
    case 'rating': return out.sort(byNumber((t) => t.rating)).reverse();
    case 'play_count': return out.sort(byNumber((t) => t.play_count)).reverse();
    case 'last_played': return out.sort(byString((t) => t.last_played)).reverse();
    case 'genre': return out.sort(byString((t) => t.genre?.toLowerCase()));
    case 'random': return out.sort((a, b) => shuffleKey(a.id, seed) - shuffleKey(b.id, seed));
    case 'date':
    default: return out.sort(byNumber((t) => t.addedAt)).reverse();
  }
}

export function computeTags(rows: readonly CatalogTrack[]): TagInfo[] {
  const counts = new Map<string, number>();
  for (const t of rows) {
    if (t.trashed) continue;
    for (const tag of t.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function computeStats(rows: readonly CatalogTrack[], tags = computeTags(rows)): LibraryStats {
  let total = 0, rated4 = 0, seconds = 0, plays = 0, untagged = 0, trashed = 0;
  for (const t of rows) {
    if (t.trashed) { trashed++; continue; }
    total++;
    if ((t.rating ?? 0) >= 4) rated4++;
    seconds += t.duration ?? 0;
    plays += t.play_count ?? 0;
    if (!t.tags?.length) untagged++;
  }
  return {
    total_tracks: total,
    rated_4plus: rated4,
    total_duration_hours: Math.floor(seconds / 3600),
    total_play_count: plays,
    untagged_count: untagged,
    trash_count: trashed,
    unique_tags: tags.length,
    top_tags: tags.slice(0, 20),
  };
}
