import React, { useEffect, useState } from 'react';
import type { PlaylistsController } from '../../types/playlist';
import { PlayerFallbackLocalPlaylist } from './PlayerFallbackLocalPlaylist';

export interface PlayerFallbackPlaylistsTabProps {
  playlists: PlaylistsController;
}

export const PlayerFallbackPlaylistsTab: React.FC<PlayerFallbackPlaylistsTabProps> = ({ playlists }) => {
  const { local, localAvailable, cloud, isLoadingCloud, refreshCloud, queueLength, createFromQueue, playCloud, saveCloudCopy } = playlists;
  const [title, setTitle] = useState('');

  // Lazy: cloud playlists load when the tab is first opened, never on app start.
  useEffect(() => { refreshCloud(); }, [refreshCloud]);

  const save = async () => {
    await createFromQueue(title);
    setTitle('');
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold">Playlists</h2>
          <button onClick={refreshCloud} disabled={isLoadingCloud}
            className="px-4 py-2 bg-purple-500/20 text-purple-300 rounded-lg hover:bg-purple-500/30 disabled:opacity-50">
            {isLoadingCloud ? 'Loading...' : '🔄 Refresh cloud'}
          </button>
        </div>

        <form onSubmit={e => { e.preventDefault(); void save(); }} className="flex gap-2 mb-6">
          <input value={title} onChange={e => setTitle(e.target.value)} maxLength={200}
            placeholder={`Name a playlist to save the queue (${queueLength} tracks)`} aria-label="New playlist name"
            className="flex-1 px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-white placeholder-gray-500" />
          <button type="submit" disabled={queueLength === 0 || !localAvailable}
            className="px-4 py-2 bg-purple-500/30 text-purple-100 rounded-lg hover:bg-purple-500/40 disabled:opacity-40">
            💾 Save queue
          </button>
        </form>

        <h3 className="text-sm uppercase tracking-wide text-gray-400 mb-2">On this device</h3>
        {!localAvailable && (
          <p className="text-sm text-amber-300 mb-3">
            Browser storage is unavailable (private mode or blocked), so playlists can&apos;t be saved here.
          </p>
        )}
        {localAvailable && local.length === 0 && (
          <div className="text-gray-400 py-6">
            <p>No saved playlists yet.</p>
            <p className="text-sm mt-1">Build a queue, name it above, and it stays on this device. Share (🔗 in the queue panel) still makes a link.</p>
          </div>
        )}
        <div className="space-y-2 mb-8">
          {local.map(p => <PlayerFallbackLocalPlaylist key={p.id} playlist={p} controller={playlists} />)}
        </div>

        <h3 className="text-sm uppercase tracking-wide text-gray-400 mb-2">Cloud (library host)</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          <a href="https://storage.noahcohn.com/admin" target="_blank" rel="noopener noreferrer"
            className="p-4 bg-purple-500/10 border border-purple-500/30 rounded-lg hover:bg-purple-500/20 transition-colors">
            <div className="font-medium text-purple-200">Open Storage Admin</div>
            <div className="text-sm text-gray-400 mt-1">Upload and organize tracks in a new tab.</div>
          </a>
          <a href="https://github.com/ford442/contabo_storage_manager" target="_blank" rel="noopener noreferrer"
            className="p-4 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10 transition-colors">
            <div className="font-medium text-white">contabo_storage_manager</div>
            <div className="text-sm text-gray-400 mt-1">Backend management workflows used by this playlist sync.</div>
          </a>
        </div>
        {cloud.length === 0 && !isLoadingCloud && (
          <p className="text-sm text-gray-400 mb-4">
            The library host has no cloud playlists (or doesn&apos;t offer them) — that doesn&apos;t affect the
            {local.length > 0 ? ` ${local.length} saved on this device above.` : ' ones you save on this device.'}
          </p>
        )}
        <div className="space-y-2">
          {cloud.map(playlist => (
            <div key={playlist.id} className="p-4 bg-white/5 rounded-lg flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium text-white truncate">{playlist.title}</div>
                {playlist.description && <div className="text-sm text-gray-400 mt-1">{playlist.description}</div>}
                <div className="text-sm text-gray-400 mt-1">{playlist.track_ids?.length || 0} tracks</div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => void playCloud(playlist.id)}
                  className="px-3 py-1 text-sm rounded bg-purple-500/30 text-purple-100 hover:bg-purple-500/40">▶ Play</button>
                <button onClick={() => void saveCloudCopy(playlist)} disabled={!localAvailable}
                  className="px-3 py-1 text-sm rounded bg-white/10 text-gray-200 hover:bg-white/20 disabled:opacity-40">Save copy</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
