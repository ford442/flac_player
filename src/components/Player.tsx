import React, { useState, useEffect, useRef } from 'react';
import { AudioPlayer, PlayerState } from '../audioPlayer';
import { SdlAudioPlayer } from '../sdlAudioPlayer';
import { Sdl2AudioPlayer } from '../sdl2AudioPlayer';
import { AudioLoader, PlaylistTrack } from '../audioLoader';
import { WebGPUVisualizer, VisualizerMode } from '../webgpuVisualizer';
import './Player.css';

type AudioOutputMode = 'web-audio' | 'sdl' | 'sdl2';

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
  const [visualizerMode, setVisualizerMode] = useState<VisualizerMode>('flat');
  const [outputMode, setOutputMode] = useState<AudioOutputMode>('web-audio');
  const [playlist, setPlaylist] = useState<PlaylistTrack[]>([]);
  const [showPlaylist, setShowPlaylist] = useState<boolean>(false);
  const [isLoadingPlaylist, setIsLoadingPlaylist] = useState<boolean>(false);
  
  // Use a generic type or union for playerRef
  const playerRef = useRef<AudioPlayer | SdlAudioPlayer | Sdl2AudioPlayer | null>(null);
  const visualizerRef = useRef<WebGPUVisualizer | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    // Initialize player based on mode
    let player: AudioPlayer | SdlAudioPlayer | Sdl2AudioPlayer;
    if (outputMode === 'sdl') {
      player = new SdlAudioPlayer();
    } else if (outputMode === 'sdl2') {
      player = new Sdl2AudioPlayer();
    } else {
      player = new AudioPlayer();
    }

    player.setStateChangeCallback(setPlayerState);
    playerRef.current = player;

    // If we have an existing visualizer, we might need to re-init it if the analyser changed
    // But SdlAudioPlayer returns a dummy analyser or null.
    // If outputMode changed, we might want to reload audio if it was loaded?
    // For now, switching modes resets the player.

    return () => {
      player.destroy();
      // We don't necessarily destroy visualizer here as it's bound to canvas,
      // but we might need to re-hook the analyser.
    };
  }, [outputMode]);

  useEffect(() => {
    // Initialize WebGPU visualizer
    // We need to re-run this when player reference changes (which happens on mode switch)
    // but playerRef.current is mutable.
    // Better to depend on outputMode to trigger re-init of visualizer source.

    const initVisualizer = async () => {
      if (!canvasRef.current || !playerRef.current) return;

      if (!visualizerRef.current) {
        const visualizer = new WebGPUVisualizer(canvasRef.current);
        visualizerRef.current = visualizer;
      }

      const analyser = playerRef.current.getAnalyser();
      // If analyser is dummy (SDL), visualizer might just show nothing or flat line.

      const success = await visualizerRef.current.initialize(analyser);
      if (success) {
          visualizerRef.current.startAnimation();
          visualizerRef.current.setMode(visualizerMode);
          visualizerRef.current.setTogglePlayCallback(() => {
              // Toggle Play callback from 3D interaction
              if (playerRef.current) {
                  const state = playerRef.current.getState();
                   if (state.isPlaying) {
                       playerRef.current.pause();
                   } else if (state.duration > 0) {
                       playerRef.current.play();
                   }
              }
          });
      } else {
          setWebGPUSupported(false);
      }
    };

    initVisualizer();
  }, [outputMode]); // Re-run when output mode changes

  // Update visualizer mode when state changes
  useEffect(() => {
      if (visualizerRef.current) {
          visualizerRef.current.setMode(visualizerMode);
      }
  }, [visualizerMode]);

  const loadAudioFromUrl = async (url: string) => {
    if (!url.trim() || !playerRef.current) {
      return;
    }

    setPlayerState(prev => ({ ...prev, isLoading: true }));
    setError('');

    try {
      const loader = new AudioLoader();
      const arrayBuffer = await loader.loadFromURL(url);
      await playerRef.current.loadAudio(arrayBuffer);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audio');
    } finally {
      setPlayerState(prev => ({ ...prev, isLoading: false }));
    }
  };

  const handleLoadAudio = async () => {
    await loadAudioFromUrl(audioUrl);
  };

  const handleLoadPlaylist = async () => {
    setIsLoadingPlaylist(true);
    try {
      const loader = new AudioLoader();
      const tracks = await loader.fetchPlaylist('music');
      setPlaylist(tracks);
      setShowPlaylist(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load playlist');
    } finally {
      setIsLoadingPlaylist(false);
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

        {showPlaylist && (
          <div className="playlist-container">
            <div className="playlist-header">
              <h3>Playlist</h3>
              <button
                className="close-playlist-btn"
                onClick={() => setShowPlaylist(false)}
              >
                &times;
              </button>
            </div>
            <div className="playlist-items">
              {playlist.map((track, index) => (
                <div
                  key={index}
                  className={`playlist-item ${audioUrl === track.url ? 'active' : ''}`}
                  onClick={() => {
                    setAudioUrl(track.url);
                    loadAudioFromUrl(track.url);
                  }}
                >
                  {track.name}
                </div>
              ))}
              {playlist.length === 0 && !isLoadingPlaylist && (
                <div style={{color: 'rgba(255,255,255,0.5)', textAlign: 'center', marginTop: '2rem'}}>
                  No tracks found
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="player-controls">

        <div className="mode-toggle-container" style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', marginBottom: '1rem'}}>

            {/* Visualizer Mode Toggle */}
            <div className="mode-toggle">
                <button
                    className={`toggle-btn ${visualizerMode === 'flat' ? 'active' : ''}`}
                    onClick={() => setVisualizerMode('flat')}
                    style={{
                        padding: '0.5rem 1rem',
                        background: visualizerMode === 'flat' ? '#0084ff' : 'rgba(255,255,255,0.1)',
                        border: 'none',
                        borderTopLeftRadius: '8px',
                        borderBottomLeftRadius: '8px',
                        color: 'white',
                        cursor: 'pointer'
                    }}
                >
                    Flat Mode
                </button>
                <button
                    className={`toggle-btn ${visualizerMode === '3D' ? 'active' : ''}`}
                    onClick={() => setVisualizerMode('3D')}
                    style={{
                        padding: '0.5rem 1rem',
                        background: visualizerMode === '3D' ? '#0084ff' : 'rgba(255,255,255,0.1)',
                        border: 'none',
                        borderTopRightRadius: '8px',
                        borderBottomRightRadius: '8px',
                        color: 'white',
                        cursor: 'pointer'
                    }}
                >
                    3D Device
                </button>
            </div>

            {/* Audio Output Toggle */}
            <div className="mode-toggle">
                <button
                    className={`toggle-btn ${outputMode === 'web-audio' ? 'active' : ''}`}
                    onClick={() => setOutputMode('web-audio')}
                    style={{
                        padding: '0.5rem 1rem',
                        background: outputMode === 'web-audio' ? '#28a745' : 'rgba(255,255,255,0.1)',
                        border: 'none',
                        borderTopLeftRadius: '8px',
                        borderBottomLeftRadius: '8px',
                        color: 'white',
                        cursor: 'pointer'
                    }}
                >
                    Web Audio
                </button>
                <button
                    className={`toggle-btn ${outputMode === 'sdl' ? 'active' : ''}`}
                    onClick={() => setOutputMode('sdl')}
                    style={{
                        padding: '0.5rem 1rem',
                        background: outputMode === 'sdl' ? '#28a745' : 'rgba(255,255,255,0.1)',
                        border: 'none',
                        color: 'white',
                        cursor: 'pointer'
                    }}
                >
                    SDL3 (WASM)
                </button>
                <button
                    className={`toggle-btn ${outputMode === 'sdl2' ? 'active' : ''}`}
                    onClick={() => setOutputMode('sdl2')}
                    style={{
                        padding: '0.5rem 1rem',
                        background: outputMode === 'sdl2' ? '#28a745' : 'rgba(255,255,255,0.1)',
                        border: 'none',
                        borderTopRightRadius: '8px',
                        borderBottomRightRadius: '8px',
                        color: 'white',
                        cursor: 'pointer'
                    }}
                >
                    SDL2 (WASM)
                </button>
            </div>
        </div>

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
          <button
            className="load-button"
            onClick={handleLoadPlaylist}
            disabled={isLoadingPlaylist}
            style={{
                marginLeft: '0.5rem',
                background: 'linear-gradient(135deg, #FF9800 0%, #F57C00 100%)'
            }}
          >
            {isLoadingPlaylist ? 'Loading...' : 'Playlist'}
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
            Supports FLAC and WAV files. Use &apos;gs://&apos; for Google Cloud Storage.
            <br/>
            <strong>3D Mode:</strong> Drag to rotate, Click on device screen to Play/Pause.
          </p>
        </div>
      </div>
    </div>
  );
};
