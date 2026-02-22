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
import json
import asyncio
import hashlib
import random
import re
from datetime import datetime
from typing import Optional, List, Dict, Any, Set
from contextlib import asynccontextmanager
from dataclasses import dataclass, asdict

import httpx
from aiocache import cached, Cache
from aiocache.serializers import JsonSerializer
from fastapi import FastAPI, HTTPException, Query, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# =============================================================================
# Configuration
# =============================================================================

# Environment variables with defaults for HF Space compatibility
DATA_DIR = os.getenv("DATA_DIR", "./data")
SONGS_DIR = os.path.join(DATA_DIR, "songs")
MUSIC_DIR = os.path.join(DATA_DIR, "music")
INDEX_FILE = os.path.join(SONGS_DIR, "index.json")
CACHE_TTL = int(os.getenv("CACHE_TTL", "300"))  # 5 minutes default
MUSICBRAINZ_BASE_URL = "https://musicbrainz.org/ws/2"
MUSICBRAINZ_USER_AGENT = os.getenv(
    "MUSICBRAINZ_USER_AGENT",
    "FLAC-Player/1.0 (flac-player@example.com)"
)
TINYURL_API_KEY = os.getenv("TINYURL_API_KEY", "")
APP_BASE_URL = os.getenv("APP_BASE_URL", "https://flac-player.hf.space")

# Ensure directories exist
os.makedirs(SONGS_DIR, exist_ok=True)
os.makedirs(MUSIC_DIR, exist_ok=True)

# =============================================================================
# Pydantic Models
# =============================================================================

class SongMetadata(BaseModel):
    """Complete song metadata model with AI generation support."""
    id: str
    name: str
    title: Optional[str] = None
    author: Optional[str] = None
    artist: Optional[str] = None
    date: Optional[str] = None
    type: Optional[str] = "audio"
    description: Optional[str] = None
    filename: Optional[str] = None
    rating: Optional[int] = Field(None, ge=0, le=10)  # 0 = trash
    genre: Optional[str] = None
    tags: Optional[List[str]] = Field(default_factory=list)
    last_played: Optional[str] = None
    url: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    # New fields for library management
    duration: Optional[float] = None  # Duration in seconds
    play_count: Optional[int] = Field(0, ge=0)
    # AI-generated track fields
    generation_model: Optional[str] = None  # e.g., "Suno v3", "Udio", "Stable Audio"
    version: Optional[str] = None  # Version of the generation
    prompt: Optional[str] = None  # Original AI prompt used


class SongCreate(BaseModel):
    """Model for creating a new song entry."""
    name: str
    title: Optional[str] = None
    author: Optional[str] = None
    artist: Optional[str] = None
    description: Optional[str] = None
    filename: Optional[str] = None
    rating: Optional[int] = Field(None, ge=0, le=10)
    genre: Optional[str] = None
    tags: Optional[List[str]] = None
    duration: Optional[float] = None
    generation_model: Optional[str] = None
    version: Optional[str] = None
    prompt: Optional[str] = None
    auto_enrich: bool = Field(True, description="Auto-fetch metadata from MusicBrainz")
    auto_parse_ai: bool = Field(True, description="Auto-parse AI metadata from filename")


class SongUpdate(BaseModel):
    """Model for full song update (PUT)."""
    name: Optional[str] = None
    title: Optional[str] = None
    author: Optional[str] = None
    artist: Optional[str] = None
    description: Optional[str] = None
    filename: Optional[str] = None
    rating: Optional[int] = Field(None, ge=0, le=10)
    genre: Optional[str] = None
    tags: Optional[List[str]] = None
    last_played: Optional[str] = None
    duration: Optional[float] = None
    play_count: Optional[int] = None
    generation_model: Optional[str] = None
    version: Optional[str] = None
    prompt: Optional[str] = None
    auto_enrich: bool = Field(False, description="Auto-fetch metadata from MusicBrainz if fields are empty")


