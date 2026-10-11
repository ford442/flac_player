import { describe, it, expect } from 'vitest';
import {
  DRIFT_THRESHOLD_MS,
  HARD_SYNC_THRESHOLD_MS,
  MAX_SEEK_LEAD_MS,
  NUDGE_RATE_DELTA,
  computeDriftMs,
  decideCorrection,
  expectedPosition,
  isOutOfSync,
  updateSeekLead,
} from '../src/listening/syncEngine';
import { ServerClock, bestSample, clockSampleFrom } from '../src/listening/clockSync';
import {
  decodeServerMessage,
  encodeClientMessage,
  isStaleRevision,
  parsePlaybackReference,
} from '../src/listening/roomProtocol';
import { deriveWsBaseUrl } from '../src/listening/roomApi';
import {
  clearHostToken,
  appBasePath,
  getRoomIdFromLocation,
  joinUrlFor,
  loadHostToken,
  saveHostToken,
} from '../src/listening/roomSession';
import type { PlaybackReference } from '../src/listening/types';

const ref = (overrides: Partial<PlaybackReference> = {}): PlaybackReference => ({
  trackId: 'a',
  trackIndex: 0,
  position: 10,
  positionUpdatedAt: 1_000_000,
  playing: true,
  rate: 1,
  ...overrides,
});

describe('syncEngine', () => {
  it('extrapolates the host position only while playing', () => {
    expect(expectedPosition(ref(), 1_002_500)).toBeCloseTo(12.5);
    expect(expectedPosition(ref({ rate: 1.5 }), 1_002_000)).toBeCloseTo(13);
    expect(expectedPosition(ref({ playing: false }), 1_009_000)).toBe(10);
    // A reference stamped slightly in our future never runs backwards.
    expect(expectedPosition(ref(), 999_000)).toBe(10);
  });

  it('reports drift in ms, positive when the guest is ahead', () => {
    expect(computeDriftMs(10.3, 10)).toBeCloseTo(300);
    expect(computeDriftMs(9.9, 10)).toBeCloseTo(-100);
  });

  const correction = (driftMs: number, nudging = false) =>
    decideCorrection({ driftMs, expectedPosition: 20, baseRate: 1, nudging, seekLeadMs: 200 });

  it('leaves small drift alone', () => {
    expect(correction(DRIFT_THRESHOLD_MS - 1)).toEqual({ kind: 'none', rate: 1 });
    expect(correction(-120)).toEqual({ kind: 'none', rate: 1 });
  });

  it('nudges playbackRate toward the host between the thresholds', () => {
    expect(correction(300)).toEqual({ kind: 'nudge', rate: 1 - NUDGE_RATE_DELTA });
    expect(correction(-400)).toEqual({ kind: 'nudge', rate: 1 + NUDGE_RATE_DELTA });
  });

  it('keeps nudging until settled (hysteresis)', () => {
    expect(correction(150, true).kind).toBe('nudge');
    expect(correction(40, true)).toEqual({ kind: 'none', rate: 1 });
  });

  it('hard-seeks past the hard threshold, leading by the learned seek latency', () => {
    expect(correction(HARD_SYNC_THRESHOLD_MS + 1)).toEqual({ kind: 'seek', position: 20.2 });
    expect(correction(-3000)).toEqual({ kind: 'seek', position: 20.2 });
    expect(decideCorrection({ driftMs: 900, expectedPosition: 0, baseRate: 1, nudging: false, seekLeadMs: 0 }))
      .toEqual({ kind: 'seek', position: 0 });
  });

  it('learns seek lead from the residual drift after a seek', () => {
    expect(updateSeekLead(150, -300)).toBe(300);
    expect(updateSeekLead(150, 100)).toBe(100);
    expect(updateSeekLead(100, 1000)).toBe(0);
    expect(updateSeekLead(900, -1000)).toBe(MAX_SEEK_LEAD_MS);
  });

  it('flags out-of-sync only past the hard threshold', () => {
    expect(isOutOfSync(null)).toBe(false);
    expect(isOutOfSync(480)).toBe(false);
    expect(isOutOfSync(-650)).toBe(true);
  });
});

describe('clockSync', () => {
  it('estimates the server offset from a round trip', () => {
    // Sent at local 1000, server stamped 6050, received at local 1100 → server is 5000 ms ahead.
    expect(clockSampleFrom(1000, 6050, 1100)).toEqual({ offsetMs: 5000, rttMs: 100 });
    expect(clockSampleFrom(1000, 6050, 900)).toBeNull();
    expect(clockSampleFrom(0, 0, 60_000)).toBeNull();
  });

  it('prefers the lowest-RTT sample', () => {
    expect(bestSample([{ offsetMs: 10, rttMs: 300 }, { offsetMs: 40, rttMs: 20 }])?.offsetMs).toBe(40);
  });

  it('maps local time to server time', () => {
    let now = 1000;
    const clock = new ServerClock(() => now);
    clock.seedFromServerTime(1500);
    expect(clock.serverNow()).toBe(1500);
    clock.addSample({ offsetMs: 400, rttMs: 300 });
    clock.addSample({ offsetMs: 450, rttMs: 30 });
    clock.seedFromServerTime(99_999); // ignored once real samples exist
    now = 2000;
    expect(clock.serverNow()).toBe(2450);
  });
});

