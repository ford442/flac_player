# FLAC Player API Documentation

This document describes the API contract used by the `flac_player` client application.

> **Architecture Note:** `flac_player` is strictly a **read-only client**. It does not manage uploads or library mutations directly. All music files and metadata are served from `storage.noahcohn.com` (the Contabo Storage Manager). Uploads and library management happen via the Storage Manager's `/admin` dashboard or by dropping files into the connected Google Cloud Storage bucket.

## Overview

The Storage Manager backend provides:
- **Music metadata management** with JSON file storage (`songs.json`)
- **MusicBrainz API integration** for auto-populating song metadata
- **Playlist sharing** with URL shortening support
- **Analytics tracking** for play events

## Quick Start (Local Development)

If you need to run the Storage Manager API locally for development:

```bash
cd ../contabo_storage_manager/packages/python-bridge
pip install -r requirements.txt
python main_gcs.py
```

The server will start on `http://localhost:8000` by default.

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Key variables:
- `FILES_DIR`: Where media files and `songs.json` are stored
- `APP_BASE_URL`: Your deployment URL (for share links)
- `TINYURL_API_KEY`: Optional TinyURL API key for URL shortening
- `MUSICBRAINZ_USER_AGENT`: Required for MusicBrainz API access

## API Endpoints

### Health & Info

#### GET `/` or `/api/health`
Health check endpoint.

**Response:**
```json
{
  "status": "healthy",
  "version": "1.0.0",
  "songs_count": 42,
  "timestamp": "2026-02-22T10:14:54.889494"
}
```

### Library Management

#### GET `/api/library/songs`
Get all songs with optional filtering and sorting.

**Query Parameters:**
- `sort_by`: Sort field (`date`, `rating`, `name`, `last_played`, `genre`)
- `sort_desc`: Sort descending (default: `true`)
- `genre`: Filter by genre
- `min_rating`: Minimum rating (1-10)

**Response:** Array of `SongMetadata`

#### GET `/api/songs/{item_id}`
Get a specific song by ID.

#### POST `/api/songs/upload` (Storage Manager only)
> Managed exclusively through the Storage Manager (`/admin` dashboard or GCS bucket sync).  
> `flac_player` does **not** call this endpoint.

Creates a new song entry with optional MusicBrainz enrichment.

**Request Body:** `SongCreate`
```json
{
  "name": "my_song.flac",
  "title": "My Song",
  "author": "Artist Name",
  "genre": "Rock",
  "rating": 8,
  "auto_enrich": true
}
```

When `auto_enrich` is `true`, the API will query MusicBrainz to fill in missing metadata like genre, tags, and description.

**Response:** `SongMetadata`

#### PUT `/api/songs/{item_id}`
Fully update a song's metadata.

**Request Body:** `SongUpdate`
Same as `SongCreate`, all provided fields overwrite existing ones.

#### PATCH `/api/songs/{item_id}`
Partially update a song's metadata.

**Request Body:** `SongPatch`
Only provided fields are updated. Use this for quick edits like rating or genre changes.

```json
{
  "rating": 9,
  "genre": "Progressive Rock",
  "auto_enrich": true
}
```

#### DELETE `/api/songs/{item_id}`
Delete a song from the library.

### Sharing

#### POST `/api/share`
Create a shareable playlist link.

**Request Body:**
```json
{
  "track_ids": ["abc123", "def456"],
  "title": "My Awesome Playlist",
  "expires_in_days": 30
}
```

**Response:**
```json
{
  "share_id": "aBcDeFgH",
  "short_url": "https://tinyurl.com/xyz123",
  "full_url": "https://your-app.hf.space/playlist/aBcDeFgH",
  "expires_at": "2026-03-24T10:14:54.889494"
}
```

#### GET `/api/share/{share_id}`
Get a shared playlist by ID.

#### GET `/playlist/{share_id}`
Redirect to the main app with the shared playlist loaded.

### MusicBrainz Integration

#### GET `/api/musicbrainz/search`
Direct MusicBrainz search endpoint.

**Query Parameters:**
- `query`: Track title to search
- `artist`: Optional artist name

**Response:**
```json
{
  "found": true,
  "data": {
    "title": "Song Title",
    "artist": "Artist Name",
    "genre": "Rock",
    "tags": ["rock", "classic rock"],
    "description": "Album version",
    "year": 1975
  }
}
```

## MusicBrainz Auto-Enrichment

When creating or updating a song with `auto_enrich: true`, the API will:

1. Search MusicBrainz for the track using `title` or `name`
2. If an artist is provided, narrow the search
3. Extract metadata from the best match:
   - Title (if not provided)
   - Artist/Author (if not provided)
   - Genre (from tags)
   - Tags (up to 5)
   - Description (from release disambiguation)
   - Year (from release date)

The API only fills in **missing** fields - existing values are preserved.

### Example Enrichment Flow

```bash
# Upload a song with minimal info
POST /api/upload/songs
{
  "name": "bohemian_rhapsody.flac",
  "title": "Bohemian Rhapsody",
  "author": "Queen",
  "genre": "Rock",
  "tags": ["rock", "classic rock"],
  "duration": 354.5,
  "auto_enrich": true
}

# Response includes enriched metadata:
{
  "id": "a1b2c3d4e5f6",
  "name": "bohemian_rhapsody.flac",
  "title": "Bohemian Rhapsody",
  "author": "Queen",
  "genre": "Rock",
  "tags": ["rock", "classic rock", "progressive rock"],
  "description": "Released 1975",
  "created_at": "2026-02-22T10:14:54.889494"
}
```

## Frontend Integration

### Tracking API

The frontend can track play events using:

```typescript
// Google Analytics 4
gtag('event', 'play_track', {
  track_id: 'abc123',
  track_name: 'Song Title',
  timestamp: '2026-02-22T10:14:54Z'
});

// Mixpanel
mixpanel.track('Play Track', {
  track_id: 'abc123',
  track_name: 'Song Title',
  genre: 'Rock'
});
```

Configure tracking IDs via environment variables:
- `REACT_APP_GA_ID`: Google Analytics Measurement ID
- `REACT_APP_MIXPANEL_TOKEN`: Mixpanel project token

### Share Playlist

```typescript
// Create a share
const response = await fetch('/api/share', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    track_ids: ['id1', 'id2', 'id3'],
    title: 'My Playlist'
  })
});

const { short_url } = await response.json();

// Share using Web Share API
await navigator.share({
  title: 'Check out my playlist',
  text: 'A collection of great tracks',
  url: short_url
});
```

## Upload & Library Management

`flac_player` does not expose upload controls in the UI. To add or manage tracks, use one of the following methods:

1. **Admin Dashboard** — Open `https://storage.noahcohn.com/admin`, drag audio files into the upload zone, and attach metadata (Title, Author, Tags).
2. **Google Cloud Storage Bucket Sync** — Drop `.flac` or `.mp3` files into the bucket's `audio/music/` folder. The VPS file watcher will auto-detect them, generate a UUID and default title, and append them to `songs.json`.

## Error Handling

All endpoints return appropriate HTTP status codes:

- `200`: Success
- `201`: Created (for POST requests)
- `400`: Bad Request (invalid input)
- `404`: Not Found
- `410`: Gone (expired share link)
- `500`: Internal Server Error

Error responses include a detail message:
```json
{
  "detail": "Song not found"
}
```

## Rate Limiting

MusicBrainz API has rate limits:
- Max 1 request per second
- Max 50 requests per second for authenticated users

The backend implements caching to minimize API calls. Results are cached for 5 minutes by default (configurable via `CACHE_TTL`).
