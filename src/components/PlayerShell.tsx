import React from 'react';
import { ToastContainer, Toast } from './Toast';
import { KeyboardHelpModal } from './KeyboardHelpModal';

interface PlayerShellProps {
  toasts: Toast[];
  onRemoveToast: (id: string) => void;
  showHelp: boolean;
  onCloseHelp: () => void;
  /** Renders the drop-target overlay while audio files are dragged over the window. */
  isDraggingFile: boolean;
  children: React.ReactNode;
}

/**
 * Chrome common to every player layout (ShaderGUI, HTML fallback, projectM embed):
 * toasts, the keyboard help modal, and the file drag-and-drop overlay.
 *
 * The drag listeners themselves live in Player.tsx and are global, so dropping a
 * file works in every layout — this only owns the visual affordance.
 */
export const PlayerShell: React.FC<PlayerShellProps> = ({
  toasts,
  onRemoveToast,
  showHelp,
  onCloseHelp,
  isDraggingFile,
  children,
}) => (
  <>
    <ToastContainer toasts={toasts} onRemove={onRemoveToast} />
    {showHelp && <KeyboardHelpModal onClose={onCloseHelp} />}
    {isDraggingFile && (
      <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center pointer-events-none">
        <div className="border-4 border-dashed border-purple-400 rounded-2xl p-12 text-center">
          <p className="text-2xl text-purple-300 font-bold">Drop FLAC/WAV files to play</p>
        </div>
      </div>
    )}
    {children}
  </>
);
