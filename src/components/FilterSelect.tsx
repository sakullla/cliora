import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { highlightRuns } from './CommandPalette';
import { Icon } from './Icon';
import styles from './FilterSelect.module.css';

/**
 * `parent` nests an option under another one (a repository under its project). Children stay folded
 * until their parent is opened, so dozens of projects with hundreds of repositories still read as one
 * short list; a search flattens the tree and names each match's parent. `group` marks a parent that is
 * only a heading: choosing it opens or closes its children instead of selecting it. `keywords` are
 * searched but not shown; `triggerLabel` is the fuller name the closed trigger shows when the label
 * alone would be ambiguous. A heading with a single child is not a tree: the child is listed in its place,
 * one click away, with the heading's name when the two differ.
 */
export type FilterSelectOption = { value: string; label: string; detail?: string; note?: string; disabled?: boolean; icon?: ReactNode; parent?: string; group?: boolean; keywords?: string; triggerLabel?: string };

/** Folding everything would hide a small tree for no gain; past this many children only the selected branch opens. */
const unfoldAllUpTo = 12;

const searchThreshold = 4;
/** Fixed row heights (px). Rows never grow after opening and long lists can be windowed. */
const rowHeight = { plain: 36, detail: 48, nested: 32, nestedDetail: 44, group: 30 };
/** Past this many visible rows only the rows in view (plus overscan) are rendered. */
const virtualAbove = 60;
const overscan = 8;
// Strip the leading verb so the search input label stays concise in both languages.
const stripLabelVerb = (label: string) => label.replace(/^(筛选|切换|Filter\s+|Switch\s+)/, '');
const wordCharacter = /[a-z0-9]/;

// A single letter or digit matches a whole word. "d" then hits "Plan D" and "model-d", and misses the letter inside "model".
function matchesFilterToken(haystack: string, token: string): boolean {
  let from = 0;
  while (from <= haystack.length) {
    const at = haystack.indexOf(token, from);
    if (at < 0) return false;
    if (token.length !== 1 || !wordCharacter.test(token)) return true;
    const before = at > 0 ? haystack[at - 1] : '';
    const after = haystack[at + token.length] ?? '';
    if (!wordCharacter.test(before) && !wordCharacter.test(after)) return true;
    from = at + 1;
  }
  return false;
}

