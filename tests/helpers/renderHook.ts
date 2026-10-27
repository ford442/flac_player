import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

// Minimal renderHook (no @testing-library dependency): mounts `hook(props)` in a
// throwaway component and re-renders it with new props.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface RenderHookResult<P, R> {
  result: { current: R };
  rerender: (props: P) => Promise<void>;
  unmount: () => Promise<void>;
}

export async function renderHook<P, R>(hook: (props: P) => R, initialProps: P): Promise<RenderHookResult<P, R>> {
  const result = { current: undefined as unknown as R };
  const Harness: React.FC<{ hookProps: P }> = ({ hookProps }) => {
    result.current = hook(hookProps);
    return null;
  };
  const container = document.createElement('div');
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(Harness, { hookProps: initialProps }));
  });
  return {
    result,
    rerender: async (props) => {
      await act(async () => { root?.render(React.createElement(Harness, { hookProps: props })); });
    },
    unmount: async () => {
      await act(async () => { root?.unmount(); });
    },
  };
}
