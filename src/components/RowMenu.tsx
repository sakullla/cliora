import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './RowMenu.module.css';

export function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const items = () => [...panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []];
  const dismiss = (restoreFocus: boolean) => { setOpen(false); if (restoreFocus) trigger.current?.focus(); };
  // Keyboard users land on the first action once the menu has been placed.
  useEffect(() => { if (open && box) items()[0]?.focus({ preventScroll: true }); }, [open, box !== null]);
  useEffect(() => { if (!open) setBox(null); }, [open]);
  function keyNavigate(event: ReactKeyboardEvent<HTMLDivElement>) {
    const list = items(); if (!list.length) return;
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Tab') { event.preventDefault(); dismiss(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
    list[next].focus();
  }
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = ref.current?.getBoundingClientRect();
      const menu = panel.current;
      if (!trigger || !menu) return;
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const left = Math.max(8, Math.min(trigger.right - width, window.innerWidth - width - 8));
      const spaceBelow = window.innerHeight - trigger.bottom - 8;
      const top = spaceBelow >= height || trigger.top < height + 8
        ? Math.min(trigger.bottom + 4, Math.max(8, window.innerHeight - height - 8))
        : trigger.top - height - 4;
      setBox({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); dismiss(true); } };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, [open]);
  return <div className={styles.rowMenu} ref={ref}>
    <button ref={trigger} type="button" className={styles.rowMenuButton} aria-label={label} title={t('tools.workspace.moreActions')} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); } }}><svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg></button>
    {open && createPortal(<div ref={panel} className={styles.rowMenuList} role="menu" aria-label={label} style={box ? { top: box.top, left: box.left } : { top: 0, left: -10000 }} onKeyDown={keyNavigate} onClick={() => dismiss(true)}>{children}</div>, document.body)}
  </div>;
}
