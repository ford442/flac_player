import React, { useEffect, useRef } from 'react';
import { METER_HZ, reduceRms } from '../gpu-chores';
import type { GpuChoreBackend } from '../gpu-chores';
import { formatTime } from '../utils/audioUtils';
import './WaveformOverview.css';

export interface WaveformOverviewProps {
  minmax: Float32Array | null;
  currentTime: number;
  duration: number;
  onSeek?: (time: number) => void;
  analyser?: AnalyserNode | null;
  rms?: number | null;
  peak?: number | null;
  backend?: GpuChoreBackend | null;
  reason?: string | null;
  className?: string;
}

function dbLabel(linear: number | null | undefined): string {
  if (linear === null || linear === undefined || linear <= 1e-9) return '-∞';
  return `${(20 * Math.log10(linear)).toFixed(1)}`;
}

function drawPeaks(
  ctx: CanvasRenderingContext2D,
  minmax: Float32Array,
  width: number,
  height: number,
  progress: number,
): void {
  const bins = Math.floor(minmax.length / 2);
  if (bins <= 0 || width <= 0 || height <= 0) return;
  ctx.clearRect(0, 0, width, height);

  const mid = height / 2;
  const playedUntil = progress * width;
  const step = width / bins;

  ctx.lineWidth = Math.max(1, step * 0.9);
  for (let i = 0; i < bins; i++) {
    const min = minmax[i * 2];
    const max = minmax[i * 2 + 1];
    const x = (i + 0.5) * step;
    const y0 = mid - max * mid;
    const y1 = mid - min * mid;
    ctx.beginPath();
    ctx.strokeStyle = x <= playedUntil ? 'rgba(34, 211, 238, 0.95)' : 'rgba(155, 89, 182, 0.7)';
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.fillRect(Math.max(0, playedUntil - 1), 0, 2, height);
}

/**
 * Scrubber peak strip. Peaks come from gpu-chores (Worker/CPU/WebGPU); live
 * RMS/peak meters sample the analyser at ≤ 30 Hz — never the audio callback.
 */
export const WaveformOverview: React.FC<WaveformOverviewProps> = ({
  minmax,
  currentTime,
  duration,
  onSeek,
  analyser,
  rms,
  peak,
  backend,
  reason,
  className,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveRmsRef = useRef(0);
  const livePeakRef = useRef(0);
  const meterLabelRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width * dpr));
      const h = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      if (minmax) {
        drawPeaks(ctx, minmax, canvas.width, canvas.height, duration > 0 ? currentTime / duration : 0);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const progress = duration > 0 ? currentTime / duration : 0;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.fillRect(0, canvas.height / 2 - 1, canvas.width, 2);
        ctx.fillStyle = 'rgba(34, 211, 238, 0.9)';
        ctx.fillRect(0, canvas.height / 2 - 2, canvas.width * progress, 4);
      }
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [minmax, currentTime, duration]);

  useEffect(() => {
    if (!analyser) return;
    const fft = analyser.fftSize;
    const buf = new Float32Array(fft);
    const interval = 1000 / METER_HZ;
    const id = window.setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      const peek = reduceRms(buf);
      liveRmsRef.current = peek.rms;
      livePeakRef.current = peek.peak;
      const el = meterLabelRef.current;
      if (el) {
        el.textContent = `RMS ${dbLabel(peek.rms)}  PK ${dbLabel(peek.peak)}`;
      }
    }, interval);
    return () => window.clearInterval(id);
  }, [analyser]);

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onSeek || duration <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    onSeek(ratio * duration);
  };

  const fileMeters = rms !== null && rms !== undefined;

  return (
    <div
      className={`waveform-overview ${className ?? ''}`.trim()}
      onClick={handleClick}
      title={onSeek ? 'Click to seek' : ''}
      style={{ cursor: onSeek && duration > 0 ? 'pointer' : 'default' }}
      data-gpu-chores-backend={backend ?? 'none'}
      data-gpu-chores-reason={reason ?? ''}
      role="slider"
      aria-label="Seek position"
      aria-valuemin={0}
      aria-valuemax={duration || 0}
      aria-valuenow={currentTime}
    >
      <canvas ref={canvasRef} className="waveform-overview-canvas" />
      <div className="waveform-overview-meta">
        <span className="waveform-overview-time">{formatTime(currentTime)}</span>
        <span ref={meterLabelRef} className="waveform-overview-meters" title="Live analyser peek (CPU, ≤ 30 Hz)">
          {fileMeters ? `file RMS ${dbLabel(rms)}  PK ${dbLabel(peak)}` : 'RMS —'}
        </span>
        <span className="waveform-overview-time">{formatTime(Math.max(0, duration - currentTime))}</span>
      </div>
    </div>
  );
};

export default WaveformOverview;
