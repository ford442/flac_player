"""
ReplayGain tag extraction for local audio files (FLAC Vorbis comments, ID3 TXXX).
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, Optional

try:
    from mutagen import File as MutagenFile
except ImportError:  # pragma: no cover - optional at runtime
    MutagenFile = None  # type: ignore[misc, assignment]


_REPLAYGAIN_DB = re.compile(r'^([+-]?\d+(?:\.\d+)?)\s*dB$', re.IGNORECASE)


def _parse_db(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    text = str(value).strip()
    match = _REPLAYGAIN_DB.match(text)
    if match:
        return float(match.group(1))
    try:
        return float(text)
    except ValueError:
        return None


def _parse_peak(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        peak = float(str(value).strip())
        return peak if peak > 0 else None
    except ValueError:
        return None


def extract_replaygain_from_file(path: str | Path) -> Dict[str, Any]:
    """
    Read ReplayGain tags from a local audio file.
    Returns a dict with optional replaygain_* keys suitable for SongMetadata.
    """
    if MutagenFile is None:
        return {}

    file_path = Path(path)
    if not file_path.is_file():
        return {}

    try:
        audio = MutagenFile(file_path, easy=False)
    except Exception:
        return {}

    if audio is None:
        return {}

    tags = audio.tags
    if tags is None:
        return {}

    result: Dict[str, Any] = {}

    def read_vorbis(key: str) -> Optional[str]:
        values = tags.get(key)
        if not values:
            return None
        first = values[0]
        return str(first) if first is not None else None

    track_gain = _parse_db(read_vorbis('REPLAYGAIN_TRACK_GAIN'))
    album_gain = _parse_db(read_vorbis('REPLAYGAIN_ALBUM_GAIN'))
    track_peak = _parse_peak(read_vorbis('REPLAYGAIN_TRACK_PEAK'))
    album_peak = _parse_peak(read_vorbis('REPLAYGAIN_ALBUM_PEAK'))

    if track_gain is not None:
        result['replaygain_track_db'] = track_gain
    if album_gain is not None:
        result['replaygain_album_db'] = album_gain
    if track_peak is not None:
        result['replaygain_track_peak'] = track_peak
    if album_peak is not None:
        result['replaygain_album_peak'] = album_peak

    return result
