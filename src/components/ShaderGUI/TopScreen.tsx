import React, { useRef, useEffect } from 'react';
import type { VisualizerBackend } from '../../visuals/types';
import type { WebGPUProbeBreadcrumb } from '../../visuals/webgpuProbe';
import './ShaderGUI.css';

interface TopScreenProps {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  artist?: string;
  title?: string;
  activeBackend?: VisualizerBackend;
  probeFailure?: WebGPUProbeBreadcrumb | null;
  onCanvasResize?: () => void;
  onCanvasDoubleClick?: () => void;
  isLoading?: boolean;
}

export const TopScreen: React.FC<TopScreenProps> = ({
  canvasRef,
  artist,
  title,
  activeBackend,
  probeFailure,
  onCanvasResize,
  onCanvasDoubleClick,
  isLoading = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const displayText = isLoading
    ? 'LOADING...'
    : (title ? (artist ? `${artist} — ${title}` : title) : 'No track loaded');

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
  }, [canvasRef, onCanvasResize]);

  return (
    <div ref={containerRef} className="shader-screen top-screen">
      {/* The canvas remains mounted so probe failures can be shown in this slot. */}
      <canvas
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
          <div className="webgpu-fatal-panel__title">WebGPU visualizer unavailable</div>
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
      {!probeFailure && <div className="artist-title-overlay">
        {isLoading ? (
          <div className="loading-text">{displayText}</div>
        ) : (
          <div className="artist-title-marquee">
            {displayText}&nbsp;&nbsp;&nbsp;&nbsp;{displayText}&nbsp;&nbsp;&nbsp;&nbsp;
          </div>
        )}
      </div>}
    </div>
  );
};

export default TopScreen;
