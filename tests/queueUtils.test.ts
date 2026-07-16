import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PlaylistTrack } from '../src/types/library';
import {
  getNextQueueIndex,
  getPreviousQueueIndex,
  handleQueueAutoAdvance,
  reorderQueueItem,
  reorderQueueIndex,
  addTrackToQueue,
  playNextTrack,
  removeFromQueue,
} from '../src/utils/queueUtils';

const track = (id: string): PlaylistTrack => ({
  id,
  name: `Track ${id}`,
  url: `https://example.com/${id}.flac`,
});

describe('getNextQueueIndex', () => {
  it('returns -1 for an empty queue', () => {
    expect(getNextQueueIndex(0, 0, false, 'off')).toBe(-1);
  });

  it('advances sequentially when shuffle is off', () => {
    expect(getNextQueueIndex(3, 0, false, 'off')).toBe(1);
    expect(getNextQueueIndex(3, 1, false, 'off')).toBe(2);
  });

  it('returns -1 at the last track when repeat is off', () => {
    expect(getNextQueueIndex(3, 2, false, 'off')).toBe(-1);
  });

  it('wraps to index 0 at the end when repeat-all is on', () => {
    expect(getNextQueueIndex(3, 2, false, 'all')).toBe(0);
  });

  it('returns 0 from an invalid current index on a non-empty queue', () => {
    expect(getNextQueueIndex(2, 99, false, 'off')).toBe(0);
  });

  describe('shuffle', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns 0 for a single-track queue with repeat-all', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      expect(getNextQueueIndex(1, 0, true, 'all')).toBe(0);
    });

    it('returns -1 for a single-track queue without repeat', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      expect(getNextQueueIndex(1, 0, true, 'off')).toBe(-1);
    });

    it('picks a different index when multiple tracks exist', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.1);
      const next = getNextQueueIndex(4, 3, true, 'off');
      expect(next).toBe(0);
      expect(next).not.toBe(3);
    });
  });
});

describe('getPreviousQueueIndex', () => {
  it('returns -1 for an empty queue', () => {
    expect(getPreviousQueueIndex(0, 0, 'off')).toBe(-1);
  });

  it('returns -1 at the first track when repeat is off', () => {
    expect(getPreviousQueueIndex(3, 0, 'off')).toBe(-1);
  });

  it('wraps to the last track when repeat-all is on', () => {
    expect(getPreviousQueueIndex(3, 0, 'all')).toBe(2);
  });

  it('steps back sequentially when repeat is off', () => {
    expect(getPreviousQueueIndex(3, 2, 'off')).toBe(1);
  });
});

describe('handleQueueAutoAdvance', () => {
  it('does nothing for an empty queue', () => {
    const onPlay = vi.fn();
    handleQueueAutoAdvance([], 0, false, 'off', onPlay);
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('calls onReplay when repeat-one is active', () => {
    const onReplay = vi.fn();
    const onPlay = vi.fn();
    handleQueueAutoAdvance([track('a')], 0, false, 'one', onPlay, onReplay);
    expect(onReplay).toHaveBeenCalledOnce();
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('plays the next track when repeat-all wraps', () => {
    const onPlay = vi.fn();
    const q = [track('a'), track('b')];
    handleQueueAutoAdvance(q, 1, false, 'all', onPlay);
    expect(onPlay).toHaveBeenCalledWith(q[0], 0);
  });
});

describe('reorderQueueItem', () => {
  it('moves an item within the queue', () => {
    const q = [track('a'), track('b'), track('c')];
    expect(reorderQueueItem(q, 0, 2).map(t => t.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('reorderQueueIndex', () => {
  it('follows a dragged current index', () => {
    expect(reorderQueueIndex(0, 0, 2)).toBe(2);
  });

  it('shifts indices when dragging downward', () => {
    expect(reorderQueueIndex(2, 0, 2)).toBe(1);
  });
});

describe('addTrackToQueue', () => {
  it('appends a new track', () => {
    const q = [track('a')];
    const next = addTrackToQueue(q, track('b'));
    expect(next).toHaveLength(2);
    expect(next[1].id).toBe('b');
  });

  it('skips duplicates by id', () => {
    const q = [track('a')];
    expect(addTrackToQueue(q, track('a'))).toBe(q);
  });
});

describe('playNextTrack', () => {
  it('inserts after the current index', () => {
    const q = [track('a'), track('b')];
    const { queue: next, insertAt } = playNextTrack(q, track('c'), 0);
    expect(insertAt).toBe(1);
    expect(next.map(t => t.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('removeFromQueue', () => {
  it('removes by index', () => {
    const q = [track('a'), track('b')];
    expect(removeFromQueue(q, 0).map(t => t.id)).toEqual(['b']);
  });
});
