"use client";

import {
  createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode,
} from "react";

interface ToastItem {
  id: number;
  message: string;
}

interface ToastContextValue {
  show: (message: string) => void;
}

const Context = createContext<ToastContextValue | null>(null);

const DISPLAY_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const show = useCallback((message: string) => {
    setToasts((current) => {
      // A message already on screen is not repeated -- a fast double submit
      // or two calls landing together should read as one confirmation, not a
      // stack of identical lines.
      if (current.some((toast) => toast.message === message)) return current;

      const id = nextId.current++;
      setTimeout(() => {
        setToasts((later) => later.filter((toast) => toast.id !== id));
      }, DISPLAY_MS);
      return [...current, { id, message }];
    });
  }, []);

  const value = useMemo(() => ({ show }), [show]);

  return (
    <Context.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast" role="status">
            {toast.message}
          </div>
        ))}
      </div>
    </Context.Provider>
  );
}

export function useToast() {
  const value = useContext(Context);
  if (!value) throw new Error("useToast requires ToastProvider");
  return value;
}
