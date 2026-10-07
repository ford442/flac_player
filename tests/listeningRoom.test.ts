import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuestSync, type GuestPlayerAdapter, type GuestSyncStatus } from '../src/listening/guestSync';
import { HEARTBEAT_INTERVAL_MS, HostPublisher, type HostSample } from '../src/listening/hostPublisher';
import { RoomConnection } from '../src/listening/roomConnection';
import { decodeServerMessage } from '../src/listening/roomProtocol';
import { NUDGE_RATE_DELTA, SEEK_COOLDOWN_MS } from '../src/listening/syncEngine';
import type { SyncClock } from '../src/types/audio';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Simulated <audio> element advanced by an explicit clock. */
class FakeElement {
  position = 0;
  playing = false;
  ended = false;
  seeking = false;
  rate = 1;
  duration = 300;

  advance(ms: number): void {
    if (!this.playing) return;
    this.position += (ms / 1000) * this.rate;
    if (this.position >= this.duration) {
      this.position = this.duration;
      this.playing = false;
      this.ended = true;
    }
  }
}

function createGuestHarness(knownTracks = ['a', 'b']) {
  let now = 1_000_000;
  const el = new FakeElement();
  const calls: string[] = [];
  let loaded: string | null = null;
  let blockAutoplay = false;
  const statuses: GuestSyncStatus[] = [];

  const clock: SyncClock = {
    getSyncPosition: () => el.position,
    isSyncPlaying: () => el.playing,
    isSyncEnded: () => el.ended,
    isSyncSeeking: () => el.seeking,
    getSyncRate: () => el.rate,
  };
  const adapter: GuestPlayerAdapter = {
    getClock: () => (loaded ? clock : null),
    getLoadedTrackId: () => loaded,
    loadTrack: async (id) => {
      calls.push(`load:${id}`);
      if (!knownTracks.includes(id)) return false;
      loaded = id;
      Object.assign(el, { position: 0, playing: false, ended: false, rate: 1 });
      return true;
    },
    play: () => {
      calls.push('play');
      if (blockAutoplay) return Promise.reject(new DOMException('blocked', 'NotAllowedError'));
      el.playing = true;
      return Promise.resolve();
    },
    pause: () => { calls.push('pause'); el.playing = false; },
    seek: (seconds) => { calls.push(`seek:${seconds.toFixed(2)}`); el.position = seconds; el.ended = false; },
    setRate: (rate) => { calls.push(`rate:${rate}`); el.rate = rate; },
  };
  // Server clock 5 s ahead of the local clock: exercises the offset path.
  const sync = new GuestSync(adapter, () => now + 5000, (s) => statuses.push(s), () => now);

  return {
    el, calls, sync, statuses,
    get now() { return now; },
    serverNow: () => now + 5000,
    tick(ms: number) { now += ms; el.advance(ms); sync.reconcile(); },
    setBlockAutoplay(value: boolean) { blockAutoplay = value; },
    lastStatus: () => statuses[statuses.length - 1],
  };
}

function snapshotFrame(serverTime: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'STATE_SNAPSHOT', roomId: 'r', serverTime, revision: 4,
    payload: {
      roomId: 'r', title: 'Friday', hostConnected: true,
      trackId: 'a', trackIndex: 0, position: 10, positionUpdatedAt: serverTime, playing: true, rate: 1,
      queue: { trackIds: ['a', 'b'], currentIndex: 0, shuffle: false, repeat: 'off' },
      revision: 4,
      ...overrides,
    },
  });
}

async function joinPlaying(h: ReturnType<typeof createGuestHarness>) {
  const message = decodeServerMessage(snapshotFrame(h.serverNow()));
  if (message?.type !== 'STATE_SNAPSHOT') throw new Error('bad snapshot');
  h.sync.setReference(message.payload);
  await flush();
}

