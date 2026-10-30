import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';
import { withMod } from '../lib/shortcut';

export function GuideDialog({ open, title, hint, wide, suspended = false, closeDisabled = false, onClose, onBack, children }: { open: boolean; title: string; hint?: string; wide?: boolean; suspended?: boolean; closeDisabled?: boolean; onClose: () => void; onBack?: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || !open || suspended) { if (element?.open) element.close(); return; }
    if (!element.open) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
      // showModal focuses the first control, which is the close button; parking focus
      // on the sheet keeps a ring off that button until the keyboard actually moves.
      if (document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('guide-dialog-close')) element.focus({ preventScroll: true });
    }
    return () => { if (element.open) element.close(); const target = returnFocus.current; if (target?.isConnected) requestAnimationFrame(() => target.focus()); };
  }, [open, suspended]);

  useLayoutEffect(() => {
    if (!open || suspended || !closeDisabled) return;
    const preventClose = (event: KeyboardEvent) => {
      const element = dialog.current;
      // Disabling the focused control can leave focus on body. Catch Escape
      // there too: repeated native cancel events can become non-cancelable.
      if (event.key === 'Escape' && element?.open && (event.target === document.body || element.contains(event.target as Node))) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    document.addEventListener('keydown', preventClose, true);
    return () => document.removeEventListener('keydown', preventClose, true);
  }, [open, suspended, closeDisabled]);

  if (!open) return null;
  return <dialog ref={dialog} tabIndex={-1} className={wide ? 'guide-dialog guide-dialog-wide' : 'guide-dialog'} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); if (!closeDisabled) onClose(); }} onKeyDown={(event) => {
    if (!withMod(event) || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    if (!event.repeat) dialog.current?.querySelector<HTMLButtonElement>('[data-dialog-save]:not(:disabled)')?.click();
  }}>
    <div className="guide-dialog-head">
      {onBack && <button type="button" className="guide-dialog-back" disabled={closeDisabled} onClick={onBack} aria-label={t('common.dialog.back')} title={t('common.dialog.back')}><Icon name="arrowLeft" size={16} /><span>{t('common.dialog.back')}</span></button>}
      <div><h2 id={titleId}>{title}</h2>{hint && <p>{hint}</p>}</div>
      <button type="button" className="guide-dialog-close" disabled={closeDisabled} onClick={onClose} aria-label={t('common.dialog.close')} title={t('common.dialog.closeEsc')}><Icon name="close" size={16} /></button>
    </div>
    <div className="guide-dialog-body">{children}</div>
  </dialog>;
}
