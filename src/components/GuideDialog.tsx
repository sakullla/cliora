import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';
import { withMod } from '../lib/shortcut';

export function GuideDialog({ open, title, hint, wide, suspended = false, onClose, onBack, children }: { open: boolean; title: string; hint?: string; wide?: boolean; suspended?: boolean; onClose: () => void; onBack?: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || !open || suspended) { if (element?.open) element.close(); return; }
    if (!element.open) { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; element.showModal(); }
    return () => { if (element.open) element.close(); const target = returnFocus.current; if (target?.isConnected) requestAnimationFrame(() => target.focus()); };
  }, [open, suspended]);

  if (!open) return null;
  return <dialog ref={dialog} className={wide ? 'guide-dialog guide-dialog-wide' : 'guide-dialog'} aria-labelledby="guide-dialog-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => {
    if (!withMod(event) || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    if (!event.repeat) dialog.current?.querySelector<HTMLButtonElement>('[data-dialog-save]:not(:disabled)')?.click();
  }}>
    <div className="guide-dialog-head">
      {onBack && <button type="button" className="guide-dialog-back" onClick={onBack} aria-label={t('common.dialog.back')} title={t('common.dialog.back')}><Icon name="arrowLeft" size={16} /><span>{t('common.dialog.back')}</span></button>}
      <div><h2 id="guide-dialog-title">{title}</h2>{hint && <p>{hint}</p>}</div>
      <button type="button" className="guide-dialog-close" onClick={onClose} aria-label={t('common.dialog.close')} title={t('common.dialog.closeEsc')}><Icon name="close" size={16} /></button>
    </div>
    <div className="guide-dialog-body">{children}</div>
  </dialog>;
}
