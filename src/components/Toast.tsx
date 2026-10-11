import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from './Icon';

export type ToastTone = 'status' | 'alert' | 'info' | 'warning';
export type Toast = { id: number; tone: ToastTone; text: string };

export const TOAST_AUTO_DISMISS_MS = 4500;
const TOAST_EXIT_MS = 190;

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
  const remaining = useRef(TOAST_AUTO_DISMISS_MS);
  const startedAt = useRef(0);
  const timer = useRef<number | null>(null);

  const timed = toast.tone !== 'alert';

  const clearTimer = () => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
  };

  useEffect(() => {
    if (!timed) return;
    remaining.current = TOAST_AUTO_DISMISS_MS;
    startedAt.current = Date.now();
    timer.current = window.setTimeout(() => dismissRef.current(), remaining.current);
    return clearTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id, timed]);

  function pause() {
    if (!timed || timer.current === null) return;
    clearTimer();
    remaining.current = Math.max(120, remaining.current - (Date.now() - startedAt.current));
  }

  function resume() {
    if (!timed || timer.current !== null) return;
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
      onKeyDown={(event) => { if (event.key === 'Escape') dismissRef.current(); }}
    >
      <span className="toast-icon"><Icon name={toneIcon[toast.tone]} size={14} strokeWidth={2.2} /></span>
      <span className="toast-text">{toast.text}</span>
      <button
        type="button"
        className="toast-close"
        aria-label={toast.tone === 'alert' ? t('common.dismissError') : t('common.dismiss')}
        onClick={() => dismissRef.current()}
      ><Icon name="close" size={12} strokeWidth={2.2} /></button>
      {timed && <span className="toast-progress" style={{ animationDuration: `${TOAST_AUTO_DISMISS_MS}ms` }} aria-hidden="true" />}
    </div>
  );
}

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
