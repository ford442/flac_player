"""
Saved playlists (CRUD) for the FLAC Player API.

Reference implementation of the contract documented in docs/API.md. Unlike share
links (immutable, expiring snapshots in ``/api/share``), a playlist is a named,
editable, persistent list of track ids stored in ``data/playlists/index.json``.

Production ``storage.noahcohn.com`` must mirror these routes to enable cloud sync;
the frontend keeps working local-first (IndexedDB) when they are missing.
"""

import asyncio
import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field, field_validator

MAX_TRACKS_PER_PLAYLIST = 5000


def _clean_title(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("title must not be empty")
    return value


class PlaylistCreate(BaseModel):
    """POST /api/playlists body."""
    title: str = Field(..., max_length=200)
    description: Optional[str] = Field("", max_length=2000)
    track_ids: List[str] = Field(default_factory=list, max_length=MAX_TRACKS_PER_PLAYLIST)

    _title = field_validator("title")(_clean_title)


class PlaylistReplace(PlaylistCreate):
    """PUT /api/playlists/{id} body — replaces title, description and track ids."""


class PlaylistPatch(BaseModel):
    """PATCH /api/playlists/{id} body — only the fields that are sent change."""
    title: Optional[str] = Field(None, max_length=200)
    description: Optional[str] = Field(None, max_length=2000)
    track_ids: Optional[List[str]] = Field(None, max_length=MAX_TRACKS_PER_PLAYLIST)

    @field_validator("title")
    @classmethod
    def _title(cls, value: Optional[str]) -> Optional[str]:
        return None if value is None else _clean_title(value)


class PlaylistResponse(BaseModel):
    id: str
    title: str
    description: str = ""
    track_ids: List[str]
    created_at: str
    updated_at: str


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class PlaylistStore:
    """JSON-file backed playlist storage (same persistence style as songs/index.json)."""

    def __init__(self, path: str):
        self.path = path
        self._playlists: Dict[str, Dict[str, Any]] = {}
        self._loaded = False
        self._lock = asyncio.Lock()

    def _load(self) -> None:
        if self._loaded:
            return
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            self._playlists = {item["id"]: item for item in data.get("playlists", [])}
        except FileNotFoundError:
            self._playlists = {}
        self._loaded = True

    def _save(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = f"{self.path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"playlists": list(self._playlists.values())}, f, indent=2)
        os.replace(tmp, self.path)

    async def list(self) -> List[Dict[str, Any]]:
        async with self._lock:
            self._load()
            return sorted(self._playlists.values(), key=lambda p: p["updated_at"], reverse=True)

    async def get(self, playlist_id: str) -> Optional[Dict[str, Any]]:
        async with self._lock:
            self._load()
            return self._playlists.get(playlist_id)

    async def create(self, title: str, description: str, track_ids: List[str]) -> Dict[str, Any]:
        async with self._lock:
            self._load()
            now = _now()
            playlist = {
                "id": uuid.uuid4().hex[:12],
                "title": title,
                "description": description or "",
                "track_ids": list(track_ids),
                "created_at": now,
                "updated_at": now,
            }
            self._playlists[playlist["id"]] = playlist
            self._save()
            return playlist

    async def update(self, playlist_id: str, changes: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        async with self._lock:
            self._load()
            playlist = self._playlists.get(playlist_id)
            if playlist is None:
                return None
            playlist.update(changes)
            playlist["updated_at"] = _now()
            self._save()
            return playlist

    async def delete(self, playlist_id: str) -> bool:
        async with self._lock:
            self._load()
            if self._playlists.pop(playlist_id, None) is None:
                return False
            self._save()
            return True


def build_playlist_router(store: PlaylistStore) -> APIRouter:
    router = APIRouter(prefix="/api/playlists", tags=["playlists"])

    @router.get("/health")
    async def playlists_health():
        """Write-support probe: clients enable cloud sync only when this answers."""
        return {"status": "ok", "writable": True}

    @router.get("", response_model=List[PlaylistResponse])
    async def list_playlists():
        return await store.list()

    @router.post("", response_model=PlaylistResponse, status_code=201)
    async def create_playlist(body: PlaylistCreate):
        return await store.create(body.title, body.description or "", body.track_ids)

    @router.get("/{playlist_id}", response_model=PlaylistResponse)
    async def get_playlist(playlist_id: str):
        playlist = await store.get(playlist_id)
        if playlist is None:
            raise HTTPException(status_code=404, detail="Playlist not found")
        return playlist

    @router.put("/{playlist_id}", response_model=PlaylistResponse)
    async def replace_playlist(playlist_id: str, body: PlaylistReplace):
        playlist = await store.update(playlist_id, {
            "title": body.title,
            "description": body.description or "",
            "track_ids": list(body.track_ids),
        })
        if playlist is None:
            raise HTTPException(status_code=404, detail="Playlist not found")
        return playlist

    @router.patch("/{playlist_id}", response_model=PlaylistResponse)
    async def patch_playlist(playlist_id: str, body: PlaylistPatch):
        playlist = await store.update(playlist_id, body.model_dump(exclude_none=True))
        if playlist is None:
            raise HTTPException(status_code=404, detail="Playlist not found")
        return playlist

    @router.delete("/{playlist_id}", status_code=204)
    async def delete_playlist(playlist_id: str):
        if not await store.delete(playlist_id):
            raise HTTPException(status_code=404, detail="Playlist not found")
        return Response(status_code=204)

    return router
