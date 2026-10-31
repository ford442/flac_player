# Offline / PWA

## Service worker (`src/sw/service-worker.ts`)

Built only in production (`npm run build`) by `workbox-webpack-plugin` `InjectManifest`
→ `<base>/service-worker.js`, registered by `src/sw/serviceWorkerClient.ts` with scope `PUBLIC_PATH`
(default `/`; see `docs/DEPLOYMENT.md` for subpath builds).
Dev builds have no service worker.

| Route | Strategy | Cache |
|---|---|---|
| Precache manifest (app shell, `manifest.json`, icons) | precache | workbox-precache |
| Navigations (e.g. `<base>/playlist/{id}`) | precached `<base>/index.html` (derived from the SW scope) | workbox-precache |
| `GET /api/songs*` (same origin or `REACT_APP_API_URL` host) | network-first (the IndexedDB catalog is the offline copy) | `API_CACHE_NAME` |
| SDL / projectM `.wasm`/`.js` | cache-first, 30 days | `flac-player-wasm-v2` |
| Audio files (`.flac .mp3 .wav .ogg .opus .m4a .aac`) | cache hit → served with `Range` (200/206/416); miss → network, not stored | `flac-player-tracks-v1` |

The audio route is what lets the native `<audio>` path (non-FLAC tracks in `streaming`
mode) play offline; the hi-fi and buffered paths read `flac-player-tracks-v1` directly
via `getOrFetchTrack()`. Range slicing lives in `src/sw/rangeResponse.ts`.

## Installability

`public/manifest.json` + icons are precached. The app is installable once the service
worker controls the page (second load of a production build, served over HTTPS).

## Library catalog (`src/catalog/`)

The library is synced into IndexedDB (`flac_player`, Dexie) and browsed from there, so search,
filters, tags and stats work with the network off. After the first sync fills an empty catalog the
app calls `navigator.storage.persist()` once; Settings → Offline shows `navigator.storage.estimate()`
and a "Keep offline data" button while storage is not persistent.

## Track cache, quota and eviction (`src/storage/trackCache.ts`)

- Tracks are stored in Cache API `flac-player-tracks-v1`, keyed by their full URL.
- Written by "Download for offline" (in the service worker via `DOWNLOAD_TRACK`, with
  progress messages) and by `getOrFetchTrack()` on buffered/hi-fi playback.
- An LRU manifest lives in `localStorage` (`flac_track_cache_lru`). When the total
  exceeds `MAX_CACHE_BYTES` (500 MB), least-recently-played tracks are evicted and
  `onCacheEviction` listeners are notified.
- The browser may also evict the whole origin under storage pressure; the LRU manifest
  can then list tracks that are gone — `isTrackCached()` checks the cache itself.

## Manual checks

On a production build: Lighthouse PWA ≥ 90; reload with DevTools "Offline" — the
shell loads; a downloaded mp3/wav/ogg and a downloaded FLAC both play.
