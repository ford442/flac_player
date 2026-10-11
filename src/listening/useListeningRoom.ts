// Listening rooms — React hook owning one room session (host or guest).
//
// Mount next to usePlaybackController (via useListeningRoomBridge), never
// inside view components. Host: observes local playback and publishes.
// Guest: applies host state through GuestSync on every message and a 1 s tick.

import { useCallback, useEffect, useRef, useState } from 'react';
import { GuestSync, INITIAL_GUEST_STATUS, type GuestPlayerAdapter, type GuestSyncStatus } from './guestSync';
import { HostPublisher, type HostSample } from './hostPublisher';
import { RoomConnection } from './roomConnection';
import { isStaleRevision } from './roomProtocol';
import { createRoom as createRoomRequest, roomWebSocketUrl } from './roomApi';
import {
  clearHostToken,
  getRoomClientId,
  joinUrlFor,
  loadHostToken,
  roomHref,
  saveHostToken,
} from './roomSession';
import type { RoomQueueState, RoomRole, ServerMessage } from './types';

const TICK_MS = 1000;
const QUEUE_PUBLISH_DEBOUNCE_MS = 300;

/** Player surface the room drives (guest) or reads (host). Must be referentially stable. */
export interface ListeningRoomPlayer extends GuestPlayerAdapter {
  /** Local playback to publish; null when nothing shareable is loaded. */
  getHostSample(): HostSample | null;
  /** Mirror the host's queue locally (guest only). */
  applyQueue(queue: RoomQueueState, currentTrackId: string | null): void;
}

export interface UseListeningRoomOptions {
  /** Room from the `/room/{id}` route; role comes from the stored host token. */
  initialRoomId: string | null;
  player: ListeningRoomPlayer;
  /** Changes whenever local playback state changes (host publishes on change). */
  playbackKey: unknown;
  /** Host's local queue, published when it changes. */
  queue: RoomQueueState;
  onNotify: (message: string, type: 'success' | 'error' | 'info') => void;
  /** Called after the session is over and the user dismissed it (or left). */
  onLeft?: (role: RoomRole) => void;
}

/**
 * A server ROOM_CLOSED reason (`host_left`, `expired`, `deleted`, `server_shutdown`)
 * or a client-side one: `not_found`, `forbidden`, `room_full`, `replaced`.
 */
export type RoomEndReason = string;

export interface ListeningRoomView {
  roomId: string | null;
  role: RoomRole | null;
  title: string;
  joinUrl: string | null;
  connected: boolean;
  reconnecting: boolean;
  hostConnected: boolean;
  guestCount: number;
  sync: GuestSyncStatus;
  /** Set once the session ended for a reason other than our own leave. */
  endedReason: RoomEndReason | null;
}

export interface UseListeningRoomResult extends ListeningRoomView {
  createRoom: (options: { title?: string; trackIds: string[] }) => Promise<boolean>;
  leaveRoom: () => void;
  requestResync: () => void;
  unlockAudio: () => void;
  copyJoinLink: () => Promise<void>;
  dismissEnded: () => void;
}

interface Session {
  roomId: string;
  role: RoomRole;
  hostToken?: string;
}

const CLOSE_CODE_REASONS: Record<number, RoomEndReason> = {
  1008: 'forbidden',
  4001: 'replaced',
  4403: 'forbidden',
  4404: 'not_found',
  4429: 'room_full',
};

function initialSession(roomId: string | null): Session | null {
  if (!roomId) return null;
  const hostToken = loadHostToken(roomId);
  return hostToken ? { roomId, role: 'host', hostToken } : { roomId, role: 'guest' };
}

