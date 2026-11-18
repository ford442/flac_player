// The library view is windowed in both layouts (#284): a 2k-track folder mounts a few
// dozen rows, scrolling moves the window, and local tracks have no host-only controls.
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { LibraryView } from '../src/components/LibraryView';
import { FALLBACK_VIEWPORT_PX, gridColumnsFor, windowRange } from '../src/components/library/useWindowedRows';
import { localTrackId, localTrackUrl } from '../src/types/track';
import type { PlaylistTrack } from '../src/types/library';

vi.mock('../src/components/OfflineCache', () => ({ OfflineBadge: () => <span data-testid="offline-badge" /> }));

const COUNT = 2000;
const folderTracks: PlaylistTrack[] = Array.from({ length: COUNT }, (_, i) => {
  const path = `Disc/${String(i).padStart(4, '0')}.flac`;
  return {
    id: localTrackId('fab12', path), source: 'local', name: path, title: `Track ${i}`, url: localTrackUrl('fab12', path),
    local: { folderId: 'fab12', path, size: 1, mtime: 1 }, duration: 60,
  };
});

function renderLibrary(viewMode: 'grid' | 'list', tracks = folderTracks) {
  return render(
    <LibraryView
      tracks={tracks} allTags={[]}
      stats={{ total_tracks: tracks.length, rated_4plus: 0, total_duration_hours: 0, total_play_count: 0, untagged_count: 0, trash_count: 0, unique_tags: 0, top_tags: [] }}
      isPlaying={false} viewMode={viewMode}
      onTrackClick={() => {}} onTrackDoubleClick={() => {}}
      onUpdateTrack={async () => {}} onTrashTrack={async () => {}}
    />,
  );
}

/** Let the scroll handler's animation frame run. */
const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

describe('windowRange', () => {
  it('covers the viewport plus overscan and pads the rest', () => {
    const r = windowRange({ count: COUNT, rowHeight: 50, overscan: 2, scrollTop: 5000, viewportHeight: 500 });
    expect(r).toEqual({ start: 98, end: 112, padTop: 98 * 50, padBottom: (COUNT - 112) * 50 });
    const grid = windowRange({ count: 10, columns: 4, rowHeight: 100, overscan: 0, scrollTop: 0, viewportHeight: 150 });
    expect(grid).toEqual({ start: 0, end: 8, padTop: 0, padBottom: 100 });
    expect(windowRange({ count: 0, rowHeight: 50, scrollTop: 0, viewportHeight: 500 })).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });

  it('follows the Tailwind grid breakpoints', () => {
    expect([320, 640, 768, 1024, 1920].map(gridColumnsFor)).toEqual([2, 3, 4, 5, 5]);
  });
});

describe('LibraryView windowing', () => {
  it(`list: ${COUNT} tracks mount fewer than 60 rows, and scrolling moves the window`, async () => {
    const { container } = renderLibrary('list');
    const rows = screen.getAllByTestId('library-track');
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.length).toBeLessThan(60);
    expect(container.querySelectorAll('tr').length).toBeLessThan(65);
    expect(screen.getByRole('table', { name: 'Library' }).getAttribute('aria-rowcount')).toBe(String(COUNT + 1));
    expect(rows[0].getAttribute('aria-rowindex')).toBe('2');

    const scroller = container.querySelector('.library-list') as HTMLElement;
    scroller.scrollTop = 53 * 1000;
    fireEvent.scroll(scroller);
    await nextFrame();
    const after = screen.getAllByTestId('library-track');
    expect(after.length).toBeLessThan(60);
    const first = Number(after[0]!.getAttribute('aria-rowindex'));
    expect(first).toBeGreaterThan(900);
    expect(first).toBeLessThan(1002);
    expect(screen.getByRole('row', { name: /^Track 1000 by/ })).toBeTruthy();
  });

  it(`grid: ${COUNT} tracks mount a viewport's worth of cards`, () => {
    renderLibrary('grid');
    const cards = screen.getAllByTestId('library-track');
    expect(cards.length).toBeLessThan(80);
    expect(cards[0].getAttribute('aria-posinset')).toBe('1');
    expect(cards[0].getAttribute('aria-setsize')).toBe(String(COUNT));
    expect(FALLBACK_VIEWPORT_PX).toBeGreaterThan(0);
  });

  it('local tracks have no edit, trash or offline-copy controls; library tracks do', () => {
    const remote: PlaylistTrack = { id: 'r1', source: 'library', name: 'r1', title: 'Remote', url: 'https://storage.test/r1.flac' };
    renderLibrary('list', [remote, folderTracks[0]!]);
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Trash' })).toHaveLength(1);
    expect(screen.getAllByTestId('offline-badge')).toHaveLength(1);
  });
});
