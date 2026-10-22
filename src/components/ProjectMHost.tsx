import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ProjectMEngine, sharedProjectMEngine, type ProjectMPresetState } from '../projectm/ProjectMEngine';
import { buildPresetShareUrl } from '../projectm/presetLibrary';
import {
  registerInAppProjectMHost,
  unregisterInAppProjectMHost,
} from '../utils/projectMBridge';
import './ProjectMHost.css';

const FAVORITES_KEY = 'projectm-favorite-presets';

export interface ProjectMHostProps {
  engine?: ProjectMEngine;
  /** Beat phase 0→1; when it snaps to 0 a beat was detected. */
  beatPhase?: number;
  beatSyncPresets?: boolean;
  onFailed?: () => void;
  onReady?: () => void;
}

function loadFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveFavorites(items: string[]) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(items.slice(0, 50)));
  } catch {
    // ignore
  }
}

/**
 * Mount point for the shared projectM canvas. The engine owns the canvas and
 * its WebGL context; this component only lends it a container, so switching
 * between the projectM and split layouts moves one canvas and one main loop.
 */
export const ProjectMHost: React.FC<ProjectMHostProps> = ({
  engine = sharedProjectMEngine,
  beatPhase = 1,
  beatSyncPresets = false,
  onFailed,
  onReady,
}) => {
  const slotRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState(engine.getStatus());
  const [preset, setPreset] = useState<ProjectMPresetState>(engine.getPresetState());
  const [shareNote, setShareNote] = useState('');
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites());
  const lastBeatPhaseRef = useRef(beatPhase);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Callbacks via refs: an inline parent arrow must not re-run the mount effect.
  const onFailedRef = useRef(onFailed);
  const onReadyRef = useRef(onReady);
  onFailedRef.current = onFailed;
  onReadyRef.current = onReady;

  useEffect(() => engine.onStatusChange((next) => setStatus(next)), [engine]);
  useEffect(() => engine.onPresetChange(setPreset), [engine]);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;

    const detach = engine.attach(slot);
    let cancelled = false;
    void engine.load().then((ok) => {
      if (cancelled) return;
      if (ok) {
        onReadyRef.current?.();
      } else {
        onFailedRef.current?.();
      }
    });

    const host = {
      addPCM: (buffer: Float32Array, channels: number) => engine.addPCM(buffer, channels),
      onTrackChange: () => {
        // Soft flush — projectM handles continuous PCM; no hard reset needed.
      },
    };
    registerInAppProjectMHost(host);

    return () => {
      cancelled = true;
      unregisterInAppProjectMHost(host);
      detach();
    };
  }, [engine]);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot || status !== 'ready') return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      // Exact device pixels when the browser reports them (zoom / monitor changes included).
      const device = entry.devicePixelContentBoxSize?.[0];
      engine.resize(width, height, device && width > 0 ? device.inlineSize / width : window.devicePixelRatio);
    });
    try {
      ro.observe(slot, { box: 'device-pixel-content-box' });
    } catch {
      ro.observe(slot); // Safari: no device-pixel-content-box
    }
    return () => ro.disconnect();
  }, [engine, status]);

  useEffect(() => {
    if (status !== 'ready') return;
    engine.setBeatSensitivity(beatSyncPresets ? 1.8 : 1.2);
  }, [beatSyncPresets, engine, status]);

  useEffect(() => {
    if (!beatSyncPresets || status !== 'ready' || preset.locked) return;
    const prev = lastBeatPhaseRef.current;
    lastBeatPhaseRef.current = beatPhase;
    if (prev > 0.5 && beatPhase < 0.1) {
      void engine.nextPreset();
    }
  }, [beatPhase, beatSyncPresets, engine, preset.locked, status]);

  const onPresetFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    const ok = engine.loadLocalPreset(file.name, text);
    if (ok) {
      const nextFavs = [file.name, ...favorites.filter(f => f !== file.name)].slice(0, 20);
      setFavorites(nextFavs);
      saveFavorites(nextFavs);
    }
  }, [engine, favorites]);

  const sharePreset = useCallback(async () => {
    if (!preset.current) return;
    const url = buildPresetShareUrl(preset.current);
    try {
      await window.navigator.clipboard.writeText(url);
      setShareNote('Link copied');
    } catch {
      // No clipboard permission: put the link in the address bar instead.
      window.history.replaceState(window.history.state, '', url);
      setShareNote('Link in address bar');
    }
    window.setTimeout(() => setShareNote(''), 2000);
  }, [preset]);

  if (status === 'error') {
    return (
      <div className="projectm-host projectm-host--error">
        <p>projectM WASM unavailable — using ShaderGUI fallback.</p>
        <p className="projectm-host__hint">Build with <code>npm run build:projectm</code> and refresh.</p>
      </div>
    );
  }

  const packReady = status === 'ready' && preset.library === 'ready';
  const libraryNote = preset.library === 'loading'
    ? 'Loading presets…'
    : preset.library === 'unavailable'
      ? 'Preset pack unavailable'
      : '';

  return (
    <div className="projectm-host">
      <div ref={slotRef} className="projectm-host__slot" />
      {status === 'loading' && (
        <div className="projectm-host__overlay">Loading projectM…</div>
      )}
      <div className="projectm-host__toolbar" role="toolbar" aria-label="projectM presets">
        <button type="button" onClick={() => void engine.prevPreset()} disabled={!packReady} title="Previous preset" aria-label="Previous preset">◀</button>
        <button type="button" onClick={() => void engine.nextPreset()} disabled={!packReady} title="Next preset" aria-label="Next preset">▶</button>
        <button type="button" onClick={() => void engine.randomPreset()} disabled={!packReady} title="Random preset" aria-label="Random preset">🔀</button>
        <button
          type="button"
          onClick={() => engine.setPresetLocked(!preset.locked)}
          disabled={status !== 'ready'}
          aria-pressed={preset.locked}
          title={preset.locked ? 'Unlock preset (resume auto-switching)' : 'Lock preset (stop auto-switching)'}
          aria-label="Lock preset"
        >
          {preset.locked ? '🔒' : '🔓'}
        </button>
        <button type="button" onClick={() => void sharePreset()} disabled={!preset.current} title="Copy a link to this preset" aria-label="Copy preset link">🔗</button>
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={status !== 'ready'} title="Load .milk preset" aria-label="Load .milk preset file">📁</button>
        <span className="projectm-host__preset-name" title={preset.current ?? preset.name} aria-live="polite">
          {shareNote || preset.name || libraryNote}
        </span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".milk,.prj,.txt"
          className="projectm-host__file-input"
          style={{ display: 'none' }}
          onChange={onPresetFile}
        />
      </div>
      {favorites.length > 0 && (
        <div className="projectm-host__favorites">
          {favorites.slice(0, 5).map(name => (
            <span key={name} className="projectm-host__fav-chip">{name}</span>
          ))}
        </div>
      )}
    </div>
  );
};

export default ProjectMHost;
