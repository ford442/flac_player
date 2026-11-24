# Embeddable mini player

A compact player for other apps and sites (album pages, blog posts) without the
library, rooms, visualizer or offline cache. The full app is unchanged; this is a
separate entry point in `src/embed/` with its own build (`webpack.embed.config.js`).

## How it plays

One native `<audio>` element per player streams `track.url` with range requests,
so remote files start quickly. Whatever the browser's `<audio>` decodes plays: FLAC, WAV
and MP3 in all current browsers (plus AAC/Ogg/Opus where supported). There is no
PlaybackEngine, zustand store, Dexie catalog, projectM, ffmpeg.wasm, WebGPU or Tailwind
in the embed path. The default (`eq="flat"`) opens no AudioContext.

A non-flat `eq` preset routes the element through the full app's 5-band layout
(`DEFAULT_EQ_BANDS`) via `openAudioContext`. The AudioContext is created lazily on first
play. Web Audio can only read cross-origin files served with CORS headers, so the element
then sets `crossorigin="anonymous"`.

Gapless playback is not supported: the player moves to the next track on `ended`.

## Builds

```bash
npm run build:embed
```

| Output | Use |
| --- | --- |
| `dist-embed/lib/index.js` | ESM library; imports `react`, `react-dom/client`, `react/jsx-runtime` from the host (≈12 KB min) |
| `dist-embed/flac-mini-player.js` | Script tag / iframe bundle with React included (≈150 KB min) |
| `dist-embed/embed.html` | iframe page that loads the bundle above |

Inside this repo (or a monorepo), import the source directly: `import { FlacMiniPlayer } from './src/embed'`.
Styles are injected once into `<head>` (`#flac-mini-player-styles`), so the player needs
no CSS loader.

## React

```tsx
import { useRef } from 'react';
import { FlacMiniPlayer, type MiniPlayerHandle, type MiniTrack } from 'flac-player-embed';

const album: MiniTrack[] = [
  { id: '1', url: 'https://storage.noahcohn.com/files/audio/music/01.flac', title: 'Opening', artist: 'Weeks on Fire' },
  { id: '2', url: 'https://storage.noahcohn.com/files/audio/music/02.mp3',  title: 'Second',  artist: 'Weeks on Fire' },
];

export function AlbumPlayer() {
  const player = useRef<MiniPlayerHandle>(null);
  return (
    <>
      <FlacMiniPlayer
        ref={player}
        tracks={album}
        layout="bar"
        onTrackChange={(t, i) => console.log('now', i, t.title)}
        onEnded={(t) => console.log('finished', t.id)}
      />
      <button onClick={() => player.current?.select(1)}>Play track 2</button>
    </>
  );
}
```

### Track shape (`MiniTrack`)

| Field | Type | Notes |
| --- | --- | --- |
| `url` | `string` | **Required.** Absolute http(s) URL, or a path relative to the page |
| `id` | `string?` | Your id; returned unchanged in events |
| `title`, `artist`, `album` | `string?` | Title falls back to the file name |
| `artwork` | `string?` | Image URL, shown in the `card` layout |
| `duration` | `number?` | Seconds; shown until the file's metadata loads |

### Props (`FlacMiniPlayerProps`)

| Prop | Default | |
| --- | --- | --- |
| `tracks` | `[]` | Playlist |
| `track` | — | Single track; takes priority over `tracks` |
| `initialIndex` | `0` | Uncontrolled start index |
| `index` | — | Controlled index; the player follows it. Pair it with `onTrackChange` |
| `autoPlay` | `false` | Subject to the browser's autoplay policy |
| `loop` | `false` | Wrap from the last track to the first |
| `layout` | `'bar'` | `'bar'` (one row) or `'card'` (artwork + stacked) |
| `showNavigation` | `tracks.length > 1` | Prev/next buttons |
| `showVolume` | `true` | Hidden below 420 px viewport width |
| `initialVolume` | `1` | 0..1 |
| `eq` | `'flat'` | `'flat' \| 'bass' \| 'vocal' \| 'bright'` |
| `preload` | `'metadata'` | `<audio preload>` |
| `theme` | `'auto'` | `'auto'` follows `prefers-color-scheme`; `'light'` or `'dark'` forces one |
| `label` | `'Audio player'` | Accessible name of the region |
| `className` | — | Added to the root `.fmp` element |

Events: `onTrackChange(track, index)`, `onPlay(track, index)`, `onPause(track, index)`,
`onEnded(track, index)` (fires before auto-advance), `onQueueEnded()`,
`onTimeUpdate(currentTime, duration)` (≈4 Hz and after seeks),
`onError(error, track, index)`.

### Imperative handle (`ref`)

`play()`, `pause()`, `toggle()`, `seek(seconds)`, `next()`, `previous()` (restarts the
track after 3 s), `select(index)`, `setVolume(0..1)`, `getState()` →
`{ index, track, playing, currentTime, duration, volume }`.

### Theming

Override the custom properties on `.fmp`: `--fmp-bg`, `--fmp-fg`, `--fmp-muted`,
`--fmp-accent`, `--fmp-track`, `--fmp-radius`.

## Accessibility and small screens

- A labelled `region` with native buttons (`Play`/`Pause`, `Previous track`, `Next track`)
  and native range inputs for seek and volume. Arrow keys seek at once; pointer drags
  preview the position and seek on release.
- Fluid width with no horizontal overflow at 320 px. The volume slider hides below 420 px.
- `prefers-reduced-motion` disables all transitions. The player has no animations.

## Script tag (non-React pages)

```html
<div data-flac-mini-player
     data-props='{"tracks":[{"url":"https://…/01.flac","title":"Opening"}],"layout":"card"}'></div>
<!-- or: <div data-flac-mini-player data-src="https://…/01.mp3" data-title="Opening" data-artist="…"></div> -->
<script src="https://<host>/flac-mini-player.js"></script>
<script>
  const p = FlacMiniPlayer.mount(document.getElementById('x'), { track: { url: '…' }, onEnded: () => {} });
  p.player?.play(); p.update({ tracks: [...] }); p.unmount();
</script>
```

Elements with `data-flac-mini-player` mount automatically on load. Call
`FlacMiniPlayer.mountAll()` for elements added later.

## iframe

```html
<iframe src="https://<host>/embed.html?src=https%3A%2F%2F…%2F01.flac&title=Opening&artist=Weeks%20on%20Fire&layout=bar"
        title="Audio player" allow="autoplay" style="border:0;width:100%;height:64px"></iframe>
```

Query params: `src`, `title`, `artist`, `artwork`, or `tracks` (URL-encoded JSON array);
also `layout`, `autoplay`, `loop`, `eq` and `theme`.

The iframe posts `{ source: 'flac-mini-player', type, … }` to its parent. `type` is one
of `ready`, `trackchange`, `play`, `pause`, `ended`, `queueended`, `timeupdate` or `error`.
It accepts commands such as
`iframe.contentWindow.postMessage({ target: 'flac-mini-player', command: 'seek', value: 30 }, '*')`.
The commands are `play`, `pause`, `toggle`, `seek`, `next`, `previous`, `select` and `setVolume`.

## Open questions

- Publishing: the library build is not on npm yet. `dist-embed/lib` can be vendored, or
  a package (`exports` → `dist-embed/lib/index.js`, React as a peer dependency) can be
  added later.
- Whether the iframe wrapper stays useful once hosts can use the React component directly.
