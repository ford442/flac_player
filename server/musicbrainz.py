"""
MusicBrainz API integration for FLAC Player.

This module provides MusicBrainz API client and metadata enrichment utilities.
"""

import os
from typing import Optional, Dict, Any, List
import httpx
from aiocache import cached, Cache
from aiocache.serializers import JsonSerializer

from models import MusicBrainzResult

# Configuration
MUSICBRAINZ_BASE_URL = "https://musicbrainz.org/ws/2"
MUSICBRAINZ_USER_AGENT = os.getenv(
    "MUSICBRAINZ_USER_AGENT",
    "FLAC-Player/1.0 (flac-player@example.com)"
)
CACHE_TTL = int(os.getenv("CACHE_TTL", "300"))  # 5 minutes default


class MusicBrainzClient:
    """Async client for MusicBrainz API."""
    
    def __init__(self, base_url: str = MUSICBRAINZ_BASE_URL, user_agent: str = MUSICBRAINZ_USER_AGENT):
        """
        Initialize MusicBrainz client.
        
        Args:
            base_url: MusicBrainz API base URL
            user_agent: User agent string for API requests
        """
        self.base_url = base_url
        self.user_agent = user_agent
        self.client: Optional[httpx.AsyncClient] = None
    
    async def __aenter__(self):
        """Context manager entry."""
        self.client = httpx.AsyncClient(
            headers={"User-Agent": self.user_agent},
            timeout=30.0,
            follow_redirects=True
        )
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit."""
        if self.client:
            await self.client.aclose()
    
    @cached(
        ttl=CACHE_TTL,
        cache=Cache.MEMORY,
        key_builder=lambda f, self, query, artist=None: f"mb_search:{query}:{artist}",
        serializer=JsonSerializer()
    )
    async def search_recording(self, query: str, artist: Optional[str] = None) -> Optional[MusicBrainzResult]:
        """
        Search for a recording on MusicBrainz.
        
        Args:
            query: Recording title or name to search for
            artist: Optional artist name to narrow search
            
        Returns:
            MusicBrainzResult with metadata or None if not found
        """
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
        """
        Get detailed release information.
        
        Args:
            release_id: MusicBrainz release ID
            
        Returns:
            Release data dictionary or None on error
        """
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
    """
    Enrich metadata by fetching from MusicBrainz API.
    
    Args:
        name: Track name
        title: Track title (optional)
        author: Track author (optional)
        artist: Track artist (optional)
        genre: Track genre (optional)
        description: Track description (optional)
        tags: Existing tags (optional)
        
    Returns:
        Dictionary of enriched metadata updates
    """
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
