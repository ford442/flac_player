import { useEffect, useRef } from 'react';
import { focusOwnsKey, matchShortcut, type ShortcutHandlers } from './keyboardShortcutMap';

interface KeyboardShortcutsOptions extends ShortcutHandlers {
  isEnabled?: boolean;
}

/**
 * Global shortcuts from `SHORTCUTS` (keyboardShortcutMap.ts). A key the focused
 * control uses itself (typing, Space on a button, arrows on a slider or select)
 * or that a control already handled (`defaultPrevented`) is left alone.
 */
export function useKeyboardShortcuts({ isEnabled = true, ...handlers }: KeyboardShortcutsOptions) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!isEnabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const def = matchShortcut(e);
      if (!def || focusOwnsKey(e.target, def)) return;
      const handler = handlersRef.current[def.action];
      if (!handler) return;
      e.preventDefault();
      handler();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isEnabled]);
}

export default useKeyboardShortcuts;
