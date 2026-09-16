import React from 'react';
import { CloudPlaylist } from '../../audioLoader';

export interface PlayerFallbackPlaylistsTabProps {
  playlists: CloudPlaylist[];
  isLoadingPlaylists: boolean;
  onLoadPlaylists: () => void;
  onLoadCloudPlaylist: (id: string) => void;
}

export const PlayerFallbackPlaylistsTab: React.FC<PlayerFallbackPlaylistsTabProps> = ({
  playlists, isLoadingPlaylists, onLoadPlaylists, onLoadCloudPlaylist,
}) => (
  <div className="flex-1 overflow-auto p-6">
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Cloud Playlists</h2>
        <button onClick={onLoadPlaylists} disabled={isLoadingPlaylists}
          className="px-4 py-2 bg-purple-500/20 text-purple-300 rounded-lg hover:bg-purple-500/30 disabled:opacity-50">
          {isLoadingPlaylists ? 'Loading...' : '🔄 Refresh'}
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
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
      {playlists.length === 0 && !isLoadingPlaylists && (
        <div className="text-gray-400 text-center py-12">
          <p>No playlists found.</p>
          <p className="text-sm mt-2">The API can't create playlists yet — share your queue (🔗 in the queue panel) to save a set of tracks.</p>
        </div>
      )}
      <div className="space-y-2">
        {playlists.map(playlist => (
          <div key={playlist.id} onClick={() => onLoadCloudPlaylist(playlist.id)}
            className="p-4 bg-white/5 rounded-lg hover:bg-white/10 cursor-pointer transition-colors">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium text-white">{playlist.title}</div>
                {playlist.description && <div className="text-sm text-gray-400 mt-1">{playlist.description}</div>}
              </div>
              <div className="text-sm text-gray-400">{playlist.track_ids?.length || 0} tracks</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  </div>
);
