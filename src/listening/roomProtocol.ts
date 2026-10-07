// Listening rooms — message encode/decode with defensive validation.
// Anything malformed decodes to null so a bad frame never reaches the player.

import type { RepeatMode } from '../storage/queueStorage';
import type {
  ClientMessageMap,
  ClientMessageType,
  ListeningRoomState,
  PlaybackReference,
  RoomQueueState,
  ServerMessage,
} from './types';

const REPEAT_MODES: readonly RepeatMode[] = ['off', 'one', 'all'];
const PLAYBACK_TYPES = new Set(['PLAY', 'PAUSE', 'SEEK', 'TRACK_CHANGE', 'HEARTBEAT']);

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function trackIdOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function encodeClientMessage<T extends ClientMessageType>(type: T, payload: ClientMessageMap[T]): string {
  return JSON.stringify({ type, payload });
}

export function parsePlaybackReference(value: unknown): PlaybackReference | null {
  if (!isObject(value)) return null;
  const position = finite(value.position, NaN);
  const positionUpdatedAt = finite(value.positionUpdatedAt, NaN);
  if (!Number.isFinite(position) || !Number.isFinite(positionUpdatedAt)) return null;
  return {
    trackId: trackIdOrNull(value.trackId),
    trackIndex: Math.trunc(finite(value.trackIndex, -1)),
    position: Math.max(0, position),
    positionUpdatedAt,
    playing: value.playing === true,
    rate: Math.min(4, Math.max(0.25, finite(value.rate, 1))),
  };
}

export function parseRoomQueue(value: unknown): RoomQueueState | null {
  if (!isObject(value) || !Array.isArray(value.trackIds)) return null;
  const repeat = REPEAT_MODES.includes(value.repeat as RepeatMode) ? (value.repeat as RepeatMode) : 'off';
  return {
    trackIds: value.trackIds.filter((id): id is string => typeof id === 'string' && id.length > 0),
    currentIndex: Math.trunc(finite(value.currentIndex, -1)),
    shuffle: value.shuffle === true,
    repeat,
  };
}

export function parseRoomState(value: unknown): ListeningRoomState | null {
  const reference = parsePlaybackReference(value);
  if (!reference || !isObject(value)) return null;
  const queue = parseRoomQueue(value.queue);
  if (!queue || typeof value.roomId !== 'string') return null;
  return {
    ...reference,
    roomId: value.roomId,
    title: typeof value.title === 'string' ? value.title : '',
    hostConnected: value.hostConnected === true,
    queue,
    revision: Math.trunc(finite(value.revision, 0)),
  };
}

/** Decode one server frame. Unknown types and malformed payloads return null. */
export function decodeServerMessage(raw: string): ServerMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(data) || typeof data.type !== 'string') return null;
  const base = {
    roomId: typeof data.roomId === 'string' ? data.roomId : '',
    serverTime: finite(data.serverTime, NaN),
    revision: typeof data.revision === 'number' ? data.revision : undefined,
  };
  if (!Number.isFinite(base.serverTime)) return null;
  const payload = data.payload;

  if (PLAYBACK_TYPES.has(data.type)) {
    const reference = parsePlaybackReference(payload);
    return reference
      ? { ...base, type: data.type as 'PLAY', payload: reference }
      : null;
  }

  switch (data.type) {
    case 'STATE_SNAPSHOT': {
      const state = parseRoomState(payload);
      return state ? { ...base, type: 'STATE_SNAPSHOT', revision: state.revision, payload: state } : null;
    }
    case 'QUEUE_UPDATE': {
      const queue = parseRoomQueue(payload);
      return queue ? { ...base, type: 'QUEUE_UPDATE', payload: queue } : null;
    }
    case 'JOINED':
      if (!isObject(payload) || (payload.role !== 'host' && payload.role !== 'guest')) return null;
      return {
        ...base,
        type: 'JOINED',
        payload: {
          role: payload.role,
          clientId: typeof payload.clientId === 'string' ? payload.clientId : '',
          guestCount: Math.max(0, Math.trunc(finite(payload.guestCount, 0))),
          hostConnected: payload.hostConnected === true,
        },
      };
    case 'PRESENCE':
      if (!isObject(payload)) return null;
      return {
        ...base,
        type: 'PRESENCE',
        payload: {
          guestCount: Math.max(0, Math.trunc(finite(payload.guestCount, 0))),
          hostConnected: payload.hostConnected === true,
        },
      };
    case 'TIME_SYNC':
      if (!isObject(payload)) return null;
      return { ...base, type: 'TIME_SYNC', payload: { t0: Number.isFinite(payload.t0) ? (payload.t0 as number) : null } };
    case 'ROOM_CLOSED':
      return {
        ...base,
        type: 'ROOM_CLOSED',
        payload: { reason: isObject(payload) && typeof payload.reason === 'string' ? payload.reason : 'host_left' },
      };
    case 'ERROR':
      return {
        ...base,
        type: 'ERROR',
        payload: {
          code: isObject(payload) && typeof payload.code === 'string' ? payload.code : 'unknown',
          message: isObject(payload) && typeof payload.message === 'string' ? payload.message : '',
        },
      };
    default:
      return null;
  }
}

/** Ignore messages that predate state we already applied (e.g. a late heartbeat after a snapshot). */
export function isStaleRevision(incoming: number | undefined, lastApplied: number): boolean {
  return incoming !== undefined && incoming < lastApplied;
}
