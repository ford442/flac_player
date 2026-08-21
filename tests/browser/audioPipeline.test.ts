import { describe, expect, it } from 'vitest';
import { AudioContextManager } from '../../src/audio/AudioContextManager';
import { createAudioBackend } from '../../src/audio/createAudioBackend';
import type { ConfigurableAudioBackend } from '../../src/types/audio';
import type { AudioOutputMode } from '../../src/hooks/usePlayerState';

const FIXTURE_DURATION_SECONDS = 1;
const ACTIVITY_TIMEOUT_MS = 1_500;
const fixtureUrl = new URL('/tests/fixtures/test.flac', window.location.origin).href;

interface AnalyserActivity {
  waveformPeak: number;
  frequencyPeakDb: number;
}

async function waitForAnalyserActivity(
  analyser: AnalyserNode,
  timeoutMs = ACTIVITY_TIMEOUT_MS
): Promise<AnalyserActivity> {
  const waveform = new Float32Array(analyser.fftSize);
  const frequency = new Float32Array(analyser.frequencyBinCount);
  const deadline = performance.now() + timeoutMs;
  let latest: AnalyserActivity = {
    waveformPeak: 0,
    frequencyPeakDb: Number.NEGATIVE_INFINITY,
  };

  while (performance.now() < deadline) {
    analyser.getFloatTimeDomainData(waveform);
    analyser.getFloatFrequencyData(frequency);
    latest = {
      waveformPeak: waveform.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0),
      frequencyPeakDb: frequency.reduce((peak, db) => Math.max(peak, db), Number.NEGATIVE_INFINITY),
    };

    if (
      latest.waveformPeak > 0.0001
      && latest.frequencyPeakDb > analyser.minDecibels + 3
    ) {
      return latest;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  }

  throw new Error(
    `Analyser remained silent for ${timeoutMs}ms `
    + `(waveform peak ${latest.waveformPeak}, frequency peak ${latest.frequencyPeakDb} dB)`
  );
}

async function waitForNonSilentPcm(
  readPeak: () => number,
  timeoutMs = ACTIVITY_TIMEOUT_MS
): Promise<number> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const peak = readPeak();
    if (peak > 0.0001) return peak;
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  }
  throw new Error(`PCM callback remained silent for ${timeoutMs}ms`);
}

async function withBackend(
  mode: AudioOutputMode,
  run: (backend: ConfigurableAudioBackend, manager: AudioContextManager) => Promise<void>
): Promise<void> {
  const manager = new AudioContextManager();
  const backend = await createAudioBackend(mode, manager);
  const context = manager.getContext();

  try {
    await backend.initialize();
    await run(backend, manager);
  } finally {
    backend.destroy();
    if (context.state !== 'closed') await context.close();
  }
}

describe('real browser audio pipeline', () => {
  it('decodes FLAC through web-audio and reaches the shared analyser', async () => {
    await withBackend('web-audio', async (backend, manager) => {
      const response = await fetch(fixtureUrl);
      expect(response.ok).toBe(true);
      await backend.loadFromArrayBuffer(await response.arrayBuffer(), 'test.flac');

      expect(backend.getState().duration).toBeCloseTo(FIXTURE_DURATION_SECONDS, 2);
      await manager.resume();
      await backend.play();

      const activity = await waitForAnalyserActivity(backend.getAnalyser()!);
      expect(activity.waveformPeak).toBeGreaterThan(0.0001);
      expect(activity.frequencyPeakDb).toBeGreaterThan(backend.getAnalyser()!.minDecibels + 3);
    });
  });

  it('stream-decodes FLAC through the hifi Worklet path with PCM and analyser output', async () => {
    await withBackend('worklet', async (backend) => {
      const response = await fetch(fixtureUrl);
      expect(response.ok).toBe(true);
      const fixture = await response.arrayBuffer();
      let pcmCallbacks = 0;
      let pcmPeak = 0;

      backend.setPCMCallback?.((buffer) => {
        pcmCallbacks += 1;
        for (const sample of buffer) pcmPeak = Math.max(pcmPeak, Math.abs(sample));
      });
      expect(backend.loadFromURLStreaming).toBeTypeOf('function');
      await backend.loadFromURLStreaming!(fixtureUrl, {
        expectedDuration: FIXTURE_DURATION_SECONDS,
        cachedResponse: new Response(fixture.slice(0), {
          headers: {
            'content-length': String(fixture.byteLength),
            'content-type': 'audio/flac',
          },
        }),
      });

      expect(backend.getPlaybackPath?.()?.strategy).toBe('hifi-stream');
      expect(backend.getState()).toMatchObject({
        isPlaying: true,
        duration: FIXTURE_DURATION_SECONDS,
      });

      const [activity, observedPcmPeak] = await Promise.all([
        waitForAnalyserActivity(backend.getAnalyser()!),
        waitForNonSilentPcm(() => pcmPeak),
      ]);
      expect(pcmCallbacks).toBeGreaterThan(0);
      expect(observedPcmPeak).toBeGreaterThan(0.0001);
      expect(activity.waveformPeak).toBeGreaterThan(0.0001);
    });
  });

  it('routes the streaming facade buffered Worklet path into the shared analyser', async () => {
    await withBackend('streaming', async (backend, manager) => {
      expect(backend.loadFromURL).toBeTypeOf('function');
      await backend.loadFromURL!(fixtureUrl, { expectedDuration: FIXTURE_DURATION_SECONDS });

      expect(backend.getPlaybackPath?.()?.strategy).toBe('buffered');
      expect(backend.getState().duration).toBeCloseTo(FIXTURE_DURATION_SECONDS, 2);
      await manager.resume();
      await backend.play();

      const activity = await waitForAnalyserActivity(backend.getAnalyser()!);
      expect(activity.waveformPeak).toBeGreaterThan(0.0001);
    });
  });
});
