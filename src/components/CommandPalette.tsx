import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from './Icon';
import { ToolIcon } from './ToolIcon';
import { Button } from './ui';
import { withMod } from '../lib/shortcut';

export type CommandItem = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keywords?: string;
  icon?: IconName;
  toolId?: string;
  /** Optional context boost when ranking search matches (e.g. current tool or active page). */
  contextBoost?: number;
  /** Hidden when the query is empty so deep destinations stay searchable without crowding the default list. */
  searchOnly?: boolean;
  run: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
};

function matchScore(item: CommandItem, needle: string): number {
  const label = item.label.trim().toLowerCase();
  const group = item.group.trim().toLowerCase();
  const hint = (item.hint ?? '').trim().toLowerCase();
  const keywords = (item.keywords ?? '').trim().toLowerCase();
  const toolId = (item.toolId ?? '').trim().toLowerCase();
  const boost = item.contextBoost ?? 0;

  if (label === needle) return 100 + boost;
  if (label.startsWith(needle)) return 85 + boost;
  if (keywords === needle || (toolId && toolId === needle)) return 75 + boost;
  if (label.includes(needle)) return 65 + boost;
  if (keywords.startsWith(needle)) return 55 + boost;
  if (keywords.includes(needle) || (toolId && toolId.includes(needle))) return 45 + boost;
  if (group.includes(needle) || hint.includes(needle)) return 30 + boost;
  const haystack = `${label} ${group} ${hint} ${keywords} ${toolId}`;
  if (haystack.includes(needle)) return 15 + boost;
  const tokens = needle.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((token) => haystack.includes(token))) {
    const labelHits = tokens.filter((token) => label.includes(token) || toolId.includes(token)).length;
    return 20 + labelHits * 10 + boost;
  }
  return 0;
}

/** Splits a label into plain and matched runs so the reader sees why a row matched. */
export function highlightRuns(label: string, query: string): { text: string; hit: boolean }[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [{ text: label, hit: false }];
  const lower = label.toLowerCase();
  const hits = new Array<boolean>(label.length).fill(false);
  // toLowerCase keeps length for the scripts used in labels; skip when casing would change length.
  if (lower.length === label.length) {
    for (const token of tokens) {
      let from = 0;
      while (from < lower.length) {
        const at = lower.indexOf(token, from);
        if (at < 0) break;
        hits.fill(true, at, at + token.length);
        from = at + token.length;
      }
    }
  }
  const runs: { text: string; hit: boolean }[] = [];
  for (let index = 0; index < label.length; index += 1) {
    const last = runs[runs.length - 1];
    if (last && last.hit === hits[index]) last.text += label[index];
    else runs.push({ text: label[index], hit: hits[index] });
  }
  return runs.length ? runs : [{ text: label, hit: false }];
}

