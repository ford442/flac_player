import React, { useState, useEffect, useRef } from 'react';
import { AudioPlayer, PlayerState } from '../audioPlayer';
import { AudioLoader } from '../audioLoader';
import { WebGPUVisualizer } from '../webgpuVisualizer';
import './Player.css';

export const Player: React.FC = () => {
  const [playerState, setPlayerState] = useState<PlayerState>({
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    isLoading: false
  });
  const [audioUrl, setAudioUrl] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [webGPUSupported, setWebGPUSupported] = useState<boolean>(true);
  
  const playerRef = useRef<AudioPlayer | null>(null);
  const visualizerRef = useRef<WebGPUVisualizer | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    // Initialize player
    const player = new AudioPlayer();
    player.setStateChangeCallback(setPlayerState);
    playerRef.current = player;

    return () => {
      player.destroy();
      if (visualizerRef.current) {
        visualizerRef.current.destroy();
      }
    };
  }, []);

  useEffect(() => {
    // Initialize WebGPU visualizer
    if (canvasRef.current && playerRef.current && !visualizerRef.current) {
      const visualizer = new WebGPUVisualizer(canvasRef.current);
      visualizer.initialize(playerRef.current.getAnalyser()).then((success) => {
        if (success) {
          visualizer.startAnimation();
          visualizerRef.current = visualizer;
        } else {
          setWebGPUSupported(false);
        }
      });
    }
  }, []);

  const handleLoadAudio = async () => {
    if (!audioUrl.trim() || !playerRef.current) {
      return;
    }

    setPlayerState(prev => ({ ...prev, isLoading: true }));
    setError('');

    try {
      const loader = new AudioLoader();
      const arrayBuffer = await loader.loadFromURL(audioUrl);
      await playerRef.current.loadAudio(arrayBuffer);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audio');
    } finally {
      setPlayerState(prev => ({ ...prev, isLoading: false }));
    }
  };

  const handlePlay = () => {
    playerRef.current?.play();
  };

  const handlePause = () => {
    playerRef.current?.pause();
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    playerRef.current?.seek(time);
  };

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="player">
      <div className="visualizer-container">
        <canvas
          ref={canvasRef}
          width={800}
          height={400}
          className="visualizer-canvas"
        />
        {!webGPUSupported && (
          <div className="webgpu-warning">
            WebGPU not supported in this browser
          </div>
        )}
      </div>

      <div className="player-controls">
        <div className="url-input-container">
          <input
            type="text"
            className="url-input"
            placeholder="Enter audio URL (Google Bucket, FTP, or direct URL)"
            value={audioUrl}
            onChange={(e) => setAudioUrl(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleLoadAudio()}
          />
          <button
            className="load-button"
            onClick={handleLoadAudio}
            disabled={playerState.isLoading || !audioUrl.trim()}
          >
            {playerState.isLoading ? 'Loading...' : 'Load'}
          </button>
        </div>

        {error && <div className="error-message">{error}</div>}

        <div className="playback-controls">
          <button
            className="control-button"
            onClick={playerState.isPlaying ? handlePause : handlePlay}
            disabled={!playerState.duration}
          >
            {playerState.isPlaying ? '⏸ Pause' : '▶ Play'}
          </button>
        </div>

        <div className="seek-container">
          <span className="time-display">{formatTime(playerState.currentTime)}</span>
          <input
            type="range"
            className="seek-slider"
            min="0"
            max={playerState.duration || 0}
            step="0.1"
            value={playerState.currentTime}
            onChange={handleSeek}
            disabled={!playerState.duration}
          />
          <span className="time-display">{formatTime(playerState.duration)}</span>
        </div>

        <div className="info-panel">
          <p className="info-text">
            Supports FLAC and WAV files from Google Cloud Storage, FTP, or direct URLs
          </p>
        </div>
      </div>
    </div>
  );
};
