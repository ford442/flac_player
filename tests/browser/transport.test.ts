import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioContextManager } from '../../src/audio/AudioContextManager';
import { PlaybackEngine } from '../../src/audio/PlaybackEngine';
import type { ConfigurableAudioBackend } from '../../src/types/audio';
import type { WorkletAudioPlayer } from '../../src/audio/backends/worklet/WorkletAudioPlayer';

const fixture = (name: string) => new URL(`/tests/fixtures/${name}`, window.location.origin).href;
const FLAC_URL = fixture('test.flac'); // small FLAC → buffered worklet path
const WAV_URL = fixture('test.wav'); // native <audio>
const MP3_URL = fixture('test.mp3'); // native <audio>
const LONG_FLAC_URL = fixture('tone-5s.flac');

/** Streaming mode never calls the loader (the facade probes and fetches itself). */
const unusedLoader = {
  probeAudioUrl: () => Promise.reject(new Error('unused in streaming mode')),
  loadFromURL: () => Promise.reject(new Error('unused in streaming mode')),
};

/** StreamingAudioPlayer internals the assertions look at. */
interface StreamingInternals extends ConfigurableAudioBackend {
  audioElement: HTMLAudioElement;
  workletPlayer: WorkletAudioPlayer;
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000, label = 'condition'): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  }
}

async function waitForAnalyserActivity(analyser: AnalyserNode, timeoutMs = 2_000): Promise<void> {
  const waveform = new Float32Array(analyser.fftSize);
  await waitFor(() => {
    analyser.getFloatTimeDomainData(waveform);
    return waveform.some((sample) => Math.abs(sample) > 0.0001);
  }, timeoutMs, 'analyser activity');
}

describe('PlaybackEngine transport (streaming backend)', () => {
  let manager: AudioContextManager;
  let engine: PlaybackEngine;
  let backend: StreamingInternals;

  beforeEach(async () => {
    manager = new AudioContextManager();
    engine = new PlaybackEngine({ loader: unusedLoader, contextManager: manager, attachBackend: () => () => {} });
    backend = (await engine.setOutputMode('streaming')) as StreamingInternals;
    expect(backend).not.toBeNull();
    // Gapless off: these tests are about one track at a time.
    engine.setGaplessSettings({ mode: 'off', crossfadeMs: 0 });
  });

  afterEach(async () => {
    engine.destroy();
    vi.restoreAllMocks();
    if (manager.hasContext()) {
      const context = manager.getContext();
      if (context.state !== 'closed') await context.close();
    }
  });

  it('FLAC → WAV stops the worklet; WAV → FLAC stops the <audio> element', async () => {
    expect(await engine.load({ url: FLAC_URL })).toBe('loaded');
    expect(backend.getPlaybackPath?.()?.strategy).toBe('buffered');
    const worklet = backend.workletPlayer;
    expect(worklet.getState().isPlaying).toBe(true);

    const workletStop = vi.spyOn(worklet, 'stop');
    expect(await engine.load({ url: WAV_URL })).toBe('loaded');
    expect(backend.getPlaybackPath?.()?.strategy).toBe('native-stream');
    expect(workletStop).toHaveBeenCalled();
    expect(worklet.getState().isPlaying).toBe(false);
    const element = backend.audioElement;
    expect(element.paused && !element.ended).toBe(false);

    const elementPause = vi.spyOn(element, 'pause');
    expect(await engine.load({ url: FLAC_URL })).toBe('loaded');
    expect(backend.getPlaybackPath?.()?.strategy).toBe('buffered');
    expect(elementPause).toHaveBeenCalled();
    expect(element.paused).toBe(true);
    expect(element.getAttribute('src')).toBeNull();
    expect(worklet.getState().isPlaying).toBe(true);
    expect(engine.getStatus().isPlaying).toBe(true);
  });

  it('the facade itself halts the path it leaves (no engine stop())', async () => {
    const worklet = backend.workletPlayer;
    await backend.loadFromURL!(FLAC_URL);
    await backend.play();
    expect(worklet.getState().isPlaying).toBe(true);

    const workletStop = vi.spyOn(worklet, 'stop');
    await backend.loadFromURL!(MP3_URL);
    await backend.play();
    expect(workletStop).toHaveBeenCalled();
    expect(worklet.getState().isPlaying).toBe(false);

    const element = backend.audioElement;
    await backend.loadFromURL!(FLAC_URL);
    expect(element.paused).toBe(true);
    expect(element.getAttribute('src')).toBeNull();
  });

  it('an overlapping load supersedes the first; only the newer path plays', async () => {
    const worklet = backend.workletPlayer;
    const first = engine.load({ url: FLAC_URL });
    const second = engine.load({ url: MP3_URL });

    expect(await first).toBe('superseded');
    expect(await second).toBe('loaded');
    expect(backend.getPlaybackPath?.()?.strategy).toBe('native-stream');
    expect(worklet.getState().isPlaying).toBe(false);
    expect(backend.audioElement.paused).toBe(false);
  });

  it('play() from several callers during a load starts the track once', async () => {
    const backendPlay = vi.spyOn(backend, 'play');
    const load = engine.load({ url: MP3_URL }, { autoplay: false });
    // Click, Media Session and the room bridge all ask while the load is in flight.
    await Promise.all([engine.play(), engine.play(), engine.play()]);
    expect(await load).toBe('loaded');

    expect(backendPlay).toHaveBeenCalledTimes(1);
    expect(engine.getStatus().isPlaying).toBe(true);
  });

  it('a graph recreate during playback keeps the track and fires `ended` once', async () => {
    engine.setNativeOnly(true);
    let endedCount = 0;
    engine.setOnEnded(() => { endedCount += 1; });

    expect(await engine.load({ url: LONG_FLAC_URL })).toBe('loaded');
    const oldElement = backend.audioElement;
    await waitFor(() => engine.getTime() > 0.3, 3_000, 'playback to advance');
    const positionBefore = oldElement.currentTime;
    const oldPause = vi.spyOn(oldElement, 'pause');

    // Latency-hint change → AudioContextManager.recreateGraph → graph listeners.
    await manager.setLatencyMode('interactive');

    expect(oldPause).toHaveBeenCalled();
    expect(oldElement.getAttribute('src')).toBeNull();
    const newElement = backend.audioElement;
    expect(newElement).not.toBe(oldElement);
    expect(newElement.src).toBe(LONG_FLAC_URL);

    await waitFor(() => !newElement.paused && newElement.currentTime > 0, 3_000, 'replacement element to play');
    expect(newElement.currentTime).toBeGreaterThanOrEqual(positionBefore - 0.05);
    await waitForAnalyserActivity(manager.getAnalyser()!);
    expect(engine.getSyncClock()).not.toBeNull();

    // The retired element's listeners are gone: a late `ended` from it is inert.
    oldElement.dispatchEvent(new Event('ended'));
    expect(endedCount).toBe(0);

    engine.seek(4.7);
    await waitFor(() => endedCount > 0, 3_000, 'track end');
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    expect(endedCount).toBe(1);
  });
});
