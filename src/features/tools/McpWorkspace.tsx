import { useRemoteReads, RemoteReadStatus } from '../../lib/remoteReads';
import { CodeEditor } from '../../components/CodeEditor';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { confirmAction } from '../../lib/confirm';
import type { Scope } from '../../types/native';
import type { McpCommitResult, McpDefinition, McpDraft, McpDraftPreview, McpTargetRequest, NativeMcpEntry } from '../../types/resources';
import { GuideDialog } from '../../components/GuideDialog';
import { SearchField } from '../../components/SearchField';
import { saveShortcutHint, searchShortcutHint } from '../../lib/shortcut';
import { Icon } from '../../components/Icon';
import { StatusBanner } from '../../components/StatusBanner';
import { useFeedback } from '../../lib/toast';
import { blankMcpDraft, editableRowsOf, hasMcpIssues, isRemoteMcp, keptMcpArgs, mcpCwdOf, mcpDefaultName, mcpDraftIssues, mcpDraftOf, mcpParseIssueTexts, mcpSummary, mcpTransportBadge, recordOfRows, type KeyValueRow, type McpParsedServer } from '../../lib/mcp';
import { McpFormFields } from '../../components/mcp/McpFormFields';
import { McpDetails } from '../../components/mcp/McpDetails';
import { McpBatchImport, type McpBatchItem } from '../../components/mcp/McpBatchImport';
import { SkeletonRows } from '../../components/Skeleton';
import { EmptyState } from '../../components/EmptyState';
import i18n from '../../i18n';
import styles from './McpWorkspace.module.css';
import { Badge, Button, IconButton } from '../../components/ui';
import { RowMenu } from '../../components/RowMenu';
import { ToolIcon } from '../../components/ToolIcon';

type DocumentMode = 'read' | 'edit';

function errorText(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : i18n.t('common.operationFailed');
}
const SEARCH_THRESHOLD = 6;
const emptyRows = () => editableRowsOf({});

