import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { formatFailure } from '../../lib/feedback';
import { useRemoteIdentity } from '../../lib/remoteReads';
import { GuideDialog } from '../../components/GuideDialog';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui';
import { SearchField } from '../../components/SearchField';
import { FilterSelect } from '../../components/FilterSelect';
import type { BusinessWorkspace } from '../../types/workspaces';
import type { PromptContext, PromptDocument, PromptSummary } from '../../types/prompts';
import { notifyPromptsChanged, promptContextKey, usePromptQuery } from '../prompts/usePromptQuery';
import { scopeLabel } from '../prompts/promptScope';
import styles from '../prompts/Prompts.module.css';

export function PromptPicker({ context, sourceKey, active = true, workspaces = [], onPick, className, labelClassName }: { context: PromptContext | null; sourceKey: string; active?: boolean; workspaces?: BusinessWorkspace[]; onPick: (prompt: PromptDocument) => void; className?: string; labelClassName?: string }) {
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
  const quick = usePromptQuery(context ?? emptyContext, { limit: 3 }, active && !!context, key);
  const results = usePromptQuery(context ?? emptyContext, { search, tags: tag.trim() ? [tag.trim()] : [], favoritesOnly: mode === 'favorites', recentOnly: mode === 'recent', includeOtherScopes: includeOther, offset, limit: 30 }, active && open && !!context, key);
  useEffect(() => { setSelected(null); setReading(false); setError(''); setNotice(''); setSearch(''); setTag(''); setOffset(0); setIncludeOther(false); readSequence.current++; abortRead.current?.abort(); }, [key]);
  useEffect(() => () => { readSequence.current++; abortRead.current?.abort(); }, []);
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
  return <div className={`${styles.pickerBar} ${className ?? ''}`} role="group" aria-label={t('sessions.pickLibraryPrompt')}>
    <span className={labelClassName}><Icon name="library" size={12} /> {t('prompts.title')}</span>
    {quick.page.items.map(item => <Button key={item.id} className={styles.pill} size="sm" variant="ghost" title={`${item.title} · ${scopeLabel(item.scope, workspaces, t)}`} disabled={reading || quick.loading} onClick={() => void read(item, true)}>{item.title}</Button>)}
    <Button size="sm" variant="ghost" data-select-trigger="true" aria-haspopup="dialog" aria-expanded={open} disabled={!context} title={!context ? t('prompts.unknownHost') : t('prompts.keepDraft')} icon={<Icon name="search" size={13} />} onClick={() => { setRestoreFocus(true); setOpen(true); setError(''); }}>{t('prompts.open')}</Button>
    {(quick.error || (!open && error)) && <span role="alert"><span>{quick.error ? t(quick.stale ? 'sessions.promptsStale' : 'sessions.promptsFailed') : error}</span> <Button size="sm" variant="ghost" onClick={quick.reload}>{t('sessions.retryPrompts')}</Button></span>}
    {notice && <span role="status">{notice}</span>}
    <GuideDialog open={open} restoreFocus={restoreFocus} title={t('prompts.open')} hint={t('prompts.keepDraft')} wide onClose={close}>
      <div className={styles.browser} onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing && selected && !reading) { event.preventDefault(); event.stopPropagation(); void read(selected, true); }
      }}>
        <div className={styles.searchPane} onKeyDown={event => {
          if (event.key === 'ArrowDown' && event.target instanceof HTMLInputElement && event.target.getAttribute('aria-label') === t('prompts.search')) {
            const first = event.currentTarget.querySelector<HTMLButtonElement>('[data-prompt-pick]:not(:disabled)');
            if (first) { event.preventDefault(); first.focus(); }
          }
        }}>
          <SearchField label={t('prompts.search')} value={search} onChange={value => changeFilters(() => setSearch(value))} placeholder={t('prompts.searchPlaceholder')} />
          <div className={styles.toolbar}><FilterSelect label={t('prompts.title')} value={mode} options={['all', 'favorites', 'recent'].map(value => ({ value, label: t(`prompts.${value}`) }))} onChange={value => changeFilters(() => setMode(value))} /><input aria-label={t('prompts.tagFilter')} placeholder={t('prompts.tagFilter')} value={tag} onChange={event => changeFilters(() => setTag(event.target.value))} /></div>
          <label><input type="checkbox" checked={includeOther} onChange={event => changeFilters(() => setIncludeOther(event.target.checked))} /> {t('prompts.includeOther')}</label>
          {(results.error || error) && <div className={styles.error} role="alert">{results.error || error}<Button size="sm" onClick={results.reload}>{t('prompts.retry')}</Button></div>}
          {results.loading && <p className={styles.hint} role="status">{t('prompts.loading')}</p>}
          <div className={styles.list} aria-label={t('prompts.title')} onKeyDown={event => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-prompt-pick]'));
            const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (at < 0 || !buttons.length) return;
            event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))].focus();
          }}>
            {results.page.items.map(item => <div className={styles.row} key={item.id} data-selected={selected?.id === item.id || undefined}><button type="button" data-prompt-pick aria-label={item.title} className={styles.rowButton} disabled={results.loading} onClick={() => void read(item)}><strong>{item.title}</strong><span className={styles.meta}>{scopeLabel(item.scope, workspaces, t)}{item.tags.map(tag => <span className={styles.tag} key={tag}>{tag}</span>)}</span><span className={styles.summary}>{item.preview}</span></button><Button size="sm" variant="ghost" aria-label={t(item.favorite ? 'prompts.unfavorite' : 'prompts.favorite')} aria-pressed={item.favorite} icon={<Icon name="star" size={13} />} onClick={() => void favorite(item)} /></div>)}
          </div>
          {!results.loading && !results.error && !results.page.items.length && <p className={styles.empty}>{t(search || tag ? 'prompts.noMatches' : 'prompts.empty')}</p>}
          <div className={styles.pageNav}><Button size="sm" disabled={!offset || results.loading} onClick={() => pageTo(Math.max(0, offset - 30))}>{t('prompts.previous')}</Button><span>{t('prompts.pageCount', { count: results.page.total })}</span><Button size="sm" disabled={results.page.nextOffset === null || results.loading} onClick={() => pageTo(results.page.nextOffset ?? 0)}>{t('prompts.next')}</Button></div>
        </div>
        <div className={styles.detail}>
          <strong>{selected?.title ?? t('prompts.preview')}</strong>
          {reading ? <p role="status">{t('prompts.loading')}</p> : selected ? <><span className={styles.meta}>{scopeLabel(selected.scope, workspaces, t)}</span><pre className={styles.preview}>{selected.body}</pre><Button title={t('prompts.insertShortcut')} disabled={!selected.body} onClick={() => void read(selected, true)}>{t('prompts.insert')}</Button></> : <p className={styles.hint}>{t('prompts.emptyHint')}</p>}
        </div>
      </div>
    </GuideDialog>
  </div>;
}
