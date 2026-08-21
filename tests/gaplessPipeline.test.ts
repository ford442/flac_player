import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeAudioWithBuffer } from '../src/audioDecoder';
import { AudioContextManager } from '../src/audio/AudioContextManager';
import { WebAudioPlayer } from '../src/audio/backends/WebAudioPlayer';
import type { TrackTransitionEvent } from '../src/types/gapless';
import {
  RecordingAudioBuffer,
  RecordingAudioContext,
  installRecordingAudioContext,
} from './helpers/recordingAudioContext';

vi.mock('../src/audioDecoder', () => ({
  decodeAudioWithBuffer: vi.fn(),
}));

const mockedDecodeAudioWithBuffer = vi.mocked(decodeAudioWithBuffer);

function decodedResult(audioBuffer: AudioBuffer) {
  return {
    decoderResult: {
      channels: audioBuffer.numberOfChannels,
      sampleRate: audioBuffer.sampleRate,
      duration: audioBuffer.duration,
      interleavedBuffer: new Float32Array(audioBuffer.length * audioBuffer.numberOfChannels),
    },
    audioBuffer,
  };
}

describe('WebAudioPlayer gapless scheduling', () => {
  let restoreAudioContext: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    restoreAudioContext = installRecordingAudioContext();
    mockedDecodeAudioWithBuffer.mockReset();
  });

  afterEach(() => {
    restoreAudioContext?.();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('schedules and hands off two decoded buffers exactly once', async () => {
    const contextManager = new AudioContextManager();
    const player = new WebAudioPlayer(contextManager);
    const context = RecordingAudioContext.instances[0];
    const currentBuffer = new RecordingAudioBuffer(2, 44_100, 44_100) as unknown as AudioBuffer;
    const nextBuffer = new RecordingAudioBuffer(2, 22_050, 44_100) as unknown as AudioBuffer;
    const transitions: Array<TrackTransitionEvent | undefined> = [];

    mockedDecodeAudioWithBuffer
      .mockResolvedValueOnce(decodedResult(currentBuffer))
      .mockResolvedValueOnce(decodedResult(nextBuffer));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([2, 3, 4]))));

    try {
      player.setGaplessSettings({ mode: 'gapless', crossfadeMs: 0 });
      player.setOnEndedCallback((event) => transitions.push(event));
      await player.loadFromArrayBuffer(new Uint8Array([1]).buffer, 'current.flac');

      player.preloadNext('https://fixtures.example/next.flac');
      await vi.waitFor(() => {
        expect(mockedDecodeAudioWithBuffer).toHaveBeenCalledTimes(2);
      });

      player.play();

      expect(context.bufferSources).toHaveLength(2);
      expect(context.bufferSources[0].startCalls).toEqual([{ when: 0, offset: 0 }]);
      expect(context.bufferSources[1].startCalls).toHaveLength(1);
      expect(context.bufferSources[1].startCalls[0].when).toBeCloseTo(0.95, 6);
      expect(transitions).toEqual([]);

      context.setCurrentTime(0.95);
      await vi.advanceTimersByTimeAsync(950);

      expect(context.bufferSources).toHaveLength(2);
      expect(context.bufferSources.every((source) => source.startCalls.length === 1)).toBe(true);
      expect(context.bufferSources[0].stopCalls).toBe(1);
      expect(context.bufferSources[0].disconnectCalls).toBe(1);
      expect(transitions).toEqual([{ alreadyPlayingNext: true }]);
      expect(transitions.filter((event) => event === undefined)).toHaveLength(0);
      expect(player.getState()).toMatchObject({ isPlaying: true, duration: 0.5 });
    } finally {
      player.setOnEndedCallback(undefined);
      player.destroy();
    }
  });
});
