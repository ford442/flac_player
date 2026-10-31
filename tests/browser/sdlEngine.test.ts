// The `sdl` output end to end in Chromium: the real engine module
// (public/sdl-audio.*) played by the `sdl-engine` worklet into the shared
// graph. Unit coverage of the processor is tests/sdlEngineProcessor.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { AudioContextManager } from '../../src/audio/AudioContextManager';
import { getAnalysisTap } from '../../src/audio/analysisRing';
import { createAudioBackend } from '../../src/audio/createAudioBackend';
import type { ConfigurableAudioBackend } from '../../src/types/audio';

const levelsUrl = new URL('/tests/fixtures/channel-levels-6ch.flac', window.location.origin).href;
const CHANNELS = 6;

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs = 8000, what = 'condition'): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (performance.now() > deadline) throw new Error(`waitFor timed out: ${what}`);
    await sleep(20);
  }
}

function engineNode(backend: ConfigurableAudioBackend): AudioWorkletNode | null {
  return (backend as unknown as { node: AudioWorkletNode | null }).node;
}

let manager: AudioContextManager | null = null;
let backend: ConfigurableAudioBackend | null = null;

async function loadLevels(): Promise<{ backend: ConfigurableAudioBackend; manager: AudioContextManager }> {
  manager = new AudioContextManager();
  backend = await createAudioBackend('sdl', manager);
  await backend.initialize();
  const bytes = await (await fetch(levelsUrl)).arrayBuffer();
  await backend.loadFromArrayBuffer(bytes, 'channel-levels-6ch.flac');
  return { backend, manager };
}

afterEach(async () => {
  backend?.destroy();
  backend = null;
  if (manager?.hasContext()) {
    const context = manager.getContext();
    if (context.state !== 'closed') await context.close();
  }
  manager = null;
});

describe('sdl engine (worklet on the shared graph)', () => {
  it('reports playable here (AudioWorklet + cross-origin isolation)', async () => {
    expect(crossOriginIsolated).toBe(true);
    const { backend } = await loadLevels();
    expect(backend.getCapabilities()).toMatchObject({ playable: true, seek: true, playbackRate: true });
  });

  it('plays 5.1 with every channel in place', async () => {
    const { backend, manager } = await loadLevels();
    const ctx = manager.getContext();
    const node = engineNode(backend)!;
    const splitter = ctx.createChannelSplitter(CHANNELS);
    node.connect(splitter);
    const analysers = Array.from({ length: CHANNELS }, (_, c) => {
      const a = ctx.createAnalyser();
      a.fftSize = 256;
      splitter.connect(a, c);
      return a;
    });
    backend.play();

    const buf = new Float32Array(256);
    const levels = await waitFor(() => {
      const got = analysers.map((a) => {
        a.getFloatTimeDomainData(buf);
        return buf[buf.length - 1];
      });
      return got.every((v) => v !== 0) ? got : null;
    }, 8000, 'all six channels sounding');
    // Channel c of the file holds int16 (c + 1) × 4096, about (c + 1) / 8 (the
    // decoder scales by 1/32767); the levels are 0.125 apart, so a moved channel shows.
    levels.forEach((v, c) => expect(v, `channel ${c}`).toBeCloseTo((c + 1) / 8, 3));
  });

  it('plays on from the same position through a graph recreate', async () => {
    const { backend, manager } = await loadLevels();
    backend.play();
    await waitFor(() => backend.getCurrentTime() > 0.5, 8000, 'clock past 0.5 s');
    const before = engineNode(backend);
    const t0 = backend.getCurrentTime();

    const ctx0 = manager.getContext();
    const hint = manager.getOutputInfo()!.latencyHint;
    await manager.setLatencyMode(hint === 'interactive' ? 'playback' : 'interactive');
    expect(manager.getContext()).not.toBe(ctx0);

    // The engine carried its position into a new epoch and a new node.
    const after = await waitFor(() => engineNode(backend) !== before && engineNode(backend), 4000, 'new node');
    expect(after.context).toBe(manager.getContext());
    expect(backend.getCurrentTime()).toBeGreaterThanOrEqual(t0);
    await waitFor(() => backend.getCurrentTime() > t0 + 0.3, 8000, 'clock advancing after recreate');
    expect(backend.getState().isPlaying).toBe(true);

    // And the new graph's dsp-chain hears it (front-left (1/8) through unity DSP).
    const heard = await waitFor(() => {
      const snapshot = getAnalysisTap()?.reader.readLatest(256);
      return snapshot && snapshot.pcm.some((v) => v !== 0) ? snapshot : null;
    }, 4000, 'analysis tap after recreate');
    expect(heard.sampleRate).toBe(manager.getContext().sampleRate);
  });

  it('ends once the processor has read the last frame, and play() restarts from the top', async () => {
    const { backend } = await loadLevels();
    let ended = 0;
    backend.setOnEndedCallback(() => { ended += 1; });
    backend.seek(3.7);
    backend.play();
    await waitFor(() => ended > 0, 4000, 'ended');
    expect(backend.getState().isPlaying).toBe(false);
    expect(backend.getCurrentTime()).toBeCloseTo(4, 2);

    backend.play();
    expect(backend.getCurrentTime()).toBeLessThan(0.1);
    await waitFor(() => backend.getCurrentTime() > 0.2, 4000, 'restart from 0');
    expect(ended).toBe(1);
  });
});
