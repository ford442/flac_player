import React, { useRef, useEffect, useState, useCallback } from 'react';
import { WebGPUVisualizer } from '../../webgpuVisualizer';
import { buildFrameUniforms } from '../../visuals/visualSync';
import {
  readVisualizerPreference,
  resolveVisualizerBackend,
} from '../../visuals/rendererSelection';
import { setCurrentVisualizer } from '../../visuals/webgl2/global';
import { cycleDebugMode } from '../../visuals/webgl2/debugModes';
import {
  probeWebGPU,
  recordWebGPUFailure,
  type WebGPUProbeBreadcrumb,
} from '../../visuals/webgpuProbe';
import { adoptVisualizerDevice, releaseVisualizerDevice } from '../../gpu-chores';
import type { GpuChoreBackend } from '../../gpu-chores';
import { WaveformOverview } from '../WaveformOverview';
import { PlaylistTrack } from '../../audioLoader';
import { Chassis } from './Chassis';
import { TopScreen } from './TopScreen';
import { BottomScreen } from './BottomScreen';
import { Knob } from './Knob';
import { Button } from './Button';
import { VolumeSlider } from './VolumeSlider';
import { useBeatDetection } from '../../hooks/useBeatDetection';
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
  /** Hide GPU visualizer; keep transport/queue controls (projectM-only mode). */
  controlsOnly?: boolean;
  /** Scrubber peaks from gpu-chores (null while streaming / not yet reduced). */
  overviewMinmax?: Float32Array | null;
  overviewRms?: number | null;
  overviewPeak?: number | null;
  overviewBackend?: GpuChoreBackend | null;
  overviewReason?: string | null;
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
  controlsOnly = false,
  overviewMinmax = null,
  overviewRms = null,
  overviewPeak = null,
  overviewBackend = null,
  overviewReason = null,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const webgpuRef = useRef<WebGPUVisualizer | null>(null);
  const animFrameRef = useRef<number>(0);
  const [probeFailure, setProbeFailure] = useState<WebGPUProbeBreadcrumb | null>(null);
  const [showDebugPanel, setShowDebugPanel] = useState(false);

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
    releaseVisualizerDevice(webgpuRef.current?.getDevice() ?? null);
    webgpuRef.current?.destroy();
    webgpuRef.current = null;
    setCurrentVisualizer(null);
  }, []);

  const initWebGPU = useCallback(async (
    node: HTMLCanvasElement,
    audioAnalyser: AnalyserNode,
    cancelled: () => boolean,
  ) => {
    setProbeFailure(null);
    const requestedVisualizer = readVisualizerPreference();
    const requiredBackend = resolveVisualizerBackend(requestedVisualizer);
    const boot = await probeWebGPU(node, { requestedVisualizer });
    if (cancelled()) {
      if (boot.ok) boot.device.destroy();
      return;
    }
    if (!boot.ok) {
      console.warn('[ShaderGUI] WebGPU boot probe failed:', boot.breadcrumb.reason);
      setProbeFailure(boot.breadcrumb);
      setCurrentVisualizer(null);
      return;
    }

    const visualizer = new WebGPUVisualizer(node);
    webgpuRef.current = visualizer;

    visualizer.setOnDeviceLost((reason) => {
      if (cancelled()) return;
      const fatal = recordWebGPUFailure(
        boot.breadcrumb,
        'webgpu-device-lost',
        reason,
      );
      releaseVisualizerDevice(visualizer.getDevice());
      visualizer.destroy();
      webgpuRef.current = null;
      setCurrentVisualizer(null);
      setProbeFailure(fatal);
    });

    try {
      await visualizer.initialize(audioAnalyser, boot);
      if (cancelled()) {
        visualizer.destroy();
        webgpuRef.current = null;
        return;
      }
      setProbeFailure(null);
      adoptVisualizerDevice(visualizer.getDevice());
      setCurrentVisualizer({
        backend: requiredBackend,
        readPixels: () => null,
        getCanvas: () => node,
        setDebugMode: (mode) => visualizer.setDebugMode(mode),
        getDebugMode: () => visualizer.getDebugMode(),
        resize: () => visualizer.resize(),
        getGpuDevice: () => visualizer.getDevice(),
      });
    } catch (err: unknown) {
      visualizer.destroy();
      webgpuRef.current = null;
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[ShaderGUI] WebGPU initialization failed:', msg);
      if (cancelled()) return;
      setCurrentVisualizer(null);
      setProbeFailure(recordWebGPUFailure(
        boot.breadcrumb,
        'webgpu-visualizer-initialize-failed',
        msg,
      ));
    }
  }, []);

  // Initialize the required WebGPU visualizer. Failure is fatal for this slot.
  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;

    const init = async () => {
      if (!canvasRef.current || !analyser || controlsOnly) return;

      destroyAllVisualizers();
      await initWebGPU(canvasRef.current, analyser, isCancelled);
    };

    init();

    return () => {
      cancelled = true;
      destroyAllVisualizers();
    };
  }, [analyser, controlsOnly, destroyAllVisualizers, initWebGPU]);

  // Alt+D cycles WebGPU shader diagnostics.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey || e.key.toLowerCase() !== 'd') return;
      const handle = webgpuRef.current;
      if (!handle) return;

      e.preventDefault();
      const next = cycleDebugMode(handle.getDebugMode());
      handle.setDebugMode(next);
      console.log(`[webgpu debug] mode: ${next}`);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

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
        if (webgpu) {
          webgpu.setAudioData(freqData);
          if (visualizerMode === '3D') {
            webgpu.render();
          } else {
            webgpu.setUniforms(frameUniforms);
            webgpu.renderGUI();
          }
        }
      }

      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [
    analyser, processFrame, beatPhaseRef, spectrumRef,
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
          <div className="text-[10px] text-gray-400">
            Required backend: <strong className="text-purple-200">webgpu</strong>
            <br />
            DEBUG_VISUALIZER: <code>{window.DEBUG_VISUALIZER ?? 'unset'}</code>
          </div>
          <div className="mt-2 text-[10px] text-gray-500">
            Handle: <code>window.currentVisualizer</code>
            {' · '}Chores: <code>window.__gpuChores</code>
          </div>
          <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap text-[9px] text-cyan-200">
            {JSON.stringify({
              probe: probeFailure ?? window.webgpuProbe ?? null,
              chores: window.__gpuChores?.last ?? null,
            }, null, 2)}
          </pre>
        </div>
      )}

      <Chassis>
      <div className={`shader-gui-layout${controlsOnly ? ' shader-gui-layout--controls-only' : ''}`}>
        {!controlsOnly && (
        <>
        <div className="shader-gui-top-left">
          <TopScreen
            canvasRef={canvasRef}
            artist={currentTrack?.author}
            title={currentTrack?.title || currentTrack?.name}
            activeBackend="webgpu"
            probeFailure={probeFailure}
            onCanvasResize={() => webgpuRef.current?.resize()}
            onCanvasDoubleClick={handleToggle3D}
            isLoading={isLoading}
          />
          <WaveformOverview
            minmax={overviewMinmax}
            currentTime={currentTime}
            duration={duration}
            onSeek={onSeek}
            analyser={analyser}
            rms={overviewRms}
            peak={overviewPeak}
            backend={overviewBackend}
            reason={overviewReason}
          />
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
        </>
        )}

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
