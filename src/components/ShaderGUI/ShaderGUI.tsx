import React, { useRef, useEffect, useState, useCallback } from 'react';
import { WebGPUVisualizer } from '../../webgpuVisualizer';
import { WebGL2Visualizer } from '../../visuals/webgl2/WebGL2Visualizer';
import { CanvasFallbackVisualizer } from '../../visuals/webglFallback';
import { buildFrameUniforms } from '../../visuals/visualSync';
import {
  resolveVisualizerBackendAsync,
  applyWebGPUFallback,
  subscribeVisualizerPreference,
  setVisualizerOverride,
} from '../../visuals/rendererSelection';
import { setCurrentVisualizer } from '../../visuals/webgl2/global';
import { cycleDebugMode } from '../../visuals/webgl2/debugModes';
import type { VisualizerBackend } from '../../visuals/types';
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

const BACKEND_LABELS: Record<VisualizerBackend, string> = {
  webgpu: 'WebGPU',
  webgl2: 'WebGL2',
  canvas2d: 'Canvas2D',
};

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
  const webgpuRef = useRef<WebGPUVisualizer | null>(null);
  const webgl2Ref = useRef<WebGL2Visualizer | null>(null);
  const canvasFallbackRef = useRef<CanvasFallbackVisualizer | null>(null);
  const animFrameRef = useRef<number>(0);
  const [activeBackend, setActiveBackend] = useState<VisualizerBackend>('webgpu');
  const activeBackendRef = useRef<VisualizerBackend>('webgpu');
  const isUnmountedRef = useRef(false);
  const [fallbackMessage, setFallbackMessage] = useState('');
  const [showDebugPanel, setShowDebugPanel] = useState(false);

  const setBackend = useCallback((backend: VisualizerBackend) => {
    activeBackendRef.current = backend;
    setActiveBackend(backend);
  }, []);

  const rsycrbRef = useRef(0.0);
  const fractalRef = useRef(0.0);
  const pulseRef = useRef(0.0);

  const [modeNone, setModeNone] = useState(1);
  const [modeIR, setModeIR] = useState(0);
  const [stopFlash, setStopFlash] = useState(0);
  const [visualizerMode, setVisualizerMode] = useState<'gui' | '3D'>('gui');

  const { beatPhaseRef, spectrumRef, processFrame } = useBeatDetection();
  const timeRef = useRef(0);

  const destroyAllVisualizers = useCallback(() => {
    webgpuRef.current?.destroy();
    webgpuRef.current = null;
    webgl2Ref.current?.destroy();
    webgl2Ref.current = null;
    canvasFallbackRef.current?.destroy();
    canvasFallbackRef.current = null;
    setCurrentVisualizer(null);
  }, []);

  const initCanvasFallback = useCallback((node: HTMLCanvasElement, audioAnalyser: AnalyserNode) => {
    const fallback = new CanvasFallbackVisualizer(node);
    fallback.initialize(audioAnalyser);
    canvasFallbackRef.current = fallback;
    setFallbackMessage('Using Canvas2D fallback — limited shader parity.');
    setBackend('canvas2d');
    setCurrentVisualizer({
      backend: 'canvas2d',
      readPixels: () => null,
      getCanvas: () => node,
      setDebugMode: () => {},
      getDebugMode: () => 'normal',
      resize: () => fallback.resize(),
    });
  }, [setBackend]);

  const initWebGL2 = useCallback((node: HTMLCanvasElement, audioAnalyser: AnalyserNode) => {
    const visualizer = new WebGL2Visualizer(node);
    const ok = visualizer.initialize(audioAnalyser);
    if (!ok) {
      initCanvasFallback(node, audioAnalyser);
      return;
    }
    webgl2Ref.current = visualizer;
    setFallbackMessage('WebGL2 reference renderer — shader-debug friendly.');
    setBackend('webgl2');
    setCurrentVisualizer({
      backend: 'webgl2',
      readPixels: () => visualizer.readPixels(),
      getCanvas: () => visualizer.getCanvas(),
      setDebugMode: (mode) => visualizer.setDebugMode(mode),
      getDebugMode: () => visualizer.getDebugMode(),
      resize: () => visualizer.resize(),
    });
  }, [initCanvasFallback, setBackend]);

  const initWebGPU = useCallback(async (
    node: HTMLCanvasElement,
    audioAnalyser: AnalyserNode,
    cancelled: () => boolean,
  ) => {
    const visualizer = new WebGPUVisualizer(node);
    webgpuRef.current = visualizer;

    visualizer.setOnDeviceLost((reason) => {
      if (cancelled()) return;
      const next = applyWebGPUFallback(reason);
      visualizer.destroy();
      webgpuRef.current = null;
      if (next === 'webgl2') {
        initWebGL2(node, audioAnalyser);
      } else {
        initCanvasFallback(node, audioAnalyser);
      }
    });

    try {
      await visualizer.initialize(audioAnalyser);
      if (cancelled()) {
        visualizer.destroy();
        webgpuRef.current = null;
        return;
      }
      setFallbackMessage('');
      setBackend('webgpu');
      setCurrentVisualizer({
        backend: 'webgpu',
        readPixels: () => null,
        getCanvas: () => node,
        setDebugMode: () => {},
        getDebugMode: () => 'normal',
        resize: () => visualizer.resize(),
      });
    } catch (err: unknown) {
      visualizer.destroy();
      webgpuRef.current = null;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[ShaderGUI] WebGPU failed:', msg);
      if (cancelled()) return;

      const next = applyWebGPUFallback(msg);
      if (next === 'webgl2') {
        initWebGL2(node, audioAnalyser);
      } else {
        initCanvasFallback(node, audioAnalyser);
      }
    }
  }, [initCanvasFallback, initWebGL2, setBackend]);

  // Initialize visualizer backend (WebGPU → WebGL2 → Canvas2D)
  useEffect(() => {
    isUnmountedRef.current = false;
    let cancelled = false;
    const isCancelled = () => cancelled;

    const init = async () => {
      if (!canvasRef.current || !analyser) return;

      destroyAllVisualizers();
      const backend = await resolveVisualizerBackendAsync();

      if (backend === 'canvas2d') {
        initCanvasFallback(canvasRef.current, analyser);
        return;
      }

      if (backend === 'webgl2') {
        initWebGL2(canvasRef.current, analyser);
        return;
      }

      await initWebGPU(canvasRef.current, analyser, isCancelled);
    };

    init();

    return () => {
      cancelled = true;
      isUnmountedRef.current = true;
      destroyAllVisualizers();
    };
  }, [analyser, destroyAllVisualizers, initCanvasFallback, initWebGL2, initWebGPU]);

  const swapBackend = useCallback((backend: VisualizerBackend) => {
    if (!canvasRef.current || !analyser) return;
    if (backend === activeBackendRef.current) return;

    destroyAllVisualizers();
    if (backend === 'webgpu') {
      initWebGPU(canvasRef.current, analyser, () => isUnmountedRef.current);
    } else if (backend === 'webgl2') {
      initWebGL2(canvasRef.current, analyser);
    } else {
      initCanvasFallback(canvasRef.current, analyser);
    }
  }, [analyser, destroyAllVisualizers, initCanvasFallback, initWebGL2, initWebGPU]);

  // Hot-swap when ?visualizer= or window.DEBUG_VISUALIZER changes (e.g. other tab / devtools)
  useEffect(() => {
    return subscribeVisualizerPreference((backend) => {
      swapBackend(backend);
    });
  }, [swapBackend]);

  // Alt+D cycles WebGL2 debug visualization modes (dev-friendly shader inspection)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey || e.key.toLowerCase() !== 'd') return;
      const gl2 = webgl2Ref.current;
      if (!gl2 || activeBackend !== 'webgl2') return;
      e.preventDefault();
      const next = cycleDebugMode(gl2.getDebugMode());
      gl2.setDebugMode(next);
      console.log(`[WebGL2 debug] mode: ${next}`);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeBackend]);

  // Animation loop — shared uniform/audio path for GPU backends
  useEffect(() => {
    const loop = () => {
      timeRef.current += 0.016;
      processFrame(analyser);

      const canvas = canvasRef.current;
      const frameUniforms = buildFrameUniforms({
        canvasWidth: canvas?.width || 640,
        canvasHeight: canvas?.height || 160,
        time: timeRef.current,
        beatPhase: beatPhaseRef.current,
        rsycrb: rsycrbRef.current,
        fractal: fractalRef.current,
        pulse: pulseRef.current,
        spectrum: spectrumRef.current,
        modeNone,
        modeIR,
        isPlaying,
        currentTime,
        duration,
        volume,
      });

      if (analyser) {
        const freqData = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(freqData);

        const webgpu = webgpuRef.current;
        if (webgpu && activeBackend === 'webgpu') {
          webgpu.setAudioData(freqData);
          if (visualizerMode === '3D') {
            webgpu.render();
          } else {
            webgpu.setUniforms(frameUniforms);
            webgpu.renderGUI();
          }
        }

        const webgl2 = webgl2Ref.current;
        if (webgl2 && activeBackend === 'webgl2') {
          webgl2.setAudioData(freqData);
          if (visualizerMode === '3D') {
            webgl2.setMode('3D');
            webgl2.setUniforms(frameUniforms);
            webgl2.render();
          } else {
            webgl2.setMode('flat');
            webgl2.setUniforms(frameUniforms);
            webgl2.renderGUI();
          }
        }
      }

      const canvasFallback = canvasFallbackRef.current;
      if (activeBackend === 'canvas2d' && canvasFallback) {
        canvasFallback.render();
      }

      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [
    analyser, activeBackend, processFrame, beatPhaseRef, spectrumRef,
    isPlaying, currentTime, duration, volume, modeNone, modeIR, visualizerMode,
  ]);

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
      webgpuRef.current?.setMode(next === '3D' ? '3D' : 'flat');
      webgl2Ref.current?.setMode(next === '3D' ? '3D' : 'flat');
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

  const handleRendererChange = useCallback((backend: VisualizerBackend) => {
    setVisualizerOverride(backend);
    swapBackend(backend);
  }, [swapBackend]);

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

      <button
        onClick={() => setShowDebugPanel((v) => !v)}
        className="absolute top-4 left-4 z-50 rounded-full border border-purple-500/40 bg-black/80 px-2 py-1 text-xs text-purple-300 hover:bg-black"
        title="Visualizer debug panel"
        aria-label="Toggle visualizer debug panel"
      >
        🎛
      </button>

      {showDebugPanel && (
        <div className="absolute top-12 left-4 z-50 max-w-xs rounded border border-purple-500/40 bg-black/90 p-3 font-mono text-xs text-purple-200">
          <div className="mb-2 font-bold text-purple-400">Visualizer Debug</div>
          <label className="flex items-center gap-2">
            <span className="text-gray-400">Backend:</span>
            <select
              value={activeBackend}
              onChange={(e) => handleRendererChange(e.target.value as VisualizerBackend)}
              className="rounded border border-purple-500/40 bg-[#111] px-1 py-0.5 text-[10px] text-purple-200"
            >
              <option value="webgpu">webgpu</option>
              <option value="webgl2">webgl2</option>
              <option value="canvas2d">canvas2d</option>
            </select>
          </label>
          <div className="mt-2 text-[10px] text-gray-400">
            Active: {BACKEND_LABELS[activeBackend]}
            {activeBackend === 'webgl2' && (
              <span className="mt-1 block text-yellow-300">Alt+D cycles debug modes</span>
            )}
          </div>
          <div className="mt-2 text-[10px] text-gray-500">
            URL: <code>?visualizer=webgl2</code>
            <br />
            Console: <code>window.DEBUG_VISUALIZER = &apos;webgl2&apos;</code>
            <br />
            Handle: <code>window.currentVisualizer</code>
          </div>
        </div>
      )}

      {fallbackMessage && !showDebugPanel && (
        <div className="absolute top-4 left-14 px-3 py-1.5 bg-yellow-500/20 text-yellow-200 rounded text-xs max-w-xs z-50 border border-yellow-500/30">
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
            webGPUSupported={activeBackend !== 'canvas2d'}
            activeBackend={activeBackend}
            onCanvasResize={() => {
              webgpuRef.current?.resize();
              webgl2Ref.current?.resize();
              canvasFallbackRef.current?.resize();
            }}
            onCanvasDoubleClick={handleToggle3D}
            isLoading={isLoading}
          />
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
