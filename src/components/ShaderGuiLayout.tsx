import React from 'react';
import { VisualizerShell } from './VisualizerShell';
import { usePlayerContext } from '../contexts/PlayerContext';

/**
 * The default visualizer-first layout: a full-bleed VisualizerShell with a few
 * floating actions. Deliberately narrower than PlayerFallbackView — library,
 * settings and generation live there, and "✨ Generate" switches to it.
 */
export const ShaderGuiLayout: React.FC = () => {
  const { data, queueState, playback, session, ui } = usePlayerContext();
  const { isResyncingLibrary, onTriggerResync } = data;
  const { queue, queueCurrentIndex } = queueState;
  const { isSharedPlaylist, sharedPlaylistTitle } = session;
  const { setActiveTab, onSetShowHtmlFallback, visualizerAesthetic, setVisualizerAesthetic } = ui;

  return (
    <>
      {!isSharedPlaylist && (
        <div className="fixed top-4 right-4 z-40 flex gap-2">
          <button onClick={() => { setActiveTab('generate'); onSetShowHtmlFallback(true); }}
            className="px-4 py-2 rounded-lg bg-fuchsia-600/90 text-white text-sm font-semibold hover:bg-fuchsia-500 transition-colors shadow-lg">
            ✨ Generate
          </button>
          <button onClick={onTriggerResync} disabled={isResyncingLibrary}
            className="px-4 py-2 rounded-lg bg-blue-600/90 text-white text-sm font-semibold hover:bg-blue-500 transition-colors shadow-lg disabled:opacity-60">
            {isResyncingLibrary ? '⏳ Rescanning...' : '🔄 Rescan Library'}
          </button>
          <a href="https://storage.noahcohn.com/admin" target="_blank" rel="noopener noreferrer"
            className="px-4 py-2 rounded-lg bg-purple-600/90 text-white text-sm font-semibold hover:bg-purple-500 transition-colors shadow-lg">
            ⬆️ Add Music
          </a>
        </div>
      )}
      {isSharedPlaylist && sharedPlaylistTitle && (
        <div className="fixed top-0 left-0 right-0 z-40 flex items-center justify-center pt-4 pointer-events-none">
          <h1 className="text-xl md:text-2xl font-bold text-white/90 bg-black/50 backdrop-blur px-6 py-2 rounded-full border border-white/10 pointer-events-auto">
            {sharedPlaylistTitle}
          </h1>
        </div>
      )}
      <VisualizerShell
        aesthetic={visualizerAesthetic}
        onAestheticChange={setVisualizerAesthetic}
        analyser={playback.analyser}
        currentTrack={playback.currentTrack} queue={queue} queueCurrentIndex={queueCurrentIndex}
        isPlaying={playback.isPlaying} isLoading={playback.isLoading}
        currentTime={playback.currentTime} duration={playback.duration}
        volume={playback.volume} muted={playback.muted}
        onPlay={playback.onPlay} onStop={playback.onStop} onSeek={playback.onSeek}
        onTrackClick={playback.onQueueTrackClick}
        onVolumeChange={playback.onVolumeChange} onMute={playback.onMute}
        onNext={playback.onNext} onPrevious={playback.onPrevious}
        onToggleFallback={() => onSetShowHtmlFallback(true)}
        showFallbackToggle={!isSharedPlaylist}
        onFileSelect={playback.onFileSelect}
      />
    </>
  );
};
