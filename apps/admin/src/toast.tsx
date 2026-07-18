import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { IconCheck, IconClose, IconInfo, IconAlertTriangle } from "./components/icons";

type ToastTone = "info" | "success" | "error" | "warning";
type Toast = { id: number; text: string; tone: ToastTone };
type ToastContextValue = { showToast: (text: string, tone?: ToastTone) => void };

const ToastContext = createContext<ToastContextValue | null>(null);

const style: Record<ToastTone, string> = {
  info: "border-brand-200 bg-brand-50 text-brand-800 dark:border-brand-900/50 dark:bg-brand-950/70 dark:text-brand-100",
  success: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/70 dark:text-emerald-100",
  warning: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/70 dark:text-amber-100",
  error: "border-red-200 bg-red-50 text-red-800 dark:border-red-900/50 dark:bg-red-950/70 dark:text-red-100",
};

function ToneIcon({ tone }: { tone: ToastTone }) {
  const cls = "h-5 w-5 shrink-0";
  if (tone === "success") return <IconCheck className={cls} />;
  if (tone === "info") return <IconInfo className={cls} />;
  return <IconAlertTriangle className={cls} />;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((items) => items.filter((item) => item.id !== id)), []);
  const showToast = useCallback((text: string, tone: ToastTone = "info") => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((items) => [...items, { id, text, tone }].slice(-4));
    window.setTimeout(() => dismiss(id), tone === "error" ? 7000 : 4500);
  }, [dismiss]);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`pointer-events-auto flex items-start gap-3 rounded-xl border p-3 text-sm shadow-lg ${style[toast.tone]}`} role="status">
            <ToneIcon tone={toast.tone} />
            <p className="min-w-0 flex-1 break-words">{toast.text}</p>
            <button className="-m-1 rounded p-1 opacity-70 hover:opacity-100" onClick={() => dismiss(toast.id)} aria-label="關閉通知">
              <IconClose className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside ToastProvider");
  return context;
}
