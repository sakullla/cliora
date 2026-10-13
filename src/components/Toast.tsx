import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from './Icon';
import { ToastContext, useToasts, type ToastController } from '../lib/toast';

/** `status` is a success result; `alert` is a failure and stays until dismissed. */
export type ToastTone = 'status' | 'alert' | 'info' | 'warning';
export type Toast = { id: number; tone: ToastTone; text: string; count: number };

export const TOAST_AUTO_DISMISS_MS = 4000;
const TOAST_DURATION: Record<ToastTone, number | null> = { status: TOAST_AUTO_DISMISS_MS, info: TOAST_AUTO_DISMISS_MS, warning: 8000, alert: null };
const TOAST_EXIT_MS = 180;

const toneIcon: Record<ToastTone, IconName> = { status: 'check', alert: 'alert', info: 'info', warning: 'alert' };

/** Keeps a toast mounted briefly after it clears so the exit animation can play. */
function useRendered(item: Toast | null): { toast: Toast | null; leaving: boolean } {
  const [rendered, setRendered] = useState<Toast | null>(item);
  const [leaving, setLeaving] = useState(false);
  const renderedRef = useRef(rendered);
  renderedRef.current = rendered;

  useEffect(() => {
    if (item) {
      setRendered(item);
      setLeaving(false);
      return;
    }
    if (!renderedRef.current) return;
    setLeaving(true);
    const timer = window.setTimeout(() => { setRendered(null); setLeaving(false); }, TOAST_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [item]);

  return { toast: rendered, leaving };
}

function ToastItem({ toast, leaving, onDismiss }: { toast: Toast; leaving: boolean; onDismiss: () => void }) {
  const { t } = useTranslation();
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const duration = TOAST_DURATION[toast.tone];
  const remaining = useRef(duration ?? 0);
  const startedAt = useRef(0);
  const timer = useRef<number | null>(null);

  const clearTimer = () => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
  };

  useEffect(() => {
    if (duration === null) return;
    remaining.current = duration;
    startedAt.current = Date.now();
    timer.current = window.setTimeout(() => dismissRef.current(), remaining.current);
    return clearTimer;
  }, [toast.id, duration]);

  function pause() {
    if (duration === null || timer.current === null) return;
    clearTimer();
    remaining.current = Math.max(120, remaining.current - (Date.now() - startedAt.current));
  }

  function resume() {
    if (duration === null || timer.current !== null) return;
    startedAt.current = Date.now();
    timer.current = window.setTimeout(() => dismissRef.current(), remaining.current);
  }

  return (
    <div
      className="toast"
      data-tone={toast.tone}
      data-leaving={leaving || undefined}
      role={toast.tone === 'alert' ? 'alert' : 'status'}
      aria-atomic="true"
      onPointerEnter={pause}
      onPointerLeave={resume}
      onFocus={pause}
      onBlur={resume}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); dismissRef.current(); } }}
    >
      <span className="toast-icon" aria-hidden="true"><Icon name={toneIcon[toast.tone]} size={12} strokeWidth={2.6} /></span>
      <span className="toast-text">{toast.text}</span>
      {toast.count > 1 && <span className="toast-count" data-count={toast.count} aria-hidden="true" />}
      <button
        type="button"
        className="toast-close"
        aria-label={toast.tone === 'alert' ? t('common.dismissError') : t('common.dismiss')}
        onClick={() => dismissRef.current()}
      ><Icon name="close" size={12} strokeWidth={2.2} /></button>
      {duration !== null && <span key={toast.id} className="toast-progress" style={{ animationDuration: `${duration}ms` }} aria-hidden="true" />}
    </div>
  );
}

/**
 * Floating feedback for one page. It is fixed to the viewport corner, so a
 * message appearing or leaving never pushes the page content around.
 */
export function ToastStack({ status, alert, onDismiss }: { status: Toast | null; alert: Toast | null; onDismiss: (tone: Toast['tone']) => void }) {
  const renderedAlert = useRendered(alert);
  const renderedStatus = useRendered(status);
  if (!renderedAlert.toast && !renderedStatus.toast) return null;
  return (
    <div className="toast-stack">
      {renderedAlert.toast && <ToastItem key={`alert-${renderedAlert.toast.id}`} toast={renderedAlert.toast} leaving={renderedAlert.leaving} onDismiss={() => onDismiss('alert')} />}
      {renderedStatus.toast && <ToastItem key={`status-${renderedStatus.toast.id}`} toast={renderedStatus.toast} leaving={renderedStatus.leaving} onDismiss={() => onDismiss('status')} />}
    </div>
  );
}

/** Shares a page's toast controller with its children and renders the stack. */
export function ToastScope({ toasts, children }: { toasts: ToastController; children: ReactNode }) {
  return <ToastContext.Provider value={toasts}>
    {children}
    <ToastStack status={toasts.notice} alert={toasts.error} onDismiss={toasts.dismiss} />
  </ToastContext.Provider>;
}

/** A self-contained scope for areas without their own controller. */
export function ToastHost({ children }: { children: ReactNode }) {
  const toasts = useToasts();
  return <ToastScope toasts={toasts}>{children}</ToastScope>;
}
