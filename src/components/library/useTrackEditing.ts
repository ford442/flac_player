import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlaylistTrack } from '../../types/library';
import { suggestTags } from '../../api/songApi';

export interface TrackEditingState {
  trackId: string | null;
  rating: number | undefined;
  tags: string[];
  isSaving: boolean;
  suggestedTags: string[];
  suggestionsLoading: boolean;
  showMusicBrainz: boolean;
}

export interface TrackEditing {
  state: TrackEditingState;
  start: (track: PlaylistTrack) => void;
  cancel: () => void;
  /** Saves changed fields; the editor stays open (with the edits) if the update fails. */
  save: () => Promise<void>;
  setRating: (rating: number | undefined) => void;
  setTags: (tags: string[]) => void;
  toggleMusicBrainz: () => void;
  /** MusicBrainz metadata is written immediately; applied tags also replace the draft tags. */
  applyMetadata: (track: PlaylistTrack, updates: Partial<PlaylistTrack>) => Promise<void>;
}

const IDLE: TrackEditingState = {
  trackId: null, rating: undefined, tags: [], isSaving: false,
  suggestedTags: [], suggestionsLoading: false, showMusicBrainz: false,
};

const sameTags = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((tag, i) => tag === b[i]);

/** One inline rating/tag editor at a time for the library grid and list. */
export function useTrackEditing(
  tracks: readonly PlaylistTrack[],
  onUpdateTrack: (id: string, updates: Partial<PlaylistTrack>) => Promise<void>,
): TrackEditing {
  const [state, setState] = useState<TrackEditingState>(IDLE);
  const editingIdRef = useRef<string | null>(null);
  editingIdRef.current = state.trackId;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const stateRef = useRef(state);
  stateRef.current = state;

  const cancel = useCallback(() => setState(IDLE), []);

  // Escape closes the editor from anywhere.
  useEffect(() => {
    if (!state.trackId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.trackId, cancel]);

  const start = useCallback((track: PlaylistTrack) => {
    setState({ ...IDLE, trackId: track.id, rating: track.rating, tags: [...(track.tags || [])], suggestionsLoading: true });
    const settle = (suggestions: string[]) => {
      if (editingIdRef.current !== track.id) return;
      setState(prev => ({ ...prev, suggestedTags: suggestions, suggestionsLoading: false }));
    };
    suggestTags(track.id).then(({ suggestions }) => settle(suggestions || []), () => settle([]));
  }, []);

  const save = useCallback(async () => {
    const { trackId, rating, tags } = stateRef.current;
    const track = tracksRef.current.find(t => t.id === trackId);
    if (!track) { setState(IDLE); return; }

    const updates: Partial<PlaylistTrack> = {};
    if (rating !== track.rating) updates.rating = rating;
    if (!sameTags(tags, track.tags || [])) updates.tags = tags;
    if (Object.keys(updates).length === 0) { setState(IDLE); return; }

    setState(prev => ({ ...prev, isSaving: true }));
    try {
      await onUpdateTrack(track.id, updates);
      setState(IDLE);
    } catch {
      // onUpdateTrack has already reported the failure; keep the edits for a retry.
      setState(prev => (prev.trackId === track.id ? { ...prev, isSaving: false } : prev));
    }
  }, [onUpdateTrack]);

  const setRating = useCallback((rating: number | undefined) => setState(prev => ({ ...prev, rating })), []);
  const setTags = useCallback((tags: string[]) => setState(prev => ({ ...prev, tags })), []);
  const toggleMusicBrainz = useCallback(
    () => setState(prev => ({ ...prev, showMusicBrainz: !prev.showMusicBrainz })), []);

  const applyMetadata = useCallback(async (track: PlaylistTrack, updates: Partial<PlaylistTrack>) => {
    await onUpdateTrack(track.id, updates);
    const tags = updates.tags;
    if (tags) setState(prev => ({ ...prev, tags: [...tags] }));
  }, [onUpdateTrack]);

  return { state, start, cancel, save, setRating, setTags, toggleMusicBrainz, applyMetadata };
}
