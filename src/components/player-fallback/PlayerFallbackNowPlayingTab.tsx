import React from 'react';
import { PlaylistTrack } from '../../audioLoader';
import { ShaderGUI } from '../ShaderGUI/ShaderGUI';
import { OverviewData, TransportControls, TransportState } from './types';

export interface PlayerFallbackNowPlayingTabProps {
  analyser: AnalyserNode | null;
  currentTrack: PlaylistTrack | null;
  queue: PlaylistTrack[];
  queueCurrentIndex: number;
  transportState: TransportState;
  transportControls: TransportControls;
  overview: OverviewData;
  onQueueTrackClick: (index: number) => void;
  onFileSelect: (files: File[]) => void;
}

export const PlayerFallbackNowPlayingTab: React.FC<PlayerFallbackNowPlayingTabProps> = ({
  analyser, currentTrack, queue, queueCurrentIndex,
  transportState, transportControls, overview,
  onQueueTrackClick, onFileSelect,
}) => (
  <div className="flex-1 flex items-center justify-center p-6 overflow-auto">
    <ShaderGUI
      analyser={analyser} currentTrack={currentTrack} queue={queue} queueCurrentIndex={queueCurrentIndex}
      isPlaying={transportState.isPlaying} isLoading={transportState.isLoading}
      currentTime={transportState.currentTime} duration={transportState.duration} volume={transportState.volume}
      muted={transportState.muted} onPlay={transportControls.onPlay} onStop={transportControls.onStop}
      onSeek={transportControls.onSeek}
      onTrackClick={(index) => onQueueTrackClick(index)}
      onVolumeChange={transportControls.onVolumeChange} onMute={transportControls.onMute}
      onNext={transportControls.onNext} onPrevious={transportControls.onPrevious}
      onFileSelect={onFileSelect}
      overviewMinmax={overview.minmax}
      overviewRms={overview.rms}
      overviewPeak={overview.peak}
      overviewBackend={overview.backend}
      overviewReason={overview.reason}
    />
  </div>
);
