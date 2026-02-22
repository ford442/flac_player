import React, { useState, useEffect, useCallback } from 'react';
import { PlaylistTrack, AudioLoader, LibraryStats } from '../audioLoader';
import { StarRating } from './StarRating';
import { TagInput } from './TagInput';

interface PileModeProps {
  isActive: boolean;
  onClose: () => void;
  onTrackRated: () => void;
  stats: LibraryStats;
}

export const PileMode: React.FC<PileModeProps> = ({
  isActive,
  onClose,
  onTrackRated,
  stats
}) => {
  const [tracks, setTracks] = useState<PlaylistTrack[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [showCelebration, setShowCelebration] = useState(false);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [editing, setEditing] = useState({
    rating: undefined as number | undefined,
    tags: [] as string[]
  });
  const [ratedCount, setRatedCount] = useState(0);
  
  const loader = new AudioLoader();
  
  const loadPileTracks = useCallback(async () => {
    setIsLoading(true);
    try {
      // Fetch tracks with rating < 4 OR no tags
      const { tracks } = await loader.fetchLibrary({
        ratingLt: 4,
        untagged: true,
        sortBy: 'random',
        limit: 50
      });
      setTracks(tracks);
      
      // Load available tags
      const tagsData = await loader.fetchTags();
      setAllTags(tagsData.map(t => t.name));
      
      if (tracks.length > 0) {
        setEditing({
          rating: tracks[0].rating,
          tags: [...(tracks[0].tags || [])]
        });
      }
    } finally {
      setIsLoading(false);
    }
  }, []);
  
  useEffect(() => {
    if (isActive) {
      loadPileTracks();
    }
  }, [isActive, loadPileTracks]);
  
  const currentTrack = tracks[currentIndex];
  
  const handleSaveAndNext = async () => {
    if (!currentTrack) return;
    
    const hasChanges = 
      editing.rating !== currentTrack.rating ||
      JSON.stringify(editing.tags) !== JSON.stringify(currentTrack.tags || []);
    
    if (hasChanges) {
      try {
        await loader.updateSampleMetadata(currentTrack.id, {
          rating: editing.rating,
          tags: editing.tags
        });
        
        if (editing.rating && editing.rating >= 4) {
          setRatedCount(prev => prev + 1);
        }
        
        onTrackRated();
      } catch (e) {
        console.error('Failed to save:', e);
      }
    }
    
    if (currentIndex < tracks.length - 1) {
      const nextIndex = currentIndex + 1;
      setCurrentIndex(nextIndex);
      setEditing({
        rating: tracks[nextIndex].rating,
        tags: [...(tracks[nextIndex].tags || [])]
      });
      
      // Show celebration every 20 tracks
      if ((currentIndex + 1) % 20 === 0) {
        const percentage = stats.total_tracks > 0 
          ? Math.round((ratedCount / stats.total_tracks) * 100)
          : 0;
        setShowCelebration(true);
        setTimeout(() => setShowCelebration(false), 3000);
      }
    } else {
      // Finished all tracks
      loadPileTracks();
      setCurrentIndex(0);
    }
  };
  
  const handleSkip = () => {
    if (currentIndex < tracks.length - 1) {
      const nextIndex = currentIndex + 1;
      setCurrentIndex(nextIndex);
      setEditing({
        rating: tracks[nextIndex].rating,
        tags: [...(tracks[nextIndex].tags || [])]
      });
    }
  };
  
  const handleTrash = async () => {
    if (!currentTrack) return;
    
    try {
      await loader.trashTrack(currentTrack.id);
      handleSkip();
      onTrackRated();
    } catch (e) {
      console.error('Failed to trash:', e);
    }
  };
  
  // Keyboard shortcuts
  useEffect(() => {
    if (!isActive) return;
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        e.preventDefault();
        setIsPlaying(p => !p);
      } else if (e.key === 'n' || e.key === 'N') {
        handleSkip();
      } else if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        // Focus tag input
        const tagInput = document.querySelector('.pile-tag-input input') as HTMLElement;
        tagInput?.focus();
      } else if (e.key >= '1' && e.key <= '5') {
        setEditing(prev => ({ ...prev, rating: parseInt(e.key) }));
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, currentIndex, tracks]);
  
  if (!isActive) return null;
  
  if (isLoading) {
    return (
      <div className="fixed inset-0 bg-[#0f0f1e] z-50 flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-4">📦</div>
          <p className="text-gray-400">Loading your pile...</p>
        </div>
      </div>
    );
  }
  
  if (tracks.length === 0) {
    return (
      <div className="fixed inset-0 bg-[#0f0f1e] z-50 flex items-center justify-center">
        <div className="text-center">
          <div className="text-6xl mb-4">🎉</div>
          <h2 className="text-2xl font-bold text-white mb-2">All Caught Up!</h2>
          <p className="text-gray-400 mb-6">Your pile is empty. Great job!</p>
          <button
            onClick={onClose}
            className="px-6 py-3 bg-purple-500 text-white rounded-lg hover:bg-purple-600"
          >
            Back to Library
          </button>
        </div>
      </div>
    );
  }
  
  return (
    <div className="fixed inset-0 bg-[#0f0f1e] z-50 flex flex-col">
      {/* Celebration Modal */}
      {showCelebration && (
        <div className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none">
          <div className="bg-gradient-to-br from-purple-500 to-blue-500 text-white px-8 py-6 rounded-2xl shadow-2xl animate-bounce">
            <div className="text-4xl mb-2">🔥</div>
            <p className="text-xl font-bold">Nice!</p>
            <p>{ratedCount} tracks rated 4+</p>
          </div>
        </div>
      )}
      
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-white/10">
        <div>
          <h2 className="text-xl font-bold text-white">📦 Sort My Pile</h2>
          <p className="text-sm text-gray-400">
            Track {currentIndex + 1} of {tracks.length} • {ratedCount} rated 4+
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-sm text-gray-400">
            <span className="text-purple-400">Space</span> Play • 
            <span className="text-purple-400 ml-1">1-5</span> Rate • 
            <span className="text-purple-400 ml-1">T</span> Tags • 
            <span className="text-purple-400 ml-1">N</span> Skip • 
            <span className="text-purple-400 ml-1">Esc</span> Exit
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-white"
          >
            ✕
          </button>
        </div>
      </div>
      
      {/* Main Content */}
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-2xl w-full">
          {/* Waveform Visualization */}
          <div className="relative h-64 bg-gradient-to-b from-purple-900/30 to-blue-900/30 rounded-2xl mb-8 overflow-hidden">
            <div className="absolute inset-0 flex items-center justify-center">
              {Array.from({ length: 50 }).map((_, i) => (
                <div
                  key={i}
                  className={`w-2 mx-0.5 rounded-full transition-all duration-300 ${
                    isPlaying 
                      ? 'bg-gradient-to-t from-purple-400 to-blue-400 animate-pulse' 
                      : 'bg-white/20'
                  }`}
                  style={{
                    height: isPlaying 
                      ? `${20 + Math.random() * 60}%`
                      : `${30 + Math.sin(i * 0.2) * 20}%`,
                    animationDelay: `${i * 0.02}s`
                  }}
                />
              ))}
            </div>
            
            {/* Play Button Overlay */}
            <button
              onClick={() => setIsPlaying(!isPlaying)}
              className="absolute inset-0 flex items-center justify-center bg-black/20 hover:bg-black/40 transition-colors"
            >
              <div className="w-20 h-20 bg-white/20 backdrop-blur rounded-full flex items-center justify-center text-3xl">
                {isPlaying ? '⏸' : '▶'}
              </div>
            </button>
          </div>
          
          {/* Track Info */}
          <div className="text-center mb-8">
            <h3 className="text-2xl font-bold text-white mb-2">
              {currentTrack.title || currentTrack.name}
            </h3>
            <p className="text-gray-400">
              {currentTrack.author || 'Unknown'}
              {currentTrack.generation_model && (
                <span className="ml-2 text-purple-400">• {currentTrack.generation_model}</span>
              )}
            </p>
            {currentTrack.prompt && (
              <p className="mt-2 text-sm text-gray-500 italic max-w-lg mx-auto">
                "{currentTrack.prompt.substring(0, 100)}..."
              </p>
            )}
          </div>
          
          {/* Rating */}
          <div className="flex flex-col items-center gap-4 mb-6">
            <label className="text-sm text-gray-400">Rate this track</label>
            <div className="flex items-center gap-4">
              <StarRating
                rating={editing.rating}
                maxRating={5}
                size="lg"
                onRate={(r) => setEditing(prev => ({ ...prev, rating: r }))}
                showTrash
              />
              {editing.rating === 0 && (
                <span className="text-red-400 text-sm">Will be trashed</span>
              )}
            </div>
          </div>
          
          {/* Tags */}
          <div className="pile-tag-input max-w-md mx-auto mb-8">
            <label className="text-sm text-gray-400 block mb-2">Tags</label>
            <TagInput
              tags={editing.tags}
              availableTags={allTags}
              onChange={(tags) => setEditing(prev => ({ ...prev, tags }))}
              placeholder="Add tags..."
            />
          </div>
          
          {/* Actions */}
          <div className="flex justify-center gap-4">
            <button
              onClick={handleTrash}
              className="px-6 py-3 bg-red-500/20 text-red-400 rounded-lg hover:bg-red-500/30 transition-colors"
            >
              🗑️ Trash
            </button>
            <button
              onClick={handleSkip}
              className="px-6 py-3 bg-white/10 text-white rounded-lg hover:bg-white/20 transition-colors"
            >
              Skip (N)
            </button>
            <button
              onClick={handleSaveAndNext}
              className="px-8 py-3 bg-gradient-to-r from-purple-500 to-blue-500 text-white rounded-lg hover:opacity-90 transition-opacity font-semibold"
            >
              Save & Next
            </button>
          </div>
        </div>
      </div>
      
      {/* Progress Bar */}
      <div className="h-1 bg-white/10">
        <div 
          className="h-full bg-gradient-to-r from-purple-500 to-blue-500 transition-all"
          style={{ width: `${((currentIndex + 1) / tracks.length) * 100}%` }}
        />
      </div>
    </div>
  );
};
