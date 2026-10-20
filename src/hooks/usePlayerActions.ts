// Room-aware transport and queue actions (#258). Components call these instead of
// taking a dozen callback props; a listening-room guest gets a hint instead of
// changing playback the host controls.

import { useMemo, useRef } from 'react';
import type { PlaylistTrack } from '../types/library';
import type { AudioOutputMode } from '../types/audio';
import type { RepeatMode } from '../storage/queueStorage';
import type { PlaybackEngine } from '../player/PlaybackEngine';
import { notify, type PlayerStore } from '../player/playerStore';
import { demoTracks, trackFromUrl } from '../utils/remoteTracks';
import { shuffleArray } from '../utils/audioUtils';

export interface PlayerActions {
  togglePlay(): void;
  pause(): void;
  stop(): void;
  next(): void;
  previous(): void;
  /** Absent when the backend cannot seek or a room guest follows the host. */
  seek?: (time: number) => void;
  seekBy?: (deltaSeconds: number) => void;
  setVolume(volume: number): void;
  toggleMute(): void;
  /** Play the queue entry at `index`. */
  playQueueIndex(index: number): void;
  /** Play a library track from its queue slot, appending it when it is not queued. */
  playTrack(track: PlaylistTrack): void;
  /** Replace the queue with this one track. */
  playNow(track: PlaylistTrack): void;
  playAll(tracks: PlaylistTrack[], shuffled?: boolean): void;
  enqueue(track: PlaylistTrack): void;
  enqueueAll(tracks: PlaylistTrack[]): void;
  enqueueNext(track: PlaylistTrack): void;
  removeFromQueue(index: number): void;
  reorderQueue(from: number, to: number): void;
  clearQueue(): void;
  toggleShuffle(): void;
  cycleRepeat(): void;
  addFiles(files: File[]): void;
  /** Returns an error message for the input form, or null when playback started. */
  loadUrl(raw: string): string | null;
  loadDemo(): void;
  setOutputMode(mode: AudioOutputMode): void;
}

export interface RoomTransportPolicy {
  /** In a room as a guest: the host owns the transport. */
  isGuest: boolean;
  inRoom: boolean;
  /** The guest's audio is still locked behind a user gesture. */
  needsUserGesture: boolean;
  unlockAudio(): void;
}

const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = { off: 'all', all: 'one', one: 'off' };

export function usePlayerActions(
  engine: PlaybackEngine,
  store: PlayerStore,
  room: RoomTransportPolicy,
  canSeek: boolean,
): PlayerActions {
  const roomRef = useRef(room);
  roomRef.current = room;
  const seekable = canSeek && !room.isGuest;

  return useMemo<PlayerActions>(() => {
    const toast = (message: string, type: 'success' | 'error' | 'info' = 'info') => notify(store, message, type);
    /** True when the caller may drive playback; a guest gets the hint instead. */
    const isHost = () => {
      if (!roomRef.current.isGuest) return true;
      toast('The host controls playback in this listening room', 'info');
      return false;
    };
    const hostOnly = (action: () => void) => () => { if (isHost()) action(); };
    const playAll = (tracks: PlaylistTrack[], shuffled = false) => {
      if (tracks.length === 0 || !isHost()) return;
      const ordered = shuffled ? shuffleArray(tracks) : tracks;
      engine.playQueue(ordered, 0);
      toast(shuffled ? `Shuffling ${ordered.length} tracks` : `Playing ${ordered.length} tracks`, 'success');
    };

    return {
      togglePlay: () => {
        const r = roomRef.current;
        if (!r.isGuest) { engine.togglePlay(); return; }
        // A guest's play button only unlocks audio; the host drives everything else.
        if (r.needsUserGesture || store.getState().transport.status !== 'playing') r.unlockAudio();
        else toast('The host controls playback in this listening room', 'info');
      },
      pause: hostOnly(() => engine.pause()),
      stop: hostOnly(() => engine.stop()),
      next: hostOnly(() => engine.next()),
      previous: hostOnly(() => engine.prev()),
      seek: seekable ? (time) => engine.seek(time) : undefined,
      seekBy: seekable ? (delta) => engine.seekBy(delta) : undefined,
      setVolume: (volume) => engine.setVolume(volume),
      toggleMute: () => engine.toggleMute(),
      playQueueIndex: (index) => { if (isHost()) engine.playAt(index); },
      playTrack: (track) => {
        if (!isHost()) return;
        if (!store.getState().queue.tracks.some((t) => t.id === track.id)) toast('Added to queue', 'success');
        engine.playTrack(track);
      },
      playNow: (track) => {
        if (!isHost()) return;
        engine.playQueue([track], 0);
        toast('Playing now: ' + (track.title || track.name), 'info');
      },
      playAll,
      enqueue: (track) => {
        engine.enqueue(track);
        toast('Added to queue', 'success');
      },
      enqueueAll: (tracks) => {
        if (tracks.length === 0) return;
        engine.enqueueAll(tracks);
        toast(`Added ${tracks.length} tracks to queue`, 'success');
      },
      enqueueNext: (track) => {
        engine.insertNext(track);
        toast('Playing next: ' + (track.title || track.name), 'success');
      },
      removeFromQueue: (index) => engine.removeFromQueue(index),
      reorderQueue: (from, to) => engine.reorderQueue(from, to),
      clearQueue: () => engine.clearQueue(),
      toggleShuffle: () => engine.setShuffle(!store.getState().queue.shuffle),
      cycleRepeat: () => engine.setRepeatMode(NEXT_REPEAT[store.getState().queue.repeatMode]),
      addFiles: (files) => {
        if (roomRef.current.inRoom) { toast('Local files cannot be shared in a listening room', 'info'); return; }
        void engine.addLocalFiles(files);
      },
      loadUrl: (raw) => {
        const track = trackFromUrl(raw);
        if (!track) return 'Enter a full http(s):// link to an audio file.';
        if (!isHost()) return null;
        // Play it next to the current track; a pasted link must not wipe the queue (#258).
        engine.playNextNow(track);
        toast('Playing now: ' + (track.title || track.name), 'info');
        return null;
      },
      loadDemo: () => {
        if (!isHost()) return;
        playAll(demoTracks());
        toast('Demo playlist loaded', 'info');
      },
      setOutputMode: (mode) => engine.setOutputMode(mode),
    };
  }, [engine, store, seekable]);
}