class SongPatch(BaseModel):
    """Model for partial song update (PATCH)."""
    name: Optional[str] = None
    title: Optional[str] = None
    author: Optional[str] = None
    artist: Optional[str] = None
    description: Optional[str] = None
    rating: Optional[int] = Field(None, ge=0, le=10)
    genre: Optional[str] = None
    tags: Optional[List[str]] = None
    last_played: Optional[str] = None
    play_count: Optional[int] = None
    generation_model: Optional[str] = None
    version: Optional[str] = None
    prompt: Optional[str] = None
    auto_enrich: bool = Field(False, description="Auto-fetch metadata from MusicBrainz if fields are empty")


class MusicBrainzResult(BaseModel):
    """Model for MusicBrainz API result."""
    title: Optional[str] = None
    artist: Optional[str] = None
    genre: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    description: Optional[str] = None
    year: Optional[int] = None


class ShareRequest(BaseModel):
    """Model for playlist share request."""
    track_ids: List[str]
    title: Optional[str] = "My Playlist"
    expires_in_days: Optional[int] = Field(30, ge=1, le=365)


class ShareResponse(BaseModel):
    """Model for playlist share response."""
    share_id: str
    short_url: str
    full_url: str
    expires_at: str


class HealthResponse(BaseModel):
    """Health check response."""
    status: str
    version: str = "1.1.0"
    songs_count: int
    timestamp: str


class LibraryStatsResponse(BaseModel):
    """Library statistics response."""
    total_tracks: int
    rated_4plus: int
    total_duration_hours: float
    total_play_count: int
    untagged_count: int
    trash_count: int  # rating = 0
    unique_tags: int
    top_tags: List[Dict[str, Any]]


class TagListResponse(BaseModel):
    """Tag list with frequencies."""
    tags: List[Dict[str, Any]]  # {name, count}


# =============================================================================
# Storage Map (In-Memory with File Persistence)
# =============================================================================

