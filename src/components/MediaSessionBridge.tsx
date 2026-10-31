import React from 'react';
import { useMediaSession } from '../hooks/useMediaSession';
import { selectIsPlaying, useClock, useTransport } from '../player/selectors';
import { useActions } from './PlayerActionsContext';

/**
 * Feeds `navigator.mediaSession` from the player store. A component of its own so
 * its clock subscription (position state) re-renders nothing else (#258).
 */
export const MediaSessionBridge: React.FC<{ playbackRate: number }> = ({ playbackRate }) => {
  const currentTrack = useTransport((t) => t.currentTrack);
  const isPlaying = useTransport(selectIsPlaying);
  const { position, duration } = useClock();
  const actions = useActions();
  useMediaSession({
    currentTrack,
    isPlaying,
    currentTime: position,
    duration,
    playbackRate,
    onPlay: () => { if (!isPlaying) actions.togglePlay(); },
    onPause: actions.pause,
    onNext: actions.next,
    onPrevious: actions.previous,
    onSeek: actions.seek,
  });
  return null;
};
