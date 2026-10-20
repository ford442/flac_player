import asyncio
import json
import socket
import threading
import time
import unittest

import httpx
import uvicorn
from fastapi import FastAPI
from websockets.exceptions import InvalidStatus
from websockets.sync.client import connect as ws_connect

import rooms
from rooms import (
    Peer,
    ProtocolError,
    Room,
    RoomManager,
    apply_host_message,
    create_rooms_router,
    initial_room_state,
    origin_allowed,
)


class LiveServer:
    """Real uvicorn on an ephemeral port: one event loop, like production
    (Starlette's TestClient runs every socket on its own loop)."""

    def __init__(self, allowed_origins=("*",), grace=30.0):
        self.manager = RoomManager(host_grace_seconds=grace)
        app = FastAPI()
        app.include_router(create_rooms_router(
            self.manager,
            app_base_url="https://player.example",
            allowed_origins=list(allowed_origins),
        ))
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="warning"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.http = httpx.Client(base_url=f"http://127.0.0.1:{self.port}", timeout=5)

    def __enter__(self):
        self.thread.start()
        deadline = time.monotonic() + 10
        while not self.server.started:
            if time.monotonic() > deadline:
                raise RuntimeError("uvicorn did not start")
            time.sleep(0.02)
        return self

    def __exit__(self, *exc):
        self.http.close()
        self.server.should_exit = True
        self.thread.join(timeout=5)

    def ws(self, room_id, **kwargs):
        return ws_connect(f"ws://127.0.0.1:{self.port}/ws/rooms/{room_id}", open_timeout=5, **kwargs)


def send(ws, msg_type, payload=None):
    ws.send(json.dumps({"type": msg_type, "payload": payload or {}}))


def recv(ws):
    return json.loads(ws.recv(timeout=5))


def join(ws, role, **payload):
    send(ws, "JOIN", {"role": role, **payload})
    return recv(ws), recv(ws), recv(ws)  # JOINED, STATE_SNAPSHOT, PRESENCE


def receive_until(ws, msg_type, limit=10):
    for _ in range(limit):
        message = recv(ws)
        if message["type"] == msg_type:
            return message
    raise AssertionError(f"{msg_type} not received")


class ApplyHostMessageTest(unittest.TestCase):
    def setUp(self):
        self.state = initial_room_state("room1", "Mix", ["a", "b"], now_ms=1_000)

    def test_play_sets_reference_and_bumps_revision(self):
        out = apply_host_message(self.state, "PLAY", {"trackId": "a", "position": 12.5, "sampledAt": 1_900}, now_ms=2_000)
        self.assertEqual(out, {
            "trackId": "a", "trackIndex": -1, "position": 12.5,
            "positionUpdatedAt": 1_900, "playing": True, "rate": 1.0,
        })
        self.assertEqual(self.state["revision"], 1)

    def test_pause_and_heartbeat_keep_track(self):
        apply_host_message(self.state, "PLAY", {"trackId": "a", "position": 1}, now_ms=2_000)
        apply_host_message(self.state, "PAUSE", {"position": 3}, now_ms=4_000)
        self.assertFalse(self.state["playing"])
        self.assertEqual(self.state["trackId"], "a")
        apply_host_message(self.state, "HEARTBEAT", {"position": 3, "playing": False}, now_ms=9_000)
        self.assertEqual(self.state["revision"], 3)

    def test_sampled_at_from_bad_clock_falls_back_to_receive_time(self):
        out = apply_host_message(self.state, "SEEK", {"trackId": "a", "position": 5, "sampledAt": 99_999}, now_ms=2_000)
        self.assertEqual(out["positionUpdatedAt"], 2_000)
        out = apply_host_message(self.state, "SEEK", {"trackId": "a", "position": 5, "sampledAt": 1}, now_ms=60_000)
        self.assertEqual(out["positionUpdatedAt"], 60_000)

    def test_track_change_updates_queue_index(self):
        apply_host_message(self.state, "TRACK_CHANGE", {"trackId": "b", "trackIndex": 1, "position": 0, "playing": False}, now_ms=2_000)
        self.assertEqual(self.state["trackId"], "b")
        self.assertEqual(self.state["queue"]["currentIndex"], 1)

    def test_clamps_position_and_rate(self):
        out = apply_host_message(self.state, "SEEK", {"trackId": "a", "position": -4, "rate": 99}, now_ms=2_000)
        self.assertEqual(out["position"], 0.0)
        self.assertEqual(out["rate"], rooms.MAX_RATE)

    def test_queue_update(self):
        out = apply_host_message(self.state, "QUEUE_UPDATE", {
            "trackIds": ["c", "d"], "currentIndex": 1, "shuffle": True, "repeat": "all",
        }, now_ms=2_000)
        self.assertEqual(out, {"trackIds": ["c", "d"], "currentIndex": 1, "shuffle": True, "repeat": "all"})

    def test_rejects_invalid_payloads(self):
        with self.assertRaises(ProtocolError):
            apply_host_message(self.state, "PLAY", {"position": "soon"}, now_ms=2_000)
        with self.assertRaises(ProtocolError):
            apply_host_message(self.state, "PLAY", {"position": float("nan")}, now_ms=2_000)
        with self.assertRaises(ProtocolError):
            apply_host_message(self.state, "QUEUE_UPDATE", {"trackIds": ["a"], "repeat": "forever"}, now_ms=2_000)
        with self.assertRaises(ProtocolError):
            apply_host_message(self.state, "QUEUE_UPDATE", {"trackIds": ["a", None]}, now_ms=2_000)
        with self.assertRaises(ProtocolError):
            apply_host_message(self.state, "JOIN", {}, now_ms=2_000)
        self.assertEqual(self.state["revision"], 0)


