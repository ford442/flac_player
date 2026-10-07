import React from 'react';
import './App.css';
import { Player } from './components/Player';
import { isRoomRoute } from './listening/roomSession';

/** Shared playlists and listening rooms open the player full-screen. */
const isSharedPlaylistRoute = (): boolean => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('share')) {
    return true;
  }

  return /^\/playlist\/[^/]+$/.test(window.location.pathname) || isRoomRoute();
};

const App: React.FC = () => {
  if (isSharedPlaylistRoute()) {
    return <Player />;
  }

  return (
    <div className="App">
      <header className="App-header">
        <h1>FLAC Player with WebGPU</h1>
        <p>High-quality audio playback with shader visualization</p>
      </header>
      <main className="App-main">
        <Player />
      </main>
    </div>
  );
};

export default App;
