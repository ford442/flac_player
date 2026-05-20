"""
FLAC Player Backend - FastAPI with MusicBrainz Integration & AI Track Management

This module provides a FastAPI backend for the FLAC Player application.
Features:
- Music metadata management with JSON storage
- MusicBrainz API integration for auto-populating metadata
- AI-generated track support (generation_model, prompt, version)
- Advanced filtering, sorting, and search
- Playlist sharing with URL shortening
- Async I/O with aiocache for performance
"""

import os
import random
import logging
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, BackgroundTasks
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from models import (
    SongMetadata, SongCreate, SongUpdate, SongPatch,
    MusicBrainzResult, ShareRequest, ShareResponse,
    HealthResponse, LibraryStatsResponse, TagListResponse
)
from storage import StorageManager, parse_ai_metadata_from_filename, suggest_tags_from_prompt
from musicbrainz import MusicBrainzClient, enrich_metadata_from_musicbrainz
from url_shortener import URLShortener

# =============================================================================
# Configuration
# =============================================================================

# Environment variables with defaults for HF Space compatibility
DATA_DIR = os.getenv("DATA_DIR", "./data")
SONGS_DIR = os.path.join(DATA_DIR, "songs")
MUSIC_DIR = os.path.join(DATA_DIR, "music")
INDEX_FILE = os.path.join(SONGS_DIR, "index.json")
CACHE_TTL = int(os.getenv("CACHE_TTL", "300"))  # 5 minutes default
APP_BASE_URL = os.getenv("APP_BASE_URL", "https://flac-player.hf.space")
CORS_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ALLOWED_ORIGINS", "*").split(",")
    if origin.strip()
]

# Ensure directories exist
os.makedirs(SONGS_DIR, exist_ok=True)
os.makedirs(MUSIC_DIR, exist_ok=True)

# =============================================================================
# Global Storage
# =============================================================================

# Global storage manager
STORAGE_MAP = StorageManager(INDEX_FILE)
SHARES_MAP: Dict[str, Dict[str, Any]] = {}


# =============================================================================
# FastAPI Application
# =============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    await STORAGE_MAP._ensure_loaded()
    yield


app = FastAPI(
    title="FLAC Player API",
    description="High-fidelity audio player backend with MusicBrainz integration and AI track management",
    version="1.1.0",
    lifespan=lifespan
)

# CORS middleware for HF Space compatibility
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =============================================================================
# API Endpoints - Core
# =============================================================================

@app.get("/", response_model=HealthResponse)
async def root():
    """Root endpoint with health info."""
    songs = await STORAGE_MAP.get_all()
    return HealthResponse(
        status="healthy",
        songs_count=len(songs),
        timestamp=datetime.now().isoformat()
    )


