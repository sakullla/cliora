import { CodeEditor } from '../../components/CodeEditor';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import type { Scope } from '../../types/native';
import type { McpCommitResult, McpDefinition, McpDraft, McpDraftPreview, McpTargetRequest, NativeMcpEntry } from '../../types/resources';
import { GuideDialog } from '../../components/GuideDialog';
import { SearchField } from '../../components/SearchField';
import { modLabel, saveShortcutHint, withMod } from '../../lib/shortcut';
import { Icon } from '../../components/Icon';
import { StatusBanner } from '../../components/StatusBanner';
import { useFeedback } from '../../lib/toast';
import { blankMcpDraft, editableRowsOf, hasMcpIssues, keptMcpArgs, mcpDraftIssues, mcpDraftOf, mcpSummary, recordOfRows, type KeyValueRow, type McpParsedServer } from '../../lib/mcp';
import { McpFormFields } from '../../components/mcp/McpFormFields';
import { McpDetails } from '../../components/mcp/McpDetails';
import { McpBatchImport, type McpBatchItem } from '../../components/mcp/McpBatchImport';
import { DocumentFoot, DocumentHeader, DocumentWorkspace, ModeSwitch, documentStyles as doc, type DocumentMode } from './DocumentWorkspace';
import { SkeletonRows } from '../../components/Skeleton';
import i18n from '../../i18n';
import styles from './McpWorkspace.module.css';

function errorText(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : i18n.t('common.operationFailed');
}
const SEARCH_THRESHOLD = 6;
const emptyRows = () => editableRowsOf({});

