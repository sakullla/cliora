import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';
import type { RemoteTarget } from '../types/remote';

type Entry = { id: string; name: string; detail: string; remote: boolean };

/**
 * One switcher for "where things run": this device or a saved SSH host.
 * Replaces the native <select> so the menu matches the app, shows addresses,
 * and keeps a stable "manage hosts" entry instead of a fake option.
 */
export function HostSwitcher({ targets, value, onChange, onManage, variant = 'sidebar', collapsed = false, label }: {
  targets: RemoteTarget[];
  value: string;
  onChange: (targetId: string) => void;
  onManage?: () => void;
  variant?: 'sidebar' | 'chip';
  collapsed?: boolean;
  label?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const entries: Entry[] = [
    { id: 'local', name: t('common.host.local'), detail: t('common.host.localDetail'), remote: false },
    ...targets.map((target) => ({ id: target.id, name: target.name, detail: `${target.user}@${target.host}${target.port && target.port !== 22 ? `:${target.port}` : ''}`, remote: true })),
  ];
  const current = entries.find((entry) => entry.id === value) ?? entries[0];
  const itemCount = entries.length + (onManage ? 1 : 0);
  const accessibleLabel = label ?? t('common.host.label');

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(Math.max(rect.width, 264), window.innerWidth - 16);
      if (collapsed) {
        const left = Math.min(rect.right + 8, window.innerWidth - width - 8);
        const top = Math.max(8, Math.min(rect.top, window.innerHeight - 320));
        setBox({ left, width, top });
        return;
      }
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const below = window.innerHeight - rect.bottom;
      const upward = below < 260 && rect.top > below;
      setBox({ left, width, top: upward ? undefined : rect.bottom + 6, bottom: upward ? window.innerHeight - rect.top + 6 : undefined });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, collapsed]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (trigger.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  useEffect(() => {
    if (!open || !box) return;
    panel.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus();
  }, [open, box, active]);

  function show() {
    setActive(Math.max(0, entries.findIndex((entry) => entry.id === current.id)));
    setOpen(true);
  }

  function close(refocus = true) {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }

  function choose(id: string) {
    close();
    if (id !== value) onChange(id);
  }

  function onPanelKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => (index + 1) % itemCount); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => (index - 1 + itemCount) % itemCount); }
    else if (event.key === 'Home') { event.preventDefault(); setActive(0); }
    else if (event.key === 'End') { event.preventDefault(); setActive(itemCount - 1); }
    else if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'Tab') close(false);
  }

  const glyph = (entry: Entry) => <span className="host-switcher-glyph" data-remote={entry.remote || undefined} aria-hidden="true"><Icon name={entry.remote ? 'server' : 'monitor'} size={variant === 'chip' ? 13 : 15} /></span>;

  return <>
    <button
      ref={trigger}
      type="button"
      className="host-switcher-trigger"
      data-variant={variant}
      data-remote={current.remote || undefined}
      data-open={open || undefined}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      aria-label={`${accessibleLabel}：${current.name}`}
      title={`${accessibleLabel}：${current.name} · ${current.detail}`}
      onClick={() => (open ? close() : show())}
      onKeyDown={(event) => { if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); show(); } }}
    >
      {glyph(current)}
      <span className="host-switcher-copy"><strong>{current.name}</strong>{variant === 'sidebar' && <small>{current.detail}</small>}</span>
      <Icon name="chevronsUpDown" size={14} className="host-switcher-caret" />
    </button>
    {open && box && createPortal(<div ref={panel} id={menuId} className="host-switcher-menu" role="menu" aria-label={accessibleLabel} style={{ top: box.top, bottom: box.bottom, left: box.left, width: box.width }} onKeyDown={onPanelKey}>
      <div className="host-switcher-heading" aria-hidden="true">{accessibleLabel}</div>
      {entries.map((entry, index) => <button key={entry.id} type="button" role="menuitemradio" aria-checked={entry.id === current.id} data-index={index} tabIndex={index === active ? 0 : -1} onMouseEnter={() => setActive(index)} onClick={() => choose(entry.id)}>
        {glyph(entry)}
        <span className="host-switcher-copy"><strong>{entry.name}</strong><small>{entry.detail}</small></span>
        {entry.id === current.id && <Icon name="check" size={14} className="host-switcher-check" />}
      </button>)}
      {onManage && <>
        <div className="host-switcher-separator" role="separator" />
        <button type="button" role="menuitem" className="host-switcher-manage" data-index={entries.length} tabIndex={active === entries.length ? 0 : -1} onMouseEnter={() => setActive(entries.length)} onClick={() => { close(false); onManage(); }}>
          <span className="host-switcher-glyph" aria-hidden="true"><Icon name="settings" size={14} /></span>
          <span className="host-switcher-copy"><strong>{t('common.host.manage')}</strong></span>
        </button>
      </>}
    </div>, document.body)}
  </>;
}
