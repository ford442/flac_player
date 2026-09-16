import React from 'react';
import { SortBy, TagInfo } from '../../audioLoader';
import { FileDropZone } from '../FileDropZone';
import { FAST_STORAGE_HOST } from '../../utils/audioUtils';
import { ViewTab } from './types';

export interface PlayerFallbackSidebarProps {
  activeTab: ViewTab;
  setActiveTab: (t: ViewTab) => void;
  libraryCount: number;
  queueCount: number;
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
  onFileSelect: (files: File[]) => void;
}

export const PlayerFallbackSidebar: React.FC<PlayerFallbackSidebarProps> = ({
  activeTab, setActiveTab, libraryCount, queueCount, playlistCount,
  minRating, setMinRating, untaggedOnly, setUntaggedOnly,
  sortBy, setSortBy, storageSourceFilter, setStorageSourceFilter, fastMirrorCount,
  generationModelFilter, setGenerationModelFilter, generationModels,
  allTags, selectedTags, setSelectedTags, onFileSelect,
}) => (
  <aside className="w-64 border-r border-white/10 bg-[#0a0a18] flex flex-col">
    <nav className="p-4 space-y-1">
      {[
        { id: 'library',     label: '📚 Library',    count: libraryCount },
        { id: 'now-playing', label: '▶️ Now Playing' },
        { id: 'queue',       label: '📋 Queue',      count: queueCount },
        { id: 'playlists',   label: '☁️ Playlists',  count: playlistCount },
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
        <label className="text-xs text-gray-500 uppercase">Min Rating</label>
        <input type="range" min="0" max="5" step="1" value={minRating}
          onChange={(e) => setMinRating(parseInt(e.target.value))} className="w-full mt-1" />
        <div className="flex justify-between text-xs text-gray-400 mt-1"><span>Any</span><span>{minRating}+ stars</span></div>
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
        <input type="checkbox" checked={untaggedOnly} onChange={(e) => setUntaggedOnly(e.target.checked)} className="rounded border-white/20 bg-white/10" />
        Untagged only
      </label>
      <div>
        <label className="text-xs text-gray-500 uppercase">Sort By</label>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}
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
        <label className="text-xs text-gray-500 uppercase">Storage Source</label>
        <select value={storageSourceFilter} onChange={(e) => setStorageSourceFilter(e.target.value as 'all' | 'fast')}
          className="w-full mt-1 px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-sm">
          <option value="all">All tracks</option>
          <option value="fast">Fast mirror only</option>
        </select>
        <p className="text-xs text-gray-500 mt-2">{fastMirrorCount}/{libraryCount} tracks available on fast mirror ({FAST_STORAGE_HOST})</p>
      </div>
      <div>
        <label className="text-xs text-gray-500 uppercase">Generation Model</label>
        <select value={generationModelFilter} onChange={(event) => setGenerationModelFilter(event.target.value)}
          className="w-full mt-1 px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-sm" aria-label="Generation model filter">
          <option value="all">All models</option>
          {generationModels.map(model => <option key={model} value={model}>{model}</option>)}
        </select>
      </div>
    </div>

    <div className="flex-1 p-4 border-t border-white/10 overflow-auto">
      <label className="text-xs text-gray-500 uppercase">Filter Tags</label>
      <div className="flex flex-wrap gap-1 mt-2">
        {allTags.slice(0, 15).map(tag => (
          <button key={tag.name}
            onClick={() => setSelectedTags(prev => prev.includes(tag.name) ? prev.filter(t => t !== tag.name) : [...prev, tag.name])}
            className={`px-2 py-1 text-xs rounded-full transition-colors ${
              selectedTags.includes(tag.name) ? 'bg-purple-500 text-white' : 'bg-white/10 text-gray-400 hover:bg-white/20'
            }`}>{tag.name} ({tag.count})</button>
        ))}
      </div>
    </div>

    <div className="p-4 border-t border-white/10">
      <label className="text-xs text-gray-500 uppercase block mb-2">Local Files</label>
      <FileDropZone onFiles={onFileSelect} />
    </div>
  </aside>
);
