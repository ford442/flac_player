import { useState, useCallback, useEffect, useMemo } from 'react';
import { fetchPlaylistTracks, fetchPlaylists, fetchSong } from '../api/songApi';
import { playlistStore, type PlaylistStore } from '../storage/playlistStore';
import type { CloudPlaylist, PlaylistTrack } from '../types/library';
import { isLibraryTrack } from '../types/track';
import type { LocalPlaylist, PlaylistsController } from '../types/playlist';
import { moveItem, resolveTracksById } from '../utils/playlistUtils';

interface UsePlaylistsParams {
  library: PlaylistTrack[];
  queue: PlaylistTrack[];
  addToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  /** Replace the queue with these tracks and start playing the first one. */
  onPlayTracks: (tracks: PlaylistTrack[]) => void;
  store?: PlaylistStore;
}

/**
 * Saved playlists: local ones live in IndexedDB (never blocks the library fetch);
 * cloud ones are the read-only `GET /api/playlists` list from the library host.
 */
export function usePlaylists({
  library, queue, addToast, onPlayTracks, store = playlistStore,
}: UsePlaylistsParams): PlaylistsController {
  const [local, setLocal] = useState<LocalPlaylist[]>([]);
  const [localAvailable, setLocalAvailable] = useState(() => store.isAvailable());
  const [cloud, setCloud] = useState<CloudPlaylist[]>([]);
  const [isLoadingCloud, setIsLoadingCloud] = useState(false);

  const reloadLocal = useCallback(async () => {
    if (!store.isAvailable()) { setLocalAvailable(false); return; }
    try {
      setLocal(await store.list());
      setLocalAvailable(true);
    } catch {
      setLocalAvailable(false);
    }
  }, [store]);

  useEffect(() => { void reloadLocal(); }, [reloadLocal]);

  const refreshCloud = useCallback(() => {
    setIsLoadingCloud(true);
    fetchPlaylists()
      .then(setCloud)
      .catch(() => addToast('Failed to load playlists', 'error'))
      .finally(() => setIsLoadingCloud(false));
  }, [addToast]);

  const replaceInState = useCallback((updated: LocalPlaylist | null) => {
    if (updated) setLocal(prev => prev.map(p => p.id === updated.id ? updated : p));
  }, []);

  /** Run a store write; on failure toast and resync from disk so the UI never shows phantom state. */
  const attempt = useCallback(async (write: () => Promise<void>, failure: string) => {
    try { await write(); }
    catch { addToast(failure, 'error'); void reloadLocal(); }
  }, [addToast, reloadLocal]);

  const knownTracks = useMemo(() => {
    const map = new Map<string, PlaylistTrack>();
    for (const t of library) map.set(t.id, t);
    for (const t of queue) if (!map.has(t.id)) map.set(t.id, t);
    return map;
  }, [library, queue]);

  const resolveTracks = useCallback(
    // Only catalog ids are looked up; a link or local-file id saved before #258 is skipped.
    (trackIds: string[]) => resolveTracksById(trackIds, knownTracks, id => (
      isLibraryTrack({ id }) ? fetchSong(id) : Promise.reject(new Error(`Not a library track: ${id}`))
    )),
    [knownTracks],
  );

  // Playlists hold catalog ids: links and local files in the queue cannot be resolved later.
  const queueIds = useCallback(() => queue.filter(isLibraryTrack).map(t => t.id), [queue]);

  const createFromQueue = useCallback(async (title: string) => {
    const trackIds = queueIds();
    if (trackIds.length === 0) { addToast('Add tracks to the queue first.', 'info'); return; }
    await attempt(async () => {
      const created = await store.create({ title, trackIds });
      setLocal(prev => [created, ...prev]);
      addToast(`Saved playlist "${created.title}" (${trackIds.length} tracks)`, 'success');
    }, 'Could not save playlist');
  }, [queueIds, store, addToast, attempt]);

  const rename = useCallback((id: string, title: string) => attempt(
    async () => replaceInState(await store.update(id, { title })), 'Could not rename playlist',
  ), [store, replaceInState, attempt]);

  const remove = useCallback((id: string) => attempt(async () => {
    await store.remove(id);
    setLocal(prev => prev.filter(p => p.id !== id));
  }, 'Could not delete playlist'), [store, attempt]);

  const moveTrack = useCallback((id: string, from: number, to: number) => attempt(async () => {
    const playlist = local.find(p => p.id === id);
    if (!playlist) return;
    replaceInState(await store.update(id, { trackIds: moveItem(playlist.trackIds, from, to) }));
  }, 'Could not reorder playlist'), [local, store, replaceInState, attempt]);

  const removeTrack = useCallback((id: string, index: number) => attempt(async () => {
    const playlist = local.find(p => p.id === id);
    if (!playlist) return;
    replaceInState(await store.update(id, { trackIds: playlist.trackIds.filter((_, i) => i !== index) }));
  }, 'Could not update playlist'), [local, store, replaceInState, attempt]);

  const overwriteWithQueue = useCallback(async (id: string) => {
    const trackIds = queueIds();
    if (trackIds.length === 0) { addToast('Add tracks to the queue first.', 'info'); return; }
    await attempt(async () => {
      replaceInState(await store.update(id, { trackIds }));
      addToast(`Playlist updated with ${trackIds.length} tracks`, 'success');
    }, 'Could not update playlist');
  }, [queueIds, store, replaceInState, addToast, attempt]);

  const playIds = useCallback(async (trackIds: string[]) => {
    if (trackIds.length === 0) { addToast('Playlist is empty or unavailable', 'info'); return; }
    const tracks = await resolveTracks(trackIds);
    if (tracks.length === 0) { addToast('None of this playlist’s tracks are available', 'error'); return; }
    onPlayTracks(tracks);
    if (tracks.length < trackIds.length) {
      addToast(`${trackIds.length - tracks.length} tracks are no longer in the library`, 'info');
    }
  }, [resolveTracks, onPlayTracks, addToast]);

  const playLocal = useCallback(async (id: string) => {
    const playlist = local.find(p => p.id === id);
    if (playlist) await playIds(playlist.trackIds);
  }, [local, playIds]);

  const playCloud = useCallback(async (id: string) => {
    await playIds(await fetchPlaylistTracks(id));
  }, [playIds]);

  const saveCloudCopy = useCallback(async (playlist: CloudPlaylist) => {
    await attempt(async () => {
      const trackIds = playlist.track_ids?.length ? playlist.track_ids : await fetchPlaylistTracks(playlist.id);
      const created = await store.create({
        title: playlist.title, description: playlist.description, trackIds, origin: 'cloud',
      });
      setLocal(prev => [created, ...prev]);
      addToast(`Saved a local copy of "${created.title}"`, 'success');
    }, 'Could not save playlist');
  }, [store, addToast, attempt]);

  return {
    local, localAvailable, cloud, isLoadingCloud, refreshCloud, queueLength: queue.length,
    createFromQueue, rename, remove, moveTrack, removeTrack, overwriteWithQueue,
    resolveTracks, playLocal, playCloud, saveCloudCopy,
  };
}
