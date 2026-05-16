import React, { useEffect } from 'react';

export interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface ToastContainerProps {
  toasts: Toast[];
  onRemove: (id: string) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onRemove }) => {
  useEffect(() => {
    toasts.forEach(toast => {
      setTimeout(() => onRemove(toast.id), 3000);
    });
  }, [toasts, onRemove]);

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`px-4 py-2 rounded-lg shadow-lg text-white text-sm animate-slide-in ${
            toast.type === 'success' ? 'bg-green-500' :
            toast.type === 'error'   ? 'bg-red-500'   : 'bg-blue-500'
          }`}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
};
