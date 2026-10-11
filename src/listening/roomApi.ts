// Listening rooms — REST client and WebSocket URL derivation.

import { getApiBaseUrl } from '../api/songApi';
import type { CreateRoomRequest, CreateRoomResponse, RoomInfo } from './types';

/** Rooms may live on a different host than the catalog (e.g. app.py prototype). */
export function getRoomsApiBaseUrl(): string {
  return (process.env.REACT_APP_ROOMS_API_URL || getApiBaseUrl()).replace(/\/+$/, '');
}

/** `https://host` → `wss://host`; an explicit REACT_APP_WS_URL wins. */
export function deriveWsBaseUrl(apiBaseUrl: string, override?: string): string {
  if (override) return override.replace(/\/+$/, '');
  return apiBaseUrl.replace(/\/+$/, '').replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s}://`);
}

export function roomWebSocketUrl(roomId: string): string {
  const base = deriveWsBaseUrl(getRoomsApiBaseUrl(), process.env.REACT_APP_WS_URL || undefined);
  return `${base}/ws/rooms/${encodeURIComponent(roomId)}`;
}

export class RoomNotFoundError extends Error {
  constructor(roomId: string) {
    super(`Listening room ${roomId} was not found or has ended`);
    this.name = 'RoomNotFoundError';
  }
}

async function failure(response: Response, fallback: string): Promise<Error> {
  try {
    const body = await response.json() as { detail?: unknown };
    if (typeof body.detail === 'string') return new Error(body.detail);
  } catch { /* non-JSON error body */ }
  return new Error(`${fallback} (${response.status})`);
}

export async function createRoom(request: CreateRoomRequest): Promise<CreateRoomResponse> {
  const response = await fetch(`${getRoomsApiBaseUrl()}/api/rooms`, {
    method: 'POST',
    mode: 'cors',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (response.status === 404 || response.status === 405) {
    throw new Error('Listening rooms are not available on this server yet');
  }
  if (!response.ok) throw await failure(response, 'Could not create listening room');
  return response.json() as Promise<CreateRoomResponse>;
}

export async function fetchRoomInfo(roomId: string): Promise<RoomInfo> {
  const response = await fetch(`${getRoomsApiBaseUrl()}/api/rooms/${encodeURIComponent(roomId)}`, {
    mode: 'cors',
    credentials: 'omit',
  });
  if (response.status === 404 || response.status === 410) throw new RoomNotFoundError(roomId);
  if (!response.ok) throw await failure(response, 'Could not load listening room');
  return response.json() as Promise<RoomInfo>;
}

export async function deleteRoom(roomId: string, hostToken: string): Promise<void> {
  const response = await fetch(`${getRoomsApiBaseUrl()}/api/rooms/${encodeURIComponent(roomId)}`, {
    method: 'DELETE',
    mode: 'cors',
    credentials: 'omit',
    headers: { 'X-Host-Token': hostToken },
  });
  if (!response.ok && response.status !== 404) throw await failure(response, 'Could not end listening room');
}
