// Queue tools that talk to the outside world: share links, offline download and
// smart mix (#258 phase 4, moved out of Player). They read the queue at call
// time, so nothing re-renders when it changes.

import { useMemo } from 'react';
import { createShare, findSimilarTracks } from '../api/songApi';
import type { PlaybackEngine } from '../player/PlaybackEngine';
import { notify, type PlayerStore } from '../player/playerStore';
import { isLibraryTrack } from '../types/track';
import { downloadForOffline, isTrackCached } from '../storage/trackCache';
import { isOfflineCacheAvailable } from '../components/OfflineCache';

export interface QueueTools {
  shareQueue(): Promise<void>;
  downloadQueue(): Promise<void>;
  smartMix(): Promise<void>;
  /** Host a listening room with the queue; absent inside a room or a shared view. */
  listenTogether?: () => void;
}

export function useQueueActions(engine: PlaybackEngine, store: PlayerStore, listenTogether?: () => void): QueueTools {
  return useMemo<QueueTools>(() => {
    const toast = (message: string, type: 'success' | 'error' | 'info') => notify(store, message, type);
    const queueTracks = () => store.getState().queue.tracks;

    return {
      listenTogether,

      shareQueue: async () => {
        const queue = queueTracks();
        if (queue.length === 0) { toast('Add tracks to the queue first.', 'info'); return; }
        // Recipients resolve ids against the catalog: links and local files would not load.
        const trackIds = queue.filter(isLibraryTrack).map(t => t.id);
        if (trackIds.length === 0) { toast('Only library tracks can be shared.', 'info'); return; }
        const omitted = queue.length - trackIds.length;
        if (omitted > 0) toast(`Left out ${omitted} non-library track${omitted === 1 ? '' : 's'} (links or local files)`, 'info');
        try {
          const shareResponse = await createShare(trackIds, 'Shared Playlist', 30);
          await window.navigator.clipboard.writeText(shareResponse.short_url || shareResponse.full_url);
          toast('Shareable playlist link copied to clipboard!', 'success');
          return;
        } catch {
          toast('Could not create shared playlist. Falling back to URL playlist.', 'error');
        }
        try {
          await window.navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}?tracks=${trackIds.join(',')}`);
          toast('Legacy playlist link copied to clipboard.', 'success');
        } catch {
          toast('Error copying link.', 'error');
        }
      },

      downloadQueue: async () => {
        const queue = queueTracks();
        if (queue.length === 0) { toast('Add tracks to the queue first.', 'info'); return; }
        if (!isOfflineCacheAvailable()) { toast('Offline cache is unavailable in this browser', 'error'); return; }
        toast(`Downloading ${queue.length} tracks for offline…`, 'info');
        let saved = 0;
        const failed: string[] = [];
        for (const track of queue) {
          try {
            if (!(await isTrackCached(track.url))) await downloadForOffline(track.url);
            saved++;
          } catch {
            failed.push(track.title || track.name);
          }
        }
        if (failed.length === 0) toast(`${saved} tracks available offline`, 'success');
        else toast(`Offline: ${saved} saved, ${failed.length} failed (${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''})`, 'error');
      },

      smartMix: async () => {
        const currentTrack = store.getState().transport.currentTrack;
        if (currentTrack && !isLibraryTrack(currentTrack)) { toast('Smart mix needs a library track', 'info'); return; }
        if (!currentTrack?.tags) { toast('No tags to base mix on', 'error'); return; }
        try {
          const similar = await findSimilarTracks(currentTrack.id, currentTrack.tags, 4, 20);
          if (similar.length > 0) {
            engine.enqueueAll(similar);
            toast(`Added ${similar.length} tracks to queue`, 'success');
          } else {
            toast('No similar tracks found', 'info');
          }
        } catch {
          toast('Failed to create smart mix', 'error');
        }
      },
    };
  }, [engine, store, listenTogether]);
}
