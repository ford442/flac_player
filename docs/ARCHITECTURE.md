# FLAC Player Architecture

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        User Interface                        │
│                      (React Components)                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────┐         ┌─────────────────────────┐   │
│  │   Player.tsx     │         │   WebGPU Visualizer     │   │
│  │                  │◄────────┤   (Shader Interface)    │   │
│  │  - URL Input     │         │                         │   │
│  │  - Play/Pause    │         │  - Audio-reactive       │   │
│  │  - Seek Bar      │         │  - Animated waves       │   │
│  │  - Time Display  │         │  - Gradient effects     │   │
│  └────────┬─────────┘         └──────────▲──────────────┘   │
│           │                              │                   │
└───────────┼──────────────────────────────┼───────────────────┘
            │                              │
            ▼                              │
┌─────────────────────────────────────────┼───────────────────┐
│                   Audio System           │                   │
├──────────────────────────────────────────┴───────────────────┤
│                                                               │
│  ┌──────────────┐      ┌──────────────┐    ┌──────────────┐ │
│  │ AudioLoader  │─────▶│ FlacDecoder  │───▶│ AudioPlayer  │ │
│  │              │      │              │    │              │ │
│  │ - Google     │      │ Web Audio    │    │ - Play/Pause │ │
│  │   Bucket     │      │   API        │    │ - Seek       │ │
│  │ - FTP        │      │ - Decode     │    │ - Volume     │ │
│  │ - HTTP/HTTPS │      │   FLAC/WAV   │    │ - Analyser   │ │
│  └──────────────┘      └──────────────┘    └──────┬───────┘ │
│                                                    │         │
│                                                    │         │
│  ┌─────────────────────────────────────────────────┘         │
│  │                                                           │
│  │   ┌─────────────┐      ┌──────────────┐                 │
│  └──▶│  Analyser   │─────▶│  Destination │                 │
│      │    Node     │      │   (Speakers) │                 │
│      └─────────────┘      └──────────────┘                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Data Flow

### 1. Loading Audio
```
User enters URL
     │
     ▼
AudioLoader fetches file (CORS-enabled)
     │
     ▼
FlacDecoder decodes using Web Audio API
     │
     ▼
AudioPlayer stores AudioBuffer
```

### 2. Playing Audio
```
User clicks Play
     │
     ▼
AudioPlayer creates BufferSourceNode
     │
     ├─▶ GainNode (volume control)
     │       │
     │       ▼
     ├─▶ AnalyserNode (frequency data)
     │       │
     │       ├─▶ WebGPU Visualizer (shader rendering)
     │       │
     │       ▼
     └─▶ Destination (speakers)
```

### 3. Seeking
```
User drags seek slider
     │
     ▼
Calculate new position
     │
     ▼
Stop current playback
     │
     ▼
Start new playback at position
```

## Component Responsibilities

### Player Component (React)
- **UI State Management**: Controls, progress, loading states
- **User Interaction**: Button clicks, slider changes, URL input
- **Coordination**: Connects AudioPlayer with WebGPU Visualizer
- **Error Handling**: Displays error messages to user

### AudioLoader
- **HTTP Fetching**: Downloads audio files via fetch API
- **Source Handling**: Supports Google Bucket, FTP, direct URLs
- **CORS Management**: Handles cross-origin requests
- **Error Handling**: Network and loading errors

### FlacDecoder
- **Audio Decoding**: Uses Web Audio API's decodeAudioData
- **Format Support**: FLAC, WAV (browser-native support)
- **Buffer Creation**: Prepares AudioBuffer for playback
- **Channel Management**: Handles mono/stereo audio

### AudioPlayer
- **Playback Control**: Play, pause, stop, seek
- **State Management**: Current time, duration, playing state
- **Audio Graph**: Manages Web Audio API nodes
- **Callbacks**: Notifies UI of state changes

### WebGPU Visualizer
- **GPU Initialization**: Sets up WebGPU device and context
- **Shader Compilation**: WGSL shader code for visualization
- **Uniform Management**: Passes audio data to shaders
- **Animation Loop**: Continuous rendering at 60fps
- **Audio Reactivity**: Visualizes frequency data

## Technology Stack Details

### Frontend
- **React 18**: Component-based UI
- **TypeScript**: Type safety and IDE support
- **CSS3**: Modern styling with gradients

### Audio Processing
- **Web Audio API**: Browser-native audio processing
- **AnalyserNode**: Real-time frequency analysis
- **AudioBuffer**: In-memory audio storage
- **BufferSourceNode**: Audio playback

### Visualization
- **WebGPU**: Modern GPU API
- **WGSL**: WebGPU Shading Language
- **Uniform Buffers**: Data transfer to GPU
- **Canvas API**: Rendering surface

### Build System
- **Webpack 5**: Module bundling
- **Babel**: JavaScript transpilation
- **TypeScript Compiler**: Type checking
- **ESLint**: Code quality

## Performance Considerations

### Audio
- Decoding happens once when loading
- Playback uses optimized Web Audio API
- Minimal CPU usage during playback

### Visualization
- GPU-accelerated rendering via WebGPU
- 60fps animation loop
- Efficient uniform buffer updates
- Fallback for non-WebGPU browsers

### Build
- Code splitting for optimal loading
- Minification and tree-shaking
- Total bundle size: ~157 KB
- Fast initial load time

## Browser Compatibility

### Required
- Modern browser (Chrome 90+, Firefox 88+, Safari 14+)
- Web Audio API support (all modern browsers)
- ES2020 JavaScript support

### Optional
- WebGPU support (Chrome 113+, Edge 113+)
- Application works without WebGPU, just no visualization

## Security

### CORS
- All audio fetching uses CORS mode
- Requires properly configured audio sources
- No credentials sent with requests

### Content Security
- No eval() or unsafe code execution
- No inline scripts in HTML
- Strict type checking via TypeScript

### Data Privacy
- No data collection
- No external analytics
- Purely client-side application
