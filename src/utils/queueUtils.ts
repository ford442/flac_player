import { PlaylistTrack, RepeatMode } from '../audioLoader';

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

  let nextIndex: number;
  if (shuffle) {
    if (queue.length === 1) {
      nextIndex = 0;
    } else {
      do {
        nextIndex = Math.floor(Math.random() * queue.length);
      } while (nextIndex === queueCurrentIndex);
    }
  } else {
    nextIndex = queueCurrentIndex + 1;
    if (nextIndex >= queue.length) {
      if (repeatMode === 'all') {
        nextIndex = 0;
      } else {
        return;
      }
    }
  }

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
