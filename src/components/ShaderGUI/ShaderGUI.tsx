import React, { useRef, useEffect, useState, useCallback } from 'react';
import { WebGPUVisualizer } from '../../webgpuVisualizer';
import { CanvasFallbackVisualizer } from '../../visuals/webglFallback';
import { PlaylistTrack } from '../../audioLoader';
import { Chassis } from './Chassis';
import { TopScreen } from './TopScreen';
import { BottomScreen } from './BottomScreen';
import { Knob } from './Knob';
import { Button } from './Button';
import { VolumeSlider } from './VolumeSlider';
import { useBeatDetection } from '../../hooks/useBeatDetection';
import { formatTime } from '../../utils/audioUtils';
import './ShaderGUI.css';

export interface ShaderGUIProps {
  analyser: AnalyserNode | null;
  currentTrack: PlaylistTrack | null;
  queue: PlaylistTrack[];
  queueCurrentIndex: number;
  isPlaying: boolean;
  isLoading?: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted?: boolean;
  onPlay: () => void;
  onStop: () => void;
  onSeek?: (time: number) => void;
  onTrackClick: (index: number) => void;
  onVolumeChange: (volume: number) => void;
  onMute?: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
  onToggleFallback?: () => void;
  showFallbackToggle?: boolean;
  onFileSelect?: (files: File[]) => void;
}

