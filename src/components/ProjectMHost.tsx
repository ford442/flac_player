import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ProjectMEngine, sharedProjectMEngine } from '../projectm/ProjectMEngine';
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

export const ProjectMHost: React.FC<ProjectMHostProps> = ({
  engine = sharedProjectMEngine,
  beatPhase = 1,
  beatSyncPresets = false,
  onFailed,
  onReady,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState(engine.getStatus());
  const [presetName, setPresetName] = useState('');
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites());
  const lastBeatPhaseRef = useRef(beatPhase);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return engine.onStatusChange((next) => setStatus(next));
  }, [engine]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    void engine.load(canvas).then((ok) => {
      if (cancelled) return;
      if (ok) {
        onReady?.();
      } else {
        onFailed?.();
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
    };
  }, [engine, onFailed, onReady]);

  useEffect(() => {
    if (!containerRef.current || status !== 'ready') return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      engine.resize(Math.round(width), Math.round(height));
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [engine, status]);

  useEffect(() => {
    if (status !== 'ready') return;
    engine.setBeatSensitivity(beatSyncPresets ? 1.8 : 1.2);
  }, [beatSyncPresets, engine, status]);

  useEffect(() => {
    if (!beatSyncPresets || status !== 'ready') return;
    const prev = lastBeatPhaseRef.current;
    lastBeatPhaseRef.current = beatPhase;
    if (prev > 0.5 && beatPhase < 0.1) {
      engine.nextPreset(false);
    }
  }, [beatPhase, beatSyncPresets, engine, status]);

  const onPresetFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    const ok = engine.loadPresetMilk(text, true);
    if (ok) {
      setPresetName(file.name);
      const nextFavs = [file.name, ...favorites.filter(f => f !== file.name)].slice(0, 20);
      setFavorites(nextFavs);
      saveFavorites(nextFavs);
    }
  }, [engine, favorites]);

  if (status === 'error') {
    return (
      <div className="projectm-host projectm-host--error">
        <p>projectM WASM unavailable — using ShaderGUI fallback.</p>
        <p className="projectm-host__hint">Build with <code>npm run build:projectm</code> and refresh.</p>
      </div>
    );
  }

  return (
    <div className="projectm-host" ref={containerRef}>
      <canvas ref={canvasRef} className="projectm-host__canvas" />
      {status === 'loading' && (
        <div className="projectm-host__overlay">Loading projectM…</div>
      )}
      <div className="projectm-host__toolbar">
        <button type="button" onClick={() => engine.prevPreset(false)} title="Previous preset">◀</button>
        <button type="button" onClick={() => engine.nextPreset(false)} title="Next preset">▶</button>
        <button type="button" onClick={() => fileInputRef.current?.click()} title="Load .milk preset">📁</button>
        {presetName && <span className="projectm-host__preset-name">{presetName}</span>}
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