export function McpWorkspace({ toolId, toolName = '', scopeLabel = '', scope, projectPath, contextId, remoteTargetId = null, onDirtyChange, onOpenLibrary }: {
  toolId: string;
  /** Shown in the dialogs as the one place a save writes to. */
  toolName?: string;
  scopeLabel?: string;
  scope: Scope;
  projectPath: string;
  contextId?: string | null;
  remoteTargetId?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  onOpenLibrary?: (definitionId: string) => void;
}) {
  const { t } = useTranslation();
  const remoteReads = useRemoteReads(remoteTargetId, JSON.stringify([toolId, scope, projectPath]), true);
  const native = remoteReads.native;
  const id = useId();
  const [definitions, setDefinitions] = useState<McpDefinition[]>([]);
  const [nativeEntries, setNativeEntries] = useState<NativeMcpEntry[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [stale, setStale] = useState(false);
  const [draft, setDraft] = useState<McpDraft>(blankMcpDraft);
  const [envRows, setEnvRows] = useState<KeyValueRow[]>(emptyRows);
  const [headerRows, setHeaderRows] = useState<KeyValueRow[]>(emptyRows);
  const [savedFingerprint, setSavedFingerprint] = useState('');
  const [nativeOrigin, setNativeOrigin] = useState<NativeMcpEntry | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [syncLibrary, setSyncLibrary] = useState(false);
  const [composing, setComposing] = useState(false);
  const [pasteFirst, setPasteFirst] = useState(false);
  const [mode, setMode] = useState<DocumentMode>('read');
  const [showIssues, setShowIssues] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [preview, setPreview] = useState<McpDraftPreview | null>(null);
  const [allowReplace, setAllowReplace] = useState(false);
  const [commitResults, setCommitResults] = useState<McpCommitResult | null>(null);
  const [batchItems, setBatchItems] = useState<McpBatchItem[] | null>(null);
  const [importSource, setImportSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const project = scope === 'project' ? projectPath || null : null;
  const target = useMemo<McpTargetRequest>(() => ({ toolId, scope, projectPath: project, enabled, contextId }), [toolId, scope, project, enabled, contextId]);
  const readTarget = useMemo<McpTargetRequest>(() => ({ ...target, enabled: true }), [target]);
  const feedback = useFeedback();
  const mounted = useRef(true);
  const loadSequence = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; loadSequence.current++; }; }, []);

  const currentFingerprint = JSON.stringify([draft, envRows, headerRows, enabled, syncLibrary]);
  remoteReads.bindWriteDraft(composing || batchItems ? `mcp:${formKey}` : null);
  const dirty = composing && currentFingerprint !== savedFingerprint;
  useLayoutEffect(() => { onDirtyChange?.(dirty || !!batchItems); }, [dirty, batchItems, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
  useEffect(() => {
    if (composing || batchItems) return;
    if (error) { feedback.setError(error); setError(''); }
    if (notice) { feedback.setNotice(notice); setNotice(''); }
  }, [composing, batchItems, error, notice, feedback]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const refreshNative = useCallback(async (fresh = true) => {
    remoteReads.rebaseWriteAction();
    if (!toolId || (scope === 'project' && !project)) { setNativeEntries([]); setListLoading(false); return; }
    const request = ++loadSequence.current;
    setListLoading(true);
    try {
      const value = remoteTargetId
        ? ((await native.getRemoteResourceStore(remoteTargetId, toolId, 'mcp', { fresh }) as { entries?: NativeMcpEntry[] }).entries ?? [])
        : await native.listNativeMcp(readTarget);
      if (!mounted.current || request !== loadSequence.current) return;
      setNativeEntries(value); setLoadError(''); setStale(false);
    } catch (value) {
      if (!mounted.current || request !== loadSequence.current) return;
      setLoadError(errorText(value)); setStale(nativeEntries.length > 0);
    } finally {
      if (mounted.current && request === loadSequence.current) setListLoading(false);
    }
  }, [toolId, scope, project, readTarget, nativeEntries.length, remoteTargetId, native]);
  useEffect(() => { if (remoteReads.active) void refreshNative(false); }, [toolId, scope, project, contextId, remoteTargetId, refreshNative]);
  useEffect(() => {
    if (remoteTargetId) {
      void native.getRemoteResourceStore(remoteTargetId, toolId, 'mcp').then(value => {
        const store = value as { definitions?: McpDefinition[] };
        setDefinitions(store.definitions ?? []);
      }).catch(value => setError(errorText(value)));
      return;
    }
    void native.listMcpDefinitions().then(setDefinitions).catch(value => setError(errorText(value)));
  }, [remoteTargetId, toolId]);

  const libraryFor = (name: string) => definitions.find(item => item.name === name.trim() && item.inLibrary !== false);
  const linked = definitions.find(item => item.id === draft.id) ?? definitions.find(item => item.name === draft.name.trim());
  const linkedInLibrary = !!linked && linked.inLibrary !== false;
  const needle = search.trim().toLowerCase();
  const shown = needle ? nativeEntries.filter(item => (item.name + ' ' + mcpSummary(item)).toLowerCase().includes(needle)) : nativeEntries;

  function resetForm(next: McpDraft, nextEnv: KeyValueRow[], nextHeaders: KeyValueRow[], nextEnabled: boolean, nextSync = false) {
    setDraft(next); setEnvRows(nextEnv); setHeaderRows(nextHeaders); setEnabled(nextEnabled); setSyncLibrary(nextSync);
    setSavedFingerprint(JSON.stringify([next, nextEnv, nextHeaders, nextEnabled, nextSync]));
    setShowIssues(false); setPreview(null); setAllowReplace(false); setCommitResults(null); setImportSource(''); setFormKey(value => value + 1);
  }
  async function canReplace() {
    const started = currentFingerprint;
    const pending = dirty || !!batchItems || !!preview;
    return !pending || confirmAction(t('tools.mcp.confirmDiscard'), () => mounted.current && currentFingerprint === started, { title: t('common.app.leaveDirtyTitle'), confirmLabel: t('common.app.leaveDirtyConfirm') });
  }
  async function startNew(paste = false) {
    if (!await canReplace()) return;
    setPasteFirst(paste);
    setNativeOrigin(null); setMode('edit'); resetForm(blankMcpDraft(), emptyRows(), emptyRows(), true);
    setComposing(true); setError(''); setNotice('');
  }
  function editNative(item: NativeMcpEntry, edit = false) {
    if (busy) return;
    const found = definitions.find(definition => definition.name === item.name);
    const next: McpDraft = { id: found?.id ?? null, name: item.name, transport: item.transport, command: item.command, args: item.args, cwd: item.cwd ?? '', url: item.url,
      env: item.env, headers: item.headers, inLibrary: found?.inLibrary === true, expectedVersion: found?.version ?? null };
    setPasteFirst(false);
    setNativeOrigin(item); setMode(edit ? 'edit' : 'read'); resetForm(next, editableRowsOf(item.env), editableRowsOf(item.headers), item.enabled);
    setComposing(true); setError(''); setNotice('');
  }
  async function openEntry(item: NativeMcpEntry, edit = false) {
    if (busy) return;
    if (composing && nativeOrigin?.name === item.name) { if (edit) setMode('edit'); return; }
    if (!await canReplace()) return;
    editNative(item, edit);
  }
  /** Leaves editing for the details of the same entry, asking first when the form changed. */
  async function backToDetails() {
    if (!nativeOrigin || !await canReplace()) return;
    editNative(nativeOrigin);
  }
  async function closeCompose() {
    if (!await canReplace()) return;
    setBatchItems(null); setImportSource('');
    setComposing(false); setPreview(null); setCommitResults(null); setError('');
  }
  function normalizedDraft() {
    return { ...draft, name: draft.name.trim(), args: keptMcpArgs(draft.args), cwd: mcpCwdOf(draft), id: linked?.id ?? draft.id,
      expectedVersion: linked?.version ?? draft.expectedVersion, inLibrary: linkedInLibrary || syncLibrary,
      env: recordOfRows(envRows), headers: recordOfRows(headerRows) };
  }
  async function save() {
    if (scope === 'project' && !project) { setError(t('tools.mcp.pickProject')); return; }
    if (hasMcpIssues(mcpDraftIssues(draft))) { setShowIssues(true); return; }
    setBusy(true); setError('');
    try {
      const next = normalizedDraft();
      if (remoteTargetId) {
        const current = await native.getRemoteResourceStore(remoteTargetId, toolId, 'mcp', { fresh: true }) as { entries?: NativeMcpEntry[]; definitions?: McpDefinition[] };
        const entry: NativeMcpEntry = { name: next.name, transport: next.transport, command: next.command, args: next.args, cwd: next.cwd, url: next.url, env: next.env, headers: next.headers, inLibrary: next.inLibrary, enabled, protectedValues: false };
        const entries = [...(current.entries ?? []).filter(item => item.name !== entry.name), entry];
        const definition: McpDefinition = { id: next.id ?? crypto.randomUUID(), name: next.name, transport: next.transport, command: next.command, args: next.args, cwd: next.cwd, url: next.url, env: next.env, headers: next.headers, inLibrary: next.inLibrary, version: (current.definitions ?? []).find(item => item.id === next.id)?.version ?? 1 };
        await native.saveRemoteResourceStore(remoteTargetId, toolId, 'mcp', { entries, definitions: [...(current.definitions ?? []).filter(item => item.id !== definition.id), definition] });
        await refreshNative(); setDefinitions(value => [...value.filter(item => item.id !== definition.id), definition]); setComposing(false); setMode('read'); setNotice(t('tools.mcp.written')); return;
      }
      setPreview(await native.previewMcpDraft(next, [{ ...target, enabled }])); setAllowReplace(false); setCommitResults(null);
    }
    catch (value) { setError(errorText(value)); }
    finally { if (mounted.current) setBusy(false); }
  }
  function commitTargets(value: McpDraftPreview, replace: boolean) {
    return value.targets.filter(item => item.status === 'ready' || replace && item.status === 'conflict').map(item => ({
      toolId: item.toolId, scope: item.scope, projectPath: item.projectPath, contextId: item.contextId ?? contextId,
      enabled, baselineHash: item.baselineHash, previewToken: item.previewToken, allowReplace: replace && item.status === 'conflict',
    }));
  }
  async function commit() {
    if (!preview) return;
    const targets = commitTargets(preview, allowReplace);
    if (!targets.length) { setError(t('tools.mcp.batchResolve')); return; }
    setBusy(true); setError('');
    try {
      const result = await native.commitMcpDraft(preview.draft, targets);
      if (!mounted.current) return;
      setCommitResults(result);
      setDefinitions(current => [...current.filter(item => item.id !== result.definition.id), result.definition]);
      const written = result.targets.length > 0 && result.targets.every(item => item.status === 'written');
      await refreshNative();
      if (written) {
        setComposing(false); setPreview(null);
        setNotice(t('tools.mcp.written'));
      } else {
        setPreview(null); setDraft(mcpDraftOf(result.definition)); setSavedFingerprint(JSON.stringify([mcpDraftOf(result.definition), envRows, headerRows, enabled, syncLibrary]));
        setError(t('tools.mcp.partialFailed'));
      }
    } catch (value) { if (mounted.current) setError(errorText(value)); }
    finally { if (mounted.current) setBusy(false); }
  }
  // Links a reviewed draft to the library definition that carries its (possibly edited) name.
  function linkDraft(value: McpDraft): McpDraft {
    const found = definitions.find(item => item.name === value.name.trim());
    return { ...value, id: found?.id ?? null, expectedVersion: found?.version ?? null, inLibrary: found?.inLibrary === true || syncLibrary };
  }
  function importJson(parsed: McpParsedServer[], source: string) {
    // Explicit names are claimed first, so a generated default never takes a name a later entry carries.
    const explicit = parsed.map(server => server.name.trim() || (parsed.length === 1 ? draft.name.trim() : ''));
    const taken = new Set([...definitions.map(item => item.name), ...nativeEntries.map(item => item.name), ...explicit.filter(Boolean)]);
    const items = parsed.map((server, index): McpBatchItem => {
      let name = explicit[index];
      const generatedName = !name;
      if (generatedName) { name = mcpDefaultName(taken); taken.add(name); }
      const blocked = mcpParseIssueTexts(t, server).join(' ');
      return { key: index + ':' + name, blocked: blocked || undefined, generatedName,
        draft: linkDraft({ ...blankMcpDraft(), name, transport: server.transport, command: server.command, args: server.args, cwd: server.cwd, url: server.url,
          env: server.env, headers: server.headers }) };
    });
    setBatchItems(items); setImportSource(source); setError('');
    return true;
  }
  async function removeNative(item: NativeMcpEntry) {
    remoteReads.beginWriteAction();
    const found = definitions.find(definition => definition.name === item.name);
    const inLibrary = found?.inLibrary === true;
    const message = inLibrary ? t('tools.mcp.confirmRemoveLibrary', { name: item.name }) : t('tools.mcp.confirmRemove', { name: item.name });
    if (!await confirmAction(message, () => mounted.current, { title: t('tools.mcp.removeTitle'), confirmLabel: t('tools.agents.delete'), destructive: true })) return;
    setBusy(true); setError('');
    try {
      if (remoteTargetId) {
        const current = await native.getRemoteResourceStore(remoteTargetId, toolId, 'mcp', { fresh: true }) as { entries?: NativeMcpEntry[]; definitions?: McpDefinition[] };
        await native.saveRemoteResourceStore(remoteTargetId, toolId, 'mcp', { entries: (current.entries ?? []).filter(entry => entry.name !== item.name), definitions: (current.definitions ?? []).filter(entry => entry.name !== item.name) });
      } else {
        await native.removeNativeMcp({ ...readTarget, enabled: item.enabled }, item.name);
      }
      if (!remoteTargetId && !inLibrary && found) await native.deleteMcpDefinition(found.id, found.version);
      if (!remoteTargetId) setDefinitions(await native.listMcpDefinitions());
      await refreshNative(); setComposing(false); setMode('read'); setNotice(t('tools.mcp.deleted'));
    } catch (value) { setError(errorText(value)); }
    finally { if (mounted.current) setBusy(false); }
  }

  const canAdd = !(busy || (scope === 'project' && !project));
  const editing = mode === 'edit' || !nativeOrigin;
  const dialogTitle = !nativeOrigin ? t('tools.mcp.newTitle') : editing ? t('tools.mcp.editTitle') : nativeOrigin.name;
  const openedLibrary = nativeOrigin ? libraryFor(nativeOrigin.name) : undefined;
  const conflicted = !!preview && preview.targets.some(item => item.status === 'conflict');
  const committable = !!preview && preview.targets.some(item => item.status === 'ready' || item.status === 'conflict');
  const where = [toolName, scopeLabel].filter(Boolean).join(' · ');
  const remoteOrigin = !!nativeOrigin && isRemoteMcp(nativeOrigin.transport);

  let listBody: ReactNode;
  if (listLoading && !nativeEntries.length) listBody = <div role="status" aria-label={t('tools.mcp.loading')}><SkeletonRows count={3} /></div>;
  else if (loadError && !nativeEntries.length) listBody = <div className={styles.empty}><StatusBanner tone="error">{loadError}</StatusBanner><p>{t('tools.mcp.blocked')}</p><Button icon={<Icon name="refresh" size={14} />} onClick={() => void refreshNative()}>{t('tools.plugins.rescan')}</Button></div>;
  else if (!nativeEntries.length) listBody = <EmptyState icon="connections" title={t('tools.mcp.emptyTitle')} detail={[t('tools.mcp.emptyDetail'), scope === 'project' && !project ? t('tools.mcp.pickProjectFirst') : ''].filter(Boolean).join(' ')} action={<div className={styles.emptyActions}><Button variant="primary" disabled={!canAdd} icon={<Icon name="plus" size={14} />} onClick={() => void startNew()}>{t('tools.mcp.add')}</Button><Button disabled={!canAdd} icon={<Icon name="clipboard" size={14} />} onClick={() => void startNew(true)}>{t('library.resources.pasteCreate')}</Button></div>} />;
  else if (!shown.length) listBody = <div className={styles.noMatch}><Icon name="search" size={18} /><p>{t('tools.mcp.noMatch', { query: search.trim() })}</p><Button size="sm" onClick={() => setSearch('')}>{t('tools.mcp.clearSearch')}</Button></div>;
  else listBody = <ul className={styles.list} aria-label={t('tools.mcp.title')}>{shown.map(item => {
    const summary = mcpSummary(item);
    const inLibrary = libraryFor(item.name);
    const remote = isRemoteMcp(item.transport);
    return <li key={item.name} className={styles.row} data-mcp-name={item.name} data-disabled={!item.enabled || undefined} data-open={composing && nativeOrigin?.name === item.name || undefined}>
      {/* The row opens the details; a double-click goes straight to editing. */}
      <button type="button" className={styles.rowOpen} aria-label={t('tools.mcp.rowOpen', { name: item.name })} title={t('tools.mcp.doubleClickHint')} disabled={busy} onClick={() => void openEntry(item)} onDoubleClick={() => void openEntry(item, true)}>
        <span className={styles.glyph} data-transport={item.transport} aria-hidden="true"><Icon name={remote ? 'globe' : 'terminal'} size={18} /></span>
        <span className={styles.main}>
          <strong>{item.name}</strong>
          <Badge className={styles.transport} tone={remote ? 'info' : 'neutral'}>{mcpTransportBadge(item.transport)}</Badge>
          {inLibrary && <Badge tone="info">{t('tools.mcp.inLibrary')}</Badge>}
          {item.protectedValues && <span className={styles.lock} title={t('tools.mcp.detailProtected')}><Icon name="lock" size={12} /></span>}
        </span>
        <code className={styles.command} title={summary}>{summary || t(remote ? 'library.resources.noUrl' : 'library.resources.noCommand')}</code>
      </button>
      <span className={styles.state} data-on={item.enabled || undefined}>{item.enabled ? t('tools.plugins.enabled') : t('tools.quota.disabled')}</span>
      <div className={styles.rowActions} role="group" aria-label={t('library.page.itemActions', { title: item.name })}>
        <Button variant="ghost" size="sm" disabled={busy} aria-label={t('tools.mcp.rowEdit', { name: item.name })} icon={<Icon name="pencil" size={14} />} onClick={() => void openEntry(item, true)}>{t('tools.mcp.edit')}</Button>
        <RowMenu label={t('library.resources.rowMenu', { name: item.name })}>
          {inLibrary && onOpenLibrary && <button type="button" role="menuitem" onClick={() => onOpenLibrary(inLibrary.id)}><Icon name="library" size={14} /><span>{t('tools.mcp.openLibrary')}</span></button>}
          <button type="button" role="menuitem" data-danger="true" disabled={busy} onClick={() => void removeNative(item)}><Icon name="trash" size={14} /><span>{t('tools.mcp.removeFromTool')}</span></button>
        </RowMenu>
      </div>
    </li>;
  })}</ul>;

  return <>
    <section className={styles.layout} aria-label={t('tools.mcp.title')}>
      <header className={styles.head} role="group" aria-label={t('tools.mcp.toolbar')}>
        <div className={styles.headTitle}>
          <span className={styles.heading}>{t('tools.mcp.title')}</span>
          {nativeEntries.length > 0 && <span className={styles.count}>{needle ? t('tools.mcp.countFiltered', { filtered: shown.length, total: nativeEntries.length }) : t('tools.mcp.activeCount', { count: nativeEntries.length })}</span>}
        </div>
        <div className={styles.headActions}>
          <IconButton size="sm" aria-label={t('tools.plugins.rescan')} title={t('tools.plugins.rescan')} disabled={listLoading || busy} data-spinning={listLoading || undefined} onClick={() => void refreshNative()} icon={<Icon name="refresh" size={15} />} />
          <Button variant="primary" size="sm" disabled={!canAdd} icon={<Icon name="plus" size={14} />} onClick={() => void startNew()}>{t('tools.mcp.add')}</Button>
        </div>
      </header>
      <p className={styles.hint}>{t('tools.mcp.description')}</p>
      {(nativeEntries.length >= SEARCH_THRESHOLD || !!needle) && <SearchField type="search" className={styles.search} pageSearch title={searchShortcutHint()} label={t('tools.mcp.searchLabel')} placeholder={t('tools.mcp.searchPlaceholder')} value={search} onChange={setSearch} />}
      <RemoteReadStatus state={remoteReads} />
      {stale && <StatusBanner tone="warning">{t('tools.mcp.stale')}</StatusBanner>}
      {loadError && nativeEntries.length > 0 && <div className={styles.retry}><StatusBanner tone="error">{loadError}</StatusBanner><Button size="sm" onClick={() => void refreshNative()}>{t('tools.plugins.rescan')}</Button></div>}
      {listBody}
    </section>

    {/* One dialog reads, adds and edits; switching from reading to editing keeps the place. */}
    <GuideDialog wide open={composing && !batchItems} title={dialogTitle} hint={editing ? t('tools.mcp.dialogHint') : undefined} onClose={() => void closeCompose()}>
      {composing && (editing ? <>
        <div className={styles.editor}>
          <div className={styles.editorForm}>
            {linkedInLibrary && <p className={styles.linkedNote}><Icon name="info" size={14} />{t('tools.mcp.linkedNote', { name: linked?.name ?? draft.name })}</p>}
            <fieldset className={styles.formFields} disabled={busy || !!preview}>
              <McpFormFields key={formKey} title={t('library.resources.connectionTitle')} draft={draft} onChange={setDraft} envRows={envRows} onEnvRowsChange={setEnvRows} headerRows={headerRows} onHeaderRowsChange={setHeaderRows} showIssues={showIssues} onImport={importJson} initialPasteOpen={pasteFirst} initialPasteText={importSource} />
            </fieldset>
          </div>
          <aside className={styles.side} aria-label={t('tools.mcp.targetTitle')}>
            <div className={styles.target}>
              <span className={styles.sideLabel}>{t('tools.mcp.targetTitle')}</span>
              <span className={styles.targetPlace}><ToolIcon toolId={toolId} size={22} /><span><strong>{toolName || toolId}</strong>{scopeLabel && <small title={project ?? undefined}>{scopeLabel}</small>}</span></span>
              <small className={styles.sideNote}>{t(remoteTargetId ? 'tools.mcp.targetRemoteHint' : 'tools.mcp.targetHint')}</small>
            </div>
            <label className={styles.option}>
              <input type="checkbox" checked={enabled} disabled={busy || !!preview} aria-labelledby={id + '-enabled-label'} aria-describedby={id + '-enabled'} onChange={event => setEnabled(event.target.checked)} />
              <span><strong id={id + '-enabled-label'}>{t('tools.mcp.enabledLabel')}</strong><small id={id + '-enabled'}>{t('tools.mcp.enabledHint')}</small></span>
            </label>
            {!linkedInLibrary && <label className={styles.option}>
              <input type="checkbox" checked={syncLibrary} disabled={busy || !!preview} aria-labelledby={id + '-library-label'} aria-describedby={id + '-library'} onChange={event => setSyncLibrary(event.target.checked)} />
              <span><strong id={id + '-library-label'}>{t('tools.mcp.alsoLibrary')}</strong><small id={id + '-library'}>{t('tools.mcp.alsoLibraryHint')}</small></span>
            </label>}
          </aside>
          {(preview || commitResults) && <div className={styles.review}>
            {preview && <div className={styles.preview} role="group" aria-label={t('tools.mcp.previewLabel')} data-conflict={conflicted || undefined}>
              <strong><Icon name={conflicted ? 'alert' : 'check'} size={14} />{conflicted ? t('tools.mcp.conflictTitle') : t('tools.mcp.previewTitle')}</strong>
              {preview.targets.map((item, index) => <div key={index} className={styles.previewTarget} data-status={item.status}><p>{item.detail}</p>{item.status === 'conflict' && <div className={styles.diff}><CodeEditor compact label={t('tools.mcp.conflictCurrent')} format="json" readOnly value={JSON.stringify(item.existing, null, 2)} /><CodeEditor compact label={t('tools.mcp.conflictNext')} format="json" readOnly value={JSON.stringify(item.proposed, null, 2)} /></div>}</div>)}
              {conflicted && <label className={styles.replace}><input type="checkbox" checked={allowReplace} disabled={busy} onChange={event => setAllowReplace(event.target.checked)} />{t('tools.mcp.batchReplace')}</label>}
            </div>}
            {commitResults && <div className={styles.results}>{commitResults.targets.map((item, index) => <p key={index} data-status={item.status}>{item.status}: {item.detail}</p>)}</div>}
          </div>}
        </div>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className="dialog-footer">
          {nativeOrigin && <Button variant="ghost" className={styles.danger} disabled={busy} icon={<Icon name="trash" size={14} />} onClick={() => void removeNative(nativeOrigin)}>{t('tools.mcp.removeFromTool')}</Button>}
          <span className="dialog-footer-gap" />
          {dirty && !preview && <span className={styles.dirty}>{t('library.page.dirtyState')}</span>}
          {preview ? <Button disabled={busy} onClick={() => { setPreview(null); setAllowReplace(false); }}>{t('library.resources.back')}</Button>
            : nativeOrigin ? <Button disabled={busy} onClick={() => void backToDetails()}>{t('tools.mcp.cancelEdit')}</Button> : <Button disabled={busy} onClick={() => void closeCompose()}>{t('common.dialog.cancel')}</Button>}
          {preview ? <Button variant="primary" data-dialog-save disabled={busy || conflicted && !allowReplace || !committable} onClick={() => void commit()}>{t('tools.mcp.confirmWrite')}</Button>
            : <Button variant="primary" data-dialog-save title={saveShortcutHint()} disabled={busy || !draft.name.trim() || scope === 'project' && !project} onClick={() => void save()}>{nativeOrigin || draft.id ? t('home.launcher.save') : t('tools.mcp.addSubmit')}</Button>}
        </div>
      </> : nativeOrigin && <>
        <div className={styles.detailBadges}>
          <Badge tone={remoteOrigin ? 'info' : 'neutral'}>{mcpTransportBadge(nativeOrigin.transport)}</Badge>
          <Badge tone={enabled ? 'success' : 'neutral'} dot>{enabled ? t('tools.plugins.enabled') : t('tools.quota.disabled')}</Badge>
          {openedLibrary && <Badge tone="info">{t('tools.mcp.inLibrary')}</Badge>}
          {where && <span className={styles.detailWhere}><ToolIcon toolId={toolId} size={16} />{where}</span>}
        </div>
        <section className={styles.details} aria-label={t('tools.mcp.detailsLabel')}>
          <McpDetails key={nativeOrigin.name} statusInHeader item={{ ...nativeOrigin, enabled }} />
        </section>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className="dialog-footer">
          <Button variant="ghost" className={styles.danger} disabled={busy} icon={<Icon name="trash" size={14} />} onClick={() => void removeNative(nativeOrigin)}>{t('tools.mcp.removeFromTool')}</Button>
          <span className="dialog-footer-gap" />
          {openedLibrary && onOpenLibrary && <Button icon={<Icon name="library" size={14} />} onClick={() => { setComposing(false); onOpenLibrary(openedLibrary.id); }}>{t('tools.mcp.openLibrary')}</Button>}
          <Button variant="primary" disabled={busy} icon={<Icon name="pencil" size={14} />} onClick={() => setMode('edit')}>{t('tools.mcp.edit')}</Button>
        </div>
      </>)}
    </GuideDialog>
    <GuideDialog wide open={!!batchItems} title={t('tools.mcp.batchTitle')} hint={t('tools.mcp.batchHint')} onClose={() => void closeCompose()}>
      {batchItems && <McpBatchImport items={batchItems} onCancel={() => setBatchItems(null)} onPreview={value => native.previewMcpDraft(linkDraft(value), [{ ...target, enabled }])}
        onCommit={(value, candidate, replace) => native.commitMcpDraft(value, candidate.targets.filter(item => item.status === 'ready' || replace && item.status === 'conflict').map(item => ({ toolId: item.toolId, scope: item.scope, projectPath: item.projectPath, contextId: item.contextId ?? contextId, enabled, baselineHash: item.baselineHash, previewToken: item.previewToken, allowReplace: replace && item.status === 'conflict' })))}
        onDefinitionSaved={result => { setDefinitions(current => [...current.filter(item => item.id !== result.definition.id), result.definition]); void refreshNative(); }}
        onComplete={() => setImportSource('')} />}
    </GuideDialog>
  </>;
}
