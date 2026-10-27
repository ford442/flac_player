import React, { useId } from 'react';
import type { SortBy, TagInfo } from '../../types/library';
import { FileDropZone } from '../FileDropZone';
import { UrlLoader } from '../UrlLoader';
import { FAST_STORAGE_HOST } from '../../utils/audioUtils';
import { useActions } from '../PlayerActionsContext';
import { useQueue } from '../../player/selectors';
import { ViewTab } from './types';

export interface PlayerFallbackSidebarProps {
  activeTab: ViewTab;
  setActiveTab: (t: ViewTab) => void;
  libraryCount: number;
  playlistCount: number;
  minRating: number;
  setMinRating: (r: number) => void;
  untaggedOnly: boolean;
  setUntaggedOnly: (v: boolean) => void;
  sortBy: SortBy;
  setSortBy: (s: SortBy) => void;
  storageSourceFilter: 'all' | 'fast';
  setStorageSourceFilter: (f: 'all' | 'fast') => void;
  fastMirrorCount: number;
  generationModelFilter: string;
  setGenerationModelFilter: (v: string) => void;
  generationModels: string[];
  allTags: TagInfo[];
  selectedTags: string[];
  setSelectedTags: React.Dispatch<React.SetStateAction<string[]>>;
}

export const PlayerFallbackSidebar: React.FC<PlayerFallbackSidebarProps> = ({
  activeTab, setActiveTab, libraryCount, playlistCount,
  minRating, setMinRating, untaggedOnly, setUntaggedOnly,
  sortBy, setSortBy, storageSourceFilter, setStorageSourceFilter, fastMirrorCount,
  generationModelFilter, setGenerationModelFilter, generationModels,
  allTags, selectedTags, setSelectedTags,
}) => {
  const id = useId();
  const queueCount = useQueue((q) => q.tracks.length);
  const { addFiles, loadUrl, loadDemo } = useActions();
  return (
    <aside className="w-64 border-r border-white/10 bg-surface-sunken flex flex-col">
      <nav className="p-4 space-y-1">
        {[
          { id: 'library',     label: '📚 Library',    count: libraryCount },
          { id: 'now-playing', label: '▶️ Now Playing' },
          { id: 'queue',       label: '📋 Queue',      count: queueCount },
          { id: 'playlists',   label: '💾 Playlists',  count: playlistCount },
          { id: 'generate',    label: '✨ Generate' },
          { id: 'convert',     label: '🔄 Convert' },
          { id: 'settings',    label: '⚙️ Settings' },
        ].map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id as ViewTab)}
            className={`w-full flex items-center justify-between px-4 py-2 rounded-lg text-left transition-colors ${
              activeTab === tab.id ? 'bg-purple-500/20 text-purple-300' : 'text-gray-400 hover:bg-white/5 hover:text-white'
            }`}>
            <span>{tab.label}</span>
            {tab.count !== undefined && <span className="text-xs bg-white/10 px-2 py-0.5 rounded-full">{tab.count}</span>}
          </button>
        ))}
      </nav>

      <div className="p-4 border-t border-white/10 space-y-4">
        <div>
          <label htmlFor={`${id}-min-rating`} className="text-xs text-gray-400 uppercase">Min Rating</label>
          <input id={`${id}-min-rating`} type="range" min="0" max="5" step="1" value={minRating}
            onChange={(e) => setMinRating(parseInt(e.target.value))} className="w-full mt-1" />
          <div className="flex justify-between text-xs text-gray-400 mt-1"><span>Any</span><span>{minRating}+ stars</span></div>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
          <input type="checkbox" checked={untaggedOnly} onChange={(e) => setUntaggedOnly(e.target.checked)} className="rounded border-white/20 bg-white/10" />
          Untagged only
        </label>
        <div>
          <label htmlFor={`${id}-sort`} className="text-xs text-gray-400 uppercase">Sort By</label>
          <select id={`${id}-sort`} value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}
            className="w-full mt-1 px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-sm">
            <option value="date">Date Added</option>
            <option value="rating">Rating</option>
            <option value="name">Name</option>
            <option value="play_count">Play Count</option>
            <option value="last_played">Last Played</option>
            <option value="random">Random</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-source`} className="text-xs text-gray-400 uppercase">Storage Source</label>
          <select id={`${id}-source`} value={storageSourceFilter} onChange={(e) => setStorageSourceFilter(e.target.value as 'all' | 'fast')}
            className="w-full mt-1 px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-sm">
            <option value="all">All tracks</option>
            <option value="fast">Fast mirror only</option>
          </select>
          <p className="text-xs text-gray-400 mt-2">{fastMirrorCount}/{libraryCount} tracks available on fast mirror ({FAST_STORAGE_HOST})</p>
        </div>
        <div>
          <label htmlFor={`${id}-model`} className="text-xs text-gray-400 uppercase">Generation Model</label>
          <select id={`${id}-model`} value={generationModelFilter} onChange={(event) => setGenerationModelFilter(event.target.value)}
            className="w-full mt-1 px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-sm">
            <option value="all">All models</option>
            {generationModels.map(model => <option key={model} value={model}>{model}</option>)}
          </select>
        </div>
      </div>

      <div className="flex-1 p-4 border-t border-white/10 overflow-auto">
        <h3 id={`${id}-tags`} className="text-xs text-gray-400 uppercase">Filter Tags</h3>
        <div role="group" aria-labelledby={`${id}-tags`} className="flex flex-wrap gap-1 mt-2">
          {allTags.slice(0, 15).map(tag => (
            <button key={tag.name} aria-pressed={selectedTags.includes(tag.name)}
              onClick={() => setSelectedTags(prev => prev.includes(tag.name) ? prev.filter(t => t !== tag.name) : [...prev, tag.name])}
              className={`px-2 py-1 text-xs rounded-full transition-colors ${
                selectedTags.includes(tag.name) ? 'bg-purple-600 text-white' : 'bg-white/10 text-gray-400 hover:bg-white/20'
              }`}>{tag.name} ({tag.count})</button>
          ))}
        </div>
      </div>

      <div className="p-4 border-t border-white/10">
        <h3 className="text-xs text-gray-400 uppercase mb-2">Local Files</h3>
        <FileDropZone onFiles={addFiles} />
      </div>

      <div className="p-4 border-t border-white/10">
        <h3 className="text-xs text-gray-400 uppercase mb-2">From URL</h3>
        <UrlLoader onLoadUrl={loadUrl} onLoadDemo={loadDemo} />
      </div>
    </aside>
  );
};
