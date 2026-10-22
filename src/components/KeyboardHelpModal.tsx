import React from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import type { ShortcutDef } from '../hooks/keyboardShortcutMap';

interface KeyboardHelpModalProps {
  /** The wired shortcuts: `listShortcuts(handlers)` with the handlers passed to `useKeyboardShortcuts`. */
  shortcuts: readonly ShortcutDef[];
  onClose: () => void;
}

export const KeyboardHelpModal: React.FC<KeyboardHelpModalProps> = ({ shortcuts, onClose }) => {
  const dialogRef = useFocusTrap<HTMLDivElement>(onClose);
  return (
    // Backdrop click is a mouse shortcut; Esc (useFocusTrap) and the close button are the keyboard paths.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-help-title"
        tabIndex={-1}
        className="bg-surface-raised border border-white/20 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl focus:outline-none"
      >
        <div className="flex items-center justify-between mb-5">
          <h2 id="keyboard-help-title" className="text-lg font-bold text-white">⌨️ Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors text-xl leading-none"
            aria-label="Close help"
          >
            ✕
          </button>
        </div>

        <dl className="grid grid-cols-1 gap-1">
          {shortcuts.map(({ action, caps, description }) => (
            <div key={action} className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0">
              <dt className="text-sm text-gray-300">{description}</dt>
              <dd className="flex items-center gap-1">
                {caps.map((cap) => (
                  <kbd
                    key={cap}
                    className="px-2 py-0.5 bg-white/10 border border-white/20 rounded text-xs text-gray-200 font-mono min-w-[28px] text-center"
                  >
                    {cap}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>

        <p className="mt-4 text-xs text-gray-400 text-center">
          Shortcuts pause while typing or while a focused control uses the key. <kbd className="font-mono">Esc</kbd> closes dialogs.
        </p>
      </div>
    </div>
  );
};

export default KeyboardHelpModal;
