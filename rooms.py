"""
Synced listening rooms — host-authoritative WebSocket signaling (#209).

A host creates a room over REST, then drives playback over
``/ws/rooms/{room_id}``; guests follow the same track and playhead.
Protocol: docs/LISTENING_ROOMS.md.

The MVP keeps every room in process memory, so run uvicorn with a single
worker (or move ``RoomManager`` onto Redis) before scaling out. The router is
self-contained so the production bridge can mount it with ``include_router``.
"""

import asyncio
import json
import logging
import math
import os
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence
from urllib.parse import quote

from fastapi import APIRouter, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from url_shortener import URLShortener

logger = logging.getLogger(__name__)

# =============================================================================
# Limits
# =============================================================================

ROOM_ID_LENGTH = 10
MAX_GUESTS = int(os.getenv("ROOM_MAX_GUESTS", "20"))
MAX_ACTIVE_ROOMS = int(os.getenv("ROOM_MAX_ACTIVE", "200"))
HOST_GRACE_SECONDS = float(os.getenv("ROOM_HOST_GRACE_SECONDS", "30"))
DEFAULT_EXPIRES_MINUTES = 240
MAX_EXPIRES_MINUTES = 24 * 60
JOIN_TIMEOUT_SECONDS = 10.0
SEND_TIMEOUT_SECONDS = 5.0
SWEEP_INTERVAL_SECONDS = 60.0

# Host control budget: 2 messages/s sustained, bursts allowed for seek scrubbing.
CONTROL_RATE_PER_SECOND = 2.0
CONTROL_BURST = 8.0
HEARTBEAT_MIN_INTERVAL_SECONDS = 3.0

# Room creation budget per client address.
CREATE_RATE_LIMIT_MAX = int(os.getenv("ROOM_CREATE_RATE_LIMIT_MAX", "10"))
CREATE_RATE_LIMIT_WINDOW = 600.0

MAX_TRACK_ID_LENGTH = 128
MAX_QUEUE_LENGTH = 1000
MAX_POSITION_SECONDS = 24 * 3600.0
MIN_RATE, MAX_RATE = 0.25, 4.0
# A host's sampledAt may trail the server clock by network latency; anything
# older than this is treated as a bad clock and replaced with receive time.
MAX_SAMPLE_AGE_MS = 10_000
MAX_MESSAGE_BYTES = 64 * 1024

REPEAT_MODES = ("off", "one", "all")
PLAYBACK_TYPES = ("PLAY", "PAUSE", "SEEK", "TRACK_CHANGE", "HEARTBEAT")
CONTROL_TYPES = PLAYBACK_TYPES + ("QUEUE_UPDATE",)

# Close codes (4000–4999 are application-defined). Clients do not reconnect on these.
CLOSE_ROOM_ENDED = 4000
CLOSE_REPLACED = 4001
CLOSE_FORBIDDEN = 4403
CLOSE_NOT_FOUND = 4404
CLOSE_ROOM_FULL = 4429


def server_time_ms() -> int:
    """Wall-clock milliseconds; clients estimate their offset against this."""
    return int(time.time() * 1000)


def _iso(epoch_seconds: float) -> str:
    return datetime.fromtimestamp(epoch_seconds, tz=timezone.utc).isoformat().replace("+00:00", "Z")


# =============================================================================
# Models
# =============================================================================

class RoomCreateRequest(BaseModel):
    title: Optional[str] = Field(None, max_length=120)
    track_ids: List[str] = Field(default_factory=list, max_length=MAX_QUEUE_LENGTH)
    expires_in_minutes: int = Field(DEFAULT_EXPIRES_MINUTES, ge=5, le=MAX_EXPIRES_MINUTES)


class RoomCreateResponse(BaseModel):
    room_id: str
    host_token: str
    join_url: str
    ws_url: str
    expires_at: str


class RoomInfoResponse(BaseModel):
    room_id: str
    title: str
    track_count: int
    guest_count: int
    host_connected: bool
    expires_at: str


# =============================================================================
# Pure state transitions (unit-tested without sockets)
# =============================================================================

