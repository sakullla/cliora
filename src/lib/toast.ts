import { useEffect, useRef, useState } from 'react';
import type { Toast } from '../components/Toast';
import { formatFailure } from './feedback';

export function useToasts() {
  const [error, setError] = useState<Toast | null>(null);
  const [notice, setNotice] = useState<Toast | null>(null);
  const sequence = useRef(0);
  const protect = useRef(false);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function showError(text: string) {
    protect.current = false;
    setNotice(null);
    setError({ id: ++sequence.current, tone: 'alert', text });
  }

  function showFailure(value: unknown, objectText: string, nextText: string, keepNotice = false) {
    if (!keepNotice || !protect.current) setNotice(null);
    if (!keepNotice) protect.current = false;
    setError({ id: ++sequence.current, tone: 'alert', text: typeof value === 'string' ? value : formatFailure(value, objectText, nextText) });
  }

  function showNotice(text: string, protectNotice = false) {
    setError(null);
    setNotice({ id: ++sequence.current, tone: 'status', text });
    protect.current = protectNotice;
  }

  function dismiss(tone: Toast['tone']) {
    if (tone === 'alert') { protect.current = false; setError(null); } else setNotice(null);
  }

  /** 操作已成功但伴随需要提示的问题时，同时展示成功与警告。 */
  function showMixed(noticeText: string, errorText: string) {
    setNotice({ id: ++sequence.current, tone: 'status', text: noticeText });
    setError({ id: ++sequence.current, tone: 'alert', text: errorText });
  }

  return { error, notice, showError, showFailure, showNotice, showMixed, dismiss, setError, setNotice };
}
