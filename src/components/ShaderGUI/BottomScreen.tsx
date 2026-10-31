import React from 'react';
import type { PlaylistTrack } from '../../types/library';
import './ShaderGUI.layout.css';

interface BottomScreenProps {
  tracks: PlaylistTrack[];
  currentIndex: number;
  onTrackClick: (index: number) => void;
  isLoading?: boolean;
}

export const BottomScreen: React.FC<BottomScreenProps> = ({
  tracks,
  currentIndex,
  onTrackClick,
  isLoading = false,
}) => {
  return (
    <div className="shader-screen bottom-screen">
      <ul className="track-list">
        {tracks.map((track, index) => (
          <li
            key={track.id || index}
            className={`track-list-item ${index === currentIndex ? 'active' : ''}`}
          >
            <button
              type="button"
              className="track-list-button"
              onClick={() => onTrackClick(index)}
              aria-current={index === currentIndex ? 'true' : undefined}
            >
              <span className="track-number">{index + 1}.</span>
              <span className="track-name">{track.title || track.name}</span>
              {index === currentIndex && (
                isLoading
                  ? <span className="track-loading-spinner" aria-label="Loading" role="img" />
                  : <span className="track-play-overlay" aria-hidden="true">&#9654;</span>
              )}
            </button>
          </li>
        ))}
        {tracks.length === 0 && (
          <li className="track-list-item" style={{ opacity: 0.5, cursor: 'default' }}>
            <span className="track-name">No tracks in queue</span>
          </li>
        )}
      </ul>
    </div>
  );
};

export default BottomScreen;
