import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { useRemoteIdentity } from '../../lib/remoteReads';
import { confirmAction } from '../../lib/confirm';
import { formatFailure } from '../../lib/feedback';
import { writeClipboard } from '../../lib/clipboard';
import { GuideDialog } from '../../components/GuideDialog';
import { SearchField } from '../../components/SearchField';
import { FilterSelect } from '../../components/FilterSelect';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui';
import { EmptyState } from '../../components/EmptyState';
import { RowMenu } from '../../components/RowMenu';
import type { BusinessWorkspace } from '../../types/workspaces';
import type { LibraryItem } from '../../types/library';
import type { PromptBatch, PromptBatchResultItem, PromptContext, PromptDocument, PromptDraft, PromptSummary, PromptPage } from '../../types/prompts';
import { PromptImportDialog } from './PromptImportDialog';
import { parseScope, scopeLabel, scopeOptions, scopeValue } from './promptScope';
import { notifyPromptsChanged, promptContextKey, usePromptQuery } from './usePromptQuery';
import styles from './Prompts.module.css';

const tagsOf = (value: string) => value.split(/[,，、]/).map(item => item.trim()).filter(Boolean);
const fromDocument = (doc: PromptDocument): PromptDraft => ({ id: doc.id, title: doc.title, body: doc.body, scope: doc.scope, tags: doc.tags, expectedVersion: doc.version });
export function PromptLibrary({ context, active, createSignal, discardSignal, spotlight, onDirtyChange, onCountChange, onRetryCounts, onLaunch }: { context: PromptContext; active: boolean; createSignal: number; discardSignal: number; spotlight?: { id: string; token: number } | null; onDirtyChange: (dirty: boolean) => void; onCountChange: (count: number) => void; onRetryCounts: () => void; onLaunch: (item: LibraryItem) => void }) {
  const { t, i18n } = useTranslation();
  const [search, setSearch] = useState('');
  const [scopeFilter, setScopeFilter] = useState('*');
  const [tagFilter, setTagFilter] = useState('');
  const [mode, setMode] = useState('all');
  const [offset, setOffset] = useState(0);
  const [workspaces, setWorkspaces] = useState<BusinessWorkspace[]>([]);
  const [scopeError, setScopeError] = useState('');
  const [selected, setSelected] = useState<Record<string, PromptSummary>>({});
  const [draft, setDraft] = useState<PromptDraft | null>(null);
  const [tagText, setTagText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editorNotice, setEditorNotice] = useState('');
  const [savedReadError, setSavedReadError] = useState('');
  const [lastSaved, setLastSaved] = useState<{ source: string; document: PromptDocument; before: PromptPage } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignScope, setAssignScope] = useState('global');
  const [assignTags, setAssignTags] = useState('');
  const [changeTags, setChangeTags] = useState(false);
  const [assignment, setAssignment] = useState<PromptBatch | null>(null);
  const [assignResults, setAssignResults] = useState<Record<string, PromptBatchResultItem>>({});
  const remoteIdentity = useRemoteIdentity(context.targetId ?? 'local');
  const source = `${promptContextKey(context)}:${remoteIdentity}`;
  const latest = useRef(source); latest.current = source;
  const origin = useRef(source);
  const assignOrigin = useRef(source);
  const mounted = useRef(true);
  const documentRead = useRef(0);
  const seenCreate = useRef(createSignal);
  const seenDiscard = useRef(discardSignal);
  const seenSpotlight = useRef<number | null>(null);
  const searchQuery = { search, scopeFilter: scopeFilter === '*' ? null : parseScope(scopeFilter), tags: tagsOf(tagFilter), includeOtherScopes: true, favoritesOnly: mode === 'favorites', recentOnly: mode === 'recent', offset, limit: 40 };
  const query = usePromptQuery(context, searchQuery, active, source);
  const all = usePromptQuery(context, { includeOtherScopes: true, limit: 1 }, active, source);
  const dirty = !!draft && JSON.stringify({ ...draft, tags: tagsOf(tagText) }) !== savedText;
  const options = scopeOptions(workspaces, t);
  const filtering = !!search.trim() || scopeFilter !== '*' || !!tagFilter || mode !== 'all';
  const tagOptions = [...new Set([...(query.page.tags ?? []), ...(tagFilter ? [tagFilter] : [])])].sort();
  function refresh() { query.reload(); all.reload(); onRetryCounts(); }
  function clearFilters() { setSearch(''); setScopeFilter('*'); setTagFilter(''); setMode('all'); setOffset(0); }
  useEffect(() => { onDirtyChange(dirty || importOpen || assignOpen); }, [dirty, importOpen, assignOpen, onDirtyChange]);
  useEffect(() => { if (query.loaded && !query.error && !filtering) onCountChange(query.page.total); else if (all.loaded && !all.error) onCountChange(all.page.total); }, [query.loaded, query.error, query.page.total, filtering, all.loaded, all.error, all.page.total, onCountChange]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; documentRead.current++; if (noticeTimer.current) clearTimeout(noticeTimer.current); if (editorNoticeTimer.current) clearTimeout(editorNoticeTimer.current); }; }, []);
  useEffect(() => {
    setSelected({}); setOffset(0); documentRead.current++; setNotice(''); setEditorNotice('');
    let live = true;
    void native.listBusinessWorkspaces().then(rows => { if (live) { setWorkspaces(Array.isArray(rows) ? rows : []); setScopeError(''); } }).catch(() => { if (live) setScopeError(t('prompts.loadScopes')); });
    return () => { live = false; documentRead.current++; };
  }, [source, t]);
  useEffect(() => { if (createSignal === seenCreate.current) return; seenCreate.current = createSignal; if (active) void create(); }, [createSignal, active]);
  useEffect(() => { if (discardSignal === seenDiscard.current) return; seenDiscard.current = discardSignal; setDraft(null); setImportOpen(false); setAssignOpen(false); setError(''); documentRead.current++; }, [discardSignal]);
  useEffect(() => { if (!active || !spotlight || seenSpotlight.current === spotlight.token) return; seenSpotlight.current = spotlight.token; void edit(spotlight.id, null); }, [active, spotlight?.id, spotlight?.token]);
  useEffect(() => {
    if (lastSaved && query.loaded && !query.loading && !query.error && query.page !== lastSaved.before) { setLastSaved(null); setSavedReadError(''); }
  }, [lastSaved, query.loaded, query.loading, query.error, query.page]);
  function announce(text: string, editor = false) {
    const timer = editor ? editorNoticeTimer : noticeTimer;
    if (timer.current) clearTimeout(timer.current);
    const setter = editor ? setEditorNotice : setNotice;
    setter(text);
    timer.current = text ? setTimeout(() => { timer.current = null; if (mounted.current) setter(''); }, 4000) : null;
  }
  const showError = (value: unknown) => setError(formatFailure(value, t('prompts.readFailed'), t('prompts.retry')));
  async function canDiscard() { return !dirty || await confirmAction(t('prompts.discard'), () => mounted.current); }
  async function create() {
    if (busy || !await canDiscard()) return;
    const next: PromptDraft = { id: null, title: '', body: '', scope: scopeFilter !== '*' && !scopeFilter.startsWith('unresolved:') ? parseScope(scopeFilter) : { kind: 'global' }, tags: [], expectedVersion: null };
    origin.current = source; setDraft(next); setTagText(''); setSavedText(JSON.stringify(next)); setError(''); announce(''); announce('', true);
  }
  async function edit(id: string, version: number | null) {
    if (busy || !await canDiscard()) return;
    const request = ++documentRead.current; const identity = source; setBusy(true); setError(''); announce(''); announce('', true);
    try { const known = lastSaved?.source === identity && lastSaved.document.id === id && (version === null || version === lastSaved.document.version) && !!(query.error || savedReadError) ? lastSaved.document : null; const value = known ?? await native.getPrompt(context, id, version); if (!mounted.current || request !== documentRead.current || latest.current !== identity) return; const next = fromDocument(value); origin.current = identity; setDraft(next); setTagText(next.tags.join(',')); setSavedText(JSON.stringify(next)); }
    catch (value) { if (mounted.current && request === documentRead.current && latest.current === identity) showError(value); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function saveDraft() {
    if (!draft || busy) return;
    if (origin.current !== source) { setError(t('prompts.sourceChanged')); return; }
    const identity = source; setBusy(true); setError(''); announce('', true);
    let saved: PromptDocument;
    try { saved = await native.savePrompt(context, { ...draft, tags: tagsOf(tagText) }); }
    catch (value) { if (mounted.current && latest.current === identity) setError(formatFailure(value, t('library.page.saveFailed'), t('library.page.saveFailedNext'))); if (mounted.current) setBusy(false); return; }
    if (!mounted.current || latest.current !== identity) { if (mounted.current) setBusy(false); return; }
    const next = fromDocument(saved);
    setDraft(next); setTagText(next.tags.join(',')); setSavedText(JSON.stringify(next));
    setLastSaved({ source: identity, document: saved, before: query.page });
    const success = t(context.targetId ? 'library.page.remoteSaved' : 'library.page.saved');
    announce(success); announce(success, true); onRetryCounts();
    try {
      await native.queryPrompts(context, searchQuery, { fresh: true });
      if (mounted.current && latest.current === identity) { setSavedReadError(''); setDraft(null); setSavedText(''); notifyPromptsChanged(); }
    } catch (value) {
      if (mounted.current && latest.current === identity) {
        const detail = typeof value === 'object' && value && 'message' in value ? String(value.message) : t('library.page.listFailed');
        const message = `${detail.replace(/[。.!\s]+$/, '')}${i18n.language === 'en' ? '. ' : '。'}${t('library.page.savedListNext')}`;
        setSavedReadError(message); setError(message); notifyPromptsChanged();
      }
    } finally { if (mounted.current) setBusy(false); }
  }
  async function copyDraft() {
    if (!draft) return;
    const identity = source;
    const copied = await writeClipboard(draft.body);
    if (!mounted.current || latest.current !== identity) return;
    if (copied) { setError(''); announce(t('library.page.copied'), true); }
    else { announce('', true); setError(t('library.page.copyFailed')); }
  }
  async function withBody(item: PromptSummary, action: 'copy' | 'launch') {
    const identity = source; const request = ++documentRead.current; setError(''); setCopiedId(null);
    try {
      const value = await native.getPrompt(context, item.id, item.version);
      if (!mounted.current || latest.current !== identity || documentRead.current !== request) return;
      if (action === 'copy') { const copied = await writeClipboard(value.body); if (latest.current === identity) { if (!copied) { announce(''); setError(t('library.page.copyFailed')); return; } setCopiedId(item.id); announce(t('library.page.copied')); } }
      else onLaunch({ id: value.id, kind: 'prompt', title: value.title, body: value.body, category: value.tags.join(','), projectId: value.legacyProjectId, version: value.version, updatedAt: value.updatedAt });
    } catch (value) { if (mounted.current && latest.current === identity && documentRead.current === request) showError(value); }
  }
  async function remove(item: PromptSummary) {
    const identity = source;
    if (busy || !await confirmAction(t('prompts.removeConfirm', { name: item.title }), () => mounted.current && latest.current === identity, { destructive: true, title: t('library.page.deleteTitle'), confirmLabel: t('library.page.deleteAction') })) return;
    if (latest.current !== identity) return;
    setBusy(true); setError('');
    try { await native.deletePrompt(context, item.id, item.version); if (mounted.current && latest.current === identity) { setSelected(previous => { const next = { ...previous }; delete next[item.id]; return next; }); notifyPromptsChanged(); } }
    catch (value) { if (mounted.current && latest.current === identity) showError(value); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function duplicate(item: PromptSummary) {
    const identity = source; if (busy) return; setBusy(true); setError('');
    try {
      const document = await native.getPrompt(context, item.id, item.version);
      if (!mounted.current || latest.current !== identity) return;
      let title = `${document.title}${t('tools.workspace.copySuffix')}`;
      let suffix = 2; while (query.page.items.some(item => item.title === title)) title = `${document.title}${t('tools.workspace.copySuffix')} ${suffix++}`;
      await native.savePrompt(context, { ...fromDocument(document), id: null, expectedVersion: null, title });
      if (mounted.current && latest.current === identity) { announce(t('library.resources.duplicated', { name: title })); notifyPromptsChanged(); }
    } catch (value) { if (mounted.current && latest.current === identity) showError(value); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function favorite(item: PromptSummary) {
    const identity = source;
    try { await native.recordPromptUsage(context, item.id, !item.favorite, false); if (latest.current === identity) notifyPromptsChanged(); }
    catch (value) { if (latest.current === identity) showError(value); }
  }
  function beginAssignment() {
    assignOrigin.current = source; setAssignScope('global'); setAssignTags(''); setChangeTags(false); setAssignment(null); setAssignResults({}); setAssignOpen(true); setError('');
  }
  async function assign() {
    if (busy || assignOrigin.current !== source) { if (assignOrigin.current !== source) setError(t('prompts.sourceChanged')); return; }
    const existing = assignment ?? { operationId: crypto.randomUUID(), items: Object.values(selected).map(item => ({ itemId: crypto.randomUUID(), action: 'reclassify' as const, draft: { id: item.id, title: item.title, body: '', tags: item.tags, scope: item.scope, expectedVersion: item.version } })) };
    const next: PromptBatch = { ...existing, items: existing.items.map(item => assignResults[item.itemId]?.status === 'saved' ? item : { ...item, draft: { ...item.draft, scope: parseScope(assignScope), tags: changeTags ? tagsOf(assignTags) : item.draft.tags } }) };
    setAssignment(next); const pending = next.items.filter(item => assignResults[item.itemId]?.status !== 'saved');
    if (!pending.length) return;
    const identity = source; setBusy(true); setError('');
    try { const result = await native.applyPromptBatch(context, { ...next, items: pending }); if (latest.current !== identity) return; setAssignResults(previous => ({ ...previous, ...Object.fromEntries(result.items.map(item => [item.itemId, item])) })); if (result.items.some(item => item.error)) setError(t('prompts.errorsRemain')); notifyPromptsChanged(); }
    catch (value) { if (latest.current === identity) showError(value); }
    finally { if (mounted.current) setBusy(false); }
  }
  function filters(change: () => void) { change(); setOffset(0); }
  const selectedCount = Object.keys(selected).length;
  const known = lastSaved?.source === source && (query.error || savedReadError) ? lastSaved.document : null;
  let rows = query.page.items;
  let hasKnownSaved = false;
  if (known) {
    const previous = rows.find(item => item.id === known.id);
    const needle = search.trim().toLowerCase();
    const matches = (scopeFilter === '*' || scopeValue(known.scope) === scopeFilter) && tagsOf(tagFilter).every(tag => known.tags.includes(tag)) && (!needle || `${known.title} ${known.body} ${known.tags.join(' ')}`.toLowerCase().includes(needle)) && (mode !== 'favorites' || previous?.favorite) && (mode !== 'recent' || !!previous?.lastUsed);
    rows = rows.filter(item => item.id !== known.id);
    if (matches) { hasKnownSaved = true; rows = [{ id: known.id, title: known.title, scope: known.scope, tags: known.tags, version: known.version, updatedAt: known.updatedAt, preview: known.body.slice(0, 160) + (known.body.length > 160 ? '…' : ''), favorite: previous?.favorite ?? false, lastUsed: previous?.lastUsed ?? 0 }, ...rows]; }
  }
  const stale = query.stale || hasKnownSaved;

  return <div className={styles.library} data-prompt-library>
    <div className={styles.toolbar}>
      <SearchField pageSearch label={t('library.page.searchLabel')} value={search} onChange={value => filters(() => setSearch(value))} placeholder={t('prompts.searchPlaceholder')} />
      <FilterSelect label={t('library.page.projectFilter')} value={scopeFilter} options={[{ value: '*', label: t('library.page.allProjects') }, ...options]} onChange={value => filters(() => setScopeFilter(value))} />
      <FilterSelect label={t('library.page.tagFilter')} value={tagFilter || '*'} options={[{ value: '*', label: t('library.page.allTags') }, ...tagOptions.map(value => ({ value, label: value }))]} onChange={value => filters(() => setTagFilter(value === '*' ? '' : value))} />
      <Button onClick={() => setImportOpen(true)} disabled={busy}>{t('prompts.import')}</Button><Button variant="ghost" onClick={refresh}>{t('prompts.refresh')}</Button>
    </div>
    <div className={styles.toolbar}><FilterSelect label={t('prompts.title')} value={mode} options={['all', 'favorites', 'recent'].map(value => ({ value, label: t(`prompts.${value}`) }))} onChange={value => filters(() => setMode(value))} /><label><input type="checkbox" aria-label={t('prompts.selectAll')} checked={query.page.items.length > 0 && query.page.items.every(item => !!selected[item.id])} onChange={event => setSelected(previous => { const next = { ...previous }; for (const item of query.page.items) { if (event.target.checked) next[item.id] = item; else delete next[item.id]; } return next; })} /> {t('prompts.selectAll')}</label><span>{t('prompts.selectedCount', { count: selectedCount })}</span><Button size="sm" disabled={!selectedCount || busy} onClick={beginAssignment}>{t('prompts.batchAssign')}</Button>{selectedCount > 0 && <Button size="sm" variant="ghost" onClick={() => setSelected({})}>{t('prompts.clearSelection')}</Button>}</div>
    <p className={styles.hint}>{t('prompts.bodySearchHint')}</p>
    {scopeError && <p className={styles.error} role="alert">{scopeError}</p>}
    {error && !draft && !assignOpen && <p className={styles.error} role="alert">{error}</p>}
    {stale && <div className={styles.error} role="alert"><p>{t('library.page.listStale', { kind: t('prompts.title') })}</p><span>{hasKnownSaved && savedReadError ? savedReadError.replace(t('library.page.savedListNext'), t('library.page.listRetryNext')) : query.error}</span><Button size="sm" onClick={refresh}>{t('prompts.retry')}</Button></div>}
    {notice && <p role="status">{notice}</p>}
    <div className={styles.resultBar}>
      {query.loaded && !query.error && <span>{t('library.page.countFiltered', { filtered: query.page.total, total: Math.max(query.page.total, all.page.total) })}</span>}
      {filtering && <Button variant="ghost" size="sm" onClick={clearFilters}>{t('library.page.clearFilters')}</Button>}
      {tagFilter ? <Button size="sm" variant="ghost" aria-label={t('library.page.activeTagChip', { tag: tagFilter })} onClick={() => filters(() => setTagFilter(''))}>{tagFilter} ×</Button> : tagOptions.map(tag => <Button key={tag} size="sm" variant="ghost" aria-label={t('library.page.filterByTag', { tag })} onClick={() => filters(() => setTagFilter(tag))}>{tag}</Button>)}
      <span className={styles.resultNote}>{t(context.targetId ? 'library.page.sourceRemote' : 'library.page.sourceLocal')}</span>
    </div>
    <div className={styles.libraryList} aria-label={t('library.page.listAria', { kind: t('prompts.title') })}>
      {query.loading && <p role="status">{t('prompts.loading')}</p>}
      {query.error && !stale ? <EmptyState icon="library" title={t('library.page.loadFailedTitle', { kind: t('prompts.title') })} detail={query.error} action={<Button onClick={refresh}>{t('prompts.retry')}</Button>} /> : rows.map(item => <article className={styles.row} key={item.id} data-library-id={item.id} data-source={item.scope.kind}>
        <div className={styles.cardHead}>
          <input type="checkbox" aria-label={`${t('prompts.select')} ${item.title}`} checked={!!selected[item.id]} onChange={event => setSelected(previous => { const next = { ...previous }; if (event.target.checked) next[item.id] = item; else delete next[item.id]; return next; })} />
          <button type="button" className={styles.rowButton} aria-label={item.title} onClick={() => void edit(item.id, item.version)}><strong data-card-title>{item.title}</strong></button>
          <div className={styles.actions}><Button size="sm" variant="ghost" aria-label={t(item.favorite ? 'prompts.unfavorite' : 'prompts.favorite')} aria-pressed={item.favorite} icon={<Icon name="star" size={13} />} onClick={() => void favorite(item)} /><Button size="sm" variant="ghost" aria-label={t('prompts.copy')} data-copied={copiedId === item.id || undefined} disabled={!item.preview} icon={copiedId === item.id ? <Icon name="check" size={13} /> : undefined} onClick={() => void withBody(item, 'copy')}>{t('prompts.copy')}</Button><Button size="sm" disabled={!item.preview} onClick={() => void withBody(item, 'launch')}>{t('prompts.launch')}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void edit(item.id, item.version)}>{t('tools.workspace.edit')}</Button><RowMenu label={t('tools.workspace.moreActions')}><button type="button" role="menuitem" disabled={busy} onClick={() => void duplicate(item)}>{t('library.resources.duplicate')}</button><button type="button" role="menuitem" data-danger="true" disabled={busy} onClick={() => void remove(item)}>{t('prompts.remove')}</button></RowMenu></div>
        </div>
        <p className={styles.summary} data-prompt-preview>{item.preview || t('library.page.emptyBody')}</p>
        <div className={styles.meta}>{scopeLabel(item.scope, workspaces, t)}{item.tags.map(tag => <span className={styles.tag} key={tag}>{tag}</span>)}</div>
      </article>)}
      {!query.loading && !query.error && !rows.length && (filtering ? <p className={styles.empty}>{t('library.page.noResults', { kind: t('prompts.title') })}</p> : <EmptyState icon="library" title={t('library.page.emptyTitle', { kind: t('prompts.title') })} detail={t('library.page.emptyPrompt')} action={<Button onClick={() => void create()}>{t('library.page.emptyCreate', { kind: t('prompts.title') })}</Button>} />)}
    </div>
    <div className={styles.pageNav}><Button size="sm" disabled={!offset || query.loading || !!query.error} onClick={() => setOffset(Math.max(0, offset - 40))}>{t('prompts.previous')}</Button><Button size="sm" disabled={query.page.nextOffset === null || query.loading || !!query.error} onClick={() => setOffset(query.page.nextOffset ?? 0)}>{t('prompts.next')}</Button></div>
    <GuideDialog open={!!draft} title={t(draft?.id ? 'prompts.edit' : 'prompts.new')} wide closeDisabled={busy} onClose={() => { void canDiscard().then(allowed => { if (allowed) { setDraft(null); setError(''); documentRead.current++; } }); }}>
      {draft && <div className={styles.form}>
        {error && <p className={styles.error} role="alert">{error}</p>}
        {editorNotice && <p role="status">{editorNotice}</p>}
        {origin.current !== source && <p role="alert">{t('prompts.sourceChanged')}</p>}
        <label>{t('prompts.name')}<input autoFocus value={draft.title} maxLength={160} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
        <div className={styles.scopeRow}><FilterSelect label={t('prompts.scope')} value={scopeValue(draft.scope)} options={options.some(item => item.value === scopeValue(draft.scope)) ? options : [...options, { value: scopeValue(draft.scope), label: scopeLabel(draft.scope, workspaces, t) }]} onChange={value => setDraft({ ...draft, scope: parseScope(value) })} /><label>{t('prompts.tags')}<input aria-label={t('library.page.addTagAria')} value={tagText} placeholder={t('prompts.tagHint')} onChange={event => setTagText(event.target.value)} /></label></div>
        {draft.scope.kind === 'unresolved' && <p className={styles.hint}>{t('prompts.oldScope')}</p>}
        <label>{t('prompts.body')}<textarea aria-label={t('library.page.bodyEditorLabel')} rows={12} value={draft.body} onChange={event => setDraft({ ...draft, body: event.target.value })} /></label>
        <div className={styles.actions}><span>{dirty ? t('prompts.unsaved') : t('prompts.saved')}</span><Button disabled={!draft.body} onClick={() => void copyDraft()}>{t('prompts.copy')}</Button>{draft.id && <Button disabled={busy} onClick={() => void edit(draft.id!, null)}>{t('prompts.retry')}</Button>}<Button variant="primary" data-dialog-save disabled={busy || !draft.title.trim() || draft.scope.kind === 'unresolved' || origin.current !== source} onClick={() => void saveDraft()}>{t('prompts.save')}</Button></div>
      </div>}
    </GuideDialog>
    {importOpen && <PromptImportDialog context={context} workspaces={workspaces} initialScope={scopeFilter === '*' ? { kind: 'global' } : parseScope(scopeFilter)} onClose={() => setImportOpen(false)} onDone={query.reload} />}
    <GuideDialog open={assignOpen} title={t('prompts.batchAssign')} hint={t('prompts.batchAssignHint')} closeDisabled={busy} onClose={() => { setAssignOpen(false); setError(''); }}>
      <div className={styles.form}>{error && <p className={styles.error} role="alert">{error}</p>}<FilterSelect label={t('prompts.scope')} value={assignScope} options={options} disabled={busy} onChange={setAssignScope} /><label><span><input type="checkbox" checked={changeTags} onChange={event => setChangeTags(event.target.checked)} /> {t('prompts.changeTags')}</span><input value={assignTags} disabled={!changeTags || busy} placeholder={t('prompts.tagHint')} onChange={event => setAssignTags(event.target.value)} /></label>
        <div className={styles.list}>{(assignment?.items ?? Object.values(selected).map(item => ({ itemId: item.id, draft: { title: item.title } }))).map(item => <div key={item.itemId} className={styles.row}><span>{item.draft.title}</span>{assignResults[item.itemId] && <span role="status">{t(`prompts.${assignResults[item.itemId].status}`)} {assignResults[item.itemId].error}</span>}</div>)}</div>
        <Button disabled={busy || !selectedCount || assignOrigin.current !== source || (!!assignment && assignment.items.every(item => assignResults[item.itemId]?.status === 'saved'))} onClick={() => void assign()}>{busy ? t('prompts.applying') : assignment ? t('prompts.batchRetry') : t('prompts.apply')}</Button>
      </div>
    </GuideDialog>
  </div>;
}
