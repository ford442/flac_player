// Listening rooms — NTP-style estimate of the server clock.
//
// Room timestamps are server wall-clock ms; device clocks can disagree by
// seconds. Each TIME_SYNC round trip yields offset = serverTime - midpoint;
// the lowest-RTT recent sample wins because its midpoint is the tightest bound.

/** Monotonic local clock in epoch-like ms (immune to wall-clock jumps). */
export function localNow(): number {
  return performance.timeOrigin + performance.now();
}

export interface ClockSample {
  offsetMs: number;
  rttMs: number;
}

/** Samples slower than this are too loose to bound the offset usefully. */
export const MAX_SAMPLE_RTT_MS = 5000;
const MAX_SAMPLES = 8;

export function clockSampleFrom(sentAt: number, serverTime: number, receivedAt: number): ClockSample | null {
  const rttMs = receivedAt - sentAt;
  if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > MAX_SAMPLE_RTT_MS) return null;
  return { offsetMs: serverTime - (sentAt + receivedAt) / 2, rttMs };
}

export function bestSample(samples: readonly ClockSample[]): ClockSample | null {
  let best: ClockSample | null = null;
  for (const sample of samples) {
    if (!best || sample.rttMs < best.rttMs) best = sample;
  }
  return best;
}

export class ServerClock {
  private samples: ClockSample[] = [];
  private offsetMs = 0;

  constructor(private readonly now: () => number = localNow) {}

  addSample(sample: ClockSample | null): void {
    if (!sample) return;
    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    this.offsetMs = bestSample(this.samples)?.offsetMs ?? this.offsetMs;
  }

  /** Coarse fallback before any TIME_SYNC reply: assume one-way latency ≈ 0. */
  seedFromServerTime(serverTime: number): void {
    if (this.samples.length === 0) this.offsetMs = serverTime - this.now();
  }

  hasSamples(): boolean {
    return this.samples.length > 0;
  }

  getOffsetMs(): number {
    return this.offsetMs;
  }

  /** Current server time estimate (ms). */
  serverNow(): number {
    return this.now() + this.offsetMs;
  }

  reset(): void {
    this.samples = [];
    this.offsetMs = 0;
  }
}
