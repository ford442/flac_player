import { useState } from 'react';
import { PlayerState } from '../audioPlayer';

export type AudioOutputMode = 'streaming' | 'web-audio' | 'worklet' | 'sdl' | 'sdl2';

export interface PlayerStateHook {
  playerState: PlayerState;
  setPlayerState: (state: PlayerState | ((prev: PlayerState) => PlayerState)) => void;
  outputMode: AudioOutputMode;
  setOutputMode: (mode: AudioOutputMode) => void;
  error: string;
  setError: (error: string) => void;
  currentTrack: PlaylistTrack | null;
  setCurrentTrack: (track: PlaylistTrack | null) => void;
  loadingTrackId: string | undefined;
  setLoadingTrackId: (id: string | undefined) => void;
  backendStatus: 'checking' | 'up' | 'down';
  setBackendStatus: (status: 'checking' | 'up' | 'down') => void;
}

// Import PlaylistTrack type
import { PlaylistTrack } from '../audioLoader';

export const usePlayerState = (): PlayerStateHook => {
  const [playerState, setPlayerState] = useState<PlayerState>({
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    isLoading: false
  });
  const [outputMode, setOutputMode] = useState<AudioOutputMode>('streaming');
  const [error, setError] = useState<string>('');
  const [currentTrack, setCurrentTrack] = useState<PlaylistTrack | null>(null);
  const [loadingTrackId, setLoadingTrackId] = useState<string | undefined>(undefined);
  const [backendStatus, setBackendStatus] = useState<'checking' | 'up' | 'down'>('checking');

  return {
    playerState,
    setPlayerState,
    outputMode,
    setOutputMode,
    error,
    setError,
    currentTrack,
    setCurrentTrack,
    loadingTrackId,
    setLoadingTrackId,
    backendStatus,
    setBackendStatus
  };
};
