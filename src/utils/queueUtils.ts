import type { PlaylistTrack } from '../types/library';
import type { RepeatMode } from '../storage/queueStorage';

export const getNextQueueIndex = (
  queueLength: number,
  queueCurrentIndex: number,
  shuffle: boolean,
  repeatMode: RepeatMode
): number => {
  if (queueLength === 0) return -1;

  const currentIndex = queueCurrentIndex >= 0 && queueCurrentIndex < queueLength ? queueCurrentIndex : -1;

  if (shuffle) {
    if (queueLength === 1) {
      return repeatMode === 'all' ? 0 : -1;
    }
    let nextIndex: number;
    do {
      nextIndex = Math.floor(Math.random() * queueLength);
    } while (nextIndex === currentIndex);
    return nextIndex;
  }

  const nextIndex = currentIndex + 1;
  if (nextIndex < queueLength) return nextIndex;
  return repeatMode === 'all' ? 0 : -1;
};

export const getPreviousQueueIndex = (
  queueLength: number,
  queueCurrentIndex: number,
  repeatMode: RepeatMode
): number => {
  if (queueLength <= 0) return -1;

  if (repeatMode === 'all') {
    return (queueCurrentIndex - 1 + queueLength) % queueLength;
  }

  if (queueCurrentIndex > 0) return queueCurrentIndex - 1;
  return -1;
};

export const handleQueueAutoAdvance = (
  queue: PlaylistTrack[],
  queueCurrentIndex: number,
  shuffle: boolean,
  repeatMode: RepeatMode,
  onPlayTrack: (track: PlaylistTrack, index: number) => void,
  onReplay?: () => void
): void => {
  if (queue.length === 0) return;
  if (repeatMode === 'one') {
    if (onReplay) onReplay();
    return;
  }

  const nextIndex = getNextQueueIndex(queue.length, queueCurrentIndex, shuffle, repeatMode);
  if (nextIndex === -1) return;

  const nextTrack = queue[nextIndex];
  if (nextTrack) {
    onPlayTrack(nextTrack, nextIndex);
  }
};

export const reorderQueueItem = (
  queue: PlaylistTrack[],
  startIndex: number,
  endIndex: number
): PlaylistTrack[] => {
  if (startIndex === endIndex) return queue;
  const next = [...queue];
  const [removed] = next.splice(startIndex, 1);
  next.splice(endIndex, 0, removed);
  return next;
};

export const reorderQueueIndex = (
  currentIndex: number,
  startIndex: number,
  endIndex: number
): number => {
  if (currentIndex === -1) return -1;
  if (currentIndex === startIndex) return endIndex;
  if (startIndex < endIndex) {
    if (currentIndex > startIndex && currentIndex <= endIndex) return currentIndex - 1;
  } else {
    if (currentIndex >= endIndex && currentIndex < startIndex) return currentIndex + 1;
  }
  return currentIndex;
};

export const addTrackToQueue = (
  queue: PlaylistTrack[],
  track: PlaylistTrack
): PlaylistTrack[] => {
  if (queue.some(t => t.id === track.id)) return queue;
  return [...queue, track];
};

export const playNextTrack = (
  queue: PlaylistTrack[],
  track: PlaylistTrack,
  queueCurrentIndex: number
): { queue: PlaylistTrack[]; insertAt: number } => {
  if (queue.some(t => t.id === track.id)) return { queue, insertAt: -1 };
  const insertAt = queueCurrentIndex >= 0 ? queueCurrentIndex + 1 : queue.length;
  const next = [...queue];
  next.splice(insertAt, 0, track);
  return { queue: next, insertAt };
};

export const removeFromQueue = (
  queue: PlaylistTrack[],
  index: number
): PlaylistTrack[] => queue.filter((_, i) => i !== index);

export const clearQueue = (): PlaylistTrack[] => [];
