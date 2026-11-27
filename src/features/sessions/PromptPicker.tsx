import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { formatFailure } from '../../lib/feedback';
import { useRemoteIdentity } from '../../lib/remoteReads';
import { GuideDialog } from '../../components/GuideDialog';
import { Icon } from '../../components/Icon';
import { Badge, Button, Segmented } from '../../components/ui';
import { modLabel } from '../../lib/shortcut';
import { SearchField } from '../../components/SearchField';
import { FilterSelect } from '../../components/FilterSelect';
import type { BusinessWorkspace } from '../../types/workspaces';
import type { PromptContext, PromptDocument, PromptSummary } from '../../types/prompts';
import { notifyPromptsChanged, promptContextKey, usePromptQuery } from '../prompts/usePromptQuery';
import { scopeLabel, scopeTone } from '../prompts/promptScope';
import styles from '../prompts/Prompts.module.css';

export type PromptPickerHandle = {
  open: () => void;
};

export const PromptPicker = forwardRef<PromptPickerHandle, {
  context: PromptContext | null;
  sourceKey: string;
  active?: boolean;
  workspaces?: BusinessWorkspace[];
  onPick: (prompt: PromptDocument) => void;
  className?: string;
  labelClassName?: string;
  /** Compact mode renders only a single trigger button (for the ACP composer toolbar). */
  compact?: boolean;
  /** Custom class for the compact trigger button so pane surfaces can apply --term-* tokens. */
  triggerClassName?: string;
  triggerLabelClassName?: string;
  triggerLabel?: string;
  triggerTitle?: string;
  disabled?: boolean;
}>(function PromptPicker({
  context,
  sourceKey,
  active = true,
  workspaces = [],
  onPick,
  className,
  labelClassName,
  compact = false,
  triggerClassName,
  triggerLabelClassName,
  triggerLabel,
  triggerTitle,
  disabled = false,
}, ref) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [restoreFocus, setRestoreFocus] = useState(true);
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [mode, setMode] = useState('all');
  const [includeOther, setIncludeOther] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<PromptDocument | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const remoteIdentity = useRemoteIdentity(context?.targetId ?? null);
  const key = `${context ? promptContextKey(context) : 'unknown'}:${sourceKey}:${remoteIdentity}`;
  const latest = useRef(key); latest.current = key;
  const pickCallback = useRef(onPick); pickCallback.current = onPick;
  const readSequence = useRef(0);
  const abortRead = useRef<AbortController | null>(null);
  const emptyContext: PromptContext = { targetId: null };
  const quick = usePromptQuery(context ?? emptyContext, { limit: 3 }, active && !compact && !!context, key);
  const results = usePromptQuery(context ?? emptyContext, { search, tags: tag.trim() ? [tag.trim()] : [], favoritesOnly: mode === 'favorites', recentOnly: mode === 'recent', includeOtherScopes: includeOther, offset, limit: 30 }, active && open && !!context, key, { keepPrevious: true });
  useEffect(() => { setSelected(null); setReading(false); setError(''); setNotice(''); setSearch(''); setTag(''); setOffset(0); setIncludeOther(false); readSequence.current++; abortRead.current?.abort(); }, [key]);
  useEffect(() => () => { readSequence.current++; abortRead.current?.abort(); }, []);
  useEffect(() => { if (disabled && open) close(); }, [disabled, open]);
  function openPicker() {
    if (!context || disabled) return;
    setRestoreFocus(true);
    setOpen(true);
    setError('');
  }
  useImperativeHandle(ref, () => ({ open: openPicker }), [context, disabled]);
  function close() { setOpen(false); setSelected(null); setReading(false); readSequence.current++; abortRead.current?.abort(); }
  function changeFilters(change: () => void) { change(); setOffset(0); setSelected(null); setError(''); readSequence.current++; abortRead.current?.abort(); }
  function pageTo(next: number) { setOffset(next); setSelected(null); setError(''); setReading(false); readSequence.current++; abortRead.current?.abort(); }
  async function read(item: Pick<PromptSummary, 'id' | 'version'>, insert = false) {
    if (!context) return;
    const request = ++readSequence.current; const identity = key;
    abortRead.current?.abort(); const controller = new AbortController(); abortRead.current = controller;
    setReading(true); setError('');
    try {
      const document = await native.getPrompt(context, item.id, item.version, { signal: controller.signal });
      if (controller.signal.aborted || request !== readSequence.current || latest.current !== identity) return;
      if (!document || typeof document.body !== 'string') throw new Error(t('prompts.readFailed'));
      if (insert) insertDocument(document, identity); else setSelected(document);
    } catch (value) { if (!controller.signal.aborted && request === readSequence.current && latest.current === identity) setError(formatFailure(value, t('prompts.readFailed'), t('prompts.retry'))); }
    finally { if (request === readSequence.current && latest.current === identity) setReading(false); }
  }
  function insertDocument(document: PromptDocument, identity = key) {
    if (!context || identity !== latest.current) return;
    // The receiving editor owns focus after insertion; cancellation still restores the trigger.
    setRestoreFocus(false); pickCallback.current(document); close();
    void native.recordPromptUsage(context, document.id, null, true).then(notifyPromptsChanged).catch(() => { if (latest.current === identity) setNotice(t('prompts.usageFailed')); });
  }
  async function favorite(item: PromptSummary) {
    if (!context) return; const identity = key;
    try { await native.recordPromptUsage(context, item.id, !item.favorite, false); if (latest.current === identity) notifyPromptsChanged(); }
    catch (value) { if (latest.current === identity) setError(formatFailure(value, t('prompts.readFailed'), t('prompts.retry'))); }
  }
  // While a new scope or filter loads, the previous rows stay in place (disabled) instead of
  // blanking the list; tags follow the last settled page the same way.
  const items = results.page.items;
  const total = results.page.total;
  const tagOptions = [...new Set([...(results.page.tags ?? []), ...(tag ? [tag] : [])])].sort();
  const paged = offset > 0 || results.page.nextOffset !== null;
  const contextScope = (() => {
    if (!context) return t('prompts.unknownHost');
    if (context.repositoryId) return scopeLabel({ kind: 'repository', repositoryId: context.repositoryId }, workspaces, t);
    if (context.workspaceId) return scopeLabel({ kind: 'workspace', workspaceId: context.workspaceId }, workspaces, t);
    return t('prompts.global');
  })();
  const filtered = !!search.trim() || !!tag || mode !== 'all';
  const dialog = <GuideDialog open={open} restoreFocus={restoreFocus} title={t('prompts.open')} hint={t('prompts.keepDraft')} wide onClose={close}>
      <div className={styles.picker} onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing && selected && !reading) { event.preventDefault(); event.stopPropagation(); void read(selected, true); }
      }}>
        <div className={styles.pickerTop}>
          <div className={styles.pickerSearch} onKeyDown={event => {
            if (event.key !== 'ArrowDown' || !(event.target instanceof HTMLInputElement)) return;
            const first = event.currentTarget.closest(`.${styles.picker}`)?.querySelector<HTMLButtonElement>('[data-prompt-pick]:not(:disabled)');
            if (first) { event.preventDefault(); first.focus(); }
          }}><SearchField label={t('prompts.search')} value={search} onChange={value => changeFilters(() => setSearch(value))} placeholder={t('prompts.searchPlaceholder')} /></div>
          <div className={styles.pickerFilters}>
            <Segmented size="sm" className={styles.scopeSwitch} label={t('prompts.scope')} value={includeOther ? 'all' : 'here'} options={[{ value: 'here', label: <><Icon name="folder" size={12} /><span className={styles.scopeName} title={contextScope}>{contextScope}</span></> }, { value: 'all', label: <><Icon name="globe" size={12} />{t('prompts.allPrompts')}</> }]} onChange={value => changeFilters(() => setIncludeOther(value === 'all'))} />
            <span className={styles.filterGap} />
            <button type="button" className={styles.chip} aria-pressed={mode === 'favorites'} onClick={() => changeFilters(() => setMode(mode === 'favorites' ? 'all' : 'favorites'))}><Icon name="star" size={12} />{t('prompts.favorites')}</button>
            <button type="button" className={styles.chip} aria-pressed={mode === 'recent'} onClick={() => changeFilters(() => setMode(mode === 'recent' ? 'all' : 'recent'))}><Icon name="clock" size={12} />{t('prompts.recent')}</button>
            {/* Always present (disabled without tags) so the filter row keeps its shape across scopes. */}
            <FilterSelect className={styles.tagSelect} label={t('prompts.tagFilter')} disabled={!tagOptions.length} value={tag || '*'} options={[{ value: '*', label: t('prompts.allTags') }, ...tagOptions.map(value => ({ value, label: value }))]} onChange={value => changeFilters(() => setTag(value === '*' ? '' : value))} />
          </div>
        </div>
        <div className={styles.browser}>
          <div className={styles.searchPane}>
            {(results.error || error) && <div className={styles.error} role="alert"><span>{results.error || error}</span><Button size="sm" onClick={results.reload}>{t('prompts.retry')}</Button></div>}
            {/* One fixed frame for every state: switching scope or filters swaps its content in place,
                so the dialog never collapses to a loading line and grows back. */}
            <div className={styles.listFrame} data-prompt-results aria-busy={results.loading || undefined}>
              {items.length > 0 ? <div className={styles.list} aria-label={t('prompts.title')} onKeyDown={event => {
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-prompt-pick]'));
                const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
                if (at < 0 || !buttons.length) return;
                event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))].focus();
              }}>
                {items.map(item => <div className={styles.pickRow} key={item.id} data-selected={selected?.id === item.id || undefined}>
                  <button type="button" data-prompt-pick aria-label={item.title} className={styles.rowButton} disabled={results.loading} onClick={() => void read(item)} onDoubleClick={() => void read(item, true)}>
                    <span className={styles.titleLine}><strong>{item.title}</strong></span>
                    <span className={styles.meta}><Badge tone={scopeTone(item.scope, workspaces)}>{scopeLabel(item.scope, workspaces, t)}</Badge>{item.tags.map(tag => <span className={styles.tag} key={tag}>{tag}</span>)}</span>
                    {item.preview && <span className={styles.summary}>{item.preview}</span>}
                  </button>
                  <Button size="sm" variant="ghost" className={styles.favorite} aria-label={t(item.favorite ? 'prompts.unfavorite' : 'prompts.favorite')} title={t(item.favorite ? 'prompts.unfavorite' : 'prompts.favorite')} aria-pressed={item.favorite} icon={<Icon name="star" size={13} />} onClick={() => void favorite(item)} />
                </div>)}
              </div>
              : results.loading ? <p className={styles.listState} role="status">{t('prompts.loading')}</p>
              : !results.error && <div className={styles.pickerEmpty}>
                <strong>{t(filtered ? 'prompts.noMatches' : 'prompts.empty')}</strong>
                {!includeOther ? <Button size="sm" icon={<Icon name="globe" size={13} />} onClick={() => changeFilters(() => setIncludeOther(true))}>{t('prompts.searchEverywhere')}</Button> : filtered && <Button size="sm" variant="ghost" onClick={() => changeFilters(() => { setSearch(''); setTag(''); setMode('all'); })}>{t('library.page.clearFilters')}</Button>}
              </div>}
            </div>
            <div className={styles.listFootBar}>{items.length > 0 && (paged
              ? <div className={styles.pageNav}><Button size="sm" variant="ghost" disabled={!offset || results.loading} icon={<Icon name="chevronLeft" size={13} />} onClick={() => pageTo(Math.max(0, offset - 30))}>{t('prompts.previous')}</Button><span className={styles.pageRange}><span>{offset + 1}–{offset + items.length}</span><span>{t('prompts.pageCount', { count: total })}</span></span><Button size="sm" variant="ghost" disabled={results.page.nextOffset === null || results.loading} onClick={() => pageTo(results.page.nextOffset ?? 0)}>{t('prompts.next')}<Icon name="chevronRight" size={13} /></Button></div>
              : <p className={styles.listFoot}>{t('prompts.pageCount', { count: total })}</p>)}</div>
          </div>
          <div className={styles.detail} aria-live="polite">
            {reading ? <p className={styles.listState} role="status">{t('prompts.loading')}</p> : selected ? <>
              <div className={styles.detailHead}><strong>{selected.title}</strong><span className={styles.meta}><Badge tone={scopeTone(selected.scope, workspaces)}>{scopeLabel(selected.scope, workspaces, t)}</Badge>{selected.tags.map(tag => <span className={styles.tag} key={tag}>{tag}</span>)}<span>{t('prompts.chars', { count: selected.body.length })}</span></span></div>
              <pre className={styles.preview}>{selected.body}</pre>
              <div className={styles.detailActions}><Button variant="primary" title={t('prompts.insertShortcut')} disabled={!selected.body} icon={<Icon name="arrowDown" size={14} />} onClick={() => void read(selected, true)}>{t('prompts.insert')}</Button></div>
            </> : <div className={styles.previewEmpty}><Icon name="file" size={20} /><p>{t('prompts.pickToPreview')}</p></div>}
          </div>
        </div>
        <p className={styles.keyHints} aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd>{t('prompts.hintMove')}</span><span><kbd>Enter</kbd>{t('prompts.hintPreview')}</span><span><kbd>{modLabel}</kbd><kbd>Enter</kbd>{t('prompts.hintInsert')}</span></p>
      </div>
    </GuideDialog>;

  if (compact) {
    const label = triggerLabel ?? t('sessions.acpInsertPrompt');
    const title = !context ? t('prompts.unknownHost') : (triggerTitle ?? t('sessions.acpInsertPromptHint'));
    return <span className={`${styles.pickerCompact}${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className={triggerClassName || styles.compactTrigger}
        data-acp-prompt-trigger=""
        data-select-trigger="true"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={title}
        disabled={disabled || !context}
        onClick={openPicker}
      >
        <Icon name="library" size={13} />
        <span className={triggerLabelClassName} aria-hidden="true">{label}</span>
      </button>
      {notice && <span role="status" className={styles.pickerNoticeSr}>{notice}</span>}
      {createPortal(dialog, document.body)}
    </span>;
  }

  return <div className={`${styles.pickerBar} ${className ?? ''}`} role="group" aria-label={t('sessions.pickLibraryPrompt')}>
    <span className={labelClassName}><Icon name="library" size={12} /> {t('prompts.title')}</span>
    {quick.page.items.map(item => <Button key={item.id} className={styles.pill} size="sm" variant="ghost" title={`${item.title} · ${scopeLabel(item.scope, workspaces, t)}`} disabled={reading || quick.loading} icon={item.favorite ? <Icon name="star" size={11} className={styles.pillStar} /> : undefined} onClick={() => void read(item, true)}>{item.title}</Button>)}
    <Button size="sm" variant="ghost" data-select-trigger="true" aria-haspopup="dialog" aria-expanded={open} disabled={disabled || !context} title={!context ? t('prompts.unknownHost') : t('prompts.keepDraft')} icon={<Icon name="search" size={13} />} onClick={openPicker}>{t('prompts.open')}</Button>
    {/* Stale prompts are still usable, so the row says so in a word and keeps the detail in the tooltip. */}
    {(quick.error || (!open && error)) && (() => {
      const message = quick.error ? t(quick.stale ? 'sessions.promptsStale' : 'sessions.promptsFailed') : error;
      return <span role="alert" className={styles.pickerAlert} data-stale={quick.error && quick.stale ? '' : undefined} title={message}><Icon name="alert" size={12} /><span>{quick.error && quick.stale ? t('sessions.promptsStaleShort') : message}</span><Button size="sm" variant="ghost" onClick={quick.reload}>{t('sessions.retryPrompts')}</Button></span>;
    })()}
    {notice && <span role="status">{notice}</span>}
    {dialog}
  </div>;
});