@app.get("/api/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint."""
    songs = await STORAGE_MAP.get_all()
    return HealthResponse(
        status="healthy",
        songs_count=len(songs),
        timestamp=datetime.now().isoformat()
    )


# =============================================================================
# API Endpoints - Library with Advanced Filtering
# =============================================================================

@app.get("/api/songs", response_model=List[SongMetadata])
async def get_songs(
    # Pagination
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    # Rating filters
    rating_gte: Optional[int] = Query(None, ge=0, le=10, description="Minimum rating (inclusive)"),
    rating_lt: Optional[int] = Query(None, ge=0, le=10, description="Rating less than (exclusive)"),
    # Tag filters
    tags: Optional[str] = Query(None, description="Comma-separated tags (AND match)"),
    tags_match: Optional[int] = Query(None, ge=1, description="Minimum number of matching tags"),
    untagged: bool = Query(False, description="Only return tracks with no tags"),
    # Search
    search: Optional[str] = Query(None, description="Fuzzy search in name/author/title"),
    # Sorting
    sort_by: str = Query(
        "date",
        enum=["date", "added_date", "rating", "rating_desc", "name", "last_played", "genre", "play_count", "random"]
    ),
    sort: Optional[str] = Query(None, enum=["random"], description="Legacy sort alias"),
    sort_desc: bool = Query(True),
    # Exclude specific ID (for smart mix)
    exclude_id: Optional[str] = Query(None),
    # AI-specific filters
    generation_model: Optional[str] = Query(None, description="Filter by AI model"),
    has_prompt: Optional[bool] = Query(None, description="Filter by presence of prompt field"),
):
    """
    Get songs with advanced filtering, sorting, and pagination.
    
    Examples:
    - /api/songs?rating_gte=4&limit=50 - High rated tracks
    - /api/songs?tags=chill,ambient - Tracks with both tags
    - /api/songs?search=lofi&sort_by=play_count - Search with sort
    - /api/songs?untagged=true&rating_lt=4 - Low rated untagged tracks
    """
    try:
        songs = await STORAGE_MAP.get_all()
        
        # Apply filters
        if rating_gte is not None:
            songs = [s for s in songs if (s.get('rating') or 0) >= rating_gte]
        
        if rating_lt is not None:
            songs = [s for s in songs if (s.get('rating') or 0) < rating_lt]
        
        if untagged:
            songs = [s for s in songs if not s.get('tags') or len(s.get('tags', [])) == 0]
        
        if tags:
            required_tags = [t.strip().lower() for t in tags.split(',')]
            
            def has_matching_tags(song):
                song_tags = [t.lower() for t in song.get('tags', [])]
                matching = sum(1 for t in required_tags if t in song_tags)
                if tags_match:
                    return matching >= tags_match
                return matching == len(required_tags)
            
            songs = [s for s in songs if has_matching_tags(s)]
        
        if search:
            search_lower = search.lower()
            songs = [
                s for s in songs 
                if (
                    search_lower in (s.get('name', '')).lower() or
                    search_lower in (s.get('title', '') or '').lower() or
                    search_lower in (s.get('author', '') or '').lower() or
                    search_lower in ','.join(s.get('tags', [])).lower()
                )
            ]
        
        if exclude_id:
            songs = [s for s in songs if s.get('id') != exclude_id]
        
        if generation_model:
            songs = [s for s in songs if generation_model.lower() in (s.get('generation_model', '')).lower()]
        
        if has_prompt is not None:
            songs = [s for s in songs if (bool(s.get('prompt')) == has_prompt)]
        
        # Sorting
        effective_sort = sort_by
        if sort == "random":
            effective_sort = "random"
        if effective_sort == "added_date":
            effective_sort = "date"
        force_descending_order = effective_sort == "rating_desc"
        if force_descending_order:
            effective_sort = "rating"

        if effective_sort == "random":
            random.shuffle(songs)
        else:
            reverse = True if force_descending_order else sort_desc
            if effective_sort == "date":
                songs.sort(key=lambda x: x.get('created_at', ''), reverse=reverse)
            elif effective_sort == "rating":
                songs.sort(key=lambda x: x.get('rating') or 0, reverse=reverse)
            elif effective_sort == "name":
                songs.sort(key=lambda x: (x.get('title') or x.get('name', '')).lower(), reverse=reverse)
            elif effective_sort == "last_played":
                songs.sort(key=lambda x: x.get('last_played', ''), reverse=reverse)
            elif effective_sort == "genre":
                songs.sort(key=lambda x: x.get('genre', '').lower(), reverse=reverse)
            elif effective_sort == "play_count":
                songs.sort(key=lambda x: x.get('play_count', 0), reverse=reverse)
        
        # Pagination
        total = len(songs)
        songs = songs[offset:offset + limit]
        
        return songs
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load songs: {str(e)}")


@app.get("/api/library/songs", response_model=List[SongMetadata])
async def get_library_songs(
    limit: int = Query(1000, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """Backward-compatible library endpoint."""
    return await get_songs(limit=limit, offset=offset)


@app.get("/api/songs/tags", response_model=TagListResponse)
async def get_tags():
    """
    Get all unique tags with their frequencies.
    Sorted by frequency (most common first).
    """
    try:
        songs = await STORAGE_MAP.get_all()
        
        tag_counts: Dict[str, int] = {}
        for song in songs:
            for tag in song.get('tags', []):
                tag_counts[tag.lower()] = tag_counts.get(tag.lower(), 0) + 1
        
        # Sort by count descending, then alphabetically
        sorted_tags = sorted(
            [{'name': tag, 'count': count} for tag, count in tag_counts.items()],
            key=lambda x: (-x['count'], x['name'])
        )
        
        return {"tags": sorted_tags}
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load tags: {str(e)}")


@app.get("/api/songs/stats", response_model=LibraryStatsResponse)
async def get_stats():
    """
    Get library statistics for dashboard display.
    """
    try:
        songs = await STORAGE_MAP.get_all()
        
        total_tracks = len(songs)
        rated_4plus = sum(1 for s in songs if (s.get('rating') or 0) >= 4)
        total_duration = sum(s.get('duration', 0) for s in songs)
        total_duration_hours = round(total_duration / 3600, 1)
        total_play_count = sum(s.get('play_count', 0) for s in songs)
        untagged_count = sum(1 for s in songs if not s.get('tags') or len(s.get('tags', [])) == 0)
        trash_count = sum(1 for s in songs if s.get('rating') == 0)
        
        # Tag analysis
        tag_counts: Dict[str, int] = {}
        for song in songs:
            for tag in song.get('tags', []):
                tag_lower = tag.lower()
                tag_counts[tag_lower] = tag_counts.get(tag_lower, 0) + 1
        
        unique_tags = len(tag_counts)
        top_tags = sorted(
            [{'name': tag, 'count': count} for tag, count in tag_counts.items()],
            key=lambda x: -x['count']
        )[:10]
        
        return LibraryStatsResponse(
            total_tracks=total_tracks,
            rated_4plus=rated_4plus,
            total_duration_hours=total_duration_hours,
            total_play_count=total_play_count,
            untagged_count=untagged_count,
            trash_count=trash_count,
            unique_tags=unique_tags,
            top_tags=top_tags
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load stats: {str(e)}")


# =============================================================================
# API Endpoints - Song CRUD
# =============================================================================

@app.get("/api/songs/{item_id}", response_model=SongMetadata)
async def get_song(item_id: str):
    """Get a specific song by ID."""
    song = await STORAGE_MAP.get(item_id)
    if not song:
        raise HTTPException(status_code=404, detail="Song not found")
    return song


@app.post("/api/upload/songs", response_model=SongMetadata)
async def upload_song(
    song: SongCreate,
    background_tasks: BackgroundTasks
):
    """
    Create a new song entry with optional AI metadata parsing and MusicBrainz enrichment.
    """
    try:
        # Normalize artist/author
        author = song.author or song.artist
        
        # Create base song data
        song_data = {
            'name': song.name,
            'title': song.title,
            'author': author,
            'artist': author,
            'description': song.description,
            'filename': song.filename or song.name,
            'cover_url': song.cover_url,
            'rating': song.rating,
            'genre': song.genre,
            'tags': song.tags or [],
            'duration': song.duration,
            'play_count': 0,
            'generation_model': song.generation_model,
            'version': song.version,
            'prompt': song.prompt,
            'type': 'audio'
        }
        
        # Auto-parse AI metadata from filename
        if song.auto_parse_ai:
            try:
                ai_metadata = parse_ai_metadata_from_filename(song.name)
                for key, value in ai_metadata.items():
                    if not song_data.get(key):
                        song_data[key] = value
            except Exception as e:
                print(f"AI metadata parsing failed: {e}")
        
        # Auto-enrich from MusicBrainz if enabled
        if song.auto_enrich:
            try:
                enrichment = await enrich_metadata_from_musicbrainz(
                    name=song.name,
                    title=song.title,
                    author=author,
                    genre=song.genre,
                    description=song.description,
                    tags=song.tags
                )
                
                for key, value in enrichment.items():
                    if not song_data.get(key):
                        song_data[key] = value
                        
            except Exception as e:
                print(f"MusicBrainz enrichment failed: {e}")
        
        # Create in storage
        item_id = await STORAGE_MAP.create(song_data)
        song_data['id'] = item_id
        
        return song_data
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create song: {str(e)}")


@app.put("/api/songs/{item_id}", response_model=SongMetadata)
async def update_song(
    item_id: str,
    updates: SongUpdate
):
    """Fully update a song's metadata."""
    try:
        existing = await STORAGE_MAP.get(item_id)
        if not existing:
            raise HTTPException(status_code=404, detail="Song not found")
        
        update_data = {k: v for k, v in updates.model_dump().items() if v is not None}
        
        # Normalize artist/author
        if 'artist' in update_data and 'author' not in update_data:
            update_data['author'] = update_data['artist']
        if 'author' in update_data and 'artist' not in update_data:
            update_data['artist'] = update_data['author']
        
        # Auto-enrich if requested
        if updates.auto_enrich:
            try:
                current_title = update_data.get('title') or existing.get('title')
                current_author = update_data.get('author') or existing.get('author')
                
                enrichment = await enrich_metadata_from_musicbrainz(
                    name=existing.get('name', ''),
                    title=current_title,
                    author=current_author
                )
                
                for key, value in enrichment.items():
                    if key not in update_data or not update_data[key]:
                        update_data[key] = value
                        
            except Exception as e:
                print(f"MusicBrainz enrichment failed: {e}")
        
        update_data.pop('auto_enrich', None)
        
        merged = {**existing, **update_data}
        
        await STORAGE_MAP.set(item_id, merged)
        return merged
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update song: {str(e)}")


@app.patch("/api/songs/{item_id}", response_model=SongMetadata)
async def patch_song(
    item_id: str,
    updates: SongPatch
):
    """
    Partially update a song's metadata.
    Use this for quick edits like updating rating, genre, tags, or play count.
    """
    try:
        existing = await STORAGE_MAP.get(item_id)
        if not existing:
            raise HTTPException(status_code=404, detail="Song not found")
        
        update_data = {k: v for k, v in updates.model_dump(exclude_unset=True).items() if v is not None}
        
        # Normalize artist/author
        if 'artist' in update_data and 'author' not in update_data:
            update_data['author'] = update_data['artist']
        if 'author' in update_data and 'artist' not in update_data:
            update_data['artist'] = update_data['author']
        
        # Auto-enrich if requested
        if updates.auto_enrich:
            try:
                current_title = update_data.get('title') or existing.get('title')
                current_author = update_data.get('author') or existing.get('author')
                
                enrichment = await enrich_metadata_from_musicbrainz(
                    name=existing.get('name', ''),
                    title=current_title,
                    author=current_author
                )
                
                for key, value in enrichment.items():
                    if key not in update_data or not update_data[key]:
                        update_data[key] = value
                        
            except Exception as e:
                print(f"MusicBrainz enrichment failed: {e}")
        
        update_data.pop('auto_enrich', None)
        
        merged = {**existing, **update_data}
        
        await STORAGE_MAP.set(item_id, merged)
        return merged
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to patch song: {str(e)}")


@app.post("/api/songs/{item_id}/play")
async def record_play(item_id: str):
    """
    Increment play count and update last_played timestamp.
    Called by frontend when a track starts playing.
    """
    try:
        existing = await STORAGE_MAP.get(item_id)
        if not existing:
            raise HTTPException(status_code=404, detail="Song not found")
        
        existing['play_count'] = existing.get('play_count', 0) + 1
        existing['last_played'] = datetime.now().isoformat()
        
        await STORAGE_MAP.set(item_id, existing)
        return {"status": "recorded", "play_count": existing['play_count']}
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to record play: {str(e)}")


@app.post("/api/songs/{item_id}/trash")
async def trash_song(item_id: str):
    """
    Mark a song as trash (rating=0, add trash tag).
    Does not delete the song, just hides it from default views.
    """
    try:
        existing = await STORAGE_MAP.get(item_id)
        if not existing:
            raise HTTPException(status_code=404, detail="Song not found")
        
        existing['rating'] = 0
        tags = existing.get('tags', [])
        if 'trash' not in [t.lower() for t in tags]:
            tags.append('trash')
        existing['tags'] = tags
        
        await STORAGE_MAP.set(item_id, existing)
        return {"status": "trashed", "id": item_id}
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to trash song: {str(e)}")


@app.delete("/api/songs/{item_id}")
async def delete_song(item_id: str):
    """Delete a song from the library."""
    success = await STORAGE_MAP.delete(item_id)
    if not success:
        raise HTTPException(status_code=404, detail="Song not found")
    return {"status": "deleted", "id": item_id}


# =============================================================================
# API Endpoints - Tag Suggestions
# =============================================================================

@app.get("/api/songs/{item_id}/suggest-tags")
async def suggest_tags(item_id: str):
    """
    Get AI-powered tag suggestions for a track based on its prompt.
    """
    try:
        song = await STORAGE_MAP.get(item_id)
        if not song:
            raise HTTPException(status_code=404, detail="Song not found")
        
        suggestions = []
        
        # Suggest from prompt
        if song.get('prompt'):
            suggestions.extend(suggest_tags_from_prompt(song['prompt']))
        
        # Suggest from name
        name_suggestions = suggest_tags_from_prompt(song.get('name', ''))
        suggestions.extend(name_suggestions)
        
        # Deduplicate and return
        unique_suggestions = list(dict.fromkeys(suggestions))
        
        return {
            "suggestions": unique_suggestions[:8],
            "source": "prompt" if song.get('prompt') else "name"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to suggest tags: {str(e)}")


# =============================================================================
# API Endpoints - Share
# =============================================================================

@app.post("/api/share", response_model=ShareResponse)
async def create_share(request: ShareRequest):
    """Create a shareable playlist link."""
    try:
        share_id = URLShortener.generate_short_id(10)

        expires_at = datetime.now() + timedelta(days=request.expires_in_days)
        
        share_data = {
            'id': share_id,
            'track_ids': request.track_ids,
            'title': request.title,
            'created_at': datetime.now().isoformat(),
            'expires_at': expires_at.isoformat()
        }
        SHARES_MAP[share_id] = share_data
        
        full_url = f"{APP_BASE_URL}/playlist/{share_id}"
        
        short_url = await URLShortener.shorten_with_tinyurl(full_url)
        if not short_url:
            short_url = full_url
        
        return ShareResponse(
            share_id=share_id,
            short_url=short_url,
            full_url=full_url,
            expires_at=expires_at.isoformat()
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create share: {str(e)}")


@app.get("/api/share/{share_id}")
async def get_share(share_id: str):
    """Get a shared playlist by ID."""
    share = SHARES_MAP.get(share_id)
    if not share:
        raise HTTPException(status_code=404, detail="Share not found")
    
    expires_at = datetime.fromisoformat(share['expires_at'])
    if datetime.now() > expires_at:
        del SHARES_MAP[share_id]
        raise HTTPException(status_code=410, detail="Share has expired")
    
    tracks = []
    for track_id in share['track_ids']:
        track = await STORAGE_MAP.get(track_id)
        if track:
            tracks.append(track)
    
    return {
        'id': share_id,
        'title': share['title'],
        'tracks': tracks,
        'created_at': share['created_at'],
        'expires_at': share['expires_at']
    }


@app.get("/playlist/{share_id}")
async def redirect_to_playlist(share_id: str):
    """Redirect to the main app with the shared playlist loaded."""
    from fastapi.responses import RedirectResponse
    
    share = SHARES_MAP.get(share_id)
    if not share:
        raise HTTPException(status_code=404, detail="Share not found")
    
    return RedirectResponse(url=f"/?share={share_id}")


# =============================================================================
# API Endpoints - Audio Streaming
# =============================================================================

@app.get("/api/music/{item_id}")
async def stream_music(item_id: str):
    """Stream audio file for a song by ID."""
    try:
        # Get song metadata
        song = await STORAGE_MAP.get(item_id)
        if not song:
            raise HTTPException(status_code=404, detail="Song not found")
        
        # Get filename from metadata
        filename = song.get("filename")
        if not filename:
            raise HTTPException(status_code=404, detail="Audio file not available for this song")
        
        # Construct full file path
        file_path = os.path.join(MUSIC_DIR, filename)
        
        # Verify file exists and is within MUSIC_DIR (security check)
        if not os.path.exists(file_path):
            raise HTTPException(status_code=404, detail="Audio file not found on disk")
        
        # Security: Ensure the resolved path is within MUSIC_DIR
        resolved_path = os.path.realpath(file_path)
        music_dir_resolved = os.path.realpath(MUSIC_DIR)
        # Normalize paths for case-insensitive filesystems (Windows, macOS)
        resolved_path_norm = os.path.normcase(resolved_path)
        music_dir_resolved_norm = os.path.normcase(music_dir_resolved)
        # Use os.path.commonpath for more robust path checking
        try:
            common = os.path.normcase(os.path.commonpath([resolved_path_norm, music_dir_resolved_norm]))
            if common != music_dir_resolved_norm:
                raise HTTPException(status_code=403, detail="Access denied")
        except ValueError:
            # Paths on different drives on Windows
            raise HTTPException(status_code=403, detail="Access denied")
        
        # Determine MIME type based on file extension
        _, ext = os.path.splitext(filename.lower())
        if ext == ".flac":
            media_type = "audio/flac"
        elif ext in [".wav", ".wave"]:
            media_type = "audio/wav"
        elif ext == ".mp3":
            media_type = "audio/mpeg"
        else:
            media_type = "audio/octet-stream"
        
        # Return file with streaming
        return FileResponse(
            file_path,
            media_type=media_type,
            filename=filename,
            headers={"Accept-Ranges": "bytes"}
        )
    except HTTPException:
        raise
    except Exception as e:
        # Log error server-side but return generic message to client
        logging.error(f"Error streaming music {item_id}: {str(e)}")
        raise HTTPException(status_code=500, detail="Internal server error")


# =============================================================================
# API Endpoints - MusicBrainz
# =============================================================================

@app.get("/api/musicbrainz/search")
async def search_musicbrainz(
    query: str,
    artist: Optional[str] = None
):
    """Direct MusicBrainz search endpoint."""
    try:
        async with MusicBrainzClient() as client:
            result = await client.search_recording(query, artist)
        
        if not result:
            return {"found": False, "message": "No results found"}
        
        return {
            "found": True,
            "data": result.model_dump()
        }
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MusicBrainz query failed: {str(e)}")


# =============================================================================
# Main Entry Point
# =============================================================================

if __name__ == "__main__":
    import uvicorn
    
    port = int(os.getenv("PORT", "7860"))
    host = os.getenv("HOST", "0.0.0.0")
    
    uvicorn.run(app, host=host, port=port)
