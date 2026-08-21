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

const CANVAS_CSS_HEIGHT = 36;

function paintOverview(
  ctx: CanvasRenderingContext2D,
  peaks: Float32Array | null,
  time: number,
  duration: number,
): void {
  const { canvas } = ctx;
  const width = canvas.width;
  const height = canvas.height;
  if (width <= 0 || height <= 0) return;
  const progress = duration > 0 ? time / duration : 0;
  if (!peaks) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fillRect(0, height / 2 - 1, width, 2);
    ctx.fillStyle = 'rgba(34, 211, 238, 0.9)';
    ctx.fillRect(0, height / 2 - 2, width * progress, 4);
    return;
  }

  const bins = Math.floor(peaks.length / 2);
  if (bins <= 0) return;
  ctx.clearRect(0, 0, width, height);

  const mid = height / 2;
  const playedUntil = progress * width;
  const step = width / bins;

  ctx.lineWidth = Math.max(1, step * 0.9);
  for (let i = 0; i < bins; i++) {
    const min = peaks[i * 2];
    const max = peaks[i * 2 + 1];
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
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveRmsRef = useRef(0);
  const livePeakRef = useRef(0);
  const meterLabelRef = useRef<HTMLSpanElement>(null);
  const drawStateRef = useRef({ minmax, currentTime, duration });
  drawStateRef.current = { minmax, currentTime, duration };

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let frame = 0;

    const draw = () => {
      frame = 0;
      const { minmax: peaks, currentTime: time, duration: len } = drawStateRef.current;
      const dpr = window.devicePixelRatio || 1;
      const rect = host.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width * dpr));
      const h = Math.max(1, Math.floor(CANVAS_CSS_HEIGHT * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      paintOverview(ctx, peaks, time, len);
    };

    const scheduleDraw = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(draw);
    };

    draw();
    // Observe the host, not the canvas. Mutating canvas.width inside a
    // ResizeObserver callback on the canvas itself trips Chrome's
    // "ResizeObserver loop completed with undelivered notifications" error,
    // which webpack-dev-server treats as a fatal overlay.
    const observer = new ResizeObserver(scheduleDraw);
    observer.observe(host);
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { minmax: peaks, currentTime: time, duration: len } = drawStateRef.current;
    paintOverview(ctx, peaks, time, len);
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
      ref={hostRef}
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
