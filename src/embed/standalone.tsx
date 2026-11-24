/**
 * Script / iframe entry (`dist-embed/flac-mini-player.js`, `embed.html`).
 *
 * Script tag: exposes `window.FlacMiniPlayer.mount(el, props)` and auto-mounts every
 * `[data-flac-mini-player]` element, reading props from its JSON `data-props` (or
 * `data-src` + `data-title` + `data-artist` for a single track).
 *
 * iframe: `embed.html?src=…&title=…&artist=…` or `embed.html?tracks=<url-encoded JSON>`;
 * plus `layout`, `autoplay`, `loop`, `eq`, `theme`. Events are posted to the parent as
 * `{ source: 'flac-mini-player', type, ... }` and it accepts
 * `{ target: 'flac-mini-player', command: 'play'|'pause'|'toggle'|'seek'|'next'|'previous'|'select'|'setVolume', value? }`.
 */
import { mountMiniPlayer, type MountedMiniPlayer } from './mount';
import type { FlacMiniPlayerProps, MiniEqPreset, MiniTrack } from './types';

const EQS: readonly MiniEqPreset[] = ['flat', 'bass', 'vocal', 'bright'];

function bool(v: string | null | undefined): boolean | undefined {
  if (v == null) return undefined;
  return v === '' || v === '1' || v === 'true';
}

export function propsFromParams(get: (key: string) => string | null | undefined): FlacMiniPlayerProps {
  const props: FlacMiniPlayerProps = {};
  const tracksJson = get('tracks');
  if (tracksJson) {
    try {
      const parsed: unknown = JSON.parse(tracksJson);
      if (Array.isArray(parsed)) {
        props.tracks = parsed.filter((t): t is MiniTrack => !!t && typeof (t as MiniTrack).url === 'string');
      }
    } catch { /* ignore malformed JSON */ }
  }
  const src = get('src');
  if (src) {
    props.track = { url: src, title: get('title') ?? undefined, artist: get('artist') ?? undefined, artwork: get('artwork') ?? undefined };
  }
  const layout = get('layout');
  if (layout === 'bar' || layout === 'card') props.layout = layout;
  const eq = get('eq');
  if (eq && (EQS as readonly string[]).includes(eq)) props.eq = eq as MiniEqPreset;
  props.autoPlay = bool(get('autoplay'));
  props.loop = bool(get('loop'));
  return props;
}

function mountAll(root: ParentNode = document): MountedMiniPlayer[] {
  const out: MountedMiniPlayer[] = [];
  root.querySelectorAll<HTMLElement>('[data-flac-mini-player]').forEach((el) => {
    if (el.dataset.fmpMounted) return;
    el.dataset.fmpMounted = '1';
    let props: FlacMiniPlayerProps = {};
    if (el.dataset.props) {
      try { props = JSON.parse(el.dataset.props) as FlacMiniPlayerProps; } catch { /* ignore */ }
    } else {
      props = propsFromParams((k) => el.getAttribute(`data-${k}`));
    }
    out.push(mountMiniPlayer(el, props));
  });
  return out;
}

function bootIframe(el: HTMLElement): void {
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme');
  const post = (type: string, data: Record<string, unknown> = {}) => {
    if (window.parent !== window) window.parent.postMessage({ source: 'flac-mini-player', type, ...data }, '*');
  };
  const mounted = mountMiniPlayer(el, {
    ...propsFromParams((k) => params.get(k)),
    theme: theme === 'light' || theme === 'dark' ? theme : 'auto',
    onTrackChange: (track, index) => post('trackchange', { track, index }),
    onPlay: (track, index) => post('play', { track, index }),
    onPause: (track, index) => post('pause', { track, index }),
    onEnded: (track, index) => post('ended', { track, index }),
    onQueueEnded: () => post('queueended'),
    onTimeUpdate: (currentTime, duration) => post('timeupdate', { currentTime, duration }),
    onError: (error, track, index) => post('error', { message: error.message, track, index }),
  });
  window.addEventListener('message', (e: MessageEvent) => {
    const msg = e.data as { target?: string; command?: string; value?: unknown } | null;
    const p = mounted.player;
    if (!msg || msg.target !== 'flac-mini-player' || !p) return;
    const n = Number(msg.value);
    switch (msg.command) {
      case 'play': void p.play(); break;
      case 'pause': p.pause(); break;
      case 'toggle': void p.toggle(); break;
      case 'seek': p.seek(n); break;
      case 'next': p.next(); break;
      case 'previous': p.previous(); break;
      case 'select': p.select(n); break;
      case 'setVolume': p.setVolume(n); break;
      default: break;
    }
  });
  post('ready');
}

declare global {
  interface Window {
    FlacMiniPlayer?: { mount: typeof mountMiniPlayer; mountAll: typeof mountAll };
  }
}

window.FlacMiniPlayer = { mount: mountMiniPlayer, mountAll };

const start = () => {
  const iframeRoot = document.getElementById('flac-mini-player-root');
  if (iframeRoot) bootIframe(iframeRoot);
  else mountAll();
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
