"""
URL shortening service for FLAC Player.

This module provides URL shortening utilities using TinyURL API or internal storage.
"""

import os
import secrets
from typing import Optional
import httpx


# Configuration
TINYURL_API_KEY = os.getenv("TINYURL_API_KEY", "")


class URLShortener:
    """Simple URL shortener using internal storage or TinyURL API."""
    
    @staticmethod
    def generate_short_id(length: int = 8) -> str:
        """
        Generate a short unique ID.
        
        Args:
            length: Length of the ID to generate
            
        Returns:
            A URL-safe random string
        """
        return secrets.token_urlsafe(length)[:length]
    
    @staticmethod
    async def shorten_with_tinyurl(long_url: str) -> Optional[str]:
        """
        Try to shorten URL using TinyURL API if key is available.
        
        Args:
            long_url: The long URL to shorten
            
        Returns:
            Shortened URL or None if service unavailable or API key not configured
        """
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
