/**
 * <FlacMiniPlayer> — compact, embeddable player (docs/EMBED.md).
 *
 * Deliberately independent of PlaybackEngine / the zustand store / the catalog: one native
 * <audio> element streams the file (range requests, so remote files start fast; FLAC, WAV
 * and MP3 all decode natively in current browsers). No Dexie, projectM, ffmpeg or WebGPU
 * code is reachable from this module, which keeps the embed bundle small.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { attachEqGraph, type MiniEqGraph } from './eqPresets';
import { ensureMiniPlayerStyles } from './styles';
import type { FlacMiniPlayerProps, MiniPlayerHandle, MiniPlayerState, MiniTrack } from './types';

const TIME_EVENT_INTERVAL_MS = 250;

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function trackLabel(t: MiniTrack): string {
  if (t.title) return t.title;
  try {
    const last = new URL(t.url, 'http://x/').pathname.split('/').pop() ?? t.url;
    return decodeURIComponent(last) || t.url;
  } catch {
    return t.url;
  }
}

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d={d} /></svg>
);
const ICON_PLAY = 'M8 5v14l11-7z';
const ICON_PAUSE = 'M6 5h4v14H6zm8 0h4v14h-4z';
const ICON_PREV = 'M6 6h2v12H6zm3.5 6L18 18V6z';
const ICON_NEXT = 'M16 6h2v12h-2zM6 18l8.5-6L6 6z';

export const FlacMiniPlayer = forwardRef<MiniPlayerHandle, FlacMiniPlayerProps>(function FlacMiniPlayer(props, ref) {
  const {
    tracks: tracksProp,
    track: singleTrack,
    initialIndex = 0,
    index: controlledIndex,
    autoPlay = false,
    loop = false,
    layout = 'bar',
    showNavigation,
    showVolume = true,
    initialVolume = 1,
    eq = 'flat',
    preload = 'metadata',
    theme = 'auto',
    className,
    label = 'Audio player',
  } = props;

  const tracks = useMemo<MiniTrack[]>(
    () => (singleTrack ? [singleTrack] : tracksProp ?? []),
    [singleTrack, tracksProp],
  );
  const clamp = useCallback((i: number) => Math.min(Math.max(0, i), Math.max(0, tracks.length - 1)), [tracks.length]);

  const [ownIndex, setOwnIndex] = useState(() => clamp(initialIndex));
  const index = clamp(controlledIndex ?? ownIndex);
  const current: MiniTrack | null = tracks[index] ?? null;

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(current?.duration ?? 0);
  const [volume, setVolumeState] = useState(Math.min(1, Math.max(0, initialVolume)));
  const [error, setError] = useState<string | null>(null);
  const [scrubbing, setScrubbing] = useState<number | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const eqRef = useRef<MiniEqGraph | null>(null);
  /** Play as soon as the next source is ready (track change while playing, autoPlay, ended → advance). */
  const playOnLoadRef = useRef(autoPlay);
  const lastTimeEventRef = useRef(0);

  // Latest props/state for event handlers without re-binding listeners.
  const live = useRef({ props, tracks, index, current });
  live.current = { props, tracks, index, current };

  useLayoutEffect(() => { ensureMiniPlayerStyles(); }, []);

  const ensureEq = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || eq === 'flat' || eqRef.current) return;
    try {
      eqRef.current = attachEqGraph(audio, eq);
    } catch {
      eqRef.current = null; // plain element playback still works
    }
  }, [eq]);

  useEffect(() => { eqRef.current?.setPreset(eq); }, [eq]);
  useEffect(() => () => { eqRef.current?.close(); eqRef.current = null; }, []);

  const goTo = useCallback((next: number, opts: { play?: boolean } = {}) => {
    const { tracks: list, index: cur, props: p } = live.current;
    if (list.length === 0) return;
    const target = Math.min(Math.max(0, next), list.length - 1);
    if (opts.play !== undefined) playOnLoadRef.current = opts.play;
    else playOnLoadRef.current = !(audioRef.current?.paused ?? true);
    if (target === cur) {
      const audio = audioRef.current;
      if (audio) audio.currentTime = 0;
      if (playOnLoadRef.current) void audio?.play().catch(() => {});
      return;
    }
    if (p.index === undefined) setOwnIndex(target);
    const t = list[target];
    if (t) p.onTrackChange?.(t, target);
  }, []);

  const play = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !live.current.current) return;
    ensureEq();
    eqRef.current?.resume();
    try {
      await audio.play();
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') {
        setError('Playback was blocked or failed');
      }
    }
  }, [ensureEq]);

  const pause = useCallback(() => { audioRef.current?.pause(); }, []);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(seconds)) return;
    const max = Number.isFinite(audio.duration) ? audio.duration : Infinity;
    audio.currentTime = Math.min(Math.max(0, seconds), max);
    setCurrentTime(audio.currentTime);
  }, []);

  const setVolume = useCallback((v: number) => {
    const clamped = Math.min(1, Math.max(0, v));
    setVolumeState(clamped);
    if (audioRef.current) audioRef.current.volume = clamped;
  }, []);

  const next = useCallback(() => {
    const { tracks: list, index: cur, props: p } = live.current;
    if (cur + 1 < list.length) goTo(cur + 1);
    else if (p.loop) goTo(0);
  }, [goTo]);

  const previous = useCallback(() => {
    const audio = audioRef.current;
    // Standard behaviour: restart the track unless we're at its very start.
    if (audio && audio.currentTime > 3) { seek(0); return; }
    const { tracks: list, index: cur, props: p } = live.current;
    if (cur > 0) goTo(cur - 1);
    else if (p.loop && list.length > 1) goTo(list.length - 1);
    else seek(0);
  }, [goTo, seek]);

  const getState = useCallback((): MiniPlayerState => {
    const audio = audioRef.current;
    return {
      index: live.current.index,
      track: live.current.current,
      playing: !!audio && !audio.paused,
      currentTime: audio?.currentTime ?? 0,
      duration: audio && Number.isFinite(audio.duration) ? audio.duration : live.current.current?.duration ?? 0,
      volume: audio?.volume ?? 1,
    };
  }, []);

  useImperativeHandle(ref, () => ({
    play,
    pause,
    toggle: () => (audioRef.current && !audioRef.current.paused ? (pause(), Promise.resolve()) : play()),
    seek,
    next,
    previous,
    select: (i: number) => goTo(i),
    setVolume,
    getState,
  }), [play, pause, seek, next, previous, goTo, setVolume, getState]);

  // New source → reset readouts; resume if we were playing.
  const src = current?.url ?? '';
  useEffect(() => {
    setCurrentTime(0);
    setDuration(live.current.current?.duration ?? 0);
    setError(null);
    const audio = audioRef.current;
    if (audio) audio.volume = volume;
    if (src && playOnLoadRef.current) void play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // <audio> → state + host events.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const cb = () => live.current;
    const onPlay = () => {
      setPlaying(true);
      const { current: t, index: i, props: p } = cb();
      if (t) p.onPlay?.(t, i);
    };
    const onPause = () => {
      setPlaying(false);
      const { current: t, index: i, props: p } = cb();
      if (t && !audio.ended) p.onPause?.(t, i);
    };
    const onTime = () => {
      setCurrentTime(audio.currentTime);
      const now = performance.now();
      if (now - lastTimeEventRef.current >= TIME_EVENT_INTERVAL_MS) {
        lastTimeEventRef.current = now;
        cb().props.onTimeUpdate?.(audio.currentTime, Number.isFinite(audio.duration) ? audio.duration : 0);
      }
    };
    const onSeeked = () => {
      lastTimeEventRef.current = performance.now();
      cb().props.onTimeUpdate?.(audio.currentTime, Number.isFinite(audio.duration) ? audio.duration : 0);
    };
    const onMeta = () => { if (Number.isFinite(audio.duration)) setDuration(audio.duration); };
    const onEnded = () => {
      setPlaying(false);
      const { current: t, index: i, tracks: list, props: p } = cb();
      if (t) p.onEnded?.(t, i);
      if (i + 1 < list.length) goTo(i + 1, { play: true });
      else if (p.loop && list.length > 0) goTo(0, { play: true });
      else p.onQueueEnded?.();
    };
    const onError = () => {
      setPlaying(false);
      const { current: t, index: i, props: p } = cb();
      if (!t) return;
      const code = audio.error?.code;
      const message = code === 4 ? 'Format not supported or file not found' : 'Could not load audio';
      setError(message);
      p.onError?.(new Error(`${message}: ${t.url}`), t, i);
    };
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('seeked', onSeeked);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('durationchange', onMeta);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('seeked', onSeeked);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('durationchange', onMeta);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
  }, [goTo]);

  const hasMany = tracks.length > 1;
  const nav = showNavigation ?? hasMany;
  const shownTime = scrubbing ?? currentTime;
  const seekMax = duration > 0 ? duration : 0;
  const title = current ? trackLabel(current) : 'No track';
  const canPrev = !!current && (index > 0 || loop || currentTime > 3);
  const canNext = !!current && (index + 1 < tracks.length || (loop && hasMany));

  const commitScrub = () => {
    if (scrubbing !== null) seek(scrubbing);
    setScrubbing(null);
  };

  const classes = ['fmp', `fmp--${layout}`, className].filter(Boolean).join(' ');

  return (
    <section className={classes} aria-label={label} data-playing={playing ? 'true' : 'false'}
      data-theme={theme === 'auto' ? undefined : theme}
    >
      {/* Music playback with its own visible controls; there is no caption track to offer. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        src={src || undefined}
        preload={preload}
        // CORS is only required once Web Audio taps the element (non-flat EQ).
        crossOrigin={eq === 'flat' ? undefined : 'anonymous'}
      />
      {layout === 'card' && (
        current?.artwork
          ? <img className="fmp-art" src={current.artwork} alt="" />
          : <div className="fmp-art" aria-hidden="true" />
      )}
      {layout === 'card' && <TrackInfo title={title} artist={current?.artist} />}
      <div className="fmp-controls">
        {nav && (
          <button type="button" className="fmp-btn" onClick={previous} disabled={!canPrev} aria-label="Previous track">
            <Icon d={ICON_PREV} />
          </button>
        )}
        <button
          type="button"
          className="fmp-btn fmp-play"
          onClick={() => (playing ? pause() : void play())}
          disabled={!current}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          <Icon d={playing ? ICON_PAUSE : ICON_PLAY} />
        </button>
        {nav && (
          <button type="button" className="fmp-btn" onClick={next} disabled={!canNext} aria-label="Next track">
            <Icon d={ICON_NEXT} />
          </button>
        )}
        <div className="fmp-main">
          {layout === 'bar' && <TrackInfo title={title} artist={current?.artist} />}
          <div className="fmp-seekrow">
            <span className="fmp-time" aria-hidden="true">{formatTime(shownTime)}</span>
            <input
              type="range"
              className="fmp-range"
              min={0}
              max={seekMax}
              step={0.1}
              value={Math.min(shownTime, seekMax)}
              disabled={!current || seekMax === 0}
              aria-label="Seek"
              aria-valuetext={`${formatTime(shownTime)} of ${formatTime(duration)}`}
              onChange={(e) => {
                const v = Number(e.currentTarget.value);
                // Pointer drags preview; keyboard steps (no pointer down) seek at once.
                if (scrubbing !== null) setScrubbing(v);
                else seek(v);
              }}
              onPointerDown={(e) => setScrubbing(Number(e.currentTarget.value))}
              onPointerUp={commitScrub}
              onPointerCancel={() => setScrubbing(null)}
              onBlur={commitScrub}
            />
            <span className="fmp-time" aria-hidden="true">{formatTime(duration)}</span>
          </div>
          {error && <span className="fmp-error" role="status">{error}</span>}
        </div>
        {showVolume && (
          <div className="fmp-volume">
            <input
              type="range"
              className="fmp-range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              aria-label="Volume"
              aria-valuetext={`${Math.round(volume * 100)}%`}
              onChange={(e) => setVolume(Number(e.currentTarget.value))}
            />
          </div>
        )}
      </div>
    </section>
  );
});

function TrackInfo({ title, artist }: { title: string; artist?: string }) {
  return (
    <div className="fmp-meta">
      <span className="fmp-title" title={title}>{title}</span>
      {artist && <span className="fmp-artist" title={artist}>{artist}</span>}
    </div>
  );
}
