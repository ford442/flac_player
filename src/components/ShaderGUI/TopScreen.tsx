import React, { useRef, useEffect } from 'react';
import type { VisualizerBackend } from '../../visuals/types';
import './ShaderGUI.css';

interface TopScreenProps {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  artist?: string;
  title?: string;
  webGPUSupported?: boolean;
  activeBackend?: VisualizerBackend;
  onCanvasResize?: () => void;
  onCanvasDoubleClick?: () => void;
  isLoading?: boolean;
}

export const TopScreen: React.FC<TopScreenProps> = ({
  canvasRef,
  artist,
  title,
  activeBackend,
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
      {/* Canvas is always rendered — either WebGPU or Canvas2D fallback draws into it */}
      <canvas
        ref={canvasRef}
        className="top-screen-canvas"
        width={640}
        height={160}
        onDoubleClick={onCanvasDoubleClick}
        data-visualizer={activeBackend ?? 'webgpu'}
        style={{
          background: 'linear-gradient(180deg, #0A0A1A 0%, #1A1A2E 100%)',
        }}
      />
      <div className="artist-title-overlay">
        {isLoading ? (
          <div className="loading-text">{displayText}</div>
        ) : (
          <div className="artist-title-marquee">
            {displayText}&nbsp;&nbsp;&nbsp;&nbsp;{displayText}&nbsp;&nbsp;&nbsp;&nbsp;
          </div>
        )}
      </div>
    </div>
  );
};

export default TopScreen;
