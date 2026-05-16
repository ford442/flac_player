"""
Pydantic models for FLAC Player API.

This module defines all request/response models for the FLAC Player backend.
"""

from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field


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
    cover_url: Optional[str] = None
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
    id: Optional[str] = None
    name: str
    title: Optional[str] = None
    author: Optional[str] = None
    artist: Optional[str] = None
    description: Optional[str] = None
    filename: Optional[str] = None
    cover_url: Optional[str] = None
    rating: Optional[int] = Field(None, ge=0, le=10)
    genre: Optional[str] = None
    tags: Optional[List[str]] = None
    duration: Optional[float] = None
    url: Optional[str] = None
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
    cover_url: Optional[str] = None
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
    cover_url: Optional[str] = None
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
