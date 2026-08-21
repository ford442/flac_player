import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { parseBuffer } from 'music-metadata';
import { AudioContextManager } from '../src/audio/AudioContextManager';
import { createAudioBackend } from '../src/audio/createAudioBackend';
import { applyReplayGainToPlayer } from '../src/hooks/useReplayGainApplication';
import {
  applyPeakLimiting,
  clampReplayGainDb,
  computeReplayGainLinear,
  dbToLinear,
  parseReplayGainFromCommon,
  replayGainTagsToTrackFields,
  resolveAlbumReferenceDb,
  resolveReplayGainDb,
} from '../src/utils/replayGain';
import type { PlaylistTrack } from '../src/types/library';
import {
  RecordingAudioContext,
  installRecordingAudioContext,
} from './helpers/recordingAudioContext';

const loudTrack: PlaylistTrack = {
  id: 'loud',
  name: 'loud.flac',
  url: 'https://example.com/loud.flac',
  replaygain_track_db: -6.5,
  replaygain_track_peak: 0.98,
};

const quietTrack: PlaylistTrack = {
  id: 'quiet',
  name: 'quiet.flac',
  url: 'https://example.com/quiet.flac',
  replaygain_track_db: 4.2,
  replaygain_track_peak: 0.4,
};

describe('replayGain utils', () => {
  it('converts dB to linear gain', () => {
    expect(dbToLinear(0)).toBeCloseTo(1, 5);
    expect(dbToLinear(-6)).toBeCloseTo(0.501, 2);
    expect(dbToLinear(6)).toBeCloseTo(1.995, 2);
  });

  it('clamps gain to ±12 dB', () => {
    expect(clampReplayGainDb(20)).toBe(12);
    expect(clampReplayGainDb(-20)).toBe(-12);
    expect(clampReplayGainDb(3)).toBe(3);
  });

  it('parses music-metadata ReplayGain tags', () => {
    const tags = parseReplayGainFromCommon({
      replaygain_track_gain: { ratio: 0.5, dB: -6 },
      replaygain_album_gain: { ratio: 0.6, dB: -4.4 },
      replaygain_track_peak: { ratio: 0.95 },
    });
    expect(tags.trackDb).toBe(-6);
    expect(tags.albumDb).toBe(-4.4);
    expect(tags.trackPeak).toBe(0.95);
  });

  it('resolves track mode gain', () => {
    expect(resolveReplayGainDb(loudTrack, { mode: 'track', limiterEnabled: true })).toBe(-6.5);
    expect(resolveReplayGainDb(loudTrack, { mode: 'off', limiterEnabled: true })).toBe(0);
  });

  it('uses first queued track album gain in album mode', () => {
    const queue: PlaylistTrack[] = [
      { ...loudTrack, replaygain_album_db: -3.0 },
      quietTrack,
    ];
    expect(resolveAlbumReferenceDb(queue)).toBe(-3.0);
    expect(resolveReplayGainDb(quietTrack, { mode: 'album', limiterEnabled: false }, -3.0)).toBe(-3.0);
  });

  it('matches perceived loudness between tagged tracks in track mode', () => {
    const loudLinear = computeReplayGainLinear(loudTrack, { mode: 'track', limiterEnabled: false });
    const quietLinear = computeReplayGainLinear(quietTrack, { mode: 'track', limiterEnabled: false });
    // Loud track is attenuated; quiet track is boosted — relative difference ≈ 10.7 dB
    const relativeDb = 20 * Math.log10(quietLinear / loudLinear);
    expect(relativeDb).toBeCloseTo(10.7, 0);
  });

  it('limits positive gain using peak metadata when limiter is enabled', () => {
    const hotTrack: PlaylistTrack = {
      ...quietTrack,
      replaygain_track_peak: 0.9,
    };
    const limited = applyPeakLimiting(4.2, hotTrack, 'track', true);
    expect(limited).toBeLessThan(4.2);
    expect(limited).toBeGreaterThan(0);
  });

  it('does not limit when limiter is disabled', () => {
    expect(applyPeakLimiting(4.2, quietTrack, 'track', false)).toBe(4.2);
  });

  it('applies tagged fixture gain and limiter settings to the real audio graph', async () => {
    const restoreAudioContext = installRecordingAudioContext();
    let player: Awaited<ReturnType<typeof createAudioBackend>> | undefined;

    try {
      const fixturePath = path.join(process.cwd(), 'tests/fixtures/replaygain-loud.flac');
      const fixture = fs.readFileSync(fixturePath);
      const metadata = await parseBuffer(new Uint8Array(fixture), {
        mimeType: 'audio/flac',
        path: fixturePath,
      });
      const tags = parseReplayGainFromCommon(metadata.common);
      const track: PlaylistTrack = {
        id: 'replaygain-fixture',
        name: 'replaygain-loud.flac',
        url: 'https://example.com/replaygain-loud.flac',
        ...replayGainTagsToTrackFields(tags),
      };
      const contextManager = new AudioContextManager();
      player = await createAudioBackend('web-audio', contextManager);

      applyReplayGainToPlayer({
        player,
        track,
        queue: [track],
        settings: { mode: 'track', limiterEnabled: true },
      });

      const context = RecordingAudioContext.instances[0];
      const replayGainNode = context.gainNodes[0];
      const limiter = context.compressorNodes[0];
      const expectedLinear = dbToLinear(-6.5);

      expect(tags.trackDb).toBeCloseTo(-6.5, 1);
      expect(contextManager.getReplayGainLinear()).toBeCloseTo(expectedLinear, 6);
      expect(replayGainNode.gain.value).toBeCloseTo(expectedLinear, 6);
      expect(limiter.threshold.value).toBe(-1);
      expect(limiter.knee.value).toBe(0);
      expect(limiter.ratio.value).toBe(20);
      expect(limiter.attack.value).toBeCloseTo(0.003, 6);
      expect(limiter.release.value).toBeCloseTo(0.1, 6);
    } finally {
      player?.destroy();
      restoreAudioContext();
    }
  });
});
