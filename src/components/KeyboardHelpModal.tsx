import React from 'react';

interface KeyboardHelpModalProps {
  onClose: () => void;
}

const SHORTCUTS = [
  { keys: ['Space'], description: 'Play / Pause' },
  { keys: ['←', '→'], description: 'Seek backward / forward 10s' },
  { keys: ['↑', '↓'], description: 'Volume up / down 10%' },
  { keys: ['N'], description: 'Next track' },
  { keys: ['P'], description: 'Previous track' },
  { keys: ['M'], description: 'Mute / Unmute' },
  { keys: ['Q'], description: 'Toggle queue panel' },
  { keys: ['S'], description: 'Toggle stack/pile view' },
  { keys: ['R'], description: 'Rate current track' },
  { keys: ['?'], description: 'Show keyboard shortcuts' },
  { keys: ['Ctrl+K'], description: 'Focus search box' },
  { keys: ['Esc'], description: 'Close dialogs / panels' },
];

export const KeyboardHelpModal: React.FC<KeyboardHelpModalProps> = ({ onClose }) => {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-[#1a1a2e] border border-white/20 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-white">⌨️ Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors text-xl leading-none"
            aria-label="Close help"
          >
            ✕
          </button>
        </div>

        <div className="grid grid-cols-1 gap-1">
          {SHORTCUTS.map(({ keys, description }) => (
            <div key={description} className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0">
              <span className="text-sm text-gray-300">{description}</span>
              <div className="flex items-center gap-1">
                {keys.map((key) => (
                  <kbd
                    key={key}
                    className="px-2 py-0.5 bg-white/10 border border-white/20 rounded text-xs text-gray-200 font-mono min-w-[28px] text-center"
                  >
                    {key}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>

        <p className="mt-4 text-xs text-gray-500 text-center">
          Shortcuts are disabled while typing in input fields
        </p>
      </div>
    </div>
  );
};

export default KeyboardHelpModal;
