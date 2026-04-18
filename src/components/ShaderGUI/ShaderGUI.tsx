import React, { useRef, useEffect, useState, useCallback } from 'react';
import { WebGPUVisualizer } from '../../webgpuVisualizer';
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
  currentTime: number;
  duration: number;
  volume: number;
  onPlay: () => void;
  onStop: () => void;
  onTrackClick: (index: number) => void;
  onVolumeChange: (volume: number) => void;
}

export const ShaderGUI: React.FC<ShaderGUIProps> = ({
  analyser,
  currentTrack,
  queue,
  queueCurrentIndex,
  isPlaying,
  currentTime,
  duration,
  volume,
  onPlay,
  onStop,
  onTrackClick,
  onVolumeChange,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const visualizerRef = useRef<WebGPUVisualizer | null>(null);
  const animFrameRef = useRef<number>(0);
  const [webGPUSupported, setWebGPUSupported] = useState(true);

  // Knob values stored in refs to avoid re-render on drag
  const rsycrbRef = useRef(0.0);
  const fractalRef = useRef(0.0);
  const pulseRef = useRef(0.0);

  // Button states (useState is fine — they change infrequently)
  const [modeNone, setModeNone] = useState(1);
  const [modeIR, setModeIR] = useState(0);
  const [stopFlash, setStopFlash] = useState(0);

  const { beatPhaseRef, spectrumRef, processFrame } = useBeatDetection();
  const timeRef = useRef(0);

  // Initialize WebGPU visualizer
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      if (!canvasRef.current || !analyser) return;

      const visualizer = new WebGPUVisualizer(canvasRef.current);
      visualizerRef.current = visualizer;

      const success = await visualizer.initialize(analyser);
      if (cancelled) {
        visualizer.destroy();
        return;
      }

      if (!success) {
        setWebGPUSupported(false);
        return;
      }
    };

    init();

    return () => {
      cancelled = true;
      if (visualizerRef.current) {
        visualizerRef.current.destroy();
        visualizerRef.current = null;
      }
    };
  }, [analyser]);

  // Animation loop
  useEffect(() => {
    const loop = () => {
      timeRef.current += 0.016;

      // Process audio data
      processFrame(analyser);

      // Stop flash is handled via setTimeout, not RAF

      // Update visualizer uniforms
      const vis = visualizerRef.current;
      if (vis && webGPUSupported) {
        const spectrum = spectrumRef.current;
        const progress = duration > 0 ? currentTime / duration : 0;

        vis.setUniforms({
          resolution: [canvasRef.current?.width || 640, canvasRef.current?.height || 160],
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

      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [analyser, webGPUSupported, processFrame, beatPhaseRef, spectrumRef, isPlaying, currentTime, duration, volume, modeNone, modeIR]);

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

  return (
    <Chassis>
      <div className="shader-gui-layout">
        <div className="shader-gui-top-left">
          <TopScreen
            canvasRef={canvasRef}
            artist={currentTrack?.author}
            title={currentTrack?.title || currentTrack?.name}
            webGPUSupported={webGPUSupported}
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
            <Button type="none" active={modeNone === 1} onClick={handleNone} />
            <Button type="ir" active={modeIR === 1} onClick={handleIR} />
            <Button type="stop" active={stopFlash > 0} onClick={handleStop} />
            <Button type="play" active={isPlaying} onClick={handlePlay} />
          </div>
        </div>

        <div className="shader-gui-bottom-left">
          <BottomScreen
            tracks={queue}
            currentIndex={queueCurrentIndex}
            onTrackClick={onTrackClick}
          />
        </div>

        <div style={{ gridColumn: 2, gridRow: 2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <VolumeSlider value={volume} onChange={onVolumeChange} />
        </div>
      </div>
    </Chassis>
  );
};

export default ShaderGUI;
