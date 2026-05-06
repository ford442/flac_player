import React, { useRef, useEffect } from 'react';
import './ShaderGUI.css';

interface TopScreenProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  artist?: string;
  title?: string;
  webGPUSupported: boolean;
  onCanvasResize?: () => void;
  onCanvasDoubleClick?: () => void;
  isLoading?: boolean;
}

export const TopScreen: React.FC<TopScreenProps> = ({
  canvasRef,
  artist,
  title,
  webGPUSupported,
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
      {webGPUSupported ? (
        <canvas
          ref={canvasRef}
          className="top-screen-canvas"
          width={640}
          height={160}
          onDoubleClick={onCanvasDoubleClick}
        />
      ) : (
        <div
          className="top-screen-canvas"
          style={{
            background: 'linear-gradient(180deg, #1A0A2E 0%, #2D1B4E 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              width: '80%',
              height: '60%',
              background: 'repeating-linear-gradient(90deg, transparent, transparent 8px, rgba(192,132,252,0.3) 8px, rgba(192,132,252,0.3) 10px)',
              borderRadius: 4,
              animation: 'pulse 2s ease-in-out infinite',
            }}
          />
        </div>
      )}
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