export function FilterSelect({ label, value, options, placeholder, disabled = false, title, searchable = true, forceSearch = false, searchLabel, searchPlaceholder, emptyText, onChange, variant = 'default', className, triggerRef, onTriggerKeyDown, onPickFolder, pickFolderLabel, onPickRemote, pickRemoteLabel, triggerDetail = true }: {
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
  variant?: 'default' | 'accent' | 'title';
  className?: string;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  onTriggerKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onPickFolder?: () => void;
  pickFolderLabel?: string;
  onPickRemote?: () => void;
  pickRemoteLabel?: string;
  triggerDetail?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [box, setBox] = useState<{ top?: number; bottom?: number; left: number; width: number; maxHeight: number } | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const setTriggerNode = (node: HTMLButtonElement | null) => {
    buttonRef.current = node;
    if (triggerRef) (triggerRef as { current: HTMLButtonElement | null }).current = node;
  };
  const revealIndex = useRef<number | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement>(document.body);
  useLayoutEffect(() => { setPortalTarget(anchor.current?.closest('dialog') ?? document.body); }, []);
  const listId = useId();
  const selected = options.find((item) => item.value === value);
  const showSearch = searchable && (forceSearch || options.length > searchThreshold);
  const needle = query.trim().toLowerCase();
  const tokens = needle ? needle.split(/\s+/).filter(Boolean) : [];
  const childCount = new Map<string, number>();
  for (const item of options) if (item.parent) childCount.set(item.parent, (childCount.get(item.parent) ?? 0) + 1);
  const labels = new Map(options.map((item) => [item.value, item.label]));
  const headings = new Map(options.filter((item) => item.group).map((item) => [item.value, item]));
  // A heading over exactly one choice adds a click and a repeated name; its only child stands in for it.
  const soleHeading = (item: FilterSelectOption) => !!item.group && childCount.get(item.value) === 1;
  const standsAlone = (item: FilterSelectOption) => !!item.parent && childCount.get(item.parent) === 1 && headings.has(item.parent);
  const matches = options.filter((item) => {
    if (!tokens.length) return soleHeading(item) ? false : !item.parent || standsAlone(item) || expanded.has(item.parent);
    // A search flattens the tree: a heading only groups, its children carry the parent's name.
    if (item.group) return false;
    const haystack = `${item.label} ${item.detail ?? ''} ${item.note ?? ''} ${item.keywords ?? ''} ${item.parent ? labels.get(item.parent) ?? '' : ''} ${item.value}`.toLowerCase();
    return tokens.every((token) => matchesFilterToken(haystack, token));
  });
  const activeId = matches.length ? `${listId}-${Math.min(active, matches.length - 1)}` : undefined;
  function toggle(parent: string, open?: boolean) {
    setExpanded((current) => {
      const next = new Set(current);
      if (open ?? !next.has(parent)) next.add(parent); else next.delete(parent);
      return next;
    });
  }

  const hasTree = childCount.size > 0;
  const hasDetail = options.some((item) => !!item.detail);
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const minWidth = hasTree || hasDetail ? 300 : 240;
      const maxCap = hasTree ? 420 : 360;
      const width = Math.min(Math.max(rect.width, minWidth), window.innerWidth - 16);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const upward = below < 220 && above > below;
      const next = { left, width, maxHeight: Math.max(180, Math.min(maxCap, upward ? above : below)), top: upward ? undefined : rect.bottom + 4, bottom: upward ? window.innerHeight - rect.top + 4 : undefined };
      // Scrolling the list itself also reaches this capture listener; an unchanged box must not re-render.
      setBox((current) => current && current.left === next.left && current.width === next.width && current.maxHeight === next.maxHeight && current.top === next.top && current.bottom === next.bottom ? current : next);
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, hasTree, hasDetail]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const total = [...childCount.values()].reduce((sum, count) => sum + count, 0);
    const initial = new Set(total <= unfoldAllUpTo ? childCount.keys() : []);
    if (selected?.parent) initial.add(selected.parent);
    setExpanded(initial);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    setScrollTop(0);
    const index = Math.max(0, matches.findIndex((item) => item.value === value));
    revealIndex.current = index;
    setActive(index);
  }, [open]);
  /** A new query starts on its first match in the same render that filters the list: an
   *  Enter typed right after the text must never see the previous, longer list's index. */
  function changeQuery(next: string) {
    revealIndex.current = 0;
    setActive(0);
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
    setQuery(next);
  }
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

  // Every row has a fixed height, so the list is laid out by arithmetic, not by measuring: the panel
  // paints in its final shape on the first frame (no row resizing after open, which WebKit did for
  // two-line rows), and long lists render only the rows in view.
  const rows = matches.map((option) => {
    const alone = !needle && standsAlone(option);
    const heading = option.parent ? labels.get(option.parent) : undefined;
    const context = option.parent && (needle || (alone && heading !== option.label)) ? [heading, option.detail].filter(Boolean).join(' · ') : option.detail;
    const nested = !!option.parent && !needle && !alone;
    const height = option.group && !context ? rowHeight.group : nested ? (context ? rowHeight.nestedDetail : rowHeight.nested) : context ? rowHeight.detail : rowHeight.plain;
    return { option, alone, heading, context, nested, height };
  });
  const offsets: number[] = [];
  let contentHeight = 0;
  for (const row of rows) { offsets.push(contentHeight); contentHeight += row.height; }
  const listMax = box ? Math.max(140, box.maxHeight - (showSearch ? 52 : 8) - (onPickFolder || onPickRemote ? 40 : 0)) : 0;
  const virtual = rows.length > virtualAbove;
  let first = 0;
  let last = rows.length;
  if (virtual) {
    while (first < rows.length - 1 && offsets[first] + rows[first].height <= scrollTop) first++;
    last = first;
    while (last < rows.length && offsets[last] < scrollTop + listMax) last++;
    first = Math.max(0, first - overscan);
    last = Math.min(rows.length, last + overscan);
  }
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open || revealIndex.current == null || !list || !rows.length) return;
    const index = Math.min(revealIndex.current, rows.length - 1);
    revealIndex.current = null;
    const top = offsets[index];
    const bottom = top + rows[index].height;
    const view = list.clientHeight || listMax;
    let next = list.scrollTop;
    if (top < next) next = top;
    else if (bottom > next + view) next = bottom - view;
    if (next !== list.scrollTop) list.scrollTop = next;
    // Same frame: the rendered window follows the scroll before anything paints.
    setScrollTop(list.scrollTop);
  }, [open, active, query, box]);

  function choose(option: FilterSelectOption) {
    if (option.disabled) return;
    if (option.group) { toggle(option.value); return; }
    setOpen(false);
    setQuery('');
    onChange(option.value);
    buttonRef.current?.focus();
  }

  function onPanelKey(event: KeyboardEvent<HTMLElement>) {
    // Tab leaves the listbox: return focus to the trigger before closing so the browser's
    // default tab order continues from the trigger instead of dropping to <body> with the panel unmounted.
    if (event.key === 'Tab') { buttonRef.current?.focus(); setOpen(false); setQuery(''); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => { const next = Math.min(index + 1, Math.max(matches.length - 1, 0)); revealIndex.current = next; return next; }); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => { const next = Math.max(index - 1, 0); revealIndex.current = next; return next; }); return; }
    if (event.key === 'PageDown') { event.preventDefault(); setActive((index) => { const next = Math.min(index + 5, Math.max(matches.length - 1, 0)); revealIndex.current = next; return next; }); return; }
    if (event.key === 'PageUp') { event.preventDefault(); setActive((index) => { const next = Math.max(index - 5, 0); revealIndex.current = next; return next; }); return; }
    if (event.key === 'Home' && (!showSearch || !query)) { event.preventDefault(); revealIndex.current = 0; setActive(0); return; }
    if (event.key === 'End' && (!showSearch || !query)) { event.preventDefault(); const last = Math.max(matches.length - 1, 0); revealIndex.current = last; setActive(last); return; }
    const current = matches[Math.min(active, matches.length - 1)];
    if (event.key === 'Enter' && current) { event.preventDefault(); choose(current); return; }
    // → opens a folded parent, ← folds it or steps from a child back to its parent.
    if (!needle && current && (event.key === 'ArrowRight' || event.key === 'ArrowLeft') && (childCount.has(current.value) || current.parent)) {
      event.preventDefault();
      if (event.key === 'ArrowRight' && childCount.has(current.value)) toggle(current.value, true);
      else if (event.key === 'ArrowLeft' && childCount.has(current.value) && expanded.has(current.value)) toggle(current.value, false);
      else if (event.key === 'ArrowLeft' && current.parent) { const at = matches.findIndex((item) => item.value === current.parent); if (at >= 0) { revealIndex.current = at; setActive(at); } }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (query) { changeQuery(''); return; }
      setOpen(false);
      setQuery('');
      buttonRef.current?.focus();
    }
  }

  function onTrigger(event: KeyboardEvent<HTMLButtonElement>) {
    if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setOpen(true); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen((current) => !current); return; }
    onTriggerKeyDown?.(event);
  }

  return <div ref={anchor} className={className ? `${styles.select} ${className}` : styles.select}>
    <button ref={setTriggerNode} type="button" className={styles.trigger} data-select-trigger="true" data-variant={variant} data-empty={!selected || undefined} data-open={open || undefined} data-value={value} aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} disabled={disabled} title={title ?? (selected ? [selected.triggerLabel ?? selected.label, selected.detail].filter(Boolean).join(' · ') : undefined)} onClick={() => setOpen((current) => !current)} onKeyDown={onTrigger}>
      {selected?.icon && <span className={styles.triggerIcon}>{selected.icon}</span>}<span className={styles.triggerCopy}><span>{selected ? selected.triggerLabel ?? selected.label : placeholder ?? t('common.filterSelect.placeholder')}</span>{triggerDetail && selected?.detail && <small>{selected.detail}</small>}</span>
    </button>
    {open && box && createPortal(<div ref={panel} className={styles.panel} style={{ top: box.top, bottom: box.bottom, left: box.left, width: box.width }} tabIndex={-1} aria-activedescendant={!showSearch && activeId ? activeId : undefined} onKeyDown={onPanelKey}>
      {showSearch && <div className={styles.searchRow} data-field-frame="">
        <Icon name="search" size={14} />
        <input ref={searchInputRef} aria-label={searchLabel ?? t('common.filterSelect.search', { label: stripLabelVerb(label) })} placeholder={searchPlaceholder ?? t('common.filterSelect.searchPlaceholder')} value={query} aria-controls={listId} aria-activedescendant={activeId} autoFocus onChange={(event) => changeQuery(event.target.value)} />
        {needle && options.length > 20 && <span className={styles.searchCount} aria-live="polite">{t('common.filterSelect.matchCount', { count: matches.length })}</span>}
        {query && <button type="button" className={styles.searchClear} aria-label={t('common.search.clear')} title={t('common.search.clear')} onClick={() => { changeQuery(''); searchInputRef.current?.focus(); }}><Icon name="close" size={14} /></button>}
      </div>}
      <div ref={listRef} className={styles.list} id={listId} role="listbox" aria-label={label} data-virtual={virtual || undefined} style={{ maxHeight: listMax }} onScroll={(event) => { if (virtual) setScrollTop(event.currentTarget.scrollTop); }}>
        {rows.length ? <>
          {virtual && first > 0 && <div aria-hidden="true" style={{ height: offsets[first], flex: 'none' }} />}
          {rows.slice(first, last).map(({ option, alone, heading, context, nested, height }, slot) => {
            const index = first + slot;
            const children = childCount.get(option.value) ?? 0;
            const open = expanded.has(option.value);
            const icon = alone && heading === option.label ? headings.get(option.parent!)?.icon ?? option.icon : option.icon;
            // Under its heading a child drops the heading's name it repeats ("app · feature" under "app").
            const shown = nested && heading && option.label.startsWith(`${heading} · `) ? option.label.slice(heading.length + 3) : option.label;
            const full = [option.triggerLabel ?? option.label, context].filter(Boolean).join(' · ');
            // Rows never take focus: it stays in the search field (or the panel), so a fold or a hover
            // keeps typing and arrow keys where they were and no focus ring lands inside the scroller.
            return <div key={option.value || '__all'} id={`${listId}-${index}`} role="option" tabIndex={-1} title={full.length > 40 ? full : undefined} style={{ height }} aria-selected={option.value === value} aria-disabled={option.disabled || undefined} aria-expanded={children ? open : undefined} data-value={option.value} data-indent={nested || undefined} data-group={option.group || undefined} data-option-index={index} data-active={index === active || undefined} onMouseDown={(event) => event.preventDefault()} onMouseMove={() => { if (active !== index && !option.disabled) setActive(index); }} onClick={() => { if (option.disabled) return; setActive(index); choose(option); }}>
              {icon && <span className={styles.optionIcon}>{icon}</span>}<span className={styles.optionCopy}><strong>{needle ? highlightRuns(option.label, query).map((run, runIndex) => run.hit ? <mark key={runIndex}>{run.text}</mark> : run.text) : shown}</strong>{context && <small>{context}</small>}</span>
              <span className={styles.optionMarks}>{option.note && <em>{option.note}</em>}{option.value === value && <Icon name="check" size={14} />}{children > 0 && !needle && <span className={styles.disclosure} role="presentation" title={t(open ? 'common.filterSelect.collapse' : 'common.filterSelect.expand', { count: children })} data-open={open || undefined} onClick={(event) => { event.stopPropagation(); toggle(option.value); }}><small>{children}</small><Icon name="chevronRight" size={13} /></span>}</span>
            </div>;
          })}
          {virtual && last < rows.length && <div aria-hidden="true" style={{ height: contentHeight - (offsets[last] ?? contentHeight), flex: 'none' }} />}
        </> : <p>{emptyText ?? t('common.filterSelect.empty')}</p>}
      </div>
      {(onPickFolder || onPickRemote) && <div className={styles.footerActions}>{onPickFolder && <button type="button" className={styles.folderPick} onClick={() => { setOpen(false); setQuery(''); onPickFolder(); }}><Icon name="folder" size={14} />{pickFolderLabel ?? t('common.filterSelect.pickFolder')}</button>}{onPickRemote && <button type="button" className={styles.folderPick} onClick={() => { setOpen(false); setQuery(''); onPickRemote(); }}><Icon name="globe" size={14} />{pickRemoteLabel ?? t('home.remote.add')}</button>}</div>}
    </div>, portalTarget)}
  </div>;
}
