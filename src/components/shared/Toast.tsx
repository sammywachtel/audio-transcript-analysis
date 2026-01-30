import React, { useState, useEffect, useCallback } from 'react';
import { cn } from '@/utils';
import { X, Undo2 } from 'lucide-react';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastData {
  id: string;
  message: string;
  action?: ToastAction;
  duration?: number; // ms, defaults to 10000
  type?: 'info' | 'success' | 'warning' | 'error';
}

interface ToastProps {
  toast: ToastData;
  onDismiss: (id: string) => void;
}

/**
 * Individual toast notification with optional undo action.
 * Auto-dismisses after duration (default 10s) unless dismissed manually.
 */
const Toast: React.FC<ToastProps> = ({ toast, onDismiss }) => {
  const [progress, setProgress] = useState(100);
  const duration = toast.duration ?? 10000;

  useEffect(() => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, 100 - (elapsed / duration) * 100);
      setProgress(remaining);

      if (remaining <= 0) {
        clearInterval(interval);
        onDismiss(toast.id);
      }
    }, 50);

    return () => clearInterval(interval);
  }, [toast.id, duration, onDismiss]);

  const typeStyles = {
    info: 'bg-slate-900 text-white',
    success: 'bg-green-800 text-white',
    warning: 'bg-amber-600 text-white',
    error: 'bg-red-700 text-white'
  };

  return (
    <div
      className={cn(
        "relative flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg min-w-[300px] max-w-[400px]",
        "animate-in slide-in-from-bottom-2 fade-in duration-200",
        typeStyles[toast.type ?? 'info']
      )}
    >
      {/* Message */}
      <span className="flex-1 text-sm font-medium">{toast.message}</span>

      {/* Action button (e.g., Undo) */}
      {toast.action && (
        <button
          onClick={() => {
            toast.action?.onClick();
            onDismiss(toast.id);
          }}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-white/20 hover:bg-white/30 text-sm font-medium transition-colors"
        >
          <Undo2 size={14} />
          {toast.action.label}
        </button>
      )}

      {/* Dismiss button */}
      <button
        onClick={() => onDismiss(toast.id)}
        className="p-1 hover:bg-white/20 rounded transition-colors"
        aria-label="Dismiss"
      >
        <X size={16} />
      </button>

      {/* Progress bar - shows time remaining */}
      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/20 rounded-b-lg overflow-hidden">
        <div
          className="h-full bg-white/60 transition-all duration-50"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
};

interface ToastContainerProps {
  toasts: ToastData[];
  onDismiss: (id: string) => void;
}

/**
 * Container for toast notifications. Stacks toasts from bottom.
 * Position: bottom-right, above the audio player.
 */
export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed z-50 flex flex-col gap-2"
      style={{
        bottom: 'calc(4rem + 1.5rem)', // Above audio player (64px) + gap
        right: '1.5rem'
      }}
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
};

/**
 * Hook for managing toast notifications.
 * Provides addToast and dismissToast functions.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastData[]>([]);

  const addToast = useCallback((toast: Omit<ToastData, 'id'>) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev, { ...toast, id }]);
    return id;
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    setToasts([]);
  }, []);

  return {
    toasts,
    addToast,
    dismissToast,
    clearAll
  };
}
