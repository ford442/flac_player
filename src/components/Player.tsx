import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { routePath } from '../utils/publicPath';
import { fetchSong } from '../api/songApi';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { isOutputPickerSupported, useAudioSettings } from '../hooks/useAudioSettings';
import { useAudioOutputInfo, useOutputDevices } from '../hooks/useAudioOutputInfo';
import { useLibraryState } from '../hooks/useLibraryState';
import { usePlayerActions } from '../hooks/usePlayerActions';
import { useQueueActions } from '../hooks/useQueueActions';
import { useAppBootstrap } from '../hooks/useAppBootstrap';
import { useGlobalFileDrop } from '../hooks/useGlobalFileDrop';
import { usePlaylists } from '../hooks/usePlaylists';
import { isAudioContextSinkSupported, sharedAudioContextManager } from '../audio/AudioContextManager';
import { isRenderSizeHintSupported } from '../audio/sampleRatePolicy';
import { usePlayer } from '../player/PlayerContext';
import { useNotify, useQueue, useSettings, useTransport } from '../player/selectors';
import { persistPlayerState } from '../player/persistence';
import { isLibraryTrack } from '../types/track';
import type { AudioOutputControls } from './EQPanel';
import { AudioCapabilitiesContext } from './AudioCapabilitiesContext';
import { PlayerActionsProvider, type AppActions } from './PlayerActionsContext';
import { TrackOverviewProvider } from './PlaybackScrubber';
import { MediaSessionBridge } from './MediaSessionBridge';
import { VisualizerShell } from './VisualizerShell';
import { PlayerToasts } from './Toast';
import { KeyboardHelpModal } from './KeyboardHelpModal';
import { PlayerFallbackView } from './PlayerFallbackView';
import { EmbedPlayerView } from './EmbedPlayerView';
import { IS_PROJECTM_EMBED } from '../utils/embedMode';
import { getInitialVisualizerAesthetic, VisualizerAesthetic } from '../utils/visualizerMode';
import { clearTrackCache } from '../storage/trackCache';
import { ListeningRoomPanel } from './ListeningRoomPanel';
import { appBasePath, getCurrentRoomId, loadHostToken } from '../listening/roomSession';
import { isShareableTrackId, useListeningRoomBridge } from '../listening/useListeningRoomBridge';
import type { LibraryViewMode, RoomBadge, ViewTab } from './player-fallback/types';
import './Player.css';

const getSharedPlaylistId = (): string | null => {
  const params = new URLSearchParams(window.location.search);
  const queryShareId = params.get('share');
  if (queryShareId) return queryShareId;
  const pathMatch = routePath(window.location.pathname).match(/^\/playlist\/([^/]+)$/);
  const pathId = pathMatch?.[1];
  return pathId ? decodeURIComponent(pathId) : null;
};

/**
 * App shell. Playback lives in the PlaybackEngine and the player store (#258):
 * Player wires settings, rooms and persistence to the engine and lays out the
 * views, which read playback state themselves. It never subscribes to the clock.
 */
