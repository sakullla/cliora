import { createContext, useContext, useMemo, useRef, useState } from 'react';
import type { Toast, ToastTone } from '../components/Toast';
import { formatFailure } from './feedback';

/**
 * Page-level transient feedback. A controller owns two slots — one for the
 * latest result (success / info / warning) and one for the latest failure —
 * so a fresh outcome replaces the previous one instead of piling up rows.
 * Toasts float above the page (see ToastStack), so showing or clearing one
 * never shifts the surrounding layout.
 */
export function useToasts() {
  const [error, setError] = useState<Toast | null>(null);
  const [notice, setNotice] = useState<Toast | null>(null);
  const sequence = useRef(0);
  const protect = useRef(false);

  // Repeating the same message restarts its timer and counts the repeat
  // instead of flashing the toast out and back in.
  function next(previous: Toast | null, tone: ToastTone, text: string): Toast {
    const count = previous && previous.tone === tone && previous.text === text ? previous.count + 1 : 1;
    return { id: ++sequence.current, tone, text, count };
  }

  function showError(text: string) {
    protect.current = false;
    setNotice(null);
    setError((previous) => next(previous, 'alert', text));
  }

  function showFailure(value: unknown, objectText: string, nextText: string, keepNotice = false) {
    if (!keepNotice || !protect.current) setNotice(null);
    if (!keepNotice) protect.current = false;
    const text = typeof value === 'string' ? value : formatFailure(value, objectText, nextText);
    setError((previous) => next(previous, 'alert', text));
  }

  function showNotice(text: string, protectNotice = false, tone: Exclude<ToastTone, 'alert'> = 'status') {
    setError(null);
    setNotice((previous) => next(previous, tone, text));
    protect.current = protectNotice;
  }

  /** A completed action that still needs attention, e.g. partial success. */
  function showWarning(text: string) {
    showNotice(text, false, 'warning');
  }

  function dismiss(tone: Toast['tone']) {
    if (tone === 'alert') { protect.current = false; setError(null); } else setNotice(null);
  }

  /** 操作已成功但伴随需要提示的问题时，同时展示成功与警告。 */
  function showMixed(noticeText: string, errorText: string) {
    setNotice((previous) => next(previous, 'status', noticeText));
    setError((previous) => next(previous, 'alert', errorText));
  }

  function clear() {
    protect.current = false;
    setNotice(null);
    setError(null);
  }

  return { error, notice, showError, showFailure, showNotice, showWarning, showMixed, dismiss, clear, setError, setNotice };
}

export type ToastController = ReturnType<typeof useToasts>;

/** Nearest page toast controller; the app shell provides a fallback. */
export const ToastContext = createContext<ToastController | null>(null);

/**
 * String-based setters for components that used to keep their own
 * `error` / `notice` state and render it inline. An empty string clears the
 * slot, matching the old `setError('')` / `setNotice('')` calls.
 */
export function useFeedback() {
  const toasts = useContext(ToastContext);
  const latest = useRef(toasts); latest.current = toasts;
  return useMemo(() => ({
    setError(text: string) { const host = latest.current; if (!host) return; if (text) host.showError(text); else host.dismiss('alert'); },
    setNotice(text: string) { const host = latest.current; if (!host) return; if (text) host.showNotice(text); else host.dismiss('status'); },
    setWarning(text: string) { const host = latest.current; if (!host) return; if (text) host.showWarning(text); else host.dismiss('status'); },
  }), []);
}
