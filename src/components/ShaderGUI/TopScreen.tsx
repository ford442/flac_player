import React, { useRef, useEffect, useLayoutEffect, useState } from 'react';
import type { VisualizerBackend } from '../../visuals/types';
import type { WebGPUProbeBreadcrumb } from '../../visuals/webgpuProbe';
import './ShaderGUI.css';

interface TopScreenProps {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  canvasSessionKey?: string;
  artist?: string;
  title?: string;
  /** Album (and year) line shown over the bottom of the screen. */
  album?: string;
  /** Cover art URL (embedded art, or the backend's cover_url fallback). */
  artworkUrl?: string | null;
  /** Spec badges, e.g. ['FLAC', '44.1 kHz', '16-bit', 'Stereo']. */
  specs?: string[];
  activeBackend?: VisualizerBackend;
  /** Loud label shown whenever a non-WebGPU (opt-in) renderer is selected; null for WebGPU. */
  rendererBadge?: string | null;
  probeFailure?: WebGPUProbeBreadcrumb | null;
  onCanvasResize?: () => void;
  onCanvasDoubleClick?: () => void;
  isLoading?: boolean;
}

export const TopScreen: React.FC<TopScreenProps> = ({
  canvasRef,
  canvasSessionKey = 'webgpu',
  artist,
  title,
  album,
  artworkUrl,
  specs,
  activeBackend,
  rendererBadge = null,
  probeFailure,
  onCanvasResize,
  onCanvasDoubleClick,
  isLoading = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const displayText = isLoading
    ? 'LOADING...'
    : (title ? (artist ? `${artist} — ${title}` : title) : 'No track loaded');

  // Scroll only when the title is wider than its box; otherwise show it whole and still.
  const overlayRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [scrollSeconds, setScrollSeconds] = useState<number | null>(null);
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const measure = measureRef.current;
    if (!overlay || !measure) return;
    const update = () => {
      const textWidth = measure.offsetWidth;
      setScrollSeconds(textWidth > overlay.clientWidth ? Math.max(6, textWidth / 40) : null);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(overlay);
    return () => observer.disconnect();
  }, [displayText, probeFailure, isLoading]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const dpr = window.devicePixelRatio || 1;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width * dpr));
      const height = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        onCanvasResize?.();
      }
    };

    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(container);

    window.addEventListener('resize', resize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [canvasRef, canvasSessionKey, onCanvasResize]);

  return (
    <div
      ref={containerRef}
      className={`shader-screen top-screen${rendererBadge && !probeFailure ? ' top-screen--badged' : ''}`}
    >
      {/* The canvas remains mounted so probe failures can be shown in this slot. */}
      <canvas
        key={canvasSessionKey}
        ref={canvasRef}
        className="top-screen-canvas"
        width={640}
        height={160}
        onDoubleClick={onCanvasDoubleClick}
        data-visualizer={activeBackend ?? 'webgpu'}
        data-webgpu-status={probeFailure ? 'failed' : 'ready'}
        style={{
          background: 'linear-gradient(180deg, #0A0A1A 0%, #1A1A2E 100%)',
        }}
      />
      {probeFailure && (
        <div
          className="webgpu-fatal-panel"
          role="alert"
          aria-label="WebGPU visualizer unavailable"
          data-webgpu-failure={probeFailure.reason ?? 'unknown'}
        >
          <div className="webgpu-fatal-panel__title">
            {probeFailure.requestedVisualizer === 'webgl2'
              ? 'Compatibility visualizer unavailable'
              : probeFailure.requestedVisualizer === 'canvas2d'
                ? 'Canvas2D visualizer unavailable'
                : 'WebGPU visualizer unavailable'}
          </div>
          <dl>
            <div>
              <dt>Reason</dt>
              <dd>{probeFailure.reason ?? 'unknown'}</dd>
            </div>
            <div>
              <dt>Browser</dt>
              <dd>
                {probeFailure.browser.brand}
                {probeFailure.browser.version ? ` ${probeFailure.browser.version}` : ''}
              </dd>
            </div>
            <div>
              <dt>Adapter</dt>
              <dd>
                {probeFailure.adapter
                  ? `${probeFailure.adapter.description} (${probeFailure.adapter.vendor} / ${probeFailure.adapter.architecture})`
                  : 'Unavailable'}
              </dd>
            </div>
          </dl>
          {probeFailure.detail && (
            <div className="webgpu-fatal-panel__detail">{probeFailure.detail}</div>
          )}
          <div className="webgpu-fatal-panel__playback">Audio playback remains available.</div>
        </div>
      )}
      {rendererBadge && !probeFailure && (
        <div className="renderer-badge" role="status" data-testid="renderer-badge">
          {rendererBadge}
        </div>
      )}
      {!probeFailure && <div
        ref={overlayRef}
        className={`artist-title-overlay${scrollSeconds !== null && !isLoading ? ' artist-title-overlay--scrolling' : ''}`}
      >
        {isLoading ? (
          <div className="loading-text">{displayText}</div>
        ) : scrollSeconds !== null ? (
          <div className="artist-title-marquee" style={{ animationDuration: `${scrollSeconds}s` }}>
            {displayText}&nbsp;&nbsp;&nbsp;&nbsp;{displayText}&nbsp;&nbsp;&nbsp;&nbsp;
          </div>
        ) : (
          <div className="artist-title-static">{displayText}</div>
        )}
        <span ref={measureRef} className="artist-title-measure" aria-hidden="true">{displayText}</span>
      </div>}
      {!probeFailure && !isLoading && (album || artworkUrl || (specs && specs.length > 0)) && (
        <div className="track-meta-overlay" data-testid="track-meta-overlay">
          {artworkUrl && (
            <img
              className="track-meta-art"
              src={artworkUrl}
              alt={`${album || title || 'Track'} cover art`}
            />
          )}
          <div className="track-meta-text">
            {album && <div className="track-meta-album">{album}</div>}
            {specs && specs.length > 0 && <div className="track-meta-specs">{specs.join(' · ')}</div>}
          </div>
        </div>
      )}
    </div>
  );
};

export default TopScreen;
