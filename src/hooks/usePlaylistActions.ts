import { useCallback } from 'react';
import { AudioLoader, PlaylistTrack } from '../audioLoader';
import { shuffleArray } from '../utils/audioUtils';

interface UsePlaylistActionsParams {
  loader: AudioLoader;
  library: PlaylistTrack[];
  queue: PlaylistTrack[];
  setQueue: React.Dispatch<React.SetStateAction<PlaylistTrack[]>>;
  setQueueCurrentIndex: React.Dispatch<React.SetStateAction<number>>;
  playTrack: (track: PlaylistTrack, index?: number) => Promise<void>;
  currentTrack: PlaylistTrack | null;
  addToast: (msg: string, type: 'success' | 'error' | 'info') => void;
}

/**
 * Queue-building actions: bulk play, smart mix, cloud playlists and sharing.
 * Each one replaces or extends the queue and then hands off to playTrack.
 */
export function usePlaylistActions({
  loader,
  library,
  queue,
  setQueue,
  setQueueCurrentIndex,
  playTrack,
  currentTrack,
  addToast,
}: UsePlaylistActionsParams) {
  const playAll = useCallback((tracks: PlaylistTrack[], shuffled = false) => {
    if (tracks.length === 0) return;
    const ordered = shuffled ? shuffleArray(tracks) : tracks;
    setQueue(ordered);
    setQueueCurrentIndex(0);
    playTrack(ordered[0], 0);
    addToast(shuffled ? `Shuffling ${ordered.length} tracks` : `Playing ${ordered.length} tracks`, 'success');
  }, [setQueue, setQueueCurrentIndex, playTrack, addToast]);

  const playNow = useCallback((track: PlaylistTrack) => {
    setQueue([track]);
    setQueueCurrentIndex(0);
    playTrack(track, 0);
    addToast('Playing now: ' + (track.title || track.name), 'info');
  }, [setQueue, setQueueCurrentIndex, playTrack, addToast]);

  const loadCloudPlaylist = useCallback(async (playlistId: string) => {
    try {
      const trackIds = await loader.fetchPlaylistTracks(playlistId);
      if (trackIds.length === 0) { addToast('Playlist is empty or unavailable', 'info'); return; }
      const matchedTracks = trackIds.map(id => library.find(t => t.id === id)).filter(Boolean) as PlaylistTrack[];
      if (matchedTracks.length === 0) { addToast('No matching tracks found in local library', 'error'); return; }
      setQueue(matchedTracks);
      setQueueCurrentIndex(0);
      playTrack(matchedTracks[0], 0);
      addToast(`Loaded ${matchedTracks.length}/${trackIds.length} tracks from playlist`, 'success');
    } catch {
      addToast('Failed to load playlist tracks', 'error');
    }
  }, [loader, library, setQueue, setQueueCurrentIndex, playTrack, addToast]);

  const handleSmartMix = useCallback(async () => {
    if (!currentTrack?.tags) { addToast('No tags to base mix on', 'error'); return; }
    try {
      const similar = await loader.findSimilarTracks(currentTrack.id, currentTrack.tags, 4, 20);
      if (similar.length > 0) {
        setQueue(prev => [...prev, ...similar.filter(t => !prev.some(p => p.id === t.id))]);
        addToast(`Added ${similar.length} tracks to queue`, 'success');
      } else {
        addToast('No similar tracks found', 'info');
      }
    } catch {
      addToast('Failed to create smart mix', 'error');
    }
  }, [loader, currentTrack, setQueue, addToast]);

  const generateShareLink = useCallback(async () => {
    if (queue.length === 0) { addToast('Add tracks to the queue first.', 'info'); return; }
    const trackIds = queue.map(t => t.id).filter(Boolean);
    if (trackIds.length === 0) { addToast('No valid tracks to share.', 'info'); return; }
    try {
      const shareResponse = await loader.createShare(trackIds, 'Shared Playlist', 30);
      await navigator.clipboard.writeText(shareResponse.short_url || shareResponse.full_url);
      addToast('Shareable playlist link copied to clipboard!', 'success');
      return;
    } catch {
      addToast('Could not create shared playlist. Falling back to URL playlist.', 'error');
    }
    // Legacy fallback: encode the track ids straight into the URL.
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}?tracks=${trackIds.join(',')}`);
      addToast('Legacy playlist link copied to clipboard.', 'success');
    } catch {
      addToast('Error copying link.', 'error');
    }
  }, [loader, queue, addToast]);

  return { playAll, playNow, loadCloudPlaylist, handleSmartMix, generateShareLink };
}
