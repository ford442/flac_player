// Listening rooms (#209) — wire types shared by the protocol, sync engine and hook.
// Contract: docs/LISTENING_ROOMS.md (server side: rooms.py).

import type { RepeatMode } from '../storage/queueStorage';

export type RoomRole = 'host' | 'guest';

export interface RoomQueueState {
  trackIds: string[];
  currentIndex: number;
  shuffle: boolean;
  repeat: RepeatMode;
}

/**
 * Where the host's playhead was, in server-clock terms. Guests extrapolate
 * `position + (serverNow - positionUpdatedAt) * rate` while `playing`.
 */
export interface PlaybackReference {
  trackId: string | null;
  trackIndex: number;
  /** Seconds. */
  position: number;
  /** Server-clock ms at which `position` was sampled. */
  positionUpdatedAt: number;
  playing: boolean;
  rate: number;
}

export interface ListeningRoomState extends PlaybackReference {
  roomId: string;
  title: string;
  hostConnected: boolean;
  queue: RoomQueueState;
  /** Monotonic; stale messages (lower revision) are ignored. */
  revision: number;
}

/** `host_left` | `expired` | `deleted` | `server_shutdown` (open set: newer servers may add reasons). */
export type RoomClosedReason = string;

export interface PresencePayload {
  guestCount: number;
  hostConnected: boolean;
}

export interface JoinedPayload extends PresencePayload {
  role: RoomRole;
  clientId: string;
}

export interface RoomErrorPayload {
  code: string;
  message: string;
}

export type PlaybackMessageType = 'PLAY' | 'PAUSE' | 'SEEK' | 'TRACK_CHANGE' | 'HEARTBEAT';

interface Envelope<T extends string, P> {
  type: T;
  roomId: string;
  /** Server wall-clock ms when the message was sent. */
  serverTime: number;
  revision?: number;
  payload: P;
}

export type ServerMessage =
  | Envelope<'JOINED', JoinedPayload>
  | Envelope<'STATE_SNAPSHOT', ListeningRoomState>
  | Envelope<PlaybackMessageType, PlaybackReference>
  | Envelope<'QUEUE_UPDATE', RoomQueueState>
  | Envelope<'PRESENCE', PresencePayload>
  | Envelope<'TIME_SYNC', { t0: number | null }>
  | Envelope<'ROOM_CLOSED', { reason: RoomClosedReason }>
  | Envelope<'ERROR', RoomErrorPayload>;

/** What the host sends for playback events; the server returns a full PlaybackReference. */
export interface HostPlaybackPayload {
  trackId: string;
  trackIndex: number;
  position: number;
  playing: boolean;
  rate: number;
  /** Host's estimate of server-clock ms when `position` was read. */
  sampledAt: number;
}

export interface ClientMessageMap {
  JOIN: { role: RoomRole; hostToken?: string; clientId?: string };
  PLAY: HostPlaybackPayload;
  PAUSE: HostPlaybackPayload;
  SEEK: HostPlaybackPayload;
  TRACK_CHANGE: HostPlaybackPayload;
  HEARTBEAT: HostPlaybackPayload;
  QUEUE_UPDATE: RoomQueueState;
  RESYNC_REQUEST: Record<string, never>;
  TIME_SYNC: { t0: number };
  LEAVE: Record<string, never>;
}

export type ClientMessageType = keyof ClientMessageMap;

export interface CreateRoomRequest {
  title?: string;
  track_ids?: string[];
  expires_in_minutes?: number;
}

export interface CreateRoomResponse {
  room_id: string;
  host_token: string;
  join_url: string;
  ws_url: string;
  expires_at: string;
}

export interface RoomInfo {
  room_id: string;
  title: string;
  track_count: number;
  guest_count: number;
  host_connected: boolean;
  expires_at: string;
}
