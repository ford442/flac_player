import React, { useState, useEffect, useRef } from 'react';
import { AudioPlayer, PlayerState } from '../audioPlayer';
import { SdlAudioPlayer } from '../sdlAudioPlayer';
import { Sdl2AudioPlayer } from '../sdl2AudioPlayer';
import { AudioWorkletPlayer } from '../audioWorkletPlayer';
import { AudioLoader, PlaylistTrack, SortBy, RepeatMode } from '../audioLoader';
import { WebGPUVisualizer, VisualizerMode } from '../webgpuVisualizer';
import './Player.css';

type AudioOutputMode = 'web-audio' | 'worklet' | 'sdl' | 'sdl2';

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
  // Playlist playback state
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [autoAdvance, setAutoAdvance] = useState<boolean>(true);
  const [shuffle, setShuffle] = useState<boolean>(false);
  // Editing state
  const [editingTrack, setEditingTrack] = useState<number | null>(null);
  const [editName, setEditName] = useState<string>('');
  const [editTitle, setEditTitle] = useState<string>('');
  const [editRating, setEditRating] = useState<number | null>(null);
  const [editGenre, setEditGenre] = useState<string>('');
  const [isSaving, setIsSaving] = useState<boolean>(false);
  // Sorting & filtering
  const [sortBy, setSortBy] = useState<SortBy>('date');
  const [sortDesc, setSortDesc] = useState<boolean>(true);
  const [filterGenre, setFilterGenre] = useState<string>('');
  const [repeatMode, setRepeatMode] = useState<RepeatMode>('off');

  // Use a generic type or union for playerRef
  const playerRef = useRef<AudioPlayer | AudioWorkletPlayer | SdlAudioPlayer | Sdl2AudioPlayer | null>(null);
  // Track edit state for double-click
  const [lastClickTime, setLastClickTime] = useState<number>(0);
  const [lastClickIndex, setLastClickIndex] = useState<number>(-1);
  const visualizerRef = useRef<WebGPUVisualizer | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    // Initialize player based on mode
    let player: AudioPlayer | AudioWorkletPlayer | SdlAudioPlayer | Sdl2AudioPlayer;
    if (outputMode === 'worklet') {
      player = new AudioWorkletPlayer();
    } else if (outputMode === 'sdl') {
      player = new SdlAudioPlayer();
    } else if (outputMode === 'sdl2') {
      player = new Sdl2AudioPlayer();
    } else {
      player = new AudioPlayer();
    }

    // Initialize AudioWorklet if needed
    if (outputMode === 'worklet') {
      (player as AudioWorkletPlayer).initialize().then(ok => {
        if (!ok) {
          setError('AudioWorklet initialization failed');
        }
      });
    }

    player.setStateChangeCallback(setPlayerState);

    // register ended callback (all player implementations now expose setOnEndedCallback)
    if ((player as any).setOnEndedCallback) {
      (player as any).setOnEndedCallback(() => {
        // advance playlist when a track ends
        if (!autoAdvance) return;
        if (!playlist || playlist.length === 0) return;
        // Respect shuffle when auto-advancing
        if (shuffle) {
          if (playlist.length === 1) {
            playTrackAtIndex(0, true).catch(err => console.warn('auto-advance failed', err));
            return;
          }
          let next;
          do { next = Math.floor(Math.random() * playlist.length); } while (next === currentIndex);
          playTrackAtIndex(next, true).catch(err => console.warn('auto-advance failed', err));
          return;
        }

        const next = currentIndex === null ? 0 : currentIndex + 1;
        const nextIndex = next >= playlist.length ? 0 : next; // wrap-to-start
        playTrackAtIndex(nextIndex, true).catch(err => console.warn('auto-advance failed', err));
      });
    }

    playerRef.current = player;

    // If we have an existing visualizer, we might need to re-init it if the analyser changed
    // But SdlAudioPlayer returns a dummy analyser or null.
    // If outputMode changed, we might want to reload audio if it was loaded?
    // For now, switching modes resets the player.

    return () => {
      (player as any).setOnEndedCallback?.(undefined);
      player.destroy();
      // We don't necessarily destroy visualizer here as it's bound to canvas,
      // but we might need to re-hook the analyser.
    };
  }, [outputMode, autoAdvance, playlist, currentIndex]);

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
      throw err;
    } finally {
      setPlayerState(prev => ({ ...prev, isLoading: false }));
    }
  };

  const handleLoadAudio = async () => {
    setCurrentIndex(null);
    await loadAudioFromUrl(audioUrl);
  };

  const handleLoadPlaylist = async () => {
    setIsLoadingPlaylist(true);
    try {
      const loader = new AudioLoader();
      const tracks = await loader.fetchPlaylist(sortBy, sortDesc, filterGenre || undefined);
      setPlaylist(tracks);
      setShowPlaylist(true);
      setCurrentIndex(tracks.length ? 0 : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load playlist');
    } finally {
      setIsLoadingPlaylist(false);
    }
  };

  const handlePlayTrack = async (index: number, autoPlay = true) => {
    await playTrackAtIndex(index, autoPlay);
    // Record play
    const track = playlist[index];
    if (track?.id) {
      const loader = new AudioLoader();
      loader.recordPlay(track.id);
    }
  };



  const handlePlay = () => {
    playerRef.current?.play();
  };

  const handlePause = () => {
    playerRef.current?.pause();
  };

  const handleNext = () => {
    if (!playlist || playlist.length === 0) return;
    if (shuffle) {
      if (playlist.length === 1) {
        playTrackAtIndex(0).catch(() => { });
        return;
      }
      let next: number;
      do { next = Math.floor(Math.random() * playlist.length); } while (next === currentIndex);
      playTrackAtIndex(next).catch(() => { });
    } else {
      const next = currentIndex === null ? 0 : currentIndex + 1;
      const nextIndex = next >= playlist.length ? 0 : next; // wrap
      playTrackAtIndex(nextIndex).catch(() => { });
    }
  };

  const playTrackAtIndex = async (index: number, autoPlay = true) => {
    if (!playlist || index < 0 || index >= playlist.length) return;
    const track = playlist[index];
    setCurrentIndex(index);
    setAudioUrl(track.url);
    await loadAudioFromUrl(track.url);
    if (autoPlay) playerRef.current?.play();
  };

  const handleTrackClick = (index: number, e: React.MouseEvent) => {
    const now = Date.now();
    const timeDiff = now - lastClickTime;
    
    if (lastClickIndex === index && timeDiff < 300) {
      // Double click detected - start editing
      e.stopPropagation();
      handleStartEdit(index);
      setLastClickTime(0);
      setLastClickIndex(-1);
    } else {
      // Single click - just play
      setLastClickTime(now);
      setLastClickIndex(index);
      setCurrentIndex(index);
      setAudioUrl(playlist[index].url);
      loadAudioFromUrl(playlist[index].url);
    }
  };

  const handleStartEdit = (index: number) => {
    const track = playlist[index];
    setEditingTrack(index);
    setEditName(track.name);
    setEditTitle(track.title || '');
    setEditRating(track.rating || null);
    setEditGenre(track.genre || '');
  };

  const handleSaveEdit = async (index: number) => {
    const track = playlist[index];
    if (!track.id) {
      setError('Cannot edit: Track has no ID');
      return;
    }
    
    setIsSaving(true);
    try {
      const loader = new AudioLoader();
      const updates: any = {};
      if (editName !== track.name) updates.name = editName;
      if (editTitle !== (track.title || '')) updates.title = editTitle || undefined;
      if (editRating !== track.rating) updates.rating = editRating;
      if (editGenre !== (track.genre || '')) updates.genre = editGenre || undefined;
      
      console.log('Saving updates:', updates);
      await loader.updateSampleMetadata(track.id, updates);
      
      // Update local playlist
      const updatedPlaylist = [...playlist];
      updatedPlaylist[index] = {
        ...track,
        name: editName,
        title: editTitle || undefined,
        rating: editRating,
        genre: editGenre || undefined
      };
      setPlaylist(updatedPlaylist);
      setEditingTrack(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save changes');
    } finally {
      setIsSaving(false);
    }
  };

  const handlePrev = () => {
    if (!playlist || playlist.length === 0) return;
    if (shuffle) {
      const idx = Math.floor(Math.random() * playlist.length);
      playTrackAtIndex(idx).catch(() => { });
    } else {
      const prev = currentIndex === null ? 0 : currentIndex - 1;
      const prevIndex = prev < 0 ? playlist.length - 1 : prev;
      playTrackAtIndex(prevIndex).catch(() => { });
    }
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
            <div className="playlist-controls" style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortBy)}
                style={{ padding: '0.5rem', background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '4px', color: 'white' }}
              >
                <option value="date">Sort by Date</option>
                <option value="rating">Sort by Rating</option>
                <option value="name">Sort by Name</option>
                <option value="last_played">Sort by Last Played</option>
                <option value="genre">Sort by Genre</option>
              </select>
              <button
                onClick={() => setSortDesc(d => !d)}
                style={{
                  padding: '0.5rem 1rem',
                  background: sortDesc ? 'rgba(0,132,255,0.3)' : 'rgba(255,255,255,0.1)',
                  border: 'none',
                  borderRadius: '4px',
                  color: 'white',
                  cursor: 'pointer'
                }}
              >
                {sortDesc ? '↓ Desc' : '↑ Asc'}
              </button>
              <input
                type="text"
                value={filterGenre}
                onChange={(e) => setFilterGenre(e.target.value)}
                placeholder="Filter by genre..."
                style={{ padding: '0.5rem', background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '4px', color: 'white', flex: 1, minWidth: '100px' }}
              />
              <button
                onClick={handleLoadPlaylist}
                disabled={isLoadingPlaylist}
                style={{
                  padding: '0.5rem 1rem',
                  background: '#28a745',
                  border: 'none',
                  borderRadius: '4px',
                  color: 'white',
                  cursor: isLoadingPlaylist ? 'not-allowed' : 'pointer'
                }}
              >
                {isLoadingPlaylist ? '...' : 'Apply'}
              </button>
            </div>
            <div className="playlist-items">
              {playlist.map((track, index) => (
                <div
                  key={index}
                  className={`playlist-item ${audioUrl === track.url ? 'active' : ''}`}
                >
                  {editingTrack === index ? (
                    <div className="edit-form" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        placeholder="Display Title"
                        style={{ width: '100%', marginBottom: '0.5rem', padding: '0.25rem', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white' }}
                      />
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        placeholder="Filename (optional)"
                        style={{ width: '100%', marginBottom: '0.5rem', padding: '0.25rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#aaa', fontSize: '0.9em' }}
                      />
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                        <label style={{ color: 'rgba(255,255,255,0.8)' }}>Rating:</label>
                        <select
                          value={editRating || ''}
                          onChange={(e) => setEditRating(e.target.value ? parseInt(e.target.value) : null)}
                          style={{ padding: '0.25rem', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white' }}
                        >
                          <option value="">-</option>
                          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                        <label style={{ color: 'rgba(255,255,255,0.8)' }}>Genre:</label>
                        <input
                          type="text"
                          value={editGenre}
                          onChange={(e) => setEditGenre(e.target.value)}
                          placeholder="e.g., ambient, bass"
                          style={{ padding: '0.25rem', flex: 1, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white' }}
                        />
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button
                          onClick={() => handleSaveEdit(index)}
                          disabled={isSaving}
                          style={{
                            padding: '0.25rem 0.5rem',
                            background: '#28a745',
                            border: 'none',
                            borderRadius: '4px',
                            color: 'white',
                            cursor: isSaving ? 'not-allowed' : 'pointer'
                          }}
                        >
                          {isSaving ? '...' : 'Save'}
                        </button>
                        <button
                          onClick={() => setEditingTrack(null)}
                          disabled={isSaving}
                          style={{
                            padding: '0.25rem 0.5rem',
                            background: 'rgba(255,255,255,0.2)',
                            border: 'none',
                            borderRadius: '4px',
                            color: 'white',
                            cursor: isSaving ? 'not-allowed' : 'pointer'
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="track-info"
                      onClick={(e) => handleTrackClick(index, e)}
                      style={{ flex: 1, cursor: 'pointer' }}
                      title="Double-click to edit"
                    >
                      <div className="track-title" style={{ fontWeight: 500 }}>
                        {track.title || track.name}
                      </div>
                      {track.title && (
                        <div className="track-filename" style={{ color: '#888', fontSize: '0.8em' }}>
                          {track.name}
                        </div>
                      )}
                      {track.rating && (
                        <div className="track-rating" style={{ color: '#FFD700', fontSize: '0.85em' }}>
                          {'★'.repeat(track.rating)}{'☆'.repeat(10 - track.rating)}
                        </div>
                      )}
                      {track.genre && (
                        <div className="track-genre" style={{ color: '#aaa', fontSize: '0.8em' }}>
                          {track.genre}
                        </div>
                      )}
                      {track.last_played && (
                        <div className="track-last-played" style={{ color: '#666', fontSize: '0.75em' }}>
                          Last: {new Date(track.last_played).toLocaleDateString()}
                        </div>
                      )}
                    </div>
                  )}

                </div>
              ))}
              {playlist.length === 0 && !isLoadingPlaylist && (
                <div style={{ color: 'rgba(255,255,255,0.5)', textAlign: 'center', marginTop: '2rem' }}>
                  No tracks found
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="player-controls">

        <div className="mode-toggle-container" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>

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
              className={`toggle-btn ${outputMode === 'worklet' ? 'active' : ''}`}
              onClick={() => setOutputMode('worklet')}
              style={{
                padding: '0.5rem 1rem',
                background: outputMode === 'worklet' ? '#28a745' : 'rgba(255,255,255,0.1)',
                border: 'none',
                color: 'white',
                cursor: 'pointer'
              }}
            >
              AudioWorklet
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
              SDL3
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
              SDL2
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
          <div className="control-group">
            <button
              className="small-button"
              onClick={handlePrev}
              disabled={!playlist.length}
              title="Previous"
            >
              « Prev
            </button>

            <button
              className="control-button"
              onClick={playerState.isPlaying ? handlePause : handlePlay}
              disabled={!playerState.duration}
            >
              {playerState.isPlaying ? '⏸ Pause' : '▶ Play'}
            </button>

            <button
              className="small-button"
              onClick={handleNext}
              disabled={!playlist.length}
              title="Next"
            >
              Next »
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button
              className={`shuffle-btn ${shuffle ? 'active' : ''}`}
              onClick={() => setShuffle(s => !s)}
              title="Shuffle"
            >
              🔀
            </button>
            <button
              className={`shuffle-btn ${repeatMode !== 'off' ? 'active' : ''}`}
              onClick={() => setRepeatMode(m => m === 'off' ? 'all' : m === 'all' ? 'one' : 'off')}
              title={`Repeat: ${repeatMode}`}
              style={{
                background: repeatMode === 'one' ? 'linear-gradient(135deg, #00c853 0%, #64dd17 100%)' : undefined
              }}
            >
              {repeatMode === 'off' ? '🔁' : repeatMode === 'all' ? '🔁' : '🔂'}
            </button>
          </div>
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
            <br />
            <strong>3D Mode:</strong> Drag to rotate, Click on device screen to Play/Pause.
            <br />
            <strong>Playlist:</strong> Double-click a track to edit title, rating & genre.
          </p>
        </div>
      </div>
    </div>
  );
};
