import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';

/**
 * Inline page feedback. The live region keeps only the message text so
 * assistive technology and text assertions read the message itself; the
 * optional action and dismiss control sit beside it.
 */
export function StatusBanner({ tone, children, onDismiss, autoDismissMs, action }: { tone: 'error' | 'success' | 'warning'; children: ReactNode; onDismiss?: () => void; autoDismissMs?: number; action?: ReactNode }) {
  const { t } = useTranslation();
  const dismiss = useRef(onDismiss); dismiss.current = onDismiss;
  const message = typeof children === 'string' ? children : null;
  useEffect(() => {
    if (!autoDismissMs) return;
    const timer = window.setTimeout(() => dismiss.current?.(), autoDismissMs);
    return () => window.clearTimeout(timer);
  }, [message, autoDismissMs]);
  return <div className="status-banner" data-tone={tone}>
    <span className="banner-icon"><Icon name={tone === 'success' ? 'check' : tone === 'warning' ? 'info' : 'alert'} size={15} strokeWidth={2} /></span>
    <p role={tone === 'error' ? 'alert' : 'status'}>{children}</p>
    {action}
    {onDismiss && <button type="button" className="status-banner-close" aria-label={t('common.dismiss')} onClick={onDismiss}><Icon name="close" size={13} strokeWidth={2} /></button>}
  </div>;
}