class LimitsTest(unittest.TestCase):
    def test_origin_allowed(self):
        self.assertTrue(origin_allowed("https://evil.example", ["*"]))
        self.assertTrue(origin_allowed("https://app.example/", ["https://app.example"]))
        self.assertFalse(origin_allowed("https://evil.example", ["https://app.example"]))
        self.assertTrue(origin_allowed(None, ["https://app.example"]))

    def test_control_token_bucket(self):
        room = Room("r", "t", "token", time.time() + 60, initial_room_state("r", "t", [], 0))
        start = room.control_refill_at
        taken = sum(room.take_control_token(start) for _ in range(20))
        self.assertEqual(taken, int(rooms.CONTROL_BURST))
        self.assertFalse(room.take_control_token(start))
        self.assertTrue(room.take_control_token(start + 1.0))


class RoomSocketTest(unittest.TestCase):
    def setUp(self):
        self.live = LiveServer(grace=0.3).__enter__()
        self.addCleanup(self.live.__exit__, None, None, None)
        created = self.live.http.post("/api/rooms", json={"title": "Friday", "track_ids": ["a", "b"]})
        self.assertEqual(created.status_code, 200)
        self.room = created.json()
        self.room_id = self.room["room_id"]

    def test_create_and_info(self):
        self.assertEqual(self.room["join_url"], f"https://player.example/?room={self.room_id}")
        self.assertTrue(self.room["ws_url"].endswith(f"/ws/rooms/{self.room_id}"))
        info = self.live.http.get(f"/api/rooms/{self.room_id}").json()
        self.assertEqual(info["title"], "Friday")
        self.assertEqual(info["track_count"], 2)
        self.assertFalse(info["host_connected"])
        self.assertEqual(self.live.http.get("/api/rooms/missing").status_code, 404)
        redirect = self.live.http.get(f"/room/{self.room_id}")
        self.assertEqual(redirect.headers["location"], f"/?room={self.room_id}")

    def test_host_events_reach_guests(self):
        with self.live.ws(self.room_id) as host:
            joined, snapshot, _ = join(host, "host", hostToken=self.room["host_token"])
            self.assertEqual(joined["payload"]["role"], "host")
            self.assertEqual(snapshot["payload"]["queue"]["trackIds"], ["a", "b"])

            with self.live.ws(self.room_id) as guest:
                joined, snapshot, presence = join(guest, "guest", clientId="g1")
                self.assertEqual(joined["payload"]["role"], "guest")
                self.assertTrue(snapshot["payload"]["hostConnected"])
                self.assertEqual(presence["payload"], {"guestCount": 1, "hostConnected": True})
                self.assertEqual(receive_until(host, "PRESENCE")["payload"]["guestCount"], 1)

                send(host, "PLAY", {"trackId": "a", "trackIndex": 0, "position": 4.0})
                play = receive_until(guest, "PLAY")
                self.assertEqual(play["payload"]["trackId"], "a")
                self.assertTrue(play["payload"]["playing"])
                self.assertEqual(play["revision"], 1)
                self.assertIsInstance(play["serverTime"], int)

                send(host, "PAUSE", {"trackId": "a", "position": 6.0})
                self.assertFalse(receive_until(guest, "PAUSE")["payload"]["playing"])

                send(guest, "TIME_SYNC", {"t0": 123})
                self.assertEqual(receive_until(guest, "TIME_SYNC")["payload"], {"t0": 123})

                send(guest, "SEEK", {"position": 1})
                self.assertEqual(receive_until(guest, "ERROR")["payload"]["code"], "forbidden")

                send(guest, "RESYNC_REQUEST")
                resync = receive_until(guest, "STATE_SNAPSHOT")
                self.assertEqual(resync["payload"]["position"], 6.0)
                self.assertFalse(resync["payload"]["playing"])

                send(host, "LEAVE")
                closed = receive_until(guest, "ROOM_CLOSED")
                self.assertEqual(closed["payload"]["reason"], "host_left")
        self.assertEqual(self.live.manager.active_count(), 0)

    def test_rejects_bad_host_token(self):
        with self.live.ws(self.room_id) as ws:
            send(ws, "JOIN", {"role": "host", "hostToken": "nope"})
            error = recv(ws)
            self.assertEqual(error["type"], "ERROR")
            self.assertEqual(error["payload"]["code"], "forbidden")

    def test_unknown_room(self):
        with self.live.ws("nope") as ws:
            self.assertEqual(recv(ws)["payload"]["code"], "room_not_found")

    def test_delete_requires_token_and_closes_room(self):
        with self.live.ws(self.room_id) as guest:
            join(guest, "guest")
            self.assertEqual(self.live.http.delete(f"/api/rooms/{self.room_id}").status_code, 403)
            response = self.live.http.delete(
                f"/api/rooms/{self.room_id}", headers={"X-Host-Token": self.room["host_token"]},
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(receive_until(guest, "ROOM_CLOSED")["payload"]["reason"], "deleted")

    def test_host_disconnect_closes_room_after_grace(self):
        with self.live.ws(self.room_id) as guest:
            join(guest, "guest")
            with self.live.ws(self.room_id) as host:
                join(host, "host", hostToken=self.room["host_token"])
            presence = receive_until(guest, "PRESENCE")
            while presence["payload"]["hostConnected"]:
                presence = receive_until(guest, "PRESENCE")
            self.assertEqual(self.live.manager.active_count(), 1)  # grace: a reload can reclaim it
            self.assertEqual(receive_until(guest, "ROOM_CLOSED")["payload"]["reason"], "host_left")
        self.assertEqual(self.live.manager.active_count(), 0)

    def test_host_reconnect_within_grace_keeps_room(self):
        with self.live.ws(self.room_id) as guest:
            join(guest, "guest")
            with self.live.ws(self.room_id) as host:
                join(host, "host", hostToken=self.room["host_token"])
            with self.live.ws(self.room_id) as host:
                join(host, "host", hostToken=self.room["host_token"])
                time.sleep(0.5)
                self.assertEqual(self.live.manager.active_count(), 1)
                send(host, "SEEK", {"trackId": "a", "position": 9})
                self.assertEqual(receive_until(guest, "SEEK")["payload"]["position"], 9)

    def test_rejects_disallowed_origin(self):
        with LiveServer(allowed_origins=("https://app.example",)) as live:
            room = live.http.post("/api/rooms", json={}).json()
            with self.assertRaises(InvalidStatus):
                live.ws(room["room_id"], origin="https://evil.example")
            with live.ws(room["room_id"], origin="https://app.example") as ws:
                join(ws, "guest")


class FakeSocket:
    def __init__(self):
        self.sent = []
        self.closed_with = None

    async def send_text(self, text):
        self.sent.append(json.loads(text))

    async def close(self, code=1000, reason=""):
        self.closed_with = code


class HostGraceTest(unittest.TestCase):
    """Grace timer and sweeper driven directly on one event loop."""

    def test_room_closes_when_host_does_not_return(self):
        async def scenario():
            manager = RoomManager(host_grace_seconds=0.01)
            room = manager.create("t", [], 60)
            socket = FakeSocket()
            room.guests["g"] = Peer(socket, "guest", "g")
            manager.start_host_grace(room)
            await asyncio.sleep(0.05)
            return manager, socket

        manager, socket = asyncio.run(scenario())
        self.assertEqual(manager.active_count(), 0)
        self.assertEqual(socket.sent[-1]["type"], "ROOM_CLOSED")
        self.assertEqual(socket.sent[-1]["payload"], {"reason": "host_left"})
        self.assertEqual(socket.closed_with, rooms.CLOSE_ROOM_ENDED)

    def test_host_reconnect_cancels_grace(self):
        async def scenario():
            manager = RoomManager(host_grace_seconds=0.02)
            room = manager.create("t", [], 60)
            manager.start_host_grace(room)
            room.host = Peer(FakeSocket(), "host", "h")
            room.grace_task.cancel()
            await asyncio.sleep(0.05)
            return manager

        self.assertEqual(asyncio.run(scenario()).active_count(), 1)

    def test_sweep_closes_expired_rooms(self):
        async def scenario():
            manager = RoomManager()
            room = manager.create("t", [], 60)
            room.expires_at = time.time() - 1
            return manager, await manager.sweep()

        manager, swept = asyncio.run(scenario())
        self.assertEqual(swept, 1)
        self.assertEqual(manager.active_count(), 0)


if __name__ == "__main__":
    unittest.main()