describe('GuestSync — apply snapshot + drift correct', () => {
  it('loads the host track, seeks ahead of the expected position and plays', async () => {
    const h = createGuestHarness();
    await joinPlaying(h);
    expect(h.calls).toEqual(['load:a', 'seek:10.15', 'rate:1', 'play']);
    expect(h.el.playing).toBe(true);
    expect(h.lastStatus().loading).toBe(false);
  });

  it('stays put when within threshold, nudges when drifting, settles back to 1×', async () => {
    const h = createGuestHarness();
    await joinPlaying(h);
    h.calls.length = 0;

    h.tick(SEEK_COOLDOWN_MS + 500);
    expect(h.calls).toEqual([]);
    expect(Math.abs(h.lastStatus().driftMs ?? 999)).toBeLessThan(250);
    expect(h.sync.getSeekLeadMs()).toBeLessThan(150); // landed ahead → less lead next time

    h.el.position += 0.25; // guest now ~400 ms ahead
    h.tick(1000);
    expect(h.calls).toEqual([`rate:${1 - NUDGE_RATE_DELTA}`]);
    expect(h.lastStatus().outOfSync).toBe(false);

    h.tick(1000); // still converging: no new calls
    expect(h.calls).toHaveLength(1);

    h.el.position -= 0.3; // back near the host
    h.tick(1000);
    expect(h.calls[h.calls.length - 1]).toBe('rate:1');
  });

  it('hard-seeks when more than 500 ms off', async () => {
    const h = createGuestHarness();
    await joinPlaying(h);
    h.tick(SEEK_COOLDOWN_MS + 500);
    h.calls.length = 0;

    h.el.position -= 2;
    h.tick(1000);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatch(/^seek:/);
    expect(h.lastStatus().outOfSync).toBe(true);
    const expected = 10 + (SEEK_COOLDOWN_MS + 1500) / 1000;
    expect(h.el.position).toBeGreaterThan(expected);
    expect(h.el.position).toBeLessThan(expected + 0.5);
  });

  it('follows host pause to the exact position, then resumes on PLAY', async () => {
    const h = createGuestHarness();
    await joinPlaying(h);
    h.calls.length = 0;

    h.sync.setReference({ trackId: 'a', trackIndex: 0, position: 50, positionUpdatedAt: h.serverNow(), playing: false, rate: 1 });
    expect(h.calls).toEqual(['pause', 'seek:50.00']);
    h.tick(1000);
    expect(h.el.position).toBe(50);

    h.calls.length = 0;
    h.sync.setReference({ trackId: 'a', trackIndex: 0, position: 50, positionUpdatedAt: h.serverNow(), playing: true, rate: 1 });
    expect(h.calls).toEqual(['play']);
  });

  it('switches tracks on TRACK_CHANGE', async () => {
    const h = createGuestHarness();
    await joinPlaying(h);
    h.calls.length = 0;
    h.sync.setReference({ trackId: 'b', trackIndex: 1, position: 0, positionUpdatedAt: h.serverNow(), playing: true, rate: 1 });
    await flush();
    expect(h.calls).toEqual(['load:b', 'rate:1', 'play']);
  });

  it('asks for a click when autoplay is blocked, and retries on unlock', async () => {
    const h = createGuestHarness();
    h.setBlockAutoplay(true);
    await joinPlaying(h);
    await flush();
    expect(h.lastStatus().needsUserGesture).toBe(true);

    h.tick(1000);
    expect(h.calls.filter((c) => c === 'play')).toHaveLength(1); // no retry loop without a gesture

    h.setBlockAutoplay(false);
    h.sync.unlock();
    expect(h.el.playing).toBe(true);
    await flush();
    expect(h.lastStatus().needsUserGesture).toBe(false);
  });

  it('reports an unresolvable track once instead of reloading forever', async () => {
    const h = createGuestHarness([]);
    await joinPlaying(h);
    expect(h.lastStatus().trackUnavailable).toBe(true);
    h.tick(1000);
    h.tick(1000);
    expect(h.calls).toEqual(['load:a']);
  });

  it('does not restart a track that ended locally before the host moved on', async () => {
    const h = createGuestHarness();
    await joinPlaying(h);
    h.calls.length = 0;
    Object.assign(h.el, { playing: false, ended: true, position: 300 });
    h.tick(1000);
    expect(h.calls).toEqual([]);
  });
});