export const Player: React.FC = () => {
  const { engine, store } = usePlayer();
  const notify = useNotify();
  const sharedPlaylistId = useMemo(() => getSharedPlaylistId(), []);
  const routeRoomId = useMemo(() => getCurrentRoomId(), []);
  // A guest link opens a read-only player (like a shared playlist): no library, no saved queue.
  const isRoomGuestRoute = useMemo(() => routeRoomId !== null && loadHostToken(routeRoomId) === null, [routeRoomId]);
  const isSharedPlaylist = sharedPlaylistId !== null || isRoomGuestRoute;

  // The engine owns one backend for the page's lifetime (attach is StrictMode-safe).
  useEffect(() => engine.attach(), [engine]);

  const audio = useAudioSettings();
  const {
    eqGains, playbackRate, gaplessSettings, replayGainSettings,
    latencyMode, renderSizeMode, setRenderSizeMode, outputDevice, onSelectOutputDevice,
  } = audio;
  useEffect(() => {
    engine.setAudioSettings({ eqGains, playbackRate, gapless: gaplessSettings, replayGain: replayGainSettings });
  }, [engine, eqGains, playbackRate, gaplessSettings, replayGainSettings]);

  // Shared playlists and room guests leave nothing behind in localStorage.
  useEffect(
    () => persistPlayerState(engine.clock, store, { position: !isSharedPlaylist, queue: !isSharedPlaylist }),
    [engine, store, isSharedPlaylist],
  );

  const library = useLibraryState({ enabled: !isSharedPlaylist, notify, engine });
  const { refreshStats } = library;
  // Starting a library track records a play: refresh the play-count stats.
  useEffect(() => engine.onTrackStarted((track) => {
    if (isLibraryTrack(track)) refreshStats();
  }), [engine, refreshStats]);

  const [sharedPlaylistTitle, setSharedPlaylistTitle] = useState('');
  const [activeTab, setActiveTab] = useState<ViewTab>('library');
  const [libraryViewMode, setLibraryViewMode] = useState<LibraryViewMode>('grid');
  const [showHtmlFallback, setShowHtmlFallback] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [visualizerAesthetic, setVisualizerAesthetic] = useState<VisualizerAesthetic>(
    () => getInitialVisualizerAesthetic()
  );
  const searchInputRef = useRef<HTMLInputElement>(null);

  const room = useListeningRoomBridge({
    initialRoomId: routeRoomId,
    engine, store,
    library: library.library,
    addToast: notify,
    onLeft: (role) => {
      // Guests were mounted read-only; reload into the normal player.
      if (role === 'guest' || isRoomGuestRoute) window.location.assign(appBasePath());
      else window.history.replaceState(window.history.state, '', appBasePath());
    },
  });
  const inRoom = room.role !== null && room.endedReason === null;
  const isRoomGuest = inRoom && room.role === 'guest';
  const roomRef = useRef(room);
  roomRef.current = room;

  useEffect(() => {
    if (!isRoomGuestRoute || !room.title) return;
    setSharedPlaylistTitle(room.title);
    document.title = room.title;
  }, [isRoomGuestRoute, room.title]);

  const capabilities = useTransport((t) => t.capabilities);
  const playerActions = usePlayerActions(engine, store, {
    isGuest: isRoomGuest,
    inRoom,
    needsUserGesture: room.sync.needsUserGesture,
    unlockAudio: room.unlockAudio,
  }, capabilities.seek);

  const startListeningRoom = useCallback(() => {
    const trackIds = store.getState().queue.tracks.map(t => t.id).filter(isShareableTrackId);
    if (trackIds.length === 0) { notify('Add library tracks to the queue first.', 'info'); return; }
    void roomRef.current.createRoom({ title: 'Listen together', trackIds });
  }, [store, notify]);
  const queueTools = useQueueActions(engine, store, isSharedPlaylist || inRoom ? undefined : startListeningRoom);
  const actions = useMemo<AppActions>(() => ({ ...playerActions, ...queueTools }), [playerActions, queueTools]);

  const roomBadge = useMemo<RoomBadge>(() => ({
    role: inRoom ? room.role : null,
    driftMs: room.sync.driftMs,
    onListenTogether: isSharedPlaylist ? undefined : startListeningRoom,
  }), [inRoom, room.role, room.sync.driftMs, isSharedPlaylist, startListeningRoom]);

  useAppBootstrap({
    engine,
    sharedPlaylistId,
    isRoomGuestRoute,
    notify,
    onPlaylistOpened: (title) => {
      setActiveTab('now-playing');
      if (title) {
        setSharedPlaylistTitle(title);
        document.title = title;
      }
    },
  });

  const queueTracks = useQueue((q) => q.tracks);
  const playlists = usePlaylists({
    library: library.library, queue: queueTracks, addToast: notify, onPlayTracks: actions.playAll,
  });

  useEffect(() => {
    void sharedAudioContextManager.setLatencyMode(latencyMode);
  }, [latencyMode]);

  useEffect(() => {
    void sharedAudioContextManager.setRenderSizeMode(renderSizeMode);
  }, [renderSizeMode]);

  useEffect(() => {
    let cancelled = false;
    void sharedAudioContextManager.setSinkId(outputDevice.id).then((ok) => {
      if (ok || cancelled) return;
      notify(`Output device unavailable — using system default`, 'error');
      void onSelectOutputDevice('');
    });
    return () => { cancelled = true; };
  }, [outputDevice.id, notify, onSelectOutputDevice]);

  const audioOutputInfo = useAudioOutputInfo();
  const outputDevices = useOutputDevices();
  const externalPlayback = useSettings((s) => s.outputMode === 'sdl');
  const audioOutput = useMemo<AudioOutputControls>(() => ({
    deviceId: outputDevice.id,
    deviceLabel: outputDevice.label,
    sinkSupported: isAudioContextSinkSupported(),
    pickerSupported: isOutputPickerSupported(),
    devices: outputDevices,
    onSelectOutputDevice,
    info: audioOutputInfo,
    externalPlayback,
    renderSize: {
      mode: renderSizeMode,
      supported: isRenderSizeHintSupported(),
      onChange: setRenderSizeMode,
    },
  }), [
    outputDevice, outputDevices, onSelectOutputDevice, audioOutputInfo, externalPlayback,
    renderSizeMode, setRenderSizeMode,
  ]);

  useKeyboardShortcuts({
    onPlayPause: actions.togglePlay,
    onSeekForward: actions.seekBy ? () => actions.seekBy?.(10) : undefined,
    onSeekBackward: actions.seekBy ? () => actions.seekBy?.(-10) : undefined,
    onNext: actions.next,
    onPrevious: actions.previous,
    onSearchFocus: () => searchInputRef.current?.focus(),
    onVolumeUp:   () => actions.setVolume(Math.min(1, store.getState().settings.volume + 0.1)),
    onVolumeDown: () => actions.setVolume(Math.max(0, store.getState().settings.volume - 0.1)),
    onToggleQueue: () => setShowQueue(prev => !prev),
    onMute: actions.toggleMute,
    onShowHelp: () => setShowHelp(prev => !prev),
    isEnabled: true,
  });

  const isDraggingFile = useGlobalFileDrop(actions.addFiles);

  const handleGenerationCompleted = async (songId: string) => {
    try {
      const generatedTrack = await fetchSong(songId);
      await library.refresh();
      actions.playNow(generatedTrack);
      setActiveTab('now-playing');
      notify(`Generated track ready: ${generatedTrack.title || generatedTrack.name}`, 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Generated track is not available yet', 'error');
    }
  };

  const roomPanel = (
    <ListeningRoomPanel
      room={room}
      onCopyLink={() => { void room.copyJoinLink(); }}
      onLeave={room.leaveRoom}
      onResync={room.requestResync}
      onStartListening={room.unlockAudio}
      onDismissEnded={room.dismissEnded}
    />
  );

  let view: React.ReactNode;
  if (IS_PROJECTM_EMBED) {
    view = <EmbedPlayerView />;
  } else if (!showHtmlFallback) {
    view = (
      <>
        {roomPanel}
        {!isSharedPlaylist && (
          <div className="fixed top-4 right-4 z-40 flex gap-2">
            {!inRoom && (
              <button onClick={startListeningRoom}
                className="px-4 py-2 rounded-lg bg-emerald-600/90 text-white text-sm font-semibold hover:bg-emerald-500 transition-colors shadow-lg"
                title="Start a synced listening room with the current queue">
                🎧 Listen together
              </button>
            )}
            <button onClick={() => { setActiveTab('generate'); setShowHtmlFallback(true); }}
              className="px-4 py-2 rounded-lg bg-fuchsia-600/90 text-white text-sm font-semibold hover:bg-fuchsia-500 transition-colors shadow-lg">
              ✨ Generate
            </button>
            <button onClick={() => { void library.triggerLibraryResync(); }} disabled={library.isResyncingLibrary}
              className="px-4 py-2 rounded-lg bg-blue-600/90 text-white text-sm font-semibold hover:bg-blue-500 transition-colors shadow-lg disabled:opacity-60">
              {library.isResyncingLibrary ? '⏳ Rescanning...' : '🔄 Rescan Library'}
            </button>
            <a href="https://storage.noahcohn.com/admin" target="_blank" rel="noopener noreferrer"
              className="px-4 py-2 rounded-lg bg-purple-600/90 text-white text-sm font-semibold hover:bg-purple-500 transition-colors shadow-lg">
              ⬆️ Add Music
            </a>
          </div>
        )}
        {showHelp && <KeyboardHelpModal onClose={() => setShowHelp(false)} />}
        {isSharedPlaylist && sharedPlaylistTitle && (
          <div className="fixed top-0 left-0 right-0 z-40 flex items-center justify-center pt-4 pointer-events-none">
            <h1 className="text-xl md:text-2xl font-bold text-white/90 bg-black/50 backdrop-blur px-6 py-2 rounded-full border border-white/10 pointer-events-auto">
              {sharedPlaylistTitle}
            </h1>
          </div>
        )}
        {isDraggingFile && (
          <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center pointer-events-none">
            <div className="border-4 border-dashed border-purple-400 rounded-2xl p-12 text-center">
              <p className="text-2xl text-purple-300 font-bold">Drop FLAC/WAV files to play</p>
            </div>
          </div>
        )}
        <VisualizerShell
          aesthetic={visualizerAesthetic}
          onAestheticChange={setVisualizerAesthetic}
          onToggleFallback={() => setShowHtmlFallback(true)}
          showFallbackToggle={!isSharedPlaylist}
          canLoadUrl
        />
      </>
    );
  } else {
    view = (
      <AudioCapabilitiesContext.Provider value={capabilities}>
        {roomPanel}
        <PlayerFallbackView
          showHelp={showHelp} setShowHelp={setShowHelp}
          showQueue={showQueue} setShowQueue={setShowQueue}
          library={library}
          playlists={playlists}
          activeTab={activeTab} setActiveTab={setActiveTab}
          libraryViewMode={libraryViewMode} setLibraryViewMode={setLibraryViewMode}
          searchInputRef={searchInputRef}
          audio={audio}
          audioOutput={audioOutput}
          isSharedPlaylist={isSharedPlaylist} sharedPlaylistTitle={sharedPlaylistTitle}
          onSetShowHtmlFallback={setShowHtmlFallback}
          onClearCache={() => { void clearTrackCache().then(() => notify('Offline cache cleared', 'success')); }}
          onGenerationCompleted={handleGenerationCompleted}
          room={roomBadge}
        />
      </AudioCapabilitiesContext.Provider>
    );
  }

  return (
    <PlayerActionsProvider value={actions}>
      <PlayerToasts />
      <MediaSessionBridge playbackRate={playbackRate} />
      {/* Scrubber peaks survive switching views; the embed view never reduces them on the GPU. */}
      {IS_PROJECTM_EMBED ? view : <TrackOverviewProvider>{view}</TrackOverviewProvider>}
    </PlayerActionsProvider>
  );
};