describe('roomProtocol', () => {
  it('encodes client messages', () => {
    expect(JSON.parse(encodeClientMessage('TIME_SYNC', { t0: 5 }))).toEqual({ type: 'TIME_SYNC', payload: { t0: 5 } });
  });

  it('decodes playback messages into full references', () => {
    const message = decodeServerMessage(JSON.stringify({
      type: 'PLAY', roomId: 'r', serverTime: 10, revision: 3,
      payload: { trackId: 'a', trackIndex: 1, position: 4, positionUpdatedAt: 9, playing: true, rate: 1 },
    }));
    expect(message?.type).toBe('PLAY');
    expect(message?.revision).toBe(3);
    expect(message?.payload).toEqual({
      trackId: 'a', trackIndex: 1, position: 4, positionUpdatedAt: 9, playing: true, rate: 1,
    });
  });

  it('decodes snapshots and queue updates', () => {
    const snapshot = decodeServerMessage(JSON.stringify({
      type: 'STATE_SNAPSHOT', roomId: 'r', serverTime: 10,
      payload: {
        roomId: 'r', title: 'Mix', hostConnected: true, trackId: null, trackIndex: -1,
        position: 0, positionUpdatedAt: 1, playing: false, rate: 1, revision: 7,
        queue: { trackIds: ['a', 2, 'b'], currentIndex: 0, shuffle: false, repeat: 'bogus' },
      },
    }));
    expect(snapshot?.type).toBe('STATE_SNAPSHOT');
    expect(snapshot?.revision).toBe(7);
    if (snapshot?.type !== 'STATE_SNAPSHOT') throw new Error('expected snapshot');
    expect(snapshot.payload.queue).toEqual({ trackIds: ['a', 'b'], currentIndex: 0, shuffle: false, repeat: 'off' });
  });

  it('rejects malformed frames', () => {
    expect(decodeServerMessage('not json')).toBeNull();
    expect(decodeServerMessage(JSON.stringify({ type: 'PLAY', serverTime: 1, payload: { position: 'x' } }))).toBeNull();
    expect(decodeServerMessage(JSON.stringify({ type: 'PLAY', payload: {} }))).toBeNull();
    expect(decodeServerMessage(JSON.stringify({ type: 'NOPE', serverTime: 1, payload: {} }))).toBeNull();
    expect(parsePlaybackReference({ position: 1 })).toBeNull();
  });

  it('clamps out-of-range reference fields', () => {
    expect(parsePlaybackReference({ position: -3, positionUpdatedAt: 1, rate: 50, trackId: '' })).toMatchObject({
      position: 0, rate: 4, trackId: null, playing: false,
    });
  });

  it('detects stale revisions', () => {
    expect(isStaleRevision(4, 5)).toBe(true);
    expect(isStaleRevision(5, 5)).toBe(false);
    expect(isStaleRevision(undefined, 5)).toBe(false);
  });
});

describe('room routing and urls', () => {
  it('reads the room from ?room= or a /room/{id} path', () => {
    expect(getRoomIdFromLocation('?room=xK9mP2nQ-_', '/')).toBe('xK9mP2nQ-_');
    expect(getRoomIdFromLocation('?room=bad!id', '/')).toBeNull();
    expect(getRoomIdFromLocation('', '/room/abcd/')).toBe('abcd');
    expect(getRoomIdFromLocation('', '/app/room/abcd')).toBe('abcd');
    expect(getRoomIdFromLocation('', '/room/')).toBeNull();
    expect(getRoomIdFromLocation('', '/room/a/b')).toBeNull();
    expect(getRoomIdFromLocation('?share=abcd', '/playlist/abcd')).toBeNull();
  });

  it('builds join links from the app origin and base path', () => {
    expect(joinUrlFor('abcd', 'https://player.example', '/')).toBe('https://player.example/?room=abcd');
    expect(joinUrlFor('abcd', 'https://player.example', '/room/old1')).toBe('https://player.example/?room=abcd');
    expect(joinUrlFor('abcd', 'https://x.example', '/flac-player/')).toBe('https://x.example/flac-player/?room=abcd');
    expect(appBasePath('/flac-player/playlist/abc')).toBe('/flac-player/');
  });

  it('derives the WebSocket base from the API base', () => {
    expect(deriveWsBaseUrl('https://storage.noahcohn.com')).toBe('wss://storage.noahcohn.com');
    expect(deriveWsBaseUrl('http://localhost:7860/')).toBe('ws://localhost:7860');
    expect(deriveWsBaseUrl('https://a.example', 'wss://b.example/')).toBe('wss://b.example');
  });

  it('keeps the host token per tab and per room', () => {
    saveHostToken('room1', 'secret');
    expect(loadHostToken('room1')).toBe('secret');
    expect(loadHostToken('room2')).toBeNull();
    clearHostToken('room1');
    expect(loadHostToken('room1')).toBeNull();
  });
});
