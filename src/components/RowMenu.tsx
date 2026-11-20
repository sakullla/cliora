import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './RowMenu.module.css';

/** `icon` and `title` replace the default ellipsis trigger, e.g. for the menu half of a split button.
 *  `side` opens the menu beside the trigger instead of below it, for triggers in a narrow vertical rail. */
export function RowMenu({ label, children, className, icon, title, side = false }: { label: string; children: ReactNode | (() => ReactNode); className?: string; icon?: ReactNode; title?: string; side?: boolean }) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const open = anchor !== null;
  return <div className={styles.rowMenu}>
    <button type="button" className={className ?? styles.rowMenuButton} aria-label={label} title={title ?? t('tools.workspace.moreActions')} aria-expanded={open} aria-haspopup="menu" onClick={event => setAnchor(open ? null : event.currentTarget)} onKeyDown={event => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setAnchor(event.currentTarget); } }}>{icon ?? <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>}</button>
    {anchor && <MenuPanel anchor={anchor} label={label} side={side} close={() => setAnchor(null)}>
      {typeof children === 'function' ? children() : children}
    </MenuPanel>}
  </div>;
}

function MenuPanel({ anchor, label, side, close, children }: { anchor: HTMLButtonElement; label: string; side: boolean; close: () => void; children: ReactNode }) {
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const portalTarget = anchor.closest('dialog') ?? document.body;
  const items = () => [...panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []];
  const dismiss = (restoreFocus: boolean) => { close(); if (restoreFocus) anchor.focus(); };
  useEffect(() => { if (box) items()[0]?.focus({ preventScroll: true }); }, [box !== null]);
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
    const place = () => {
      const triggerRect = anchor.parentElement?.getBoundingClientRect();
      const menu = panel.current;
      if (!triggerRect || !menu) return;
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      // If an open <dialog> is mid-animation (transform !== 'none'), it acts as the fixed containing block.
      const containing = menu.offsetParent instanceof HTMLElement ? menu.offsetParent : null;
      const containingRect = containing?.getBoundingClientRect();
      const originLeft = containingRect ? containingRect.left + containing!.clientLeft : 0;
      const originTop = containingRect ? containingRect.top + containing!.clientTop : 0;
      if (side) {
        setBox({
          top: Math.max(8, Math.min(triggerRect.top, window.innerHeight - height - 8)) - originTop,
          left: Math.max(8, Math.min(triggerRect.right + 6, window.innerWidth - width - 8)) - originLeft,
        });
        return;
      }
      const left = Math.max(8, Math.min(triggerRect.right - width, window.innerWidth - width - 8)) - originLeft;
      const spaceBelow = window.innerHeight - triggerRect.bottom - 8;
      const top = (spaceBelow >= height || triggerRect.top < height + 8
        ? Math.min(triggerRect.bottom + 4, Math.max(8, window.innerHeight - height - 8))
        : triggerRect.top - height - 4) - originTop;
      setBox({ top, left });
    };
    place();
    const dialogHost = portalTarget !== document.body ? portalTarget : null;
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    dialogHost?.addEventListener('animationend', place);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      dialogHost?.removeEventListener('animationend', place);
    };
  }, [anchor, side, portalTarget]);
  useEffect(() => {
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchor.parentElement?.contains(target) || panel.current?.contains(target)) return;
      close();
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(true); } };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', key, true); };
  }, [anchor, close]);
  return createPortal(<div ref={panel} className={styles.rowMenuList} role="menu" aria-label={label} style={box ? { top: box.top, left: box.left } : { top: 0, left: -10000 }} onKeyDown={keyNavigate} onClick={() => dismiss(true)}>{children}</div>, portalTarget);
}
