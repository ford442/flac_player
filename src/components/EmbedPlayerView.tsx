import React, { useEffect, useRef } from 'react';
import { PlaylistTrack } from '../audioLoader';
import { formatTime } from '../utils/audioUtils';

/**
 * Compact, audio-only transport UI for Project-M embed mode (?projectm=1).
 *
 * Rendered by Player instead of ShaderGUI / PlayerFallbackView when
 * IS_PROJECTM_EMBED is true. Because ShaderGUI (the WebGPU spectrum/pattern
 * visualizer) is never mounted in this path, no WebGPU device is acquired and
 * the GPU budget is left free for the Project-M visualizer in the host page.
 * Audio still flows to Project-M via utils/projectMBridge.ts, which is wired up
 * inside the Player engine effect independently of this view.
 */
export interface EmbedPlayerViewProps {
  currentTrack: PlaylistTrack | null;
  isPlaying: boolean;
  isLoading: boolean;
  currentTime: number;
  duration: number;
  onPlay: () => void;
  onStop: () => void;
  onSeek?: (time: number) => void;
  onNext?: () => void;
  onPrevious?: () => void;
  onFileSelect?: (files: File[]) => void;
}

export const EmbedPlayerView: React.FC<EmbedPlayerViewProps> = ({
  currentTrack,
  isPlaying,
  isLoading,
  currentTime,
  duration,
  onPlay,
  onStop,
  onSeek,
  onNext,
  onPrevious,
  onFileSelect,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Hint that this tab is acting as an audio feeder for Project-M.
  useEffect(() => {
    const previous = document.title;
    document.title = '🎵 FLAC → Project-M';
    return () => { document.title = previous; };
  }, []);

  const title = currentTrack
    ? (currentTrack.title || currentTrack.name || 'Unknown track')
    : 'No track loaded';
  const artist = currentTrack?.artist || currentTrack?.author || '';

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (files.length && onFileSelect) onFileSelect(files);
    e.target.value = ''; // allow re-selecting the same file
  };

  const onSeekInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    onSeek?.(Number(e.target.value));
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md flex flex-col gap-4 rounded-xl border border-white/10 bg-gray-900/60 p-5 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <span className="text-xs font-mono uppercase tracking-wider text-cyan-400">
            Project-M audio feed
          </span>
          <span className={`text-[10px] font-mono ${isPlaying ? 'text-green-400' : 'text-gray-500'}`}>
            {isLoading ? 'loading…' : isPlaying ? '▶ playing' : '■ stopped'}
          </span>
        </div>

        {/* Track info */}
        <div className="min-h-[2.75rem] flex flex-col justify-center">
          <span className="text-sm font-medium truncate" title={title}>{title}</span>
          {artist && <span className="text-xs text-gray-400 truncate" title={artist}>{artist}</span>}
        </div>

        {/* Seek bar */}
        <div className="flex items-center gap-3 text-xs font-mono text-gray-400">
          <span className="w-12 text-right shrink-0">{formatTime(currentTime)}</span>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(currentTime, duration || 0)}
            onChange={onSeekInput}
            disabled={!duration || !onSeek}
            aria-label="Seek"
            className="flex-1 accent-cyan-500 cursor-pointer disabled:cursor-not-allowed"
          />
          <span className="w-12 shrink-0">{formatTime(duration)}</span>
        </div>

        {/* Transport controls */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onPrevious}
            disabled={!onPrevious}
            aria-label="Previous"
            className="flex items-center justify-center w-9 h-9 rounded-full bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            ⏮
          </button>
          <button
            type="button"
            onClick={onPlay}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            className="flex items-center justify-center w-11 h-11 rounded-full bg-cyan-600 hover:bg-cyan-500 text-white text-lg transition-colors"
          >
            {isPlaying ? '⏸' : '▶'}
          </button>
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop"
            className="flex items-center justify-center w-9 h-9 rounded-full bg-gray-700 hover:bg-gray-600 transition-colors"
          >
            ⏹
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={!onNext}
            aria-label="Next"
            className="flex items-center justify-center w-9 h-9 rounded-full bg-gray-700 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            ⏭
          </button>

          <div className="flex-1" />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-3 h-9 rounded-full bg-gray-700 hover:bg-gray-600 text-sm transition-colors"
          >
            Load file
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".flac,.wav,audio/flac,audio/wav,audio/x-flac"
            multiple
            className="hidden"
            onChange={onFileChange}
          />
        </div>

        <p className="text-[10px] text-gray-500 leading-relaxed">
          WebGPU visualizer disabled — this window only decodes audio and forwards
          it to the Project-M visualizer. Close it to stop the feed.
        </p>
      </div>
    </div>
  );
};

export default EmbedPlayerView;
