import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import { withMod } from '../lib/shortcut';

export function GuideDialog({ open, title, hint, onClose, children }: { open: boolean; title: string; hint?: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || !open) return;
    if (!element.open) element.showModal();
    return () => { if (element.open) element.close(); };
  }, [open]);

  if (!open) return null;
  return <dialog ref={dialog} className="guide-dialog" aria-labelledby="guide-dialog-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onKeyDown={(event) => {
    if (!withMod(event) || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    if (!event.repeat) dialog.current?.querySelector<HTMLButtonElement>('[data-dialog-save]:not(:disabled)')?.click();
  }}>
    <div className="guide-dialog-head">
      <div><h2 id="guide-dialog-title">{title}</h2>{hint && <p>{hint}</p>}</div>
      <button type="button" className="guide-dialog-close" onClick={onClose} aria-label="关闭" title="关闭（Esc）"><Icon name="close" size={16} /></button>
    </div>
    <div className="guide-dialog-body">{children}</div>
  </dialog>;
}
