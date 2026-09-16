import React, { useState } from 'react';
import { PlaylistTrack } from '../audioLoader';
import { searchMusicBrainz, MusicBrainzMatch } from '../api/songApi';

interface MusicBrainzPanelProps {
  track: PlaylistTrack;
  /** Persists the confirmed fields (PATCH /api/songs/{id}). */
  onApply: (updates: Partial<PlaylistTrack>) => Promise<void>;
  onNotify?: (message: string, type: 'success' | 'error' | 'info') => void;
  onClose: () => void;
}

type Field = 'title' | 'genre' | 'description' | 'tags';

/**
 * MusicBrainz lookup for one track. Nothing is written until the user picks
 * fields and confirms. The PATCH endpoint has no `author` field, so artist is
 * shown for reference only.
 */
export const MusicBrainzPanel: React.FC<MusicBrainzPanelProps> = ({ track, onApply, onNotify, onClose }) => {
  const [query, setQuery] = useState(track.title || track.name || '');
  const [artist, setArtist] = useState(track.author || '');
  const [status, setStatus] = useState<'idle' | 'searching' | 'none' | 'error' | 'saving'>('idle');
  const [match, setMatch] = useState<MusicBrainzMatch | null>(null);
  const [selected, setSelected] = useState<Set<Field>>(new Set());

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setStatus('searching');
    setMatch(null);
    try {
      const result = await searchMusicBrainz(query.trim(), artist.trim() || undefined);
      setMatch(result);
      setStatus(result ? 'idle' : 'none');
      if (result) {
        const fields: Field[] = ['title', 'genre', 'description'];
        setSelected(new Set([
          ...fields.filter(f => result[f] && result[f] !== track[f]),
          ...(result.tags.length ? ['tags' as Field] : []),
        ]));
      }
    } catch (err) {
      setStatus('error');
      onNotify?.(err instanceof Error ? err.message : 'MusicBrainz search failed', 'error');
    }
  };

  const toggle = (f: Field) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(f)) next.delete(f); else next.add(f);
    return next;
  });

  const apply = async () => {
    if (!match) return;
    const updates: Partial<PlaylistTrack> = {};
    if (selected.has('title') && match.title) updates.title = match.title;
    if (selected.has('genre') && match.genre) updates.genre = match.genre;
    if (selected.has('description') && match.description) updates.description = match.description;
    if (selected.has('tags') && match.tags.length) {
      updates.tags = Array.from(new Set([...(track.tags || []), ...match.tags.map(t => t.toLowerCase())]));
    }
    if (Object.keys(updates).length === 0) { onClose(); return; }
    setStatus('saving');
    try {
      await onApply(updates);
      onClose();
    } catch {
      setStatus('idle'); // onApply already toasts
    }
  };

  type Row = { field: Field | null; label: string; value: string; current?: string };
  const rows: Row[] = match ? ([
    { field: 'title', label: 'Title', value: match.title || '', current: track.title || track.name },
    { field: null, label: 'Artist', value: match.artist || '', current: track.author },
    { field: 'genre', label: 'Genre', value: match.genre || '', current: track.genre },
    { field: 'description', label: 'Description', value: match.description || '', current: track.description },
    { field: 'tags', label: 'Tags (merged)', value: match.tags.join(', '), current: (track.tags || []).join(', ') },
  ] as Row[]).filter(r => r.value) : [];

  return (
    <div
      className="musicbrainz-panel space-y-2 text-sm"
      role="region"
      aria-label={`MusicBrainz lookup for ${track.title || track.name}`}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
    >
      <form onSubmit={search} className="flex flex-wrap gap-1">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Title"
          aria-label="MusicBrainz title query"
          className="flex-1 min-w-[6rem] px-2 py-1 bg-white/10 border border-white/20 rounded text-white"
        />
        <input
          value={artist}
          onChange={e => setArtist(e.target.value)}
          placeholder="Artist (optional)"
          aria-label="MusicBrainz artist"
          className="flex-1 min-w-[6rem] px-2 py-1 bg-white/10 border border-white/20 rounded text-white"
        />
        <button
          type="submit"
          disabled={status === 'searching' || !query.trim()}
          className="px-2 py-1 bg-white/10 rounded text-white hover:bg-white/20 disabled:opacity-50"
        >
          {status === 'searching' ? 'Searching…' : 'Search MusicBrainz'}
        </button>
      </form>

      <div role="status" aria-live="polite" className="text-xs text-gray-400">
        {status === 'none' && 'No MusicBrainz match.'}
        {status === 'error' && 'MusicBrainz search failed.'}
      </div>

      {match && (
        <>
          <ul className="space-y-1">
            {rows.map(r => (
              <li key={r.label} className="flex items-start gap-2">
                {r.field ? (
                  <input
                    type="checkbox"
                    id={`mb-${track.id}-${r.field}`}
                    checked={selected.has(r.field)}
                    onChange={() => toggle(r.field as Field)}
                    className="mt-1"
                  />
                ) : <span className="w-[13px]" />}
                <label htmlFor={r.field ? `mb-${track.id}-${r.field}` : undefined} className="flex-1 min-w-0">
                  <span className="text-gray-400">{r.label}: </span>
                  <span className="text-white break-words">{r.value}</span>
                  {r.current && r.current !== r.value && (
                    <span className="block text-xs text-gray-500 truncate">current: {r.current}</span>
                  )}
                  {!r.field && <span className="block text-xs text-gray-500">(not editable via API)</span>}
                </label>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={apply}
              disabled={status === 'saving' || selected.size === 0}
              className="px-3 py-1 bg-purple-500 text-white rounded hover:bg-purple-600 disabled:opacity-50"
            >
              {status === 'saving' ? 'Saving…' : `Apply ${selected.size} field${selected.size === 1 ? '' : 's'}`}
            </button>
            <button type="button" onClick={onClose} className="px-3 py-1 bg-white/10 text-white rounded hover:bg-white/20">
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
};