class ProtocolError(ValueError):
    """A client message that cannot be applied; reported back as ERROR."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def initial_room_state(room_id: str, title: str, track_ids: Sequence[str], now_ms: int) -> Dict[str, Any]:
    return {
        "roomId": room_id,
        "title": title,
        "hostConnected": False,
        "trackId": None,
        "trackIndex": -1,
        "position": 0.0,
        "positionUpdatedAt": now_ms,
        "playing": False,
        "rate": 1.0,
        "queue": {
            "trackIds": list(track_ids),
            "currentIndex": 0 if track_ids else -1,
            "shuffle": False,
            "repeat": "off",
        },
        "revision": 0,
    }


def _number(value: Any, name: str, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ProtocolError("invalid_payload", f"{name} must be a finite number")
    return float(min(high, max(low, value)))


def _track_id(value: Any) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str) or not value or len(value) > MAX_TRACK_ID_LENGTH:
        raise ProtocolError("invalid_payload", "trackId must be a non-empty string")
    return value


def _index(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ProtocolError("invalid_payload", f"{name} must be an integer")
    return max(-1, min(MAX_QUEUE_LENGTH, value))


def playback_reference(state: Dict[str, Any]) -> Dict[str, Any]:
    """The subset of room state a guest needs to place its playhead."""
    return {
        "trackId": state["trackId"],
        "trackIndex": state["trackIndex"],
        "position": state["position"],
        "positionUpdatedAt": state["positionUpdatedAt"],
        "playing": state["playing"],
        "rate": state["rate"],
    }


def apply_host_message(state: Dict[str, Any], msg_type: str, payload: Any, now_ms: int) -> Dict[str, Any]:
    """
    Apply one host control message to ``state`` in place and return the
    payload to broadcast. Playback messages broadcast the full playback
    reference so guests never merge partial updates. Raises ProtocolError.
    """
    if msg_type not in CONTROL_TYPES:
        raise ProtocolError("unknown_type", f"Unsupported message type: {msg_type}")
    if not isinstance(payload, dict):
        raise ProtocolError("invalid_payload", "payload must be an object")

    if msg_type == "QUEUE_UPDATE":
        track_ids = payload.get("trackIds")
        if not isinstance(track_ids, list) or len(track_ids) > MAX_QUEUE_LENGTH:
            raise ProtocolError("invalid_payload", "trackIds must be a list")
        cleaned = [_track_id(t) for t in track_ids]
        if any(t is None for t in cleaned):
            raise ProtocolError("invalid_payload", "trackIds must be strings")
        repeat = payload.get("repeat", state["queue"]["repeat"])
        if repeat not in REPEAT_MODES:
            raise ProtocolError("invalid_payload", "repeat must be off, one, or all")
        queue = {
            "trackIds": cleaned,
            "currentIndex": _index(payload.get("currentIndex", -1), "currentIndex"),
            "shuffle": bool(payload.get("shuffle", False)),
            "repeat": repeat,
        }
        state["queue"] = queue
        state["revision"] += 1
        return dict(queue)

    position = _number(payload.get("position", 0.0), "position", 0.0, MAX_POSITION_SECONDS)
    track_id = _track_id(payload.get("trackId", state["trackId"]))

    sampled_at = payload.get("sampledAt")
    if isinstance(sampled_at, (int, float)) and not isinstance(sampled_at, bool) and math.isfinite(sampled_at):
        sampled_at = int(sampled_at)
        if sampled_at > now_ms or now_ms - sampled_at > MAX_SAMPLE_AGE_MS:
            sampled_at = now_ms
    else:
        sampled_at = now_ms

    if msg_type == "PLAY":
        playing = True
    elif msg_type == "PAUSE":
        playing = False
    elif "playing" in payload:
        playing = bool(payload["playing"])
    else:
        playing = state["playing"]

    if "rate" in payload:
        state["rate"] = _number(payload["rate"], "rate", MIN_RATE, MAX_RATE)
    if "trackIndex" in payload:
        state["trackIndex"] = _index(payload["trackIndex"], "trackIndex")
        state["queue"]["currentIndex"] = state["trackIndex"]

    state["trackId"] = track_id
    state["position"] = position
    state["positionUpdatedAt"] = sampled_at
    state["playing"] = playing
    state["revision"] += 1
    return playback_reference(state)


def envelope(msg_type: str, room_id: str, payload: Any, revision: Optional[int] = None) -> Dict[str, Any]:
    message: Dict[str, Any] = {
        "type": msg_type,
        "roomId": room_id,
        "serverTime": server_time_ms(),
        "payload": payload,
    }
    if revision is not None:
        message["revision"] = revision
    return message


def origin_allowed(origin: Optional[str], allowed_origins: Sequence[str]) -> bool:
    """Mirror CORSMiddleware for the WebSocket handshake (which CORS does not cover)."""
    if "*" in allowed_origins:
        return True
    if not origin:
        # Non-browser clients (CLI tools, tests) send no Origin header.
        return True
    return origin.rstrip("/") in {o.rstrip("/") for o in allowed_origins}


# =============================================================================
# Live rooms
# =============================================================================

@dataclass
class Peer:
    ws: WebSocket
    role: str
    client_id: str
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send(self, message: Dict[str, Any]) -> bool:
        try:
            async with self.lock:
                await asyncio.wait_for(self.ws.send_text(json.dumps(message)), SEND_TIMEOUT_SECONDS)
            return True
        except Exception:  # disconnected or stalled peer; its own loop cleans up
            return False

    async def close(self, code: int, reason: str = "") -> None:
        try:
            await self.ws.close(code=code, reason=reason)
        except Exception:
            pass


@dataclass
class Room:
    room_id: str
    title: str
    host_token: str
    expires_at: float
    state: Dict[str, Any]
    host: Optional[Peer] = None
    guests: Dict[str, Peer] = field(default_factory=dict)
    grace_task: Optional[asyncio.Task] = None
    closed: bool = False
    control_tokens: float = CONTROL_BURST
    control_refill_at: float = field(default_factory=time.monotonic)
    last_heartbeat_at: float = 0.0

    def is_expired(self, now: Optional[float] = None) -> bool:
        return (now if now is not None else time.time()) >= self.expires_at

    def presence(self) -> Dict[str, Any]:
        return {"guestCount": len(self.guests), "hostConnected": self.host is not None}

    def peers(self) -> List[Peer]:
        return ([self.host] if self.host else []) + list(self.guests.values())

    def take_control_token(self, now: Optional[float] = None) -> bool:
        now = now if now is not None else time.monotonic()
        elapsed = max(0.0, now - self.control_refill_at)
        self.control_refill_at = now
        self.control_tokens = min(CONTROL_BURST, self.control_tokens + elapsed * CONTROL_RATE_PER_SECOND)
        if self.control_tokens < 1.0:
            return False
        self.control_tokens -= 1.0
        return True


class RoomManager:
    """Owns every live room in this process."""

    def __init__(self, host_grace_seconds: float = HOST_GRACE_SECONDS):
        self.rooms: Dict[str, Room] = {}
        self.host_grace_seconds = host_grace_seconds
        self._create_log: Dict[str, List[float]] = {}

    def active_count(self) -> int:
        return len(self.rooms)

    def check_create_rate(self, client: str) -> None:
        now = time.monotonic()
        recent = [t for t in self._create_log.get(client, []) if t > now - CREATE_RATE_LIMIT_WINDOW]
        if len(recent) >= CREATE_RATE_LIMIT_MAX:
            raise HTTPException(status_code=429, detail="Too many rooms created. Try again later.")
        recent.append(now)
        self._create_log[client] = recent

    def create(self, title: str, track_ids: Sequence[str], expires_in_minutes: int) -> Room:
        if len(self.rooms) >= MAX_ACTIVE_ROOMS:
            raise HTTPException(status_code=503, detail="Too many active listening rooms")
        room_id = URLShortener.generate_short_id(ROOM_ID_LENGTH)
        while room_id in self.rooms:
            room_id = URLShortener.generate_short_id(ROOM_ID_LENGTH)
        room = Room(
            room_id=room_id,
            title=title,
            host_token=secrets.token_urlsafe(32),
            expires_at=time.time() + expires_in_minutes * 60,
            state=initial_room_state(room_id, title, track_ids, server_time_ms()),
        )
        self.rooms[room_id] = room
        return room

    def get(self, room_id: str) -> Optional[Room]:
        return self.rooms.get(room_id)

    async def get_live(self, room_id: str) -> Optional[Room]:
        """Return the room unless it is missing or expired (expired rooms are closed)."""
        room = self.rooms.get(room_id)
        if room and room.is_expired():
            await self.close_room(room, "expired")
            return None
        return room

    async def broadcast(self, room: Room, message: Dict[str, Any], exclude: Optional[Peer] = None) -> None:
        targets = [p for p in room.peers() if p is not exclude]
        if targets:
            await asyncio.gather(*(p.send(message) for p in targets))

    async def broadcast_presence(self, room: Room) -> None:
        room.state["hostConnected"] = room.host is not None
        await self.broadcast(room, envelope("PRESENCE", room.room_id, room.presence()))

    async def close_room(self, room: Room, reason: str) -> None:
        if room.closed:
            return
        room.closed = True
        self.rooms.pop(room.room_id, None)
        if room.grace_task and room.grace_task is not asyncio.current_task():
            room.grace_task.cancel()
        peers = room.peers()
        room.host = None
        room.guests = {}
        message = envelope("ROOM_CLOSED", room.room_id, {"reason": reason})
        for peer in peers:
            await peer.send(message)
            await peer.close(CLOSE_ROOM_ENDED, reason)

    def start_host_grace(self, room: Room) -> None:
        async def expire_after_grace() -> None:
            try:
                await asyncio.sleep(self.host_grace_seconds)
            except asyncio.CancelledError:
                return
            if room.host is None and not room.closed:
                await self.close_room(room, "host_left")

        if room.grace_task:
            room.grace_task.cancel()
        room.grace_task = asyncio.create_task(expire_after_grace())

    async def sweep(self) -> int:
        now = time.time()
        expired = [room for room in self.rooms.values() if room.is_expired(now)]
        for room in expired:
            await self.close_room(room, "expired")
        return len(expired)

    async def run_sweeper(self, interval: float = SWEEP_INTERVAL_SECONDS) -> None:
        while True:
            await asyncio.sleep(interval)
            try:
                await self.sweep()
            except Exception:
                logger.exception("Listening room sweep failed")

    async def shutdown(self) -> None:
        for room in list(self.rooms.values()):
            await self.close_room(room, "server_shutdown")


# =============================================================================
# Router
# =============================================================================

def _client_key(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _ws_base_url(request: Request, override: Optional[str]) -> str:
    if override:
        return override.rstrip("/")
    proto = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    host = request.headers.get("x-forwarded-host", request.headers.get("host", request.url.netloc))
    scheme = "wss" if proto in ("https", "wss") else "ws"
    return f"{scheme}://{host}"


async def _receive_json(ws: WebSocket) -> Optional[Dict[str, Any]]:
    """Next JSON object from the socket; None for malformed frames (caller reports)."""
    raw = await ws.receive_text()
    if len(raw) > MAX_MESSAGE_BYTES:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) and isinstance(data.get("type"), str) else None


def create_rooms_router(
    manager: RoomManager,
    *,
    app_base_url: str,
    allowed_origins: Sequence[str],
    public_ws_base_url: Optional[str] = None,
) -> APIRouter:
    router = APIRouter()

    @router.post("/api/rooms", response_model=RoomCreateResponse)
    async def create_room(body: RoomCreateRequest, request: Request):
        manager.check_create_rate(_client_key(request))
        track_ids = [t for t in body.track_ids if isinstance(t, str) and 0 < len(t) <= MAX_TRACK_ID_LENGTH]
        room = manager.create(body.title or "Listening room", track_ids, body.expires_in_minutes)
        return RoomCreateResponse(
            room_id=room.room_id,
            host_token=room.host_token,
            join_url=f"{app_base_url.rstrip('/')}/?room={room.room_id}",
            ws_url=f"{_ws_base_url(request, public_ws_base_url)}/ws/rooms/{room.room_id}",
            expires_at=_iso(room.expires_at),
        )

    @router.get("/api/rooms/{room_id}", response_model=RoomInfoResponse)
    async def get_room(room_id: str):
        room = await manager.get_live(room_id)
        if not room:
            raise HTTPException(status_code=404, detail="Room not found or ended")
        return RoomInfoResponse(
            room_id=room.room_id,
            title=room.title,
            track_count=len(room.state["queue"]["trackIds"]),
            guest_count=len(room.guests),
            host_connected=room.host is not None,
            expires_at=_iso(room.expires_at),
        )

    @router.delete("/api/rooms/{room_id}")
    async def delete_room(room_id: str, x_host_token: Optional[str] = Header(None)):
        room = manager.get(room_id)
        if not room:
            raise HTTPException(status_code=404, detail="Room not found or ended")
        if not x_host_token or not secrets.compare_digest(x_host_token, room.host_token):
            raise HTTPException(status_code=403, detail="Host token required")
        await manager.close_room(room, "deleted")
        return {"status": "deleted", "room_id": room_id}

    @router.get("/room/{room_id}", include_in_schema=False)
    async def room_link(room_id: str):
        """Pretty link → the SPA's `?room=` form (like /playlist/{id} → ?share=)."""
        return RedirectResponse(url=f"/?room={quote(room_id, safe='')}")

    @router.websocket("/ws/rooms/{room_id}")
    async def room_socket(websocket: WebSocket, room_id: str):
        if not origin_allowed(websocket.headers.get("origin"), allowed_origins):
            await websocket.close(code=1008)
            return
        await websocket.accept()

        async def reject(code: str, message: str, close_code: int) -> None:
            try:
                await websocket.send_text(json.dumps(envelope("ERROR", room_id, {"code": code, "message": message})))
                await websocket.close(code=close_code, reason=code)
            except Exception:
                pass

        room = await manager.get_live(room_id)
        if not room:
            await reject("room_not_found", "Room not found or ended", CLOSE_NOT_FOUND)
            return

        try:
            join = await asyncio.wait_for(_receive_json(websocket), JOIN_TIMEOUT_SECONDS)
        except (asyncio.TimeoutError, WebSocketDisconnect):
            await reject("join_timeout", "Send JOIN first", CLOSE_FORBIDDEN)
            return
        join_payload = join.get("payload") if join and join.get("type") == "JOIN" else None
        if not isinstance(join_payload, dict):
            await reject("join_required", "First message must be JOIN", CLOSE_FORBIDDEN)
            return

        params = websocket.query_params
        role = join_payload.get("role") or params.get("role")
        client_id = join_payload.get("clientId") or params.get("client_id") or secrets.token_urlsafe(8)
        client_id = str(client_id)[:64]

        if room.closed:
            await reject("room_not_found", "Room not found or ended", CLOSE_NOT_FOUND)
            return

        if role == "host":
            token = join_payload.get("hostToken") or params.get("host_token") or ""
            if not isinstance(token, str) or not secrets.compare_digest(token, room.host_token):
                await reject("forbidden", "Invalid host token", CLOSE_FORBIDDEN)
                return
            peer = Peer(websocket, "host", client_id)
            previous = room.host
            room.host = peer
            if room.grace_task:
                room.grace_task.cancel()
                room.grace_task = None
            if previous:
                await previous.close(CLOSE_REPLACED, "replaced")
        elif role == "guest":
            previous = room.guests.get(client_id)
            if not previous and len(room.guests) >= MAX_GUESTS:
                await reject("room_full", "This room is full", CLOSE_ROOM_FULL)
                return
            peer = Peer(websocket, "guest", client_id)
            room.guests[client_id] = peer
            if previous:
                await previous.close(CLOSE_REPLACED, "replaced")
        else:
            await reject("invalid_role", "role must be host or guest", CLOSE_FORBIDDEN)
            return

        room.state["hostConnected"] = room.host is not None
        await peer.send(envelope("JOINED", room_id, {
            "role": peer.role,
            "clientId": client_id,
            **room.presence(),
        }))
        await peer.send(envelope("STATE_SNAPSHOT", room_id, room.state, room.state["revision"]))
        await manager.broadcast_presence(room)

        try:
            while not room.closed:
                message = await _receive_json(websocket)
                if message is None:
                    await peer.send(envelope("ERROR", room_id, {"code": "invalid_message", "message": "Malformed message"}))
                    continue
                msg_type = message["type"]
                payload = message.get("payload") or {}

                if msg_type == "TIME_SYNC":
                    await peer.send(envelope("TIME_SYNC", room_id, {"t0": payload.get("t0") if isinstance(payload, dict) else None}))
                elif msg_type == "RESYNC_REQUEST":
                    await peer.send(envelope("STATE_SNAPSHOT", room_id, room.state, room.state["revision"]))
                elif msg_type == "LEAVE":
                    if peer.role == "host":
                        await manager.close_room(room, "host_left")
                    break
                elif msg_type in CONTROL_TYPES:
                    if peer.role != "host":
                        await peer.send(envelope("ERROR", room_id, {"code": "forbidden", "message": "Only the host controls playback"}))
                        continue
                    if msg_type == "HEARTBEAT":
                        now = time.monotonic()
                        if now - room.last_heartbeat_at < HEARTBEAT_MIN_INTERVAL_SECONDS:
                            continue
                        room.last_heartbeat_at = now
                    elif not room.take_control_token():
                        await peer.send(envelope("ERROR", room_id, {"code": "rate_limited", "message": "Too many control messages"}))
                        continue
                    try:
                        out = apply_host_message(room.state, msg_type, payload, server_time_ms())
                    except ProtocolError as err:
                        await peer.send(envelope("ERROR", room_id, {"code": err.code, "message": err.message}))
                        continue
                    await manager.broadcast(room, envelope(msg_type, room_id, out, room.state["revision"]), exclude=peer)
                elif msg_type == "JOIN":
                    continue
                else:
                    await peer.send(envelope("ERROR", room_id, {"code": "unknown_type", "message": f"Unsupported message type: {msg_type}"}))
        except (WebSocketDisconnect, RuntimeError):
            # RuntimeError: the socket was closed from another task (replaced / room closed).
            pass
        except Exception:
            logger.exception("Listening room socket failed (room %s)", room_id)
        finally:
            if not room.closed:
                if peer.role == "host" and room.host is peer:
                    room.host = None
                    manager.start_host_grace(room)
                    await manager.broadcast_presence(room)
                elif peer.role == "guest" and room.guests.get(client_id) is peer:
                    del room.guests[client_id]
                    await manager.broadcast_presence(room)

    return router