export function CommandPalette({ open, commands, sourceFailed = false, onRetrySources, onClose }: {
  open: boolean;
  commands: CommandItem[];
  sourceFailed?: boolean;
  onRetrySources?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const chosen = useRef(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands.filter((item) => !item.searchOnly);
    return commands
      .map((item, order) => ({ item, order, score: matchScore(item, needle) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .map((entry) => entry.item);
  }, [commands, query]);
  const index = shown.length ? Math.min(active, shown.length - 1) : 0;
  const activeItem = shown[index];

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || !open) return;
    chosen.current = false;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!element.open) element.showModal();
    input.current?.focus();
    return () => {
      if (element.open) element.close();
      const target = returnFocus.current;
      if (!chosen.current && target?.isConnected) requestAnimationFrame(() => target.focus());
    };
  }, [open]);

  useEffect(() => { setQuery(''); setActive(0); }, [open]);
  useEffect(() => {
    if (!open) return;
    document.getElementById(`command-option-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, index, query]);

  if (!open) return null;

  function choose(item: CommandItem | undefined) {
    if (!item) return;
    chosen.current = true;
    onClose();
    item.run();
  }

  function chooseSecondary(item: CommandItem | undefined) {
    if (!item?.onSecondary) return;
    chosen.current = true;
    onClose();
    item.onSecondary();
  }

  function clearQuery() {
    setQuery('');
    setActive(0);
    input.current?.focus();
  }

  return <dialog ref={dialog} className="command-dialog" aria-labelledby="command-dialog-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={(event) => {
    if (withMod(event) && event.key.toLowerCase() === 'k') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key === 'ArrowDown' || (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'n')) { event.preventDefault(); setActive(shown.length ? (index + 1) % shown.length : 0); return; }
    if (event.key === 'ArrowUp' || (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'p')) { event.preventDefault(); setActive(shown.length ? (index - 1 + shown.length) % shown.length : 0); return; }
    if (event.key === 'PageDown') { event.preventDefault(); setActive(shown.length ? Math.min(shown.length - 1, index + 5) : 0); return; }
    if (event.key === 'PageUp') { event.preventDefault(); setActive(shown.length ? Math.max(0, index - 5) : 0); return; }
    if (event.key === 'Home') { event.preventDefault(); setActive(0); return; }
    if (event.key === 'End') { event.preventDefault(); setActive(Math.max(0, shown.length - 1)); return; }
    if (event.key === 'Enter' && event.altKey && !event.nativeEvent.isComposing && activeItem?.onSecondary) {
      event.preventDefault();
      chooseSecondary(activeItem);
      return;
    }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing && document.activeElement === input.current) {
      event.preventDefault();
      if (shown.length) choose(shown[index]);
      else if (query.trim()) clearQuery();
    }
  }}>
    <h2 id="command-dialog-title" className="sr-only">{t('common.palette.title')}</h2>
    {/* The header row is the field: the input stays flat instead of drawing its own focus box. */}
    <div className="command-input-row" data-field-frame="">
      <Icon name="search" size={16} />
      <input ref={input} role="combobox" aria-expanded="true" aria-controls="command-list" aria-autocomplete="list" aria-activedescendant={shown.length ? `command-option-${index}` : undefined} aria-label={t('common.palette.search')} placeholder={t('common.palette.search')} value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} />
      {query && <button type="button" className="command-clear" aria-label={t('common.palette.clearQuery')} title={t('common.palette.clearQuery')} onClick={clearQuery}><Icon name="close" size={15} /></button>}
    </div>
    {sourceFailed && <div className="command-source-notice" role="status">
      <Icon name="alert" size={14} />
      <span>{t('common.palette.partialFailed')}</span>
      {onRetrySources && <Button size="sm" variant="ghost" onClick={onRetrySources}>{t('common.palette.retrySources')}</Button>}
    </div>}
    <div id="command-list" className="command-list" role="listbox" aria-label={t('common.palette.listLabel')}>
      {shown.length ? shown.map((item, itemIndex) => {
        const previous = shown[itemIndex - 1];
        return <div key={item.id} role="presentation" className="command-row">
          {previous?.group !== item.group && <div className="command-group">{item.group}</div>}
          <div className="command-item-wrap" data-selected={itemIndex === index || undefined}>
            <button type="button" id={`command-option-${itemIndex}`} role="option" aria-selected={itemIndex === index} className="command-option" onMouseMove={() => setActive(itemIndex)} onClick={() => choose(item)}>
              <span className="command-glyph" aria-hidden="true">{item.toolId ? <ToolIcon toolId={item.toolId} size={18} /> : item.icon ? <Icon name={item.icon} size={16} /> : null}</span>
              <span className="command-label">{highlightRuns(item.label, query).map((run, runIndex) => run.hit ? <mark key={runIndex}>{run.text}</mark> : run.text)}</span>
              {item.hint && <small>{item.hint}</small>}
            </button>
            {item.onSecondary && item.secondaryLabel && <button type="button" className="command-secondary" aria-label={`${item.label} · ${item.secondaryLabel}`} title={`${item.secondaryLabel} (Alt+Enter)`} onMouseEnter={() => setActive(itemIndex)} onClick={() => chooseSecondary(item)}>{item.secondaryLabel}</button>}
          </div>
        </div>;
      }) : <div className="command-empty-state">
        <p className="command-empty" role="status">{t('common.palette.empty', { query: query.trim() })}</p>
        {query.trim() && <Button size="sm" variant="ghost" onClick={clearQuery}>{t('common.palette.clearQuery')}</Button>}
      </div>}
    </div>
    <div className="command-foot">
      <span><kbd>↑</kbd><kbd>↓</kbd> {t('common.palette.footChoose')}</span>
      <span><kbd>Enter</kbd> {t('common.palette.footOpen')}</span>
      {activeItem?.onSecondary && <span><kbd>Alt</kbd><kbd>Enter</kbd> {activeItem.secondaryLabel ?? t('common.palette.footSecondary')}</span>}
      <span><kbd>Esc</kbd> {t('common.palette.footClose')}</span>
    </div>
  </dialog>;
}
