import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import styles from './ModelCombobox.module.css';

function scrollParent(node: HTMLElement | null) {
  for (let element = node?.parentElement ?? null; element && element !== document.body; element = element.parentElement) {
    const overflow = getComputedStyle(element).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return element;
  }
  return null;
}

export function ModelCombobox({ id, label, value, placeholder, options, disabled, action, onChange }: {
  id?: string;
  label: string;
  value: string;
  placeholder: string;
  options: string[];
  disabled?: boolean;
  action?: { label: string; busy: boolean; onClick: () => void };
  onChange: (model: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  const [filtering, setFiltering] = useState(false);
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<{ top?: number; bottom?: number; left: number; width: number; maxHeight: number } | null>(null);
  const anchor = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const listId = useId();
  const needle = filtering ? text.trim().toLowerCase() : '';
  const matches = options.filter(model => model.toLowerCase().includes(needle));

  useEffect(() => { if (document.activeElement !== anchor.current) setText(value); }, [value]);

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.max(rect.width, 220);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      // Stay inside the scrolling form so the list never covers a dialog footer.
      const bounds = scrollParent(anchor.current)?.getBoundingClientRect();
      const below = Math.min(window.innerHeight, bounds?.bottom ?? Infinity) - rect.bottom - 12;
      const above = rect.top - Math.max(0, bounds?.top ?? 0) - 12;
      const upward = below < 180 && above > below;
      setBox({
        left,
        width,
        maxHeight: Math.max(140, Math.min(280, upward ? above : below)),
        top: upward ? undefined : rect.bottom + 4,
        bottom: upward ? window.innerHeight - rect.top + 4 : undefined,
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, text]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchor.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
      setFiltering(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  useEffect(() => { setActive(0); }, [needle, open]);

  function choose(model: string) {
    setText(model);
    setFiltering(false);
    setOpen(false);
    onChange(model);
    anchor.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); setFiltering(false); setText(value); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive(index => Math.min(index + 1, Math.max(matches.length - 1, 0))); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); setActive(index => Math.max(index - 1, 0)); return; }
    if (event.key === 'Enter' && open && matches[active]) { event.preventDefault(); choose(matches[active]); }
  }

  return <div className={styles.combo}>
    <input ref={anchor} id={id} className={styles.trigger} role="combobox" aria-label={label} aria-expanded={open} aria-controls={open ? listId : undefined} aria-autocomplete="list" value={text} placeholder={placeholder} disabled={disabled} onFocus={() => { setFiltering(false); setOpen(true); }} onBlur={() => { setOpen(false); setFiltering(false); }} onChange={event => { const next = event.target.value; setText(next); setFiltering(true); setOpen(true); onChange(next); }} onKeyDown={onKeyDown} />
    {open && box && createPortal(<div ref={panel} className={styles.panel} style={{ top: box.top, bottom: box.bottom, left: box.left, width: box.width, maxHeight: box.maxHeight }}>
      <div id={listId} className={styles.list} role="listbox" aria-label={t('tools.modelCombo.list', { label })}>
        {matches.map((model, index) => <button key={model} type="button" role="option" aria-selected={model === value} data-active={index === active} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(model)}><span>{model}</span></button>)}
      </div>
      {!matches.length && <div className={styles.empty}><p>{filtering ? t('tools.modelCombo.noMatch') : t('tools.modelCombo.noCatalog')}</p></div>}
      {!filtering && action && <button className={styles.fetch} type="button" disabled={action.busy} onMouseDown={event => event.preventDefault()} onClick={() => action.onClick()}>{action.busy ? t('tools.modelCombo.fetching') : action.label}</button>}
    </div>, anchor.current?.closest('dialog') ?? document.body)}
  </div>;
}
