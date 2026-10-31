import React from 'react';
import type { AudioOutputMode } from '../../types/audio';
import { MetadataPanel } from '../MetadataPanel';
import { PlaybackScrubber } from '../PlaybackScrubber';
import { useActions } from '../PlayerActionsContext';
import { selectIsLoading, selectIsPlaying, useQueue, useSettings, useTransport } from '../../player/selectors';
import { getNextQueueIndex, getPreviousQueueIndex } from '../../utils/queueUtils';
import { OutputModeOptions } from './OutputModeOptions';

/** Bottom transport bar; reads the player store, so it takes no props. */
export const PlayerFallbackTransportBar: React.FC = () => {
  const currentTrack = useTransport((t) => t.currentTrack);
  const isPlaying = useTransport(selectIsPlaying);
  const isLoading = useTransport(selectIsLoading);
  const duration = useTransport((t) => t.duration);
  const queueLength = useQueue((q) => q.tracks.length);
  const queueCurrentIndex = useQueue((q) => q.currentIndex);
  const shuffle = useQueue((q) => q.shuffle);
  const repeatMode = useQueue((q) => q.repeatMode);
  const volume = useSettings((st) => st.volume);
  const muted = useSettings((st) => st.muted);
  const outputMode = useSettings((st) => st.outputMode);
  const {
    togglePlay: onPlay, next: onNext, previous: onPrevious, toggleMute: onMute,
    toggleShuffle, cycleRepeat, setOutputMode,
  } = useActions();

  return (
    <footer className="border-t border-white/10 bg-surface-sunken px-6 py-4">
      <div className="flex items-center justify-between">
        <div className="w-1/3 flex items-center gap-3">
          {currentTrack && (
            <MetadataPanel
              file={currentTrack.file}
              audioUrl={currentTrack.url}
              trackInfo={{
                title: currentTrack.title || currentTrack.name,
                artist: currentTrack.artist || currentTrack.author,
                duration: currentTrack.duration || duration,
                coverUrl: currentTrack.cover_url,
                cacheKey: currentTrack.id || currentTrack.url,
                generationModel: currentTrack.generation_model,
                version: currentTrack.version,
                prompt: currentTrack.prompt,
              }}
            />
          )}
        </div>

        <div className="w-1/3 flex flex-col items-center">
          <div className="flex items-center gap-4 mb-2">
            <button onClick={onPrevious}
              className="text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
              disabled={getPreviousQueueIndex(queueLength, queueCurrentIndex, repeatMode) === -1 || isLoading}
              aria-label="Previous track">⏮</button>
            <button onClick={onPlay} disabled={isLoading}
              className="w-12 h-12 bg-white text-black rounded-full flex items-center justify-center text-xl hover:scale-105 transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label={isPlaying ? 'Pause' : 'Play'}>
              {isLoading ? <div className="spinner" style={{ borderTopColor: '#000' }} /> : isPlaying ? '⏸' : '▶'}
            </button>
            <button onClick={onNext}
              className="text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
              disabled={getNextQueueIndex(queueLength, queueCurrentIndex, shuffle, repeatMode) === -1 && !isLoading}
              aria-label="Next track">⏭</button>
          </div>
          <div className="w-full max-w-md">
            <PlaybackScrubber />
          </div>
        </div>

        <div className="w-1/3 flex items-center justify-end gap-4">
          <button onClick={toggleShuffle} className={`text-sm ${shuffle ? 'text-purple-400' : 'text-gray-400'}`} title="Shuffle" aria-label="Toggle shuffle" aria-pressed={shuffle}>🔀</button>
          <button onClick={cycleRepeat}
            className={`text-sm ${repeatMode !== 'off' ? 'text-purple-400' : 'text-gray-400'}`} title={`Repeat: ${repeatMode}`}
            aria-label={`Repeat mode: ${repeatMode}`} aria-pressed={repeatMode !== 'off'}>
            {repeatMode === 'one' ? '🔂' : '🔁'}
          </button>
          <button onClick={onMute}
            className={`text-sm ${muted ? 'text-yellow-400' : 'text-gray-400'} hover:text-white transition-colors`}
            title={muted ? 'Unmute (M)' : 'Mute (M)'} aria-label={muted ? 'Unmute' : 'Mute'} aria-pressed={muted}>
            {muted ? '🔇' : '🔊'}
          </button>
          <select value={outputMode} onChange={(e) => setOutputMode(e.target.value as AudioOutputMode)}
            className="px-3 py-1 bg-white/10 rounded text-sm" aria-label="Audio output mode">
            <OutputModeOptions />
          </select>
          <span className="text-xs text-gray-400 w-12 text-right">{muted ? '🔇 0%' : `${Math.round(volume * 100)}%`}</span>
        </div>
      </div>
    </footer>
  );
};
