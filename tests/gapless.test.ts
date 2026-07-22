import { describe, it, expect } from 'vitest';
import { overlapSeconds, isGaplessActive } from '../src/types/gapless';

describe('gapless settings', () => {
  it('returns zero overlap for gapless mode', () => {
    expect(overlapSeconds({ mode: 'gapless', crossfadeMs: 3000 })).toBe(0);
  });

  it('converts crossfade ms to seconds', () => {
    expect(overlapSeconds({ mode: 'crossfade', crossfadeMs: 2500 })).toBe(2.5);
  });

  it('detects active gapless modes', () => {
    expect(isGaplessActive({ mode: 'off', crossfadeMs: 3000 })).toBe(false);
    expect(isGaplessActive({ mode: 'gapless', crossfadeMs: 3000 })).toBe(true);
    expect(isGaplessActive({ mode: 'crossfade', crossfadeMs: 3000 })).toBe(true);
  });
});
