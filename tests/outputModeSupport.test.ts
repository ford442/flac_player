import { describe, it, expect, afterEach, vi } from 'vitest';
import { outputModeUnavailableReason } from '../src/audio/outputModeSupport';

describe('outputModeUnavailableReason (#259 A5)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('disables SDL3 (a -pthread build) on a page without cross-origin isolation', () => {
    vi.stubGlobal('crossOriginIsolated', false);
    expect(outputModeUnavailableReason('sdl')).toMatch(/cross-origin isolation/);
    expect(outputModeUnavailableReason('streaming')).toBeNull();
    expect(outputModeUnavailableReason('worklet')).toBeNull();
    expect(outputModeUnavailableReason('web-audio')).toBeNull();
  });

  it('offers SDL3 when the page is isolated', () => {
    vi.stubGlobal('crossOriginIsolated', true);
    expect(outputModeUnavailableReason('sdl')).toBeNull();
  });
});
