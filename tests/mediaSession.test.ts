import { describe, it, expect } from 'vitest';
import { buildMediaMetadataInit } from '../src/hooks/useMediaSession';

describe('buildMediaMetadataInit', () => {
  it('uses cover_url artwork when present', () => {
    const init = buildMediaMetadataInit({ id: '1', name: 'a.flac', title: 'Song', author: 'Me', url: 'https://x/a.flac', cover_url: 'https://x/c.jpg' });
    expect(init.title).toBe('Song');
    expect(init.artist).toBe('Me');
    expect(init.artwork).toEqual([{ src: 'https://x/c.jpg', sizes: '512x512', type: 'image/jpeg' }]);
  });

  it('falls back to packaged icons and file name', () => {
    const init = buildMediaMetadataInit({ id: '2', name: 'b.flac', url: 'https://x/b.flac' });
    expect(init.title).toBe('b.flac');
    expect(init.artwork?.[0].src).toBe('/icons/icon-192.png');
  });
});
