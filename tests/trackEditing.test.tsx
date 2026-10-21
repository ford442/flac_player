import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PlaylistTrack } from '../src/types/library';

const suggestTags = vi.hoisted(() => vi.fn());
vi.mock('../src/api/songApi', () => ({ suggestTags }));

import { useTrackEditing } from '../src/components/library/useTrackEditing';

const TRACK = { id: 't1', name: 'One.flac', title: 'One', url: 'https://x/one.flac', rating: 2, tags: ['a'] } as PlaylistTrack;

// Each test sets its own implementation. (A beforeEach mockReset made Vitest 4 report the
// rejected suggestion promise as a test error even though the hook handles it.)

describe('useTrackEditing', () => {
  it('clears the suggestions spinner when the request rejects', async () => {
    suggestTags.mockImplementation(() => Promise.reject(new Error('offline')));
    const { result } = renderHook(() => useTrackEditing([TRACK], vi.fn()));
    act(() => result.current.start(TRACK));
    expect(result.current.state.suggestionsLoading).toBe(true);
    await waitFor(() => expect(result.current.state.suggestionsLoading).toBe(false));
    expect(result.current.state.suggestedTags).toEqual([]);
  });

  it('saves only changed fields and closes', async () => {
    suggestTags.mockResolvedValue({ suggestions: ['b'], source: 'test' });
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useTrackEditing([TRACK], onUpdate));
    act(() => result.current.start(TRACK));
    act(() => result.current.setTags(['a', 'b']));
    await act(() => result.current.save());
    expect(onUpdate).toHaveBeenCalledWith('t1', { tags: ['a', 'b'] });
    expect(result.current.state.trackId).toBeNull();
  });

  it('keeps the edits open when the save fails', async () => {
    suggestTags.mockResolvedValue({ suggestions: [], source: 'test' });
    const onUpdate = vi.fn().mockRejectedValue(new Error('Failed to save changes'));
    const { result } = renderHook(() => useTrackEditing([TRACK], onUpdate));
    act(() => result.current.start(TRACK));
    act(() => result.current.setRating(5));
    await act(() => result.current.save());
    expect(result.current.state).toMatchObject({ trackId: 't1', rating: 5, isSaving: false });
  });

  it('Escape cancels', () => {
    suggestTags.mockResolvedValue({ suggestions: [], source: 'test' });
    const { result } = renderHook(() => useTrackEditing([TRACK], vi.fn()));
    act(() => result.current.start(TRACK));
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(result.current.state.trackId).toBeNull();
  });
});
