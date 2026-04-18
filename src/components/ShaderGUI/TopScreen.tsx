import React from 'react';
import './ShaderGUI.css';

interface TopScreenProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  artist?: string;
  title?: string;
  webGPUSupported: boolean;
}

export const TopScreen: React.FC<TopScreenProps> = ({
  canvasRef,
  artist,
  title,
  webGPUSupported,
}) => {
  const displayText = title ? (artist ? `${artist} — ${title}` : title) : 'No track loaded';

  return (
    <div className="shader-screen top-screen">
      {webGPUSupported ? (
        <canvas
          ref={canvasRef}
          className="top-screen-canvas"
          width={640}
          height={160}
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
        <div className="artist-title-marquee">
          {displayText}&nbsp;&nbsp;&nbsp;&nbsp;{displayText}&nbsp;&nbsp;&nbsp;&nbsp;
        </div>
      </div>
    </div>
  );
};

export default TopScreen;