export function McpWorkspace({ toolId, scope, projectPath, contextId, remoteTargetId = null, onDirtyChange, onOpenLibrary }: {
  toolId: string;
  scope: Scope;
  projectPath: string;
  contextId?: string | null;
  remoteTargetId?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  onOpenLibrary?: (definitionId: string) => void;
}) {
  const { t } = useTranslation();
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

  const refreshNative = useCallback(async () => {
    if (!toolId || (scope === 'project' && !project)) { setNativeEntries([]); setListLoading(false); return; }
    const request = ++loadSequence.current;
    setListLoading(true);
    try {
      const value = remoteTargetId
        ? ((await native.getRemoteResourceStore(remoteTargetId, toolId, 'mcp') as { entries?: NativeMcpEntry[] }).entries ?? [])
        : await native.listNativeMcp(readTarget);
      if (!mounted.current || request !== loadSequence.current) return;
      setNativeEntries(value); setLoadError(''); setStale(false);
    } catch (value) {
      if (!mounted.current || request !== loadSequence.current) return;
      setLoadError(errorText(value)); setStale(nativeEntries.length > 0);
    } finally {
      if (mounted.current && request === loadSequence.current) setListLoading(false);
    }
  }, [toolId, scope, project, readTarget, nativeEntries.length, remoteTargetId]);
  useEffect(() => { void refreshNative(); }, [toolId, scope, project, contextId, remoteTargetId, refreshNative]);
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
  async function startNew() {
    if (!await canReplace()) return;
    setNativeOrigin(null); setMode('edit'); resetForm(blankMcpDraft(), emptyRows(), emptyRows(), true);
    setComposing(true); setError(''); setNotice('');
  }
  function editNative(item: NativeMcpEntry) {
    if (busy) return;
    const found = definitions.find(definition => definition.name === item.name);
    const next: McpDraft = { id: found?.id ?? null, name: item.name, transport: item.transport, command: item.command, args: item.args, url: item.url,
      env: item.env, headers: item.headers, inLibrary: found?.inLibrary === true, expectedVersion: found?.version ?? null };
    setNativeOrigin(item); setMode('read'); resetForm(next, editableRowsOf(item.env), editableRowsOf(item.headers), item.enabled);
    setComposing(true); setError(''); setNotice('');
  }
  async function openEntry(item: NativeMcpEntry) {
    if (busy || composing && nativeOrigin?.name === item.name) return;
    if (!await canReplace()) return;
    editNative(item);
  }
  async function closeCompose() {
    if (!await canReplace()) return;
    setBatchItems(null); setImportSource('');
    setComposing(false); setPreview(null); setCommitResults(null); setError('');
  }
  function normalizedDraft() {
    return { ...draft, name: draft.name.trim(), args: keptMcpArgs(draft.args), id: linked?.id ?? draft.id,
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
        const current = await native.getRemoteResourceStore(remoteTargetId, toolId, 'mcp') as { entries?: NativeMcpEntry[]; definitions?: McpDefinition[] };
        const entry: NativeMcpEntry = { name: next.name, transport: next.transport, command: next.command, args: next.args, url: next.url, env: next.env, headers: next.headers, inLibrary: next.inLibrary, enabled, protectedValues: false };
        const entries = [...(current.entries ?? []).filter(item => item.name !== entry.name), entry];
        const definition: McpDefinition = { id: next.id ?? crypto.randomUUID(), name: next.name, transport: next.transport, command: next.command, args: next.args, url: next.url, env: next.env, headers: next.headers, inLibrary: next.inLibrary, version: (current.definitions ?? []).find(item => item.id === next.id)?.version ?? 1 };
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
  function importJson(parsed: McpParsedServer[], source: string) {
    const seen = new Set<string>();
    const items = parsed.map((server, index): McpBatchItem => {
      const name = server.name.trim() || (parsed.length === 1 ? draft.name.trim() : '');
      const found = definitions.find(item => item.name === name);
      const duplicate = !!name && seen.has(name); seen.add(name);
      const blocked = [duplicate ? t('tools.mcp.batchDuplicate', { name }) : '', ...server.invalid.map(issue => t('tools.mcp.parseIssue.' + issue))].filter(Boolean).join(' ');
      return { key: index + ':' + name, blocked: blocked || undefined,
        draft: { id: found?.id ?? null, name, transport: server.transport, command: server.command, args: server.args, url: server.url,
          env: server.env, headers: server.headers, inLibrary: found?.inLibrary === true || syncLibrary, expectedVersion: found?.version ?? null } };
    });
    setBatchItems(items); setImportSource(source); setError('');
    return true;
  }
  async function removeNative(item: NativeMcpEntry) {
    const found = definitions.find(definition => definition.name === item.name);
    const inLibrary = found?.inLibrary === true;
    const message = inLibrary ? t('tools.mcp.confirmRemoveLibrary', { name: item.name }) : t('tools.mcp.confirmRemove', { name: item.name });
    if (!await confirmAction(message, () => mounted.current, { title: t('tools.mcp.removeTitle'), confirmLabel: t('tools.agents.delete'), destructive: true })) return;
    setBusy(true); setError('');
    try {
      if (remoteTargetId) {
        const current = await native.getRemoteResourceStore(remoteTargetId, toolId, 'mcp') as { entries?: NativeMcpEntry[]; definitions?: McpDefinition[] };
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

  function onKey(event: KeyboardEvent<HTMLElement>) {
    if (batchItems || !composing || mode !== 'edit' || !withMod(event) || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    if (event.repeat || busy) return;
    if (preview) void commit();
    else void save();
  }
  const canAdd = !(busy || (scope === 'project' && !project));
  const editing = mode === 'edit' || !nativeOrigin;
  const articleLabel = !nativeOrigin ? t('tools.mcp.newTitle') : editing ? t('tools.mcp.editTitle') : t('tools.mcp.detailsLabel');
  const openedLibrary = nativeOrigin ? libraryFor(nativeOrigin.name) : undefined;
  let listBody: ReactNode;
  if (listLoading && !nativeEntries.length) listBody = <div className={styles.listWrap} role="status" aria-label={t('tools.mcp.loading')}><SkeletonRows count={3} /></div>;
  else listBody = <div className={styles.listWrap}>
    {loadError && !nativeEntries.length && <div className={styles.empty}><StatusBanner tone="error">{loadError}</StatusBanner><p>{t('tools.mcp.blocked')}</p><button type="button" onClick={() => void refreshNative()}><Icon name="refresh" size={14} />{t('tools.plugins.rescan')}</button></div>}
    {!loadError && !nativeEntries.length && <div className={styles.empty}><span className={styles.emptyIcon}><Icon name="connections" size={24} /></span><strong>{t('tools.mcp.emptyTitle')}</strong><p>{t('tools.mcp.emptyDetail')}</p>{scope === 'project' && !project && <p>{t('tools.mcp.pickProjectFirst')}</p>}<button type="button" className={styles.primary} disabled={!canAdd} onClick={() => void startNew()}><Icon name="plus" size={14} />{t('tools.mcp.add')}</button></div>}
    {nativeEntries.length > 0 && shown.length === 0 && <div className={doc.noMatch}><Icon name="search" size={18} /><p>{t('tools.mcp.noMatch', { query: search.trim() })}</p><button type="button" onClick={() => setSearch('')}>{t('tools.mcp.clearSearch')}</button></div>}
    {shown.length > 0 && <ul className={doc.rows} aria-label={t('tools.mcp.title')}>{shown.map(item => {
      const summary = mcpSummary(item);
      return <li key={item.name}><button type="button" className={doc.row} aria-current={composing && nativeOrigin?.name === item.name ? 'true' : undefined} data-disabled={!item.enabled || undefined} disabled={busy} onClick={() => void openEntry(item)}>
        <span className={doc.rowTitle}><strong>{item.name}</strong></span>
        <span className={doc.rowSummary}>{summary || (item.transport === 'http' ? 'HTTP' : 'stdio')}</span>
        <span className={doc.rowMeta}>
          <span className={doc.chip} data-tone={item.enabled ? 'on' : 'muted'}>{item.enabled ? t('tools.plugins.enabled') : t('tools.quota.disabled')}</span>
          <span className={doc.chip}>{item.transport === 'http' ? 'HTTP' : 'stdio'}</span>
          {libraryFor(item.name) && <span className={doc.chip} data-tone="info">{t('tools.mcp.inLibrary')}</span>}
        </span>
      </button></li>;
    })}</ul>}
  </div>;

  return <>
    <DocumentWorkspace label={t('tools.mcp.title')} toolbarLabel={t('tools.mcp.toolbar')} backLabel={t('common.dialog.back')} onBack={() => { void closeCompose(); }} onKeyDown={onKey}
      heading={t('tools.mcp.title')}
      count={nativeEntries.length ? (needle ? t('tools.mcp.countFiltered', { filtered: shown.length, total: nativeEntries.length }) : t('tools.mcp.activeCount', { count: nativeEntries.length })) : undefined}
      actions={<>
        <button type="button" className={doc.iconButton} aria-label={t('tools.plugins.rescan')} title={t('tools.plugins.rescan')} disabled={listLoading || busy} data-spinning={listLoading || undefined} onClick={() => void refreshNative()}><Icon name="refresh" size={15} /></button>
        <button type="button" className={doc.accentButton} aria-label={t('tools.mcp.add')} title={t('tools.mcp.add')} disabled={!canAdd} onClick={() => void startNew()}><Icon name="plus" size={16} /></button>
      </>}
      search={(nativeEntries.length >= SEARCH_THRESHOLD || !!needle) ? <SearchField type="search" label={t('tools.mcp.searchLabel')} placeholder={t('tools.mcp.searchPlaceholder')} value={search} onChange={setSearch} /> : undefined}
      notices={<>{stale && <StatusBanner tone="warning">{t('tools.mcp.stale')}</StatusBanner>}{loadError && nativeEntries.length > 0 && <div className={styles.retry}><StatusBanner tone="error">{loadError}</StatusBanner><button type="button" onClick={() => void refreshNative()}>{t('tools.plugins.rescan')}</button></div>}</>}
      list={listBody}
      placeholder={!composing && nativeEntries.length > 0 ? <div className={doc.placeholder}><span className={doc.placeholderIcon} aria-hidden="true"><Icon name="connections" size={22} /></span><strong>{t('tools.mcp.selectHint')}</strong><p>{t('tools.mcp.selectDetail')}</p></div> : null}
      document={composing ? <article className={doc.doc} aria-label={articleLabel}>
        <DocumentHeader
          title={nativeOrigin?.name || t('tools.mcp.newTitle')}
          badges={nativeOrigin ? <>
            <span className={doc.chip}>{nativeOrigin.transport === 'http' ? 'HTTP' : 'stdio'}</span>
            <span className={doc.chip} data-tone={enabled ? 'on' : 'muted'}>{enabled ? t('tools.plugins.enabled') : t('tools.quota.disabled')}</span>
            {openedLibrary && <span className={doc.chip} data-tone="info">{t('tools.mcp.inLibrary')}</span>}
          </> : undefined}
          tools={<>
            {nativeOrigin && <ModeSwitch mode={mode} editable disabled={busy || !!preview} onChange={setMode} />}
            {openedLibrary && onOpenLibrary && <button type="button" onClick={() => onOpenLibrary(openedLibrary.id)}><Icon name="library" size={14} />{t('tools.mcp.openLibrary')}</button>}
            {nativeOrigin && <button type="button" className={styles.dangerQuiet} disabled={busy} onClick={() => void removeNative(nativeOrigin)}><Icon name="trash" size={14} />{t('tools.mcp.removeFromTool')}</button>}
            <button type="button" className={doc.iconButton} aria-label={t('common.dialog.close')} title={t('common.dialog.close')} onClick={() => void closeCompose()}><Icon name="close" size={15} /></button>
          </>}
        />
        {editing ? <>
          <div className={doc.scroll}>
            <div className={styles.panel}>
            {linkedInLibrary && <p className={styles.linkedNote}><Icon name="info" size={14} />{t('tools.mcp.linkedNote', { name: linked?.name ?? draft.name })}</p>}
            <fieldset className={styles.formFields} disabled={busy || !!preview}>
              <McpFormFields key={formKey} title={t('library.resources.connectionTitle')} draft={draft} onChange={setDraft} envRows={envRows} onEnvRowsChange={setEnvRows} headerRows={headerRows} onHeaderRowsChange={setHeaderRows} showIssues={showIssues} onImport={importJson} initialPasteText={importSource} />
            </fieldset>
            <div className={styles.options}>
              <div className={styles.option}><label><input type="checkbox" checked={enabled} disabled={busy || !!preview} aria-describedby={id + '-enabled'} onChange={event => setEnabled(event.target.checked)} />{t('tools.mcp.enabledLabel')}</label><small id={id + '-enabled'}>{t('tools.mcp.enabledHint')}</small></div>
              {!linkedInLibrary && <div className={styles.option}><label><input type="checkbox" checked={syncLibrary} disabled={busy || !!preview} aria-describedby={id + '-library'} onChange={event => setSyncLibrary(event.target.checked)} />{t('tools.mcp.alsoLibrary')}</label><small id={id + '-library'}>{t('tools.mcp.alsoLibraryHint')}</small></div>}
            </div>
            {preview && <div className={styles.preview} role="group" aria-label={t('tools.mcp.previewLabel')}>
              <strong>{preview.targets.some(item => item.status === 'conflict') ? t('tools.mcp.conflictTitle') : t('tools.mcp.previewTitle')}</strong>
              {preview.targets.map((item, index) => <div key={index} className={styles.previewTarget} data-status={item.status}><p>{item.detail}</p>{item.status === 'conflict' && <div className={styles.diff}><CodeEditor compact label={t('tools.mcp.conflictCurrent')} format="json" readOnly value={JSON.stringify(item.existing, null, 2)} /><CodeEditor compact label={t('tools.mcp.conflictNext')} format="json" readOnly value={JSON.stringify(item.proposed, null, 2)} /></div>}</div>)}
              {preview.targets.some(item => item.status === 'conflict') && <label className={styles.replace}><input type="checkbox" checked={allowReplace} disabled={busy} onChange={event => setAllowReplace(event.target.checked)} />{t('tools.mcp.batchReplace')}</label>}
            </div>}
            {commitResults && <div className={styles.results}>{commitResults.targets.map((item, index) => <p key={index} data-status={item.status}>{item.status}: {item.detail}</p>)}</div>}
            {error && <p className={styles.error} role="alert">{error}</p>}
            {notice && <p className={styles.notice} role="status">{notice}</p>}
            </div>
          </div>
          <DocumentFoot dirty={dirty} note={t('common.document.saveHint', { mod: modLabel })}>
            {preview && <button type="button" disabled={busy} onClick={() => { setPreview(null); setAllowReplace(false); }}>{t('library.resources.back')}</button>}
            {preview ? <button type="button" className={styles.primary} disabled={busy || preview.targets.some(item => item.status === 'conflict') && !allowReplace || preview.targets.every(item => item.status !== 'ready' && item.status !== 'conflict')} onClick={() => void commit()}>{t('tools.mcp.confirmWrite')}</button>
              : <button type="button" className={styles.primary} title={saveShortcutHint()} disabled={busy || !draft.name.trim() || scope === 'project' && !project} onClick={() => void save()}>{nativeOrigin || draft.id ? t('home.launcher.save') : t('tools.mcp.addSubmit')}</button>}
          </DocumentFoot>
        </> : nativeOrigin && <div className={doc.body}><McpDetails key={nativeOrigin.name} item={{ ...nativeOrigin, enabled }} /></div>}
      </article> : null}
    />
    <GuideDialog wide open={!!batchItems} title={t('tools.mcp.batchTitle')} hint={t('tools.mcp.batchHint')} onClose={() => void closeCompose()}>
      {batchItems && <McpBatchImport items={batchItems} onCancel={() => setBatchItems(null)} onPreview={value => native.previewMcpDraft(value, [{ ...target, enabled }])}
        onCommit={(value, candidate, replace) => native.commitMcpDraft(value, candidate.targets.filter(item => item.status === 'ready' || replace && item.status === 'conflict').map(item => ({ toolId: item.toolId, scope: item.scope, projectPath: item.projectPath, contextId: item.contextId ?? contextId, enabled, baselineHash: item.baselineHash, previewToken: item.previewToken, allowReplace: replace && item.status === 'conflict' })))}
        onDefinitionSaved={result => { setDefinitions(current => [...current.filter(item => item.id !== result.definition.id), result.definition]); void refreshNative(); }}
        onComplete={() => setImportSource('')} />}
    </GuideDialog>
  </>;
}
