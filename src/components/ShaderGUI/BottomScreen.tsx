import React from 'react';
import { PlaylistTrack } from '../../audioLoader';
import './ShaderGUI.css';

interface BottomScreenProps {
  tracks: PlaylistTrack[];
  currentIndex: number;
  onTrackClick: (index: number) => void;
}

export const BottomScreen: React.FC<BottomScreenProps> = ({
  tracks,
  currentIndex,
  onTrackClick,
}) => {
  const visibleTracks = tracks.slice(0, 8);

  return (
    <div className="shader-screen bottom-screen">
      <ul className="track-list">
        {visibleTracks.map((track, index) => (
          <li
            key={track.id || index}
            className={`track-list-item ${index === currentIndex ? 'active' : ''}`}
            onClick={() => onTrackClick(index)}
          >
            <span className="track-number">{index + 1}.</span>
            <span className="track-name">{track.title || track.name}</span>
            {index === currentIndex && (
              <span className="track-play-icon">▶</span>
            )}
          </li>
        ))}
        {visibleTracks.length === 0 && (
          <li className="track-list-item" style={{ opacity: 0.5, cursor: 'default' }}>
            <span className="track-name">No tracks in queue</span>
          </li>
        )}
      </ul>
    </div>
  );
};

export default BottomScreen;
