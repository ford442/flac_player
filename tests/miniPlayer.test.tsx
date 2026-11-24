import { createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlacMiniPlayer, formatTime, type MiniPlayerHandle, type MiniTrack } from '../src/embed';
import { propsFromParams } from '../src/embed/standalone';

const TRACKS: MiniTrack[] = [
  { id: 'a', url: 'https://example.com/a.flac', title: 'Alpha', artist: 'Band' },
  { id: 'b', url: 'https://example.com/b.mp3', title: 'Beta', artist: 'Band' },
  { id: 'c', url: 'https://example.com/c.wav' },
];

let playSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // jsdom has no media pipeline: emulate play/pause flipping `paused` and firing events.
  playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false });
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: true });
    this.dispatchEvent(new Event('pause'));
  });
});
afterEach(() => vi.restoreAllMocks());

const audio = () => document.querySelector('audio') as HTMLAudioElement;

describe('FlacMiniPlayer', () => {
  it('renders the current track and streams it through one <audio>', () => {
    render(<FlacMiniPlayer tracks={TRACKS} />);
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Band')).toBeTruthy();
    expect(audio().getAttribute('src')).toBe(TRACKS[0]!.url);
    expect(audio().hasAttribute('crossorigin')).toBe(false);
    expect(screen.getByRole('region', { name: 'Audio player' })).toBeTruthy();
  });

  it('single track hides navigation and falls back to the file name', () => {
    render(<FlacMiniPlayer track={{ url: 'https://x.test/My%20Song.mp3' }} />);
    expect(screen.getByText('My Song.mp3')).toBeTruthy();
    expect(screen.queryByLabelText('Next track')).toBeNull();
  });

  it('play/pause button drives the element and fires host events', async () => {
    const onPlay = vi.fn();
    const onPause = vi.fn();
    render(<FlacMiniPlayer tracks={TRACKS} onPlay={onPlay} onPause={onPause} />);
    await act(async () => { fireEvent.click(screen.getByLabelText('Play')); });
    expect(playSpy).toHaveBeenCalled();
    expect(onPlay).toHaveBeenCalledWith(TRACKS[0], 0);
    await act(async () => { fireEvent.click(screen.getByLabelText('Pause')); });
    expect(onPause).toHaveBeenCalledWith(TRACKS[0], 0);
  });

  it('next/previous change track and report onTrackChange', async () => {
    const onTrackChange = vi.fn();
    render(<FlacMiniPlayer tracks={TRACKS} onTrackChange={onTrackChange} />);
    await act(async () => { fireEvent.click(screen.getByLabelText('Next track')); });
    expect(onTrackChange).toHaveBeenLastCalledWith(TRACKS[1], 1);
    expect(audio().getAttribute('src')).toBe(TRACKS[1]!.url);
    await act(async () => { fireEvent.click(screen.getByLabelText('Previous track')); });
    expect(onTrackChange).toHaveBeenLastCalledWith(TRACKS[0], 0);
  });

  it('ended advances and keeps playing; queue end fires onQueueEnded', async () => {
    const onEnded = vi.fn();
    const onQueueEnded = vi.fn();
    render(<FlacMiniPlayer tracks={TRACKS} initialIndex={2} onEnded={onEnded} onQueueEnded={onQueueEnded} />);
    await act(async () => { audio().dispatchEvent(new Event('ended')); });
    expect(onEnded).toHaveBeenCalledWith(TRACKS[2], 2);
    expect(onQueueEnded).toHaveBeenCalledTimes(1);

    onEnded.mockClear();
    playSpy.mockClear();
    render(<FlacMiniPlayer tracks={TRACKS.slice(0, 2)} />);
    const second = document.querySelectorAll('audio')[1] as HTMLAudioElement;
    await act(async () => { second.dispatchEvent(new Event('ended')); });
    expect(second.getAttribute('src')).toBe(TRACKS[1]!.url);
    expect(playSpy).toHaveBeenCalled();
  });

  it('loop wraps from the last track to the first', async () => {
    const onTrackChange = vi.fn();
    render(<FlacMiniPlayer tracks={TRACKS} initialIndex={2} loop onTrackChange={onTrackChange} />);
    await act(async () => { audio().dispatchEvent(new Event('ended')); });
    expect(onTrackChange).toHaveBeenCalledWith(TRACKS[0], 0);
  });

  it('exposes an imperative handle', async () => {
    const ref = createRef<MiniPlayerHandle>();
    render(<FlacMiniPlayer ref={ref} tracks={TRACKS} />);
    Object.defineProperty(audio(), 'duration', { configurable: true, value: 100 });
    act(() => ref.current!.seek(42));
    expect(audio().currentTime).toBe(42);
    act(() => ref.current!.seek(500));
    expect(audio().currentTime).toBe(100);
    await act(async () => { await ref.current!.play(); });
    expect(ref.current!.getState().playing).toBe(true);
    act(() => ref.current!.select(1));
    expect(ref.current!.getState().index).toBe(1);
    act(() => ref.current!.setVolume(0.25));
    expect(audio().volume).toBe(0.25);
  });

  it('controlled index follows the prop', () => {
    const { rerender } = render(<FlacMiniPlayer tracks={TRACKS} index={0} />);
    rerender(<FlacMiniPlayer tracks={TRACKS} index={1} />);
    expect(screen.getByText('Beta')).toBeTruthy();
  });

  it('surfaces load errors', async () => {
    const onError = vi.fn();
    render(<FlacMiniPlayer tracks={TRACKS} onError={onError} />);
    await act(async () => { audio().dispatchEvent(new Event('error')); });
    expect(onError).toHaveBeenCalledWith(expect.any(Error), TRACKS[0], 0);
    expect(screen.getByRole('status').textContent).toMatch(/Could not load/);
  });

  it('only sets crossOrigin when an EQ preset needs Web Audio', () => {
    render(<FlacMiniPlayer tracks={TRACKS} eq="bass" />);
    expect(audio().getAttribute('crossorigin')).toBe('anonymous');
  });
});

describe('embed helpers', () => {
  it('formatTime', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(65.4)).toBe('1:05');
    expect(formatTime(3725)).toBe('1:02:05');
    expect(formatTime(NaN)).toBe('0:00');
  });

  it('propsFromParams reads iframe/data-attribute params', () => {
    const q = new URLSearchParams('src=https://x/a.mp3&title=T&layout=card&autoplay=1&eq=vocal&eq2=no');
    const p = propsFromParams((k) => q.get(k));
    expect(p.track).toMatchObject({ url: 'https://x/a.mp3', title: 'T' });
    expect(p.layout).toBe('card');
    expect(p.autoPlay).toBe(true);
    expect(p.eq).toBe('vocal');
    const t = new URLSearchParams({ tracks: JSON.stringify([{ url: 'u1' }, { nope: 1 }]) });
    expect(propsFromParams((k) => t.get(k)).tracks).toEqual([{ url: 'u1' }]);
  });
});
