import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import styles from './FilterSelect.module.css';

export type FilterSelectOption = { value: string; label: string; detail?: string; note?: string; disabled?: boolean; icon?: ReactNode };

const searchThreshold = 4;
const searchInputLabel = (label: string) => `搜索${label.replace(/^(筛选|切换)/, '')}`;

export function FilterSelect({ label, value, options, placeholder = '选择', disabled = false, title, searchable = true, forceSearch = false, searchLabel, searchPlaceholder = '输入名称', emptyText = '没有匹配的选项', onChange, variant = 'default', className, triggerRef, onTriggerKeyDown, onPickFolder, pickFolderLabel = '选择文件夹…', triggerDetail = true }: {
  label: string;
  value: string;
  options: FilterSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  searchable?: boolean;
  forceSearch?: boolean;
  searchLabel?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  onChange: (value: string) => void;
  variant?: 'default' | 'accent';
  className?: string;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  onTriggerKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onPickFolder?: () => void;
  pickFolderLabel?: string;
  triggerDetail?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<{ top?: number; bottom?: number; left: number; width: number; maxHeight: number } | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement>(document.body);
  useLayoutEffect(() => { setPortalTarget(anchor.current?.closest('dialog') ?? document.body); }, []);
  const listId = useId();
  const selected = options.find((item) => item.value === value);
  const showSearch = searchable && (forceSearch || options.length > searchThreshold);
  const needle = query.trim().toLowerCase();
  const matches = options.filter((item) => `${item.label} ${item.detail ?? ''}`.toLowerCase().includes(needle));

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(Math.max(rect.width, 240), window.innerWidth - 16);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const upward = below < 220 && above > below;
      setBox({ left, width, maxHeight: Math.max(180, Math.min(320, upward ? above : below)), top: upward ? undefined : rect.bottom + 4, bottom: upward ? window.innerHeight - rect.top + 4 : undefined });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, matches.findIndex((item) => item.value === value)));
  }, [open]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchor.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
      setQuery('');
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => {
    if (!open || showSearch) return;
    panel.current?.focus();
  }, [open, showSearch, box]);
  useEffect(() => {
    if (!open || !panel.current) return;
    const node = panel.current.querySelector<HTMLElement>('[data-active="true"]');
    const list = node?.parentElement;
    if (!node || !list) return;
    const top = node.offsetTop;
    const bottom = top + node.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [open, active, query]);

  function choose(option: FilterSelectOption) {
    if (option.disabled) return;
    setOpen(false);
    setQuery('');
    onChange(option.value);
    triggerRef?.current?.focus();
  }

  function onPanelKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(index + 1, Math.max(matches.length - 1, 0))); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); return; }
    if (event.key === 'Enter' && matches[active]) { event.preventDefault(); choose(matches[active]); return; }
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); setQuery(''); triggerRef?.current?.focus(); }
  }

  function onTrigger(event: KeyboardEvent<HTMLButtonElement>) {
    if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setOpen(true); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen((current) => !current); return; }
    onTriggerKeyDown?.(event);
  }

  return <div ref={anchor} className={className ? `${styles.select} ${className}` : styles.select}>
    <button ref={triggerRef} type="button" className={styles.trigger} data-select-trigger="true" data-variant={variant} data-empty={!selected || undefined} data-open={open || undefined} aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} disabled={disabled} title={title ?? (selected ? [selected.label, selected.detail].filter(Boolean).join(' · ') : undefined)} onClick={() => setOpen((current) => !current)} onKeyDown={onTrigger}>
      {selected?.icon && <span className={styles.triggerIcon}>{selected.icon}</span>}<span className={styles.triggerCopy}><span>{selected?.label ?? placeholder}</span>{triggerDetail && selected?.detail && <small>{selected.detail}</small>}</span>
    </button>
    {open && box && createPortal(<div ref={panel} className={styles.panel} style={{ top: box.top, bottom: box.bottom, left: box.left, width: box.width }} tabIndex={-1} onKeyDown={onPanelKey}>
      {showSearch && <input aria-label={searchLabel ?? searchInputLabel(label)} placeholder={searchPlaceholder} value={query} autoFocus onChange={(event) => setQuery(event.target.value)} />}
      <div className={styles.list} id={listId} role="listbox" aria-label={label} style={{ maxHeight: Math.max(140, box.maxHeight - (showSearch ? 52 : 8) - (onPickFolder ? 40 : 0)) }}>
        {matches.length ? matches.map((option, index) => <button key={option.value || '__all'} type="button" role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined} data-active={index === active || undefined} disabled={option.disabled} onMouseEnter={() => setActive(index)} onClick={() => choose(option)}>
          {option.icon && <span className={styles.optionIcon}>{option.icon}</span>}<span className={styles.optionCopy}><strong>{option.label}</strong>{option.detail && <small>{option.detail}</small>}</span>
          <span className={styles.optionMarks}>{option.note && <em>{option.note}</em>}{option.value === value && <Icon name="check" size={14} />}</span>
        </button>) : <p>{emptyText}</p>}
      </div>
      {onPickFolder && <button type="button" className={styles.folderPick} onClick={() => { setOpen(false); setQuery(''); onPickFolder(); }}><Icon name="folder" size={14} />{pickFolderLabel}</button>}
    </div>, portalTarget)}
  </div>;
}
