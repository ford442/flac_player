// Listening rooms — one WebSocket session: JOIN, clock sync, reconnect.
//
// Reconnects with backoff after unexpected drops (a host must come back within
// the server's grace period). Room-ended and auth close codes are final.

import { ServerClock, clockSampleFrom, localNow } from './clockSync';
import { decodeServerMessage, encodeClientMessage } from './roomProtocol';
import type { ClientMessageMap, ClientMessageType, RoomRole, ServerMessage } from './types';

/** Server close codes that end the session for good (rooms.py). */
export const FINAL_CLOSE_CODES = new Set([1008, 4000, 4001, 4403, 4404, 4429]);

const TIME_SYNC_BURST = 5;
const TIME_SYNC_BURST_SPACING_MS = 250;
const TIME_SYNC_INTERVAL_MS = 15_000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10_000;

export interface RoomConnectionOptions {
  url: string;
  role: RoomRole;
  hostToken?: string;
  clientId?: string;
  onMessage: (message: ServerMessage) => void;
  /** connected = socket open and JOIN sent; reconnecting = waiting to retry. */
  onStatus: (status: { connected: boolean; reconnecting: boolean }) => void;
  /** Session is over (final close code or close()); no more reconnects. */
  onEnded: (info: { code: number; reason: string }) => void;
  /** Injectable for tests. */
  WebSocketImpl?: typeof WebSocket;
  now?: () => number;
}

export class RoomConnection {
  readonly clock: ServerClock;
  private ws: WebSocket | null = null;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private syncTimers: ReturnType<typeof setTimeout>[] = [];
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private ended = false;
  private readonly now: () => number;

  constructor(private readonly options: RoomConnectionOptions) {
    this.now = options.now ?? localNow;
    this.clock = new ServerClock(this.now);
  }

  connect(): void {
    if (this.ended) return;
    const Impl = this.options.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new Impl(this.options.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      this.sendRaw('JOIN', {
        role: this.options.role,
        ...(this.options.hostToken ? { hostToken: this.options.hostToken } : {}),
        ...(this.options.clientId ? { clientId: this.options.clientId } : {}),
      });
      this.startTimeSync();
      this.options.onStatus({ connected: true, reconnecting: false });
    };

    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws || typeof event.data !== 'string') return;
      const message = decodeServerMessage(event.data);
      if (!message) return;
      if (message.type === 'TIME_SYNC') {
        if (message.payload.t0 !== null) {
          this.clock.addSample(clockSampleFrom(message.payload.t0, message.serverTime, this.now()));
        }
        return;
      }
      this.clock.seedFromServerTime(message.serverTime);
      this.options.onMessage(message);
    };

    ws.onclose = (event: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopTimeSync();
      if (this.ended) return;
      if (FINAL_CLOSE_CODES.has(event.code)) {
        this.finish(event.code, event.reason);
        return;
      }
      this.options.onStatus({ connected: false, reconnecting: true });
      this.scheduleReconnect();
    };

    ws.onerror = () => { /* onclose follows and decides on reconnect */ };
  }

  /** Send a client message; false when the socket is not open (callers re-publish later). */
  send<T extends ClientMessageType>(type: T, payload: ClientMessageMap[T]): boolean {
    return this.sendRaw(type, payload);
  }

  isOpen(): boolean {
    return this.ws?.readyState === 1;
  }

  /** Leave for good. `announce` sends LEAVE first (host: ends the room). */
  close(announce = false): void {
    if (this.ended) return;
    if (announce) this.sendRaw('LEAVE', {});
    const ws = this.ws;
    this.finish(1000, 'left');
    try { ws?.close(1000, 'left'); } catch { /* already closing */ }
  }

  private finish(code: number, reason: string): void {
    this.ended = true;
    this.ws = null;
    this.stopTimeSync();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.options.onStatus({ connected: false, reconnecting: false });
    this.options.onEnded({ code, reason });
  }

  private sendRaw<T extends ClientMessageType>(type: T, payload: ClientMessageMap[T]): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(encodeClientMessage(type, payload));
      return true;
    } catch {
      return false;
    }
  }

  private scheduleReconnect(): void {
    if (this.ended || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempts);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startTimeSync(): void {
    this.stopTimeSync();
    const ping = () => { this.sendRaw('TIME_SYNC', { t0: this.now() }); };
    for (let i = 0; i < TIME_SYNC_BURST; i++) {
      this.syncTimers.push(setTimeout(ping, i * TIME_SYNC_BURST_SPACING_MS));
    }
    this.syncInterval = setInterval(ping, TIME_SYNC_INTERVAL_MS);
  }

  private stopTimeSync(): void {
    this.syncTimers.forEach(clearTimeout);
    this.syncTimers = [];
    if (this.syncInterval) clearInterval(this.syncInterval);
    this.syncInterval = null;
  }
}
