import React from 'react';
import './App.css';
import { Player } from './components/Player';

const App: React.FC = () => {
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
