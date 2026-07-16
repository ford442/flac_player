import { describe, it, expect } from 'vitest';
import { isSWServerMessage } from '../src/sw/swMessages';

describe('swMessages', () => {
  it('recognizes valid server messages', () => {
    expect(isSWServerMessage({
      type: 'DOWNLOAD_COMPLETE',
      requestId: 'x',
      url: 'https://example.com/a.flac',
      size: 123,
    })).toBe(true);
  });

  it('rejects invalid payloads', () => {
    expect(isSWServerMessage(null)).toBe(false);
    expect(isSWServerMessage({ type: 'UNKNOWN' })).toBe(false);
  });
});
