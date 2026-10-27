import React, { useCallback, useEffect } from 'react';
import { dismissToast } from '../player/playerStore';
import { useErrors } from '../player/selectors';
import { usePlayer } from '../player/PlayerContext';

export interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface ToastContainerProps {
  toasts: Toast[];
  onRemove: (id: string) => void;
}

/** Errors stay up longer: they are often the only sign a load failed. */
const TOAST_MS: Record<Toast['type'], number> = { success: 3000, info: 3000, error: 6000 };

const ToastItem: React.FC<{ toast: Toast; onRemove: (id: string) => void }> = ({ toast, onRemove }) => {
  useEffect(() => {
    const id = setTimeout(() => onRemove(toast.id), TOAST_MS[toast.type]);
    return () => clearTimeout(id);
  }, [toast.id, toast.type, onRemove]);

  return (
    <div
      role={toast.type === 'error' ? 'alert' : 'status'}
      className={`px-4 py-2 rounded-lg shadow-lg text-white text-sm animate-slide-in ${
        toast.type === 'success' ? 'bg-green-500' :
        toast.type === 'error'   ? 'bg-red-500'   : 'bg-blue-500'
      }`}
    >
      {toast.message}
    </div>
  );
};

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onRemove }) => (
  <div className="fixed top-4 right-4 z-50 flex flex-col gap-2">
    {toasts.map(toast => <ToastItem key={toast.id} toast={toast} onRemove={onRemove} />)}
  </div>
);

/** Toasts from the player store (engine errors and UI notifications alike). */
export const PlayerToasts: React.FC = () => {
  const { store } = usePlayer();
  const toasts = useErrors((e) => e.toasts);
  const onRemove = useCallback((id: string) => dismissToast(store, id), [store]);
  return <ToastContainer toasts={toasts} onRemove={onRemove} />;
};
