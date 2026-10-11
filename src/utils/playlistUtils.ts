import type { PlaylistTrack } from '../types/library';

/** Move one item (same semantics as queue reordering); out-of-range indices return the input unchanged. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from === to || from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Resolve ids to tracks in playlist order. Known tracks come from `known`; the rest are
 * fetched with `fetchById` (at most `concurrency` at a time). Missing/failed ids are dropped.
 */
export async function resolveTracksById(
  trackIds: readonly string[],
  known: ReadonlyMap<string, PlaylistTrack>,
  fetchById: (id: string) => Promise<PlaylistTrack>,
  concurrency = 4,
): Promise<PlaylistTrack[]> {
  const resolved = new Map(known);
  const missing = Array.from(new Set(trackIds.filter(id => !resolved.has(id))));
  let cursor = 0;
  const worker = async () => {
    while (cursor < missing.length) {
      const id = missing[cursor++];
      try { resolved.set(id, await fetchById(id)); } catch { /* unavailable track: skipped */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, missing.length) }, worker));
  return trackIds.map(id => resolved.get(id)).filter((t): t is PlaylistTrack => !!t);
}