class StorageManager:
    """Manages song metadata storage with JSON file persistence."""
    
    def __init__(self, index_path: str):
        self.index_path = index_path
        self._cache: Dict[str, Dict[str, Any]] = {}
        self._loaded = False
        self._lock = asyncio.Lock()
    
    async def _ensure_loaded(self):
        """Load index from disk if not already loaded."""
        if not self._loaded:
            async with self._lock:
                if not self._loaded:
                    await self._load()
                    self._loaded = True
    
    async def _load(self):
        """Load index from JSON file."""
        try:
            if os.path.exists(self.index_path):
                with open(self.index_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    self._cache = {item['id']: item for item in data.get('songs', [])}
            else:
                self._cache = {}
        except Exception as e:
            print(f"Error loading index: {e}")
            self._cache = {}
    
    async def _save(self):
        """Save index to JSON file."""
        async with self._lock:
            try:
                data = {
                    'songs': list(self._cache.values()),
                    'updated_at': datetime.now().isoformat()
                }
                os.makedirs(os.path.dirname(self.index_path), exist_ok=True)
                with open(self.index_path, 'w', encoding='utf-8') as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
            except Exception as e:
                print(f"Error saving index: {e}")
                raise
    
    async def get_all(self) -> List[Dict[str, Any]]:
        """Get all songs."""
        await self._ensure_loaded()
        return list(self._cache.values())
    
    async def get(self, item_id: str) -> Optional[Dict[str, Any]]:
        """Get a song by ID."""
        await self._ensure_loaded()
        return self._cache.get(item_id)
    
    async def set(self, item_id: str, data: Dict[str, Any]):
        """Set a song by ID."""
        await self._ensure_loaded()
        data['updated_at'] = datetime.now().isoformat()
        self._cache[item_id] = data
        await self._save()
    
    async def delete(self, item_id: str) -> bool:
        """Delete a song by ID."""
        await self._ensure_loaded()
        if item_id in self._cache:
            del self._cache[item_id]
            await self._save()
            return True
        return False
    
    async def create(self, data: Dict[str, Any]) -> str:
        """Create a new song entry."""
        await self._ensure_loaded()
        item_id = data.get('id') or hashlib.md5(
            f"{data.get('name', '')}:{datetime.now().isoformat()}".encode()
        ).hexdigest()[:12]
        data['id'] = item_id
        data['created_at'] = datetime.now().isoformat()
        self._cache[item_id] = data
        await self._save()
        return item_id


# Global storage manager
STORAGE_MAP = StorageManager(INDEX_FILE)
SHARES_MAP: Dict[str, Dict[str, Any]] = {}

# =============================================================================
# AI Metadata Parser
# =============================================================================

def parse_ai_metadata_from_filename(filename: str) -> Dict[str, Any]:
    """
    Parse AI generation metadata from filename patterns.
    
    Patterns supported:
    - suno_v3_chill.wav -> model=Suno v3, tags=[chill]
    - udio_upbeat_pop_v2.flac -> model=Udio, tags=[upbeat, pop], version=v2
    - stableaudio_ambient_pad_v1.wav -> model=Stable Audio, tags=[ambient, pad]
    """
    metadata = {}
    name_lower = filename.lower()
    
    # Extract model from filename
    if 'suno' in name_lower:
        metadata['generation_model'] = 'Suno'
        # Try to extract version like v3, v4
        version_match = re.search(r'v\d+', name_lower)
        if version_match:
            metadata['version'] = version_match.group(0)
    elif 'udio' in name_lower:
        metadata['generation_model'] = 'Udio'
    elif 'stable' in name_lower or 'stableaudio' in name_lower:
        metadata['generation_model'] = 'Stable Audio'
    elif 'mubert' in name_lower:
        metadata['generation_model'] = 'Mubert'
    elif 'boomy' in name_lower:
        metadata['generation_model'] = 'Boomy'
    elif 'aiva' in name_lower:
        metadata['generation_model'] = 'AIVA'
    
    # Extract tags from descriptive parts
    # Remove model name and extension, keep descriptive parts as tags
    clean_name = re.sub(r'\.(flac|wav|mp3|ogg)$', '', filename, flags=re.IGNORECASE)
    clean_name = re.sub(r'[_-]', ' ', clean_name)
    
    # Common music genre/style keywords to extract as tags
    genre_keywords = [
        'chill', 'upbeat', 'ambient', 'electronic', 'pop', 'rock', 'jazz', 'classical',
        'lofi', 'hip hop', 'hiphop', 'rap', 'edm', 'house', 'techno', 'dnb', 'drum and bass',
        'synthwave', 'cinematic', 'orchestral', 'piano', 'guitar', 'bass', 'pads',
        'melodic', 'rhythmic', 'dark', 'bright', 'energetic', 'calm', 'meditation',
        'focus', 'workout', 'sleep', 'study', 'gaming', 'background'
    ]
    
    found_tags = []
    name_lower_clean = clean_name.lower()
    for keyword in genre_keywords:
        if keyword in name_lower_clean:
            found_tags.append(keyword)
    
    if found_tags:
        metadata['tags'] = found_tags
    
    return metadata


def suggest_tags_from_prompt(prompt: str) -> List[str]:
    """Simple keyword extraction from AI prompt for tag suggestions."""
    if not prompt:
        return []
    
    prompt_lower = prompt.lower()
    
    # Music-related keywords
    keywords = {
        'electronic': ['electronic', 'synth', 'electro', 'digital'],
        'ambient': ['ambient', 'atmosphere', 'space', 'ethereal', 'drone'],
        'piano': ['piano', 'keyboard', 'keys'],
        'guitar': ['guitar', 'acoustic', 'strumming'],
        'upbeat': ['upbeat', 'happy', 'cheerful', 'energetic', 'dance'],
        'chill': ['chill', 'relax', 'calm', 'peaceful', 'meditation'],
        'dark': ['dark', 'moody', 'cinematic', 'intense', 'dramatic'],
        'lofi': ['lofi', 'lo-fi', 'vinyl', 'crackling'],
        'orchestral': ['orchestral', 'symphony', 'strings', 'violin', 'cello'],
        'beats': ['beats', 'drums', 'percussion', 'rhythm'],
        'bass': ['bass', 'sub', 'low', 'deep'],
        'vocal': ['vocal', 'voice', 'singing', 'lyrics'],
    }
    
    suggested = []
    for tag, patterns in keywords.items():
        if any(pattern in prompt_lower for pattern in patterns):
            suggested.append(tag)
    
    return suggested[:5]  # Return top 5


# =============================================================================
# MusicBrainz API Integration
# =============================================================================

class MusicBrainzClient:
    """Async client for MusicBrainz API."""
    
    def __init__(self, base_url: str = MUSICBRAINZ_BASE_URL, user_agent: str = MUSICBRAINZ_USER_AGENT):
        self.base_url = base_url
        self.user_agent = user_agent
        self.client: Optional[httpx.AsyncClient] = None
    
    async def __aenter__(self):
        self.client = httpx.AsyncClient(
            headers={"User-Agent": self.user_agent},
            timeout=30.0,
            follow_redirects=True
        )
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.client:
            await self.client.aclose()
    
    @cached(
        ttl=CACHE_TTL,
        cache=Cache.MEMORY,
        key_builder=lambda f, self, query, artist=None: f"mb_search:{query}:{artist}",
        serializer=JsonSerializer()
    )
    async def search_recording(self, query: str, artist: Optional[str] = None) -> Optional[MusicBrainzResult]:
        """Search for a recording on MusicBrainz."""
        if not self.client:
            raise RuntimeError("Client not initialized")
        
        try:
            search_terms = [f'"{query}"']
            if artist:
                search_terms.append(f'artist:"{artist}"')
            
            params = {
                'query': ' '.join(search_terms),
                'fmt': 'json',
                'limit': 5
            }
            
            response = await self.client.get(
                f"{self.base_url}/recording",
                params=params
            )
            response.raise_for_status()
            data = response.json()
            
            recordings = data.get('recordings', [])
            if not recordings:
                return None
            
            recording = recordings[0]
            result = MusicBrainzResult()
            
            result.title = recording.get('title')
            
            artists = recording.get('artist-credit', [])
            if artists:
                result.artist = artists[0].get('name', '')
            
            tags = recording.get('tags', [])
            if tags:
                result.tags = [tag['name'] for tag in tags[:5]]
                result.genre = tags[0]['name']
            
            releases = recording.get('releases', [])
            if releases:
                release_id = releases[0].get('id')
                if release_id:
                    release_data = await self._get_release(release_id)
                    if release_data:
                        date = release_data.get('date', '')
                        if date:
                            try:
                                result.year = int(date[:4]) if len(date) >= 4 else None
                            except ValueError:
                                pass
                        
                        release_tags = release_data.get('tags', [])
                        if release_tags:
                            existing_tags = set(result.tags)
                            for tag in release_tags[:5]:
                                tag_name = tag.get('name', '')
                                if tag_name and tag_name not in existing_tags:
                                    result.tags.append(tag_name)
                                    existing_tags.add(tag_name)
                        
                        disambiguation = release_data.get('disambiguation', '')
                        if disambiguation:
                            result.description = disambiguation
            
            if not result.description and result.artist:
                result.description = f"Track by {result.artist}"
                if result.year:
                    result.description += f", {result.year}"
            
            return result
            
        except httpx.HTTPError as e:
            print(f"MusicBrainz API error: {e}")
            return None
        except Exception as e:
            print(f"Unexpected error querying MusicBrainz: {e}")
            return None
    
    async def _get_release(self, release_id: str) -> Optional[Dict[str, Any]]:
        """Get detailed release information."""
        if not self.client:
            return None
        
        try:
            response = await self.client.get(
                f"{self.base_url}/release/{release_id}",
                params={'fmt': 'json', 'inc': 'tags+genres'}
            )
            response.raise_for_status()
            return response.json()
        except Exception as e:
            print(f"Error fetching release: {e}")
            return None


async def enrich_metadata_from_musicbrainz(
    name: str,
    title: Optional[str] = None,
    author: Optional[str] = None,
    artist: Optional[str] = None,
    genre: Optional[str] = None,
    description: Optional[str] = None,
    tags: Optional[List[str]] = None
) -> Dict[str, Any]:
    """Enrich metadata by fetching from MusicBrainz API."""
    updates = {}
    
    search_title = title or name
    search_artist = author or artist
    
    if '.' in search_title:
        search_title = search_title.rsplit('.', 1)[0]
    
    async with MusicBrainzClient() as client:
        result = await client.search_recording(search_title, search_artist)
    
    if not result:
        return updates
    
    if not title and result.title:
        updates['title'] = result.title
    
    if not author and result.artist:
        updates['author'] = result.artist
    
    if not genre and result.genre:
        updates['genre'] = result.genre
    
    if not description and result.description:
        updates['description'] = result.description
    
    if not tags and result.tags:
        updates['tags'] = result.tags
    
    if result.year and not description:
        desc = updates.get('description', '') or description or ''
        if not desc or result.year not in desc:
            updates['description'] = f"{desc} ({result.year})" if desc else f"Released {result.year}"
    
    return updates


# =============================================================================
# URL Shortening Service
# =============================================================================

class URLShortener:
    """Simple URL shortener using internal storage or TinyURL API."""
    
    @staticmethod
    def generate_short_id(length: int = 8) -> str:
        """Generate a short unique ID."""
        import secrets
        return secrets.token_urlsafe(length)[:length]
    
    @staticmethod
    async def shorten_with_tinyurl(long_url: str) -> Optional[str]:
        """Try to shorten URL using TinyURL API if key is available."""
        if not TINYURL_API_KEY:
            return None
        
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    "https://api.tinyurl.com/create",
                    headers={"Authorization": f"Bearer {TINYURL_API_KEY}"},
                    json={"url": long_url}
                )
                if response.status_code == 200:
                    data = response.json()
                    return data.get('data', {}).get('tiny_url')
        except Exception as e:
            print(f"TinyURL API error: {e}")
        
        return None


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
    allow_origins=["*"],
    allow_credentials=True,
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
    sort_by: str = Query("date", enum=["date", "rating", "name", "last_played", "genre", "play_count", "random"]),
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
        if sort_by == "random":
            random.shuffle(songs)
        else:
            reverse = sort_desc
            if sort_by == "date":
                songs.sort(key=lambda x: x.get('created_at', ''), reverse=reverse)
            elif sort_by == "rating":
                songs.sort(key=lambda x: x.get('rating') or 0, reverse=reverse)
            elif sort_by == "name":
                songs.sort(key=lambda x: (x.get('title') or x.get('name', '')).lower(), reverse=reverse)
            elif sort_by == "last_played":
                songs.sort(key=lambda x: x.get('last_played', ''), reverse=reverse)
            elif sort_by == "genre":
                songs.sort(key=lambda x: x.get('genre', '').lower(), reverse=reverse)
            elif sort_by == "play_count":
                songs.sort(key=lambda x: x.get('play_count', 0), reverse=reverse)
        
        # Pagination
        total = len(songs)
        songs = songs[offset:offset + limit]
        
        return songs
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load songs: {str(e)}")


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
        
        expires_at = datetime.now()
        expires_at = expires_at.replace(day=expires_at.day + request.expires_in_days)
        
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