export function useListeningRoom({
  initialRoomId, player, playbackKey, queue, onNotify, onLeft,
}: UseListeningRoomOptions): UseListeningRoomResult {
  const [session, setSession] = useState<Session | null>(() => initialSession(initialRoomId));
  const [title, setTitle] = useState('');
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [hostConnected, setHostConnected] = useState(false);
  const [guestCount, setGuestCount] = useState(0);
  const [sync, setSync] = useState<GuestSyncStatus>(INITIAL_GUEST_STATUS);
  const [endedReason, setEndedReason] = useState<RoomEndReason | null>(null);

  const connectionRef = useRef<RoomConnection | null>(null);
  const guestRef = useRef<GuestSync | null>(null);
  const publisherRef = useRef<HostPublisher | null>(null);
  const playerRef = useRef(player);
  playerRef.current = player;
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const notifyRef = useRef(onNotify);
  notifyRef.current = onNotify;
  const onLeftRef = useRef(onLeft);
  onLeftRef.current = onLeft;

  // One connection per session.
  useEffect(() => {
    if (!session) return;
    const { roomId, role } = session;
    let lastRevision = -1;
    let endReason: RoomEndReason | null = null;

    setTitle('');
    setConnected(false);
    setReconnecting(false);
    setHostConnected(role === 'host');
    setGuestCount(0);
    setSync(INITIAL_GUEST_STATUS);
    setEndedReason(null);

    const connection = new RoomConnection({
      url: roomWebSocketUrl(roomId),
      role,
      hostToken: session.hostToken,
      clientId: getRoomClientId(),
      onStatus: (status) => {
        setConnected(status.connected);
        setReconnecting(status.reconnecting);
      },
      onEnded: ({ code }) => {
        const reason = endReason ?? CLOSE_CODE_REASONS[code] ?? (code === 1000 ? null : 'host_left');
        if (!reason) return;
        // Stop steering playback; whatever is playing keeps playing locally.
        guestRef.current?.dispose();
        if (role === 'host') clearHostToken(roomId);
        setEndedReason(reason);
      },
      onMessage: (message: ServerMessage) => {
        switch (message.type) {
          case 'JOINED':
            setGuestCount(message.payload.guestCount);
            setHostConnected(message.payload.hostConnected);
            if (role === 'host') {
              // Fresh socket: guests may have missed anything sent while we were away.
              publisherRef.current?.reset();
              publisherRef.current?.publishQueue(queueRef.current);
              publisherRef.current?.observe(playerRef.current.getHostSample());
            }
            break;
          case 'STATE_SNAPSHOT':
            lastRevision = message.payload.revision;
            setTitle(message.payload.title);
            setHostConnected(message.payload.hostConnected);
            if (role === 'guest') {
              playerRef.current.applyQueue(message.payload.queue, message.payload.trackId);
              guestRef.current?.setReference(message.payload);
            }
            break;
          case 'PLAY':
          case 'PAUSE':
          case 'SEEK':
          case 'TRACK_CHANGE':
          case 'HEARTBEAT':
            if (role !== 'guest' || isStaleRevision(message.revision, lastRevision)) break;
            if (message.revision !== undefined) lastRevision = message.revision;
            guestRef.current?.setReference(message.payload);
            break;
          case 'QUEUE_UPDATE':
            if (role !== 'guest' || isStaleRevision(message.revision, lastRevision)) break;
            if (message.revision !== undefined) lastRevision = message.revision;
            playerRef.current.applyQueue(message.payload, guestRef.current?.getReference()?.trackId ?? null);
            break;
          case 'PRESENCE':
            setGuestCount(message.payload.guestCount);
            setHostConnected(message.payload.hostConnected);
            break;
          case 'ROOM_CLOSED':
            endReason = message.payload.reason;
            break;
          case 'ERROR':
            if (message.payload.code === 'room_not_found') endReason = 'not_found';
            else if (message.payload.code === 'forbidden' && role === 'host') endReason = 'forbidden';
            else if (message.payload.code === 'room_full') endReason = 'room_full';
            else if (message.payload.code !== 'rate_limited') console.warn('[ListeningRoom]', message.payload);
            break;
          default:
            break;
        }
      },
    });
    connectionRef.current = connection;

    const serverNow = () => connection.clock.serverNow();
    if (role === 'guest') {
      guestRef.current = new GuestSync(playerRef.current, serverNow, setSync);
    } else {
      publisherRef.current = new HostPublisher((type, payload) => connection.send(type, payload), serverNow);
    }

    const tick = setInterval(() => {
      if (role === 'guest') guestRef.current?.reconcile();
      else if (connection.isOpen()) publisherRef.current?.observe(playerRef.current.getHostSample());
    }, TICK_MS);

    connection.connect();

    return () => {
      clearInterval(tick);
      connection.close(false);
      guestRef.current?.dispose();
      guestRef.current = null;
      publisherRef.current = null;
      if (connectionRef.current === connection) connectionRef.current = null;
    };
  }, [session]);

  // Host: publish immediately on local playback changes (play/pause/seek/track).
  useEffect(() => {
    if (session?.role !== 'host' || !connected) return;
    publisherRef.current?.observe(playerRef.current.getHostSample());
  }, [session, connected, playbackKey]);

  // Host: publish queue edits (debounced; drag-reorder fires in bursts).
  const queueKey = JSON.stringify(queue);
  useEffect(() => {
    if (session?.role !== 'host' || !connected) return;
    const timer = setTimeout(() => publisherRef.current?.publishQueue(queueRef.current), QUEUE_PUBLISH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [session, connected, queueKey]);

  const createRoom = useCallback(async ({ title: roomTitle, trackIds }: { title?: string; trackIds: string[] }) => {
    try {
      const created = await createRoomRequest({ title: roomTitle, track_ids: trackIds });
      saveHostToken(created.room_id, created.host_token);
      try { window.history.replaceState(window.history.state, '', roomHref(created.room_id)); } catch { /* sandboxed */ }
      setSession({ roomId: created.room_id, role: 'host', hostToken: created.host_token });
      const link = joinUrlFor(created.room_id);
      try {
        await navigator.clipboard.writeText(link);
        notifyRef.current('Listening room created — join link copied', 'success');
      } catch {
        notifyRef.current(`Listening room created: ${link}`, 'success');
      }
      return true;
    } catch (err) {
      notifyRef.current(err instanceof Error ? err.message : 'Could not create listening room', 'error');
      return false;
    }
  }, []);

  const finish = useCallback(() => {
    const role = session?.role;
    setSession(null);
    setEndedReason(null);
    setConnected(false);
    setSync(INITIAL_GUEST_STATUS);
    if (role) onLeftRef.current?.(role);
  }, [session]);

  const leaveRoom = useCallback(() => {
    if (!session) return;
    // Host LEAVE ends the room for everyone; a guest just disconnects.
    connectionRef.current?.close(session.role === 'host');
    if (session.role === 'host') clearHostToken(session.roomId);
    finish();
  }, [session, finish]);

  const requestResync = useCallback(() => {
    guestRef.current?.unlock();
    connectionRef.current?.send('RESYNC_REQUEST', {});
  }, []);

  const unlockAudio = useCallback(() => {
    guestRef.current?.unlock();
  }, []);

  const copyJoinLink = useCallback(async () => {
    if (!session) return;
    try {
      await navigator.clipboard.writeText(joinUrlFor(session.roomId));
      notifyRef.current('Join link copied', 'success');
    } catch {
      notifyRef.current(joinUrlFor(session.roomId), 'info');
    }
  }, [session]);

  return {
    roomId: session?.roomId ?? null,
    role: session?.role ?? null,
    title,
    joinUrl: session ? joinUrlFor(session.roomId) : null,
    connected,
    reconnecting,
    hostConnected,
    guestCount,
    sync,
    endedReason,
    createRoom,
    leaveRoom,
    requestResync,
    unlockAudio,
    copyJoinLink,
    dismissEnded: finish,
  };
}
