// src/visuals/webglFallback.ts
// Final fallback visualizer using Canvas2D when WebGPU and WebGL2 are unavailable.
// Draws animated frequency bars + waveform. Prefer WebGL2Visualizer for shader parity.

export class CanvasFallbackVisualizer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animationFrameId: number | null = null;
  private analyser: AnalyserNode | null = null;
  private freqData = new Uint8Array(0);
  private waveData = new Uint8Array(0);
  private time = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas2D not supported');
    }
    this.ctx = ctx;
  }

  initialize(analyser: AnalyserNode): boolean {
    this.analyser = analyser;
    this.freqData = new Uint8Array(analyser.frequencyBinCount);
    this.waveData = new Uint8Array(analyser.frequencyBinCount);
    return true;
  }

  render(): void {
    if (!this.analyser) return;

    this.analyser.getByteFrequencyData(this.freqData);
    this.analyser.getByteTimeDomainData(this.waveData);
    this.time += 0.016;

    const { width, height } = this.canvas;
    const ctx = this.ctx;

    // Subtle trail effect
    ctx.fillStyle = 'rgba(5, 5, 15, 0.25)';
    ctx.fillRect(0, 0, width, height);

    // Frequency bars
    const barCount = 64;
    const barWidth = width / barCount;
    const binRatio = this.freqData.length / barCount;

    for (let i = 0; i < barCount; i++) {
      let sum = 0;
      const start = Math.floor(i * binRatio);
      const end = Math.floor((i + 1) * binRatio);
      for (let j = start; j < end; j++) sum += this.freqData[j];
      const avg = sum / Math.max(1, end - start) / 255;

      const barHeight = avg * height * 0.75;
      const x = i * barWidth;
      const y = height - barHeight;

      const hue = 180 + (i / barCount) * 120 + Math.sin(this.time * 2 + i * 0.1) * 20;
      ctx.fillStyle = `hsla(${hue}, 80%, 60%, ${0.5 + avg * 0.5})`;
      ctx.fillRect(x + 1, y, barWidth - 2, barHeight);
    }

    // Waveform line with glow
    ctx.beginPath();
    ctx.shadowBlur = 8;
    ctx.shadowColor = 'rgba(100, 200, 255, 0.5)';
    ctx.strokeStyle = 'rgba(150, 220, 255, 0.7)';
    ctx.lineWidth = 2;

    const sliceWidth = width / this.waveData.length;
    let x = 0;
    for (let i = 0; i < this.waveData.length; i++) {
      const v = this.waveData[i] / 128.0;
      const y = (v * height) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Subtle overlay text
    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.font = '10px monospace';
    ctx.fillText('Canvas2D Fallback', 8, height - 8);
  }

  startAnimation(): void {
    const loop = () => {
      this.render();
      this.animationFrameId = requestAnimationFrame(loop);
    };
    loop();
  }

  stopAnimation(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  resize(): void {
    // Canvas dimensions are managed by the parent component (TopScreen)
  }

  destroy(): void {
    this.stopAnimation();
    this.analyser = null;
  }
}