describe('HostPublisher', () => {
  function createHost() {
    let now = 50_000;
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    let online = true;
    const publisher = new HostPublisher(
      (type, payload) => {
        if (!online) return false;
        sent.push({ type, payload: payload as unknown as Record<string, unknown> });
        return true;
      },
      () => now + 1000,
      () => now,
    );
    return {
      publisher, sent,
      advance(ms: number) { now += ms; },
      setOnline(value: boolean) { online = value; },
    };
  }
  const sample = (overrides: Partial<HostSample> = {}): HostSample => ({
    trackId: 'a', trackIndex: 0, position: 0, playing: false, rate: 1, ...overrides,
  });

  it('publishes nothing without a shareable track', () => {
    const h = createHost();
    expect(h.publisher.observe(null)).toBeNull();
    expect(h.publisher.observe(sample({ trackId: null }))).toBeNull();
    expect(h.sent).toEqual([]);
  });

  it('publishes track changes, play/pause edges, seeks and heartbeats', () => {
    const h = createHost();
    expect(h.publisher.observe(sample())).toBe('TRACK_CHANGE');
    expect(h.sent[0].payload).toMatchObject({ trackId: 'a', position: 0, playing: false, sampledAt: 51_000 });

    expect(h.publisher.observe(sample({ position: 0.1, playing: true }))).toBe('PLAY');
    h.advance(1000);
    expect(h.publisher.observe(sample({ position: 1.1, playing: true }))).toBeNull();

    h.advance(1000);
    expect(h.publisher.observe(sample({ position: 30, playing: true }))).toBe('SEEK');
    h.advance(100);
    expect(h.publisher.observe(sample({ position: 45, playing: true }))).toBeNull(); // throttled scrub
    h.advance(300);
    expect(h.publisher.observe(sample({ position: 45.3, playing: true }))).toBe('SEEK');

    h.advance(HEARTBEAT_INTERVAL_MS);
    expect(h.publisher.observe(sample({ position: 50.3, playing: true }))).toBe('HEARTBEAT');

    expect(h.publisher.observe(sample({ position: 50.3, playing: false }))).toBe('PAUSE');
    expect(h.publisher.observe(sample({ trackId: 'b', trackIndex: 1 }))).toBe('TRACK_CHANGE');
    expect(h.sent.map((m) => m.type)).toEqual(['TRACK_CHANGE', 'PLAY', 'SEEK', 'SEEK', 'HEARTBEAT', 'PAUSE', 'TRACK_CHANGE']);
  });

  it('announces a new track while loading, but not a reload of the same one', () => {
    const h = createHost();
    expect(h.publisher.observe(sample({ loading: true }))).toBeNull(); // guests' state unknown yet
    h.publisher.observe(sample({ position: 12, playing: true }));
    expect(h.publisher.observe(sample({ position: 0, loading: true }))).toBeNull(); // same track restarting
    expect(h.publisher.observe(sample({ trackId: 'b', trackIndex: 1, loading: true }))).toBe('TRACK_CHANGE');
    expect(h.sent.slice(-1)[0]?.payload).toMatchObject({ trackId: 'b', position: 0, playing: false });
    expect(h.publisher.observe(sample({ trackId: 'b', trackIndex: 1, position: 0.2, playing: true }))).toBe('PLAY');
  });

  it('treats a rate change as a re-anchor', () => {
    const h = createHost();
    h.publisher.observe(sample({ playing: true }));
    expect(h.publisher.observe(sample({ playing: true, rate: 1.25 }))).toBe('SEEK');
  });

  it('retries after a failed send and re-publishes everything after reset', () => {
    const h = createHost();
    h.setOnline(false);
    expect(h.publisher.observe(sample())).toBeNull();
    h.setOnline(true);
    expect(h.publisher.observe(sample())).toBe('TRACK_CHANGE');
    h.publisher.reset();
    expect(h.publisher.observe(sample())).toBe('TRACK_CHANGE');
  });

  it('deduplicates queue updates', () => {
    const h = createHost();
    const queue = { trackIds: ['a', 'b'], currentIndex: 0, shuffle: false, repeat: 'off' as const };
    expect(h.publisher.publishQueue(queue)).toBe(true);
    expect(h.publisher.publishQueue({ ...queue })).toBe(false);
    expect(h.publisher.publishQueue({ ...queue, currentIndex: 1 })).toBe(true);
  });
});

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 0;
  sent: { type: string; payload: Record<string, unknown> }[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code = 1000, reason = '') { this.drop(code, reason); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  drop(code: number, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

describe('RoomConnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function connect(role: 'host' | 'guest' = 'host') {
    let now = 10_000;
    const messages: string[] = [];
    const statuses: { connected: boolean; reconnecting: boolean }[] = [];
    const ended: { code: number; reason: string }[] = [];
    const connection = new RoomConnection({
      url: 'ws://rooms.test/ws/rooms/r',
      role,
      hostToken: role === 'host' ? 'secret' : undefined,
      clientId: 'c1',
      onMessage: (m) => messages.push(m.type),
      onStatus: (s) => statuses.push(s),
      onEnded: (e) => ended.push(e),
      WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
      now: () => now,
    });
    connection.connect();
    return { connection, messages, statuses, ended, setNow: (v: number) => { now = v; } };
  }

  it('sends JOIN on open and measures the server clock', () => {
    const c = connect();
    const ws = MockWebSocket.instances[0];
    ws.open();
    expect(ws.sent[0]).toEqual({ type: 'JOIN', payload: { role: 'host', hostToken: 'secret', clientId: 'c1' } });
    expect(c.statuses.slice(-1)[0]).toEqual({ connected: true, reconnecting: false });

    vi.advanceTimersByTime(0);
    const ping = ws.sent.find((m) => m.type === 'TIME_SYNC');
    expect(ping?.payload).toEqual({ t0: 10_000 });
    c.setNow(10_100);
    ws.receive({ type: 'TIME_SYNC', roomId: 'r', serverTime: 70_050, payload: { t0: 10_000 } });
    expect(c.connection.clock.getOffsetMs()).toBe(60_000);
    expect(c.messages).toEqual([]); // clock traffic is internal
  });

  it('forwards decoded messages and ignores junk', () => {
    const c = connect('guest');
    const ws = MockWebSocket.instances[0];
    ws.open();
    ws.receive({ type: 'PRESENCE', roomId: 'r', serverTime: 1, payload: { guestCount: 2, hostConnected: true } });
    ws.receive({ type: 'PLAY', roomId: 'r', serverTime: 1, payload: { position: 'nope' } });
    expect(c.messages).toEqual(['PRESENCE']);
  });

  it('reconnects after an unexpected drop but not after the room ends', () => {
    const c = connect();
    MockWebSocket.instances[0].open();
    MockWebSocket.instances[0].drop(1006);
    expect(c.statuses.slice(-1)[0]).toEqual({ connected: false, reconnecting: true });
    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    MockWebSocket.instances[1].open();
    MockWebSocket.instances[1].drop(4000, 'host_left');
    vi.advanceTimersByTime(30_000);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(c.ended).toEqual([{ code: 4000, reason: 'host_left' }]);
  });

  it('announces LEAVE when the host ends the room', () => {
    const c = connect();
    const ws = MockWebSocket.instances[0];
    ws.open();
    c.connection.close(true);
    expect(ws.sent.slice(-1)[0]).toEqual({ type: 'LEAVE', payload: {} });
    expect(c.ended).toEqual([{ code: 1000, reason: 'left' }]);
    expect(c.connection.send('HEARTBEAT', {
      trackId: 'a', trackIndex: 0, position: 0, playing: false, rate: 1, sampledAt: 0,
    })).toBe(false);
  });
});
