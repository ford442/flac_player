import React from 'react';
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TopScreen } from '../src/components/ShaderGUI/TopScreen';

// #259 D: cover art must load under COEP require-corp (CORS first, then no-cors)
// and disappear quietly when the art host allows neither.

function renderWithArt(url: string) {
  const canvasRef = React.createRef<HTMLCanvasElement>();
  return render(<TopScreen canvasRef={canvasRef} title="Song" album="Album" artworkUrl={url} />);
}

describe('TopScreen cover art', () => {
  beforeAll(() => {
    // jsdom has no ResizeObserver (TopScreen measures the title and canvas with it).
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(cleanup);

  it('requests the art CORS-mode first', () => {
    renderWithArt('https://art.example/cover.jpg');
    const img = screen.getByAltText('Album cover art');
    expect(img.getAttribute('crossorigin')).toBe('anonymous');
  });

  it('retries no-cors after a CORS failure, then hides the art', () => {
    renderWithArt('https://art.example/cover.jpg');
    fireEvent.error(screen.getByAltText('Album cover art'));

    const retry = screen.getByAltText('Album cover art');
    expect(retry.hasAttribute('crossorigin')).toBe(false);
    expect(retry.getAttribute('data-cors-mode')).toBe('no-cors');

    fireEvent.error(retry);
    expect(screen.queryByAltText('Album cover art')).toBeNull();
    // The rest of the overlay stays.
    expect(screen.getByText('Album')).toBeTruthy();
  });

  it('starts over in CORS mode for the next track', () => {
    const canvasRef = React.createRef<HTMLCanvasElement>();
    const { rerender } = render(
      <TopScreen canvasRef={canvasRef} album="Album" artworkUrl="https://art.example/a.jpg" />,
    );
    fireEvent.error(screen.getByAltText('Album cover art'));
    fireEvent.error(screen.getByAltText('Album cover art'));
    expect(screen.queryByAltText('Album cover art')).toBeNull();

    rerender(<TopScreen canvasRef={canvasRef} album="Album" artworkUrl="https://art.example/b.jpg" />);
    expect(screen.getByAltText('Album cover art').getAttribute('crossorigin')).toBe('anonymous');
  });
});
