"""Round-trip tests for the playlist CRUD contract (docs/API.md → Playlists)."""
import importlib
import os
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture()
def client(monkeypatch):
    """The real app, with DATA_DIR pointed at a throwaway directory."""
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("DATA_DIR", tmp)
        sys.modules.pop("app", None)
        app_module = importlib.import_module("app")
        with TestClient(app_module.app) as c:
            c.data_dir = tmp
            yield c
        sys.modules.pop("app", None)


def test_create_get_list_round_trip(client):
    created = client.post("/api/playlists", json={
        "title": "  Night drive ", "description": "synthwave", "track_ids": ["a", "b", "c"],
    })
    assert created.status_code == 201
    body = created.json()
    assert body["title"] == "Night drive"
    assert body["track_ids"] == ["a", "b", "c"]
    assert body["updated_at"]

    fetched = client.get(f"/api/playlists/{body['id']}")
    assert fetched.status_code == 200
    assert fetched.json() == body

    listed = client.get("/api/playlists").json()
    assert [p["id"] for p in listed] == [body["id"]]
    assert set(listed[0]) >= {"id", "title", "description", "track_ids", "updated_at"}


def test_put_replaces_and_patch_merges(client):
    pid = client.post("/api/playlists", json={"title": "One", "description": "d", "track_ids": ["a"]}).json()["id"]

    replaced = client.put(f"/api/playlists/{pid}", json={"title": "Two", "track_ids": ["b", "a"]}).json()
    assert (replaced["title"], replaced["description"], replaced["track_ids"]) == ("Two", "", ["b", "a"])

    patched = client.patch(f"/api/playlists/{pid}", json={"description": "new"}).json()
    assert (patched["title"], patched["description"], patched["track_ids"]) == ("Two", "new", ["b", "a"])
    assert patched["updated_at"] >= replaced["updated_at"]


def test_delete_then_404(client):
    pid = client.post("/api/playlists", json={"title": "Gone", "track_ids": []}).json()["id"]
    assert client.delete(f"/api/playlists/{pid}").status_code == 204
    assert client.get(f"/api/playlists/{pid}").status_code == 404
    assert client.delete(f"/api/playlists/{pid}").status_code == 404
    assert client.put(f"/api/playlists/{pid}", json={"title": "x", "track_ids": []}).status_code == 404
    assert client.patch(f"/api/playlists/{pid}", json={"title": "x"}).status_code == 404


def test_validation(client):
    assert client.post("/api/playlists", json={"title": "   ", "track_ids": []}).status_code == 422
    assert client.post("/api/playlists", json={"track_ids": []}).status_code == 422
    pid = client.post("/api/playlists", json={"title": "ok", "track_ids": []}).json()["id"]
    assert client.patch(f"/api/playlists/{pid}", json={"title": ""}).status_code == 422


def test_persists_next_to_songs_index(client):
    client.post("/api/playlists", json={"title": "Persisted", "track_ids": ["x"]})
    assert os.path.exists(os.path.join(client.data_dir, "playlists", "index.json"))

    # A fresh store reading the same file sees the playlist (survives restart).
    from playlists import PlaylistStore
    import asyncio
    store = PlaylistStore(os.path.join(client.data_dir, "playlists", "index.json"))
    assert [p["title"] for p in asyncio.run(store.list())] == ["Persisted"]


def test_health_probe_is_not_shadowed_by_id_route(client):
    res = client.get("/api/playlists/health")
    assert res.status_code == 200
    assert res.json()["writable"] is True


def test_share_links_unaffected(client):
    assert client.get("/api/share/does-not-exist").status_code == 404
