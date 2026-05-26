/**
 * EQChain – 5-band parametric EQ using BiquadFilterNodes.
 *
 * Band layout (centre frequencies):
 *  0 – Sub-bass   60 Hz  (lowshelf)
 *  1 – Bass      250 Hz  (peaking)
 *  2 – Mid      1000 Hz  (peaking)
 *  3 – High-mid 4000 Hz  (peaking)
 *  4 – Treble   12000 Hz (highshelf)
 *
 * Usage:
 *   const eq = new EQChain(audioContext);
 *   // Insert between gainNode and analyser:
 *   gainNode.disconnect();
 *   gainNode.connect(eq.input);
 *   eq.output.connect(analyser);
 *
 *   // Adjust a band (gain in dB, -12 to +12):
 *   eq.setBandGain(2, 3.5);
 */

export interface EQBand {
  /** Centre frequency in Hz */
  frequency: number;
  /** Filter type */
  type: BiquadFilterType;
  /** Gain in dB (−12 to +12) */
  gain: number;
  /** Q factor */
  Q: number;
  /** Human-readable label */
  label: string;
}

export const DEFAULT_EQ_BANDS: EQBand[] = [
  { frequency: 60,    type: 'lowshelf',  gain: 0, Q: 1.0, label: 'Sub' },
  { frequency: 250,   type: 'peaking',   gain: 0, Q: 1.4, label: 'Bass' },
  { frequency: 1000,  type: 'peaking',   gain: 0, Q: 1.4, label: 'Mid' },
  { frequency: 4000,  type: 'peaking',   gain: 0, Q: 1.4, label: 'Hi-Mid' },
  { frequency: 12000, type: 'highshelf', gain: 0, Q: 1.0, label: 'Treble' },
];

export class EQChain {
  private filters: BiquadFilterNode[];
  readonly input: BiquadFilterNode;
  readonly output: BiquadFilterNode;

  constructor(private ctx: AudioContext) {
    this.filters = DEFAULT_EQ_BANDS.map(band => {
      const node = ctx.createBiquadFilter();
      node.type = band.type;
      node.frequency.value = band.frequency;
      node.gain.value = band.gain;
      node.Q.value = band.Q;
      return node;
    });

    // Chain: filter[0] → filter[1] → … → filter[n-1]
    for (let i = 0; i < this.filters.length - 1; i++) {
      this.filters[i].connect(this.filters[i + 1]);
    }

    this.input  = this.filters[0];
    this.output = this.filters[this.filters.length - 1];
  }

  setBandGain(bandIndex: number, gainDb: number): void {
    if (bandIndex < 0 || bandIndex >= this.filters.length) return;
    this.filters[bandIndex].gain.value = Math.max(-12, Math.min(12, gainDb));
  }

  getBandGain(bandIndex: number): number {
    if (bandIndex < 0 || bandIndex >= this.filters.length) return 0;
    return this.filters[bandIndex].gain.value;
  }

  getAllGains(): number[] {
    return this.filters.map(f => f.gain.value);
  }

  setAllGains(gains: number[]): void {
    gains.forEach((g, i) => this.setBandGain(i, g));
  }

  resetAll(): void {
    this.filters.forEach(f => { f.gain.value = 0; });
  }

  disconnect(): void {
    this.filters.forEach(f => {
      try { f.disconnect(); } catch { /* already disconnected */ }
    });
  }
}
