import { PlaylistTrack, RepeatMode } from '../audioLoader';

export const getNextQueueIndex = (queueLength: number, currentIndex: number, shuffle: boolean, repeatMode: 'off' | 'all' | 'one'): number => {
  if (queueLength === 0) return -1;
  if (shuffle) return Math.floor(Math.random() * queueLength);
  if (currentIndex < queueLength - 1) return currentIndex + 1;
  return repeatMode === 'all' && queueLength > 1 ? 0 : -1;
};

export const getPreviousQueueIndex = (queueLength: number, currentIndex: number, repeatMode: 'off' | 'all' | 'one'): number => {
  if (queueLength === 0) return -1;
  if (currentIndex > 0) return currentIndex - 1;
  return repeatMode === 'all' && queueLength > 1 ? queueLength - 1 : -1;
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
