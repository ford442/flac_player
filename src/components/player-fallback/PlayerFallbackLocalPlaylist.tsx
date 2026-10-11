import React, { useEffect, useMemo, useState } from 'react';
import type { PlaylistTrack } from '../../types/library';
import type { LocalPlaylist, PlaylistsController } from '../../types/playlist';
import { useDragReorder } from '../../hooks/useDragReorder';

interface Props {
  playlist: LocalPlaylist;
  controller: PlaylistsController;
}

export const PlayerFallbackLocalPlaylist: React.FC<Props> = ({ playlist, controller }) => {
  const { rename, remove, moveTrack, removeTrack, overwriteWithQueue, resolveTracks, playLocal, queueLength } = controller;
  const [expanded, setExpanded] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(playlist.title);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [tracksById, setTracksById] = useState<Map<string, PlaylistTrack>>(new Map());

  // Reordering doesn't change the id set, so it never triggers a refetch.
  const idSetKey = useMemo(() => Array.from(new Set(playlist.trackIds)).sort().join('\n'), [playlist.trackIds]);
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    void resolveTracks(playlist.trackIds).then(tracks => {
      if (!cancelled) setTracksById(new Map(tracks.map(t => [t.id, t])));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, idSetKey]);

  const { dragIndex, overIndex, rowProps } = useDragReorder((from, to) => { void moveTrack(playlist.id, from, to); });

  const commitTitle = () => {
    setEditingTitle(false);
    const next = draftTitle.trim();
    if (next && next !== playlist.title) void rename(playlist.id, next);
    else setDraftTitle(playlist.title);
  };

  const btn = 'px-3 py-1 text-sm rounded bg-white/10 text-gray-200 hover:bg-white/20 disabled:opacity-40';

  return (
    <div className="bg-white/5 rounded-lg" data-testid="local-playlist">
      <div className="p-4 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editingTitle ? (
            <input
              autoFocus value={draftTitle} aria-label="Rename playlist" maxLength={200}
              onChange={e => setDraftTitle(e.target.value)} onBlur={commitTitle}
              onKeyDown={e => {
                if (e.key === 'Enter') commitTitle();
                if (e.key === 'Escape') { setDraftTitle(playlist.title); setEditingTitle(false); }
              }}
              className="w-full px-2 py-1 bg-black/40 border border-purple-500/50 rounded text-white"
            />
          ) : (
            <div className="font-medium text-white truncate">
              {playlist.title}
              {playlist.origin === 'cloud' && <span className="ml-2 text-xs text-purple-300">☁️ copy</span>}
            </div>
          )}
          <div className="text-sm text-gray-400 mt-1">
            {playlist.trackIds.length} tracks • updated {new Date(playlist.updatedAt).toLocaleDateString()}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 justify-end">
          <button className={`${btn} !bg-purple-500/30 !text-purple-100`} onClick={() => void playLocal(playlist.id)}
            disabled={playlist.trackIds.length === 0}>▶ Play</button>
          <button className={btn} onClick={() => setExpanded(v => !v)} aria-expanded={expanded}>
            {expanded ? 'Hide' : 'Edit'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 border-t border-white/10 pt-3">
          <div className="flex flex-wrap gap-2 mb-3">
            <button className={btn} onClick={() => { setDraftTitle(playlist.title); setEditingTitle(true); }}>✏️ Rename</button>
            <button className={btn} onClick={() => void overwriteWithQueue(playlist.id)} disabled={queueLength === 0}
              title="Replace this playlist's tracks with the current queue">Replace with queue</button>
            {confirmingDelete ? (
              <>
                <button className={`${btn} !bg-red-500/30 !text-red-100`} onClick={() => void remove(playlist.id)}>Confirm delete</button>
                <button className={btn} onClick={() => setConfirmingDelete(false)}>Cancel</button>
              </>
            ) : (
              <button className={btn} onClick={() => setConfirmingDelete(true)}>🗑 Delete</button>
            )}
          </div>
          {playlist.trackIds.length === 0 && <p className="text-sm text-gray-400">No tracks. Use “Replace with queue” to fill it.</p>}
          <ul className="space-y-1">
            {playlist.trackIds.map((id, index) => {
              const track = tracksById.get(id);
              return (
                <li
                  key={`${id}-${index}`}
                  {...rowProps(index)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded bg-black/20 cursor-grab ${
                    dragIndex === index ? 'opacity-50' : ''} ${overIndex === index ? 'ring-1 ring-purple-400' : ''}`}
                >
                  <span aria-hidden className="text-gray-500 select-none">⋮⋮</span>
                  <span className="flex-1 min-w-0 truncate text-sm text-gray-100">
                    {track ? (track.title || track.name) : <span className="text-gray-500">Track unavailable ({id})</span>}
                  </span>
                  <button aria-label={`Move ${track?.title ?? 'track'} up`} className="px-1 text-gray-400 hover:text-white disabled:opacity-30"
                    disabled={index === 0} onClick={() => void moveTrack(playlist.id, index, index - 1)}>▲</button>
                  <button aria-label={`Move ${track?.title ?? 'track'} down`} className="px-1 text-gray-400 hover:text-white disabled:opacity-30"
                    disabled={index === playlist.trackIds.length - 1} onClick={() => void moveTrack(playlist.id, index, index + 1)}>▼</button>
                  <button aria-label={`Remove ${track?.title ?? 'track'}`} className="px-1 text-gray-400 hover:text-red-300"
                    onClick={() => void removeTrack(playlist.id, index)}>✕</button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
};