export const ShaderGUI: React.FC<ShaderGUIProps> = ({
  analyser,
  currentTrack,
  queue,
  queueCurrentIndex,
  isPlaying,
  isLoading = false,
  currentTime,
  duration,
  volume,
  muted = false,
  onPlay,
  onStop,
  onSeek,
  onTrackClick,
  onVolumeChange,
  onMute,
  onNext,
  onPrevious,
  onToggleFallback,
  showFallbackToggle = false,
  onFileSelect,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const visualizerRef = useRef<WebGPUVisualizer | null>(null);
  const fallbackRef = useRef<CanvasFallbackVisualizer | null>(null);
  const animFrameRef = useRef<number>(0);
  const [webGPUSupported, setWebGPUSupported] = useState(true);
  const [fallbackMessage, setFallbackMessage] = useState('');

  // Knob values stored in refs to avoid re-render on drag
  const rsycrbRef = useRef(0.0);
  const fractalRef = useRef(0.0);
  const pulseRef = useRef(0.0);

  // Button states (useState is fine — they change infrequently)
  const [modeNone, setModeNone] = useState(1);
  const [modeIR, setModeIR] = useState(0);
  const [stopFlash, setStopFlash] = useState(0);
  const [visualizerMode, setVisualizerMode] = useState<'gui' | '3D'>('gui');

  const { beatPhaseRef, spectrumRef, processFrame } = useBeatDetection();
  const timeRef = useRef(0);

  // Initialize WebGPU visualizer (with fallback)
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      if (!canvasRef.current || !analyser) return;

      const visualizer = new WebGPUVisualizer(canvasRef.current);
      visualizerRef.current = visualizer;

      try {
        await visualizer.initialize(analyser);
        if (cancelled) {
          visualizer.destroy();
          return;
        }
        setWebGPUSupported(true);
        setFallbackMessage('');
      } catch (err: unknown) {
        visualizer.destroy();
        visualizerRef.current = null;

        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('webgpu-unsupported')) {
          setFallbackMessage('WebGPU not supported in this browser. Using Canvas2D fallback.');
        } else if (msg.includes('webgpu-no-adapter')) {
          setFallbackMessage('No GPU adapter found. Using Canvas2D fallback.');
        } else if (msg.includes('webgpu-shader-compile-error')) {
          setFallbackMessage('WebGPU shader error. Using Canvas2D fallback.');
        } else {
          setFallbackMessage('WebGPU initialization failed. Using Canvas2D fallback.');
        }
        console.warn('[ShaderGUI] WebGPU failed:', msg);
        setWebGPUSupported(false);

        // Initialize Canvas2D fallback
        const fallback = new CanvasFallbackVisualizer(canvasRef.current);
        fallback.initialize(analyser);
        fallbackRef.current = fallback;
      }
    };

    init();

    return () => {
      cancelled = true;
      visualizerRef.current?.destroy();
      visualizerRef.current = null;
      fallbackRef.current?.destroy();
      fallbackRef.current = null;
    };
  }, [analyser]);

  // Animation loop
  useEffect(() => {
    const loop = () => {
      timeRef.current += 0.016;

      // Process audio data
      processFrame(analyser);

      // Update WebGPU visualizer
      const vis = visualizerRef.current;
      if (vis && webGPUSupported && analyser) {
        const freqData = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(freqData);
        vis.setAudioData(freqData);
      }

      if (vis && webGPUSupported) {
        if (visualizerMode === '3D') {
          vis.render();
        } else {
          const spectrum = spectrumRef.current;
          const progress = duration > 0 ? currentTime / duration : 0;
          const canvas = canvasRef.current;

          vis.setUniforms({
            resolution: [canvas?.width || 640, canvas?.height || 160],
            time: timeRef.current,
            beatPhase: beatPhaseRef.current,
            rsycrb: rsycrbRef.current,
            fractal: fractalRef.current,
            pulse: pulseRef.current,
            audioLevel: spectrum[0] + spectrum[1] + spectrum[2],
            audioLevelL: spectrum[0],
            audioLevelR: spectrum[1],
            spectrum0: spectrum[0],
            spectrum1: spectrum[1],
            spectrum2: spectrum[2],
            spectrum3: spectrum[3],
            spectrum4: spectrum[4],
            modeNone: modeNone,
            modeIR: modeIR,
            isPlaying: isPlaying ? 1 : 0,
            playbackProgress: progress,
            volume: volume,
            colorShift: 0,
          });

          vis.renderGUI();
        }
      }

      // Render Canvas2D fallback when WebGPU is unavailable
      const fallback = fallbackRef.current;
      if (!webGPUSupported && fallback) {
        fallback.render();
      }

      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [analyser, webGPUSupported, processFrame, beatPhaseRef, spectrumRef, isPlaying, currentTime, duration, volume, modeNone, modeIR, visualizerMode]);

  const handlePlay = useCallback(() => {
    onPlay();
  }, [onPlay]);

  const handleStop = useCallback(() => {
    setStopFlash(1);
    setTimeout(() => setStopFlash(0), 300);
    onStop();
  }, [onStop]);

  const handleSeekBarClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!onSeek || duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(ratio * duration);
  }, [onSeek, duration]);

  const handleNone = useCallback(() => {
    setModeNone(prev => {
      const next = prev ? 0 : 1;
      if (next) setModeIR(0);
      return next;
    });
  }, []);

  const handleIR = useCallback(() => {
    setModeIR(prev => {
      const next = prev ? 0 : 1;
      if (next) setModeNone(0);
      return next;
    });
  }, []);

  const handleToggle3D = useCallback(() => {
    setVisualizerMode(prev => {
      const next = prev === 'gui' ? '3D' : 'gui';
      visualizerRef.current?.setMode(next === '3D' ? '3D' : 'flat');
      return next;
    });
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter(
      f => f.name.endsWith('.flac') || f.name.endsWith('.wav') || f.name.endsWith('.mp3') || f.type.includes('audio')
    );
    if (files.length > 0 && onFileSelect) {
      onFileSelect(files);
    }
    e.target.value = '';
  }, [onFileSelect]);

  const handleOpenFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  return (
    <div className="relative flex flex-col items-center justify-center min-h-screen bg-black">
      {showFallbackToggle && onToggleFallback && (
        <button
          onClick={onToggleFallback}
          className="absolute top-4 right-4 px-4 py-2 bg-white/10 text-white rounded hover:bg-white/20 text-xs tracking-widest uppercase z-50"
        >
          Open Advanced Library
        </button>
      )}
      {fallbackMessage && (
        <div className="absolute top-4 left-4 px-3 py-1.5 bg-yellow-500/20 text-yellow-200 rounded text-xs max-w-xs z-50 border border-yellow-500/30">
          {fallbackMessage}
        </div>
      )}
      <Chassis>
      <div className="shader-gui-layout">
        <div className="shader-gui-top-left">
          <TopScreen
            canvasRef={canvasRef}
            artist={currentTrack?.author}
            title={currentTrack?.title || currentTrack?.name}
            webGPUSupported={webGPUSupported}
            onCanvasResize={() => {
              visualizerRef.current?.resize();
              fallbackRef.current?.resize();
            }}
            onCanvasDoubleClick={handleToggle3D}
            isLoading={isLoading}
          />
          {/* Seek bar + time display */}
          <div className="shader-seek-row">
            <span className="shader-time-display">{formatTime(currentTime)}</span>
            <div
              className="shader-seek-bar"
              onClick={handleSeekBarClick}
              title={onSeek ? 'Click to seek' : ''}
              style={{ cursor: onSeek && duration > 0 ? 'pointer' : 'default' }}
            >
              <div
                className="shader-seek-progress"
                style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
              />
            </div>
            <span className="shader-time-display shader-time-right">
              -{formatTime(Math.max(0, duration - currentTime))}
            </span>
          </div>
        </div>

        <div className="shader-gui-top-right">
          <div className="shader-gui-knobs">
            <Knob
              label="RSYCRB"
              initialValue={0}
              onChange={(v) => { rsycrbRef.current = v; }}
            />
            <Knob
              label="FRACTAL"
              initialValue={0}
              onChange={(v) => { fractalRef.current = v; }}
            />
            <Knob
              label="PULSE"
              initialValue={0}
              onChange={(v) => { pulseRef.current = v; }}
            />
          </div>

          <div className="shader-gui-buttons">
            <Button type="prev" active={false} onClick={() => onPrevious?.()} />
            <Button type="none" active={modeNone === 1} onClick={handleNone} />
            <Button type="ir" active={modeIR === 1} onClick={handleIR} />
            <Button type="stop" active={stopFlash > 0} onClick={handleStop} />
            <Button type="play" active={isPlaying} onClick={handlePlay} />
            <Button type="next" active={false} onClick={() => onNext?.()} />
          </div>

          {onFileSelect && (
            <button
              onClick={handleOpenFiles}
              className="shader-button"
              title="Open local audio files"
              aria-label="Open Files"
            >
              <span className="button-icon">📂</span>
            </button>
          )}
        </div>

        <div className="shader-gui-bottom-left">
          <BottomScreen
            tracks={queue}
            currentIndex={queueCurrentIndex}
            onTrackClick={onTrackClick}
            isLoading={isLoading}
          />
        </div>

        <div className="shader-gui-volume-col">
          <VolumeSlider value={muted ? 0 : volume} onChange={onVolumeChange} />
          {onMute && (
            <button
              onClick={onMute}
              className="shader-mute-btn"
              title={muted ? 'Unmute (M)' : 'Mute (M)'}
              aria-label={muted ? 'Unmute' : 'Mute'}
            >
              {muted ? '🔇' : '🔊'}
            </button>
          )}
        </div>
      </div>
    </Chassis>
    <input
      ref={fileInputRef}
      type="file"
      multiple
      accept=".flac,.wav,.mp3,audio/flac,audio/wav,audio/x-wav,audio/mpeg"
      onChange={handleFileInput}
      className="hidden"
      aria-hidden="true"
    />
    </div>
  );
};

export default ShaderGUI;
