import { describe, expect, it } from 'vitest';
import { demoTracks, trackFromUrl } from '../src/utils/remoteTracks';

describe('trackFromUrl', () => {
  it('derives a title from the decoded file name', () => {
    const t = trackFromUrl('  https://projectm.1ink.us/songs/Claws%20of%20the%20Angel.flac ');
    expect(t?.title).toBe('Claws of the Angel');
    expect(t?.url).toBe('https://projectm.1ink.us/songs/Claws%20of%20the%20Angel.flac');
  });
  it.each(['', 'not a url', 'ftp://x/y.flac', 'javascript:alert(1)', '/songs/a.flac'])(
    'rejects %j', (input) => expect(trackFromUrl(input)).toBeNull());
  it('survives a malformed percent escape', () => {
    expect(trackFromUrl('https://x.test/100%.flac')?.title).toBe('100%');
  });
});

describe('demoTracks', () => {
  it('returns absolute https tracks with unique ids', () => {
    const tracks = demoTracks();
    expect(tracks.length).toBeGreaterThan(0);
    expect(new Set(tracks.map(t => t.id)).size).toBe(tracks.length);
    tracks.forEach(t => expect(t.url).toMatch(/^https:\/\/projectm\.1ink\.us\/songs\/.+\.flac$/));
  });
});
