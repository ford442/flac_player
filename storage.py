"""
Storage management for FLAC Player API.

This module handles JSON-based song metadata storage with file persistence,
and utilities for parsing AI metadata from filenames and prompts.
"""

import os
import json
import asyncio
import hashlib
import re
from datetime import datetime
from typing import Optional, List, Dict, Any


class StorageManager:
    """Manages song metadata storage with JSON file persistence."""
    
    def __init__(self, index_path: str):
        """
        Initialize StorageManager.
        
        Args:
            index_path: Path to JSON index file
        """
        self.index_path = index_path
        self._cache: Dict[str, Dict[str, Any]] = {}
        self._loaded = False
        self._lock = asyncio.Lock()
        self._mtime: Optional[float] = None
    
    async def _ensure_loaded(self):
        """Load index from disk if not already loaded or if file changed."""
        mtime = None
        try:
            mtime = os.path.getmtime(self.index_path)
        except OSError:
            pass
        
        if not self._loaded or (mtime is not None and mtime != self._mtime):
            async with self._lock:
                if not self._loaded or (mtime is not None and mtime != self._mtime):
                    await self._load()
                    self._loaded = True
    
    async def _load(self):
        """Load index from JSON file."""
        try:
            if os.path.exists(self.index_path):
                with open(self.index_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    self._cache = {item['id']: item for item in data.get('songs', [])}
                self._mtime = os.path.getmtime(self.index_path)
            else:
                self._cache = {}
                self._mtime = None
        except Exception as e:
            print(f"Error loading index: {e}")
            self._cache = {}
            self._mtime = None
    
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
                self._mtime = os.path.getmtime(self.index_path)
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


def parse_ai_metadata_from_filename(filename: str) -> Dict[str, Any]:
    """
    Parse AI generation metadata from filename patterns.
    
    Patterns supported:
    - suno_v3_chill.wav -> model=Suno v3, tags=[chill]
    - udio_upbeat_pop_v2.flac -> model=Udio, tags=[upbeat, pop], version=v2
    - stableaudio_ambient_pad_v1.wav -> model=Stable Audio, tags=[ambient, pad]
    
    Args:
        filename: Audio filename to parse
        
    Returns:
        Dictionary with extracted metadata (generation_model, version, tags)
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
    """
    Simple keyword extraction from AI prompt for tag suggestions.
    
    Args:
        prompt: AI generation prompt text
        
    Returns:
        List of suggested tags (up to 5)
    """
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
