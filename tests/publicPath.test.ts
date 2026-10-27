import { describe, expect, it } from 'vitest';
import { assetUrl, normalizePublicPath, routePath } from '../src/utils/publicPath';

describe('normalizePublicPath', () => {
  it.each([
    [undefined, '/'],
    ['', '/'],
    ['/', '/'],
    ['flac-player', '/flac-player/'],
    ['/flac-player', '/flac-player/'],
    ['/flac-player/', '/flac-player/'],
    ['https://test.1ink.us/flac-player/', '/flac-player/'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePublicPath(input)).toBe(expected);
  });
});

describe('assetUrl', () => {
  it('prefixes the base and drops a leading slash', () => {
    expect(assetUrl('service-worker.js', '/flac-player/')).toBe('/flac-player/service-worker.js');
    expect(assetUrl('/icons/icon-192.png', '/')).toBe('/icons/icon-192.png');
  });
});

describe('routePath', () => {
  it('strips the base from the pathname', () => {
    expect(routePath('/flac-player/playlist/abc', '/flac-player/')).toBe('/playlist/abc');
    expect(routePath('/flac-player', '/flac-player/')).toBe('/');
    expect(routePath('/flac-player/', '/flac-player/')).toBe('/');
  });
  it('is the identity at the root or outside the base', () => {
    expect(routePath('/playlist/abc', '/')).toBe('/playlist/abc');
    expect(routePath('/other/x', '/flac-player/')).toBe('/other/x');
  });
});
