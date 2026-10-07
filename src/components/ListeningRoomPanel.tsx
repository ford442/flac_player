import React from 'react';
import type { ListeningRoomView } from '../listening/useListeningRoom';
import './ListeningRoomPanel.css';

export interface ListeningRoomPanelProps {
  room: ListeningRoomView;
  onCopyLink: () => void;
  onLeave: () => void;
  onResync: () => void;
  onStartListening: () => void;
  onDismissEnded: () => void;
}

const END_MESSAGES: Record<string, string> = {
  host_left: 'The host ended the session',
  expired: 'This listening room expired',
  deleted: 'The host ended the session',
  server_shutdown: 'The room server restarted',
  not_found: 'This listening room was not found or has ended',
  forbidden: 'You cannot host this room from this tab',
  room_full: 'This listening room is full',
  replaced: 'This room was opened in another tab',
};

function formatDrift(driftMs: number): string {
  const rounded = Math.round(driftMs / 10) * 10;
  return `${rounded >= 0 ? '+' : '−'}${Math.abs(rounded)} ms`;
}

/** Host/guest badge and actions for an active listening room (#209). */
export const ListeningRoomPanel: React.FC<ListeningRoomPanelProps> = ({
  room, onCopyLink, onLeave, onResync, onStartListening, onDismissEnded,
}) => {
  if (!room.roomId) return null;

  if (room.endedReason) {
    return (
      <div className="listening-room-panel" role="status" aria-live="polite" data-testid="listening-room-panel">
        <span className="listening-room-dot listening-room-dot--ended" aria-hidden="true" />
        <span className="listening-room-label">{END_MESSAGES[room.endedReason] ?? 'Session ended'}</span>
        <button type="button" className="listening-room-button" onClick={onDismissEnded}>OK</button>
      </div>
    );
  }

  const isHost = room.role === 'host';
  let label: string;
  let tone: 'ok' | 'warn' | 'bad';
  if (!room.connected) {
    label = room.reconnecting ? 'Reconnecting…' : 'Connecting…';
    tone = 'warn';
  } else if (isHost) {
    label = `Hosting · ${room.guestCount} listening`;
    tone = 'ok';
  } else if (!room.hostConnected) {
    label = 'Waiting for host…';
    tone = 'warn';
  } else if (room.sync.trackUnavailable) {
    label = 'Track unavailable';
    tone = 'bad';
  } else if (room.sync.loading) {
    label = 'Loading track…';
    tone = 'warn';
  } else if (room.sync.outOfSync) {
    label = 'Out of sync';
    tone = 'bad';
  } else {
    label = room.sync.driftMs !== null ? `Listening · synced ${formatDrift(room.sync.driftMs)}` : 'Listening · synced';
    tone = 'ok';
  }

  return (
    <div className="listening-room-panel" role="status" aria-live="polite" data-testid="listening-room-panel"
      data-role={room.role ?? undefined}>
      <span className={`listening-room-dot listening-room-dot--${tone}`} aria-hidden="true" />
      <span className="listening-room-label">
        {room.title && <span className="listening-room-title">{room.title}</span>}
        <span data-testid="listening-room-status">{label}</span>
      </span>
      {!isHost && room.sync.needsUserGesture && (
        <button type="button" className="listening-room-button listening-room-button--primary" onClick={onStartListening}>
          ▶ Start listening
        </button>
      )}
      {isHost ? (
        <button type="button" className="listening-room-button" onClick={onCopyLink} title="Copy join link">
          🔗 Copy link
        </button>
      ) : (
        <button type="button" className="listening-room-button" onClick={onResync}
          title="Ask the host for the current position">
          Resync
        </button>
      )}
      <button type="button" className="listening-room-button" onClick={() => {
        if (!isHost || window.confirm('End the listening room for everyone?')) onLeave();
      }}>
        {isHost ? 'End room' : 'Leave'}
      </button>
    </div>
  );
};
