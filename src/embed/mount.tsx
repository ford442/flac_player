import { createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { FlacMiniPlayer } from './FlacMiniPlayer';
import type { FlacMiniPlayerProps, MiniPlayerHandle } from './types';

export interface MountedMiniPlayer {
  /** Imperative controls; null until the first render commits. */
  readonly player: MiniPlayerHandle | null;
  /** Re-render with merged props (e.g. a new playlist). */
  update(props: Partial<FlacMiniPlayerProps>): void;
  unmount(): void;
}

/** Non-React hosts: render the mini player into `element`. */
export function mountMiniPlayer(element: Element, props: FlacMiniPlayerProps): MountedMiniPlayer {
  const root = createRoot(element);
  const ref = createRef<MiniPlayerHandle>();
  let current = props;
  const render = () => root.render(<FlacMiniPlayer ref={ref} {...current} />);
  render();
  return {
    get player() { return ref.current; },
    update(next) { current = { ...current, ...next }; render(); },
    unmount() { root.unmount(); },
  };
}
