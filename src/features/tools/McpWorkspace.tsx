import { useRemoteReads, RemoteReadStatus } from '../../lib/remoteReads';
import { CodeEditor } from '../../components/CodeEditor';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { confirmAction } from '../../lib/confirm';
import type { Scope } from '../../types/native';
import type { McpCommitResult, McpDefinition, McpDraft, McpDraftPreview, McpTargetRequest, NativeMcpEntry } from '../../types/resources';
import { GuideDialog } from '../../components/GuideDialog';
import { SearchField } from '../../components/SearchField';
import { modLabel, saveShortcutHint, searchShortcutHint, withMod } from '../../lib/shortcut';
import { Icon } from '../../components/Icon';
import { StatusBanner } from '../../components/StatusBanner';
import { useFeedback } from '../../lib/toast';
import { blankMcpDraft, editableRowsOf, hasMcpIssues, isRemoteMcp, keptMcpArgs, mcpCwdOf, mcpDefaultName, mcpDraftIssues, mcpDraftOf, mcpParseIssueTexts, mcpSummary, mcpTransportBadge, recordOfRows, type KeyValueRow, type McpParsedServer } from '../../lib/mcp';
import { McpFormFields } from '../../components/mcp/McpFormFields';
import { McpDetails } from '../../components/mcp/McpDetails';
import { McpBatchImport, type McpBatchItem } from '../../components/mcp/McpBatchImport';
import { SkeletonRows } from '../../components/Skeleton';
import { EmptyState } from '../../components/EmptyState';
import { SecretMcpPanel } from './SecretMcpPanel';
import i18n from '../../i18n';
import { DocumentFoot, DocumentHeader, DocumentWorkspace, ModeSwitch, Toggle, documentStyles as doc, type DocumentMode } from './DocumentWorkspace';
import styles from './McpWorkspace.module.css';
import { Badge, Button, IconButton } from '../../components/ui';
import { ToolIcon } from '../../components/ToolIcon';

function errorText(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : i18n.t('common.operationFailed');
}
const emptyRows = () => editableRowsOf({});

export function McpWorkspace({ toolId, toolName = '', scopeLabel = '', scope, projectPath, contextId, remoteTargetId = null, onDirtyChange, onOpenLibrary }: {
  toolId: string;
  /** Shown in the document as the one place a save writes to. */
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
  const [entries, setEntries] = useState<NativeMcpEntry[]>([]);
  const [definitions, setDefinitions] = useState<McpDefinition[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [remoteIssues, setRemoteIssues] = useState<Array<{ kind?: string; path?: string; message: string }>>([]);
  const [stale, setStale] = useState(false);
  /** The saved entry the document shows; its working copy lives in the draft below. */
  const [selected, setSelected] = useState<NativeMcpEntry | null>(null);
  const [creating, setCreating] = useState(false);
  const [mode, setMode] = useState<DocumentMode>('read');
  const [draft, setDraft] = useState<McpDraft>(blankMcpDraft);
  const [envRows, setEnvRows] = useState<KeyValueRow[]>(emptyRows);
  const [headerRows, setHeaderRows] = useState<KeyValueRow[]>(emptyRows);
  const [savedFingerprint, setSavedFingerprint] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [syncLibrary, setSyncLibrary] = useState(false);
  const [pasteFirst, setPasteFirst] = useState(false);
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
  const readTarget = useMemo<McpTargetRequest>(() => ({ toolId, scope, projectPath: project, contextId, enabled: true }), [toolId, scope, project, contextId]);
  const hasEntries = useRef(false); hasEntries.current = entries.length > 0;
  const feedback = useFeedback();
  const mounted = useRef(true);
  const loadSequence = useRef(0);
  // The confirmation takes the keyboard, so Enter/S keeps confirming and cancelling stays one press away.
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (preview) confirmRef.current?.focus(); }, [preview]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; loadSequence.current++; }; }, []);

  const opened = creating || !!selected;
  const currentFingerprint = JSON.stringify([draft, envRows, headerRows, enabled, syncLibrary]);
  remoteReads.bindWriteDraft(opened || batchItems ? `mcp:${formKey}` : null);
  const dirty = opened && currentFingerprint !== savedFingerprint;
  useLayoutEffect(() => { onDirtyChange?.(dirty || !!batchItems); }, [dirty, batchItems, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
  // Page-level notes belong to the toast; a document keeps its own error strip visible.
  useEffect(() => {
    if (batchItems) return;
    if (error && !opened) { feedback.setError(error); setError(''); }
    if (notice) { feedback.setNotice(notice); setNotice(''); }
  }, [opened, batchItems, error, notice, feedback]);

  const refreshNative = useCallback(async (fresh = true) => {
    remoteReads.rebaseWriteAction();
    if (!toolId || (scope === 'project' && !project)) { setEntries([]); setListLoading(false); return; }
    const request = ++loadSequence.current;
    setListLoading(true);
    try {
      if (remoteTargetId) {
        const store = await native.getRemoteResourceStore(remoteTargetId, toolId, 'mcp', { fresh }) as { entries?: NativeMcpEntry[]; issues?: Array<{ kind?: string; path?: string; message: string }> };
        if (!mounted.current || request !== loadSequence.current) return;
        setEntries(store.entries ?? []);
        setRemoteIssues(store.issues ?? []);
      } else {
        const value = await native.listNativeMcp(readTarget);
        // Older test doubles may still return the former bare array.
        const store = Array.isArray(value) ? { entries: value, issues: [] } : value;
        if (!mounted.current || request !== loadSequence.current) return;
        setEntries(store.entries);
        setRemoteIssues(store.issues ?? []);
      }
      if (!mounted.current || request !== loadSequence.current) return;
      setLoadError(''); setStale(false);
    } catch (value) {
      if (!mounted.current || request !== loadSequence.current) return;
      setLoadError(errorText(value)); setStale(hasEntries.current);
    } finally {
      if (mounted.current && request === loadSequence.current) setListLoading(false);
    }
  }, [toolId, scope, project, readTarget, remoteTargetId, native]);
  useEffect(() => { if (remoteReads.active) void refreshNative(false); }, [toolId, scope, project, contextId, remoteTargetId, refreshNative, remoteReads.active]);
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
  const shown = needle ? entries.filter(item => (item.name + ' ' + mcpSummary(item)).toLowerCase().includes(needle)) : entries;
  const openedLibrary = selected ? libraryFor(selected.name) : undefined;

  function resetForm(next: McpDraft, nextEnv: KeyValueRow[], nextHeaders: KeyValueRow[], nextEnabled: boolean, nextSync = false) {
    setDraft(next); setEnvRows(nextEnv); setHeaderRows(nextHeaders); setEnabled(nextEnabled); setSyncLibrary(nextSync);
    setSavedFingerprint(JSON.stringify([next, nextEnv, nextHeaders, nextEnabled, nextSync]));
    setShowIssues(false); setPreview(null); setAllowReplace(false); setCommitResults(null); setImportSource(''); setFormKey(value => value + 1);
  }
  /** The one confirmation for leaving a draft: switching entries, closing or replacing it. */
  async function canReplace() {
    const started = currentFingerprint;
    const pending = dirty || !!batchItems || !!preview;
    return !pending || confirmAction(t('tools.mcp.confirmDiscard'), () => mounted.current && currentFingerprint === started, { title: t('common.app.leaveDirtyTitle'), confirmLabel: t('common.app.leaveDirtyConfirm') });
  }
  /** Shows a saved entry; a working copy that differs from it stays dirty in either mode. */
  function loadEntry(item: NativeMcpEntry, edit = false) {
    const found = definitions.find(definition => definition.name === item.name);
    const next: McpDraft = { id: found?.id ?? null, name: item.name, transport: item.transport, command: item.command, args: item.args, cwd: item.cwd ?? '', url: item.url,
      env: item.env, headers: item.headers, inLibrary: found?.inLibrary === true, expectedVersion: found?.version ?? null };
    setPasteFirst(false);
    setCreating(false); setSelected(item); setMode(edit ? 'edit' : 'read');
    resetForm(next, editableRowsOf(item.env), editableRowsOf(item.headers), item.enabled);
    setError(''); setNotice('');
  }
  function clearDocument() {
    setCreating(false); setSelected(null); setMode('read');
    resetForm(blankMcpDraft(), emptyRows(), emptyRows(), true);
    setError('');
  }
  async function startNew(paste = false) {
    if (!await canReplace()) return;
    setPasteFirst(paste);
    setCreating(true); setSelected(null); setMode('edit');
    resetForm(blankMcpDraft(), emptyRows(), emptyRows(), true);
    setError(''); setNotice('');
  }
  async function openEntry(item: NativeMcpEntry, edit = false) {
    if (busy) return;
    // A foreign source is read-only: opening never starts an edit draft.
    if (item.readOnly) edit = false;
    if (!creating && selected?.name === item.name) { if (edit) setMode('edit'); return; }
    if (!await canReplace()) return;
    loadEntry(item, edit);
  }
  async function closeDocument() {
    if (!await canReplace()) return;
    clearDocument();
  }
  /** Drops the working copy and returns to what is saved, without losing the entry itself. */
  async function revertDraft() {
    if (!await canReplace()) return;
    if (selected) loadEntry(selected);
    else clearDocument();
  }
  async function closeBatch() {
    if (!await canReplace()) return;
    setBatchItems(null); setImportSource('');
    clearDocument();
  }
  function normalizedDraft() {
    return { ...draft, name: draft.name.trim(), args: keptMcpArgs(draft.args), cwd: mcpCwdOf(draft), id: linked?.id ?? draft.id,
      expectedVersion: linked?.version ?? draft.expectedVersion, inLibrary: linkedInLibrary || syncLibrary,
      env: recordOfRows(envRows), headers: recordOfRows(headerRows) };
  }
  /** Reading shows the working copy while it differs from the entry it was loaded from, so an edit is visible before it is written. */
  function shownEntryOf(item: NativeMcpEntry): NativeMcpEntry {
    if (!dirty) return { ...item, enabled };
    const next = normalizedDraft();
    return { name: next.name || item.name, transport: next.transport, command: next.command, args: next.args, cwd: next.cwd, url: next.url,
      env: next.env, headers: next.headers, inLibrary: next.inLibrary, enabled, protectedValues: item.protectedValues };
  }
  async function save() {
    if (!opened) return;
    if (selected?.readOnly) { setError(t('tools.skills.stateReadOnly')); return; }
    if (scope === 'project' && !project) { setError(t('tools.mcp.pickProject')); return; }
    if (hasMcpIssues(mcpDraftIssues(draft))) { setShowIssues(true); return; }
    setBusy(true); setError('');
    try {
      const next = normalizedDraft();
      const nextEnabled = enabled;
      if (remoteTargetId) {
        const current = await native.getRemoteResourceStore(remoteTargetId, toolId, 'mcp', { fresh: true }) as { entries?: NativeMcpEntry[]; definitions?: McpDefinition[] };
        const entry: NativeMcpEntry = { name: next.name, transport: next.transport, command: next.command, args: next.args, cwd: next.cwd, url: next.url, env: next.env, headers: next.headers, inLibrary: next.inLibrary, enabled: nextEnabled, protectedValues: false };
        const entries = [...(current.entries ?? []).filter(item => item.name !== entry.name), entry];
        const definition: McpDefinition = { id: next.id ?? crypto.randomUUID(), name: next.name, transport: next.transport, command: next.command, args: next.args, cwd: next.cwd, url: next.url, env: next.env, headers: next.headers, inLibrary: next.inLibrary, version: (current.definitions ?? []).find(item => item.id === next.id)?.version ?? 1 };
        await native.saveRemoteResourceStore(remoteTargetId, toolId, 'mcp', { entries, definitions: [...(current.definitions ?? []).filter(item => item.id !== definition.id), definition] });
        await refreshNative();
        if (!mounted.current) return;
        setDefinitions(value => [...value.filter(item => item.id !== definition.id), definition]);
        setSelected(entry); setCreating(false); setMode('read');
        resetForm({ ...next, id: definition.id, expectedVersion: definition.version, inLibrary: definition.inLibrary }, editableRowsOf(entry.env), editableRowsOf(entry.headers), entry.enabled);
        setNotice(t('tools.mcp.written'));
        return;
      }
      setPreview(await native.previewMcpDraft(next, [{ ...target, enabled: nextEnabled }]));
      setAllowReplace(false); setCommitResults(null);
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
      if (!mounted.current) return;
      if (written) {
        const definition = result.definition;
        const entry: NativeMcpEntry = { name: definition.name, transport: definition.transport, command: definition.command, args: definition.args, cwd: definition.cwd, url: definition.url, env: definition.env, headers: definition.headers, inLibrary: definition.inLibrary, enabled, protectedValues: false };
        setSelected(entry); setCreating(false); setMode('read');
        resetForm(mcpDraftOf(definition), editableRowsOf(definition.env), editableRowsOf(definition.headers), entry.enabled);
        setNotice(t('tools.mcp.written'));
      } else {
        // The definition was saved, but at least one target was not; the draft stays, now marked saved.
        const saved = mcpDraftOf(result.definition);
        setDraft(saved);
        setSavedFingerprint(JSON.stringify([saved, envRows, headerRows, enabled, syncLibrary]));
        setPreview(null); setCommitResults(result); setError(t('tools.mcp.partialFailed'));
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
    const taken = new Set([...definitions.map(item => item.name), ...entries.map(item => item.name), ...explicit.filter(Boolean)]);
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
      await refreshNative();
      if (!mounted.current) return;
      clearDocument(); setNotice(t('tools.mcp.deleted'));
    } catch (value) { setError(errorText(value)); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function toggleExternal(next: boolean) {
    if (!selected?.readOnly || !selected.switchable) return;
    remoteReads.beginWriteAction();
    setBusy(true); setError('');
    try {
      await native.setExternalMcpEnabled({ ...readTarget }, selected.name, next);
      setEnabled(next);
      setSelected(current => current ? { ...current, enabled: next } : current);
      await refreshNative();
      if (!mounted.current) return;
      setNotice(t('tools.mcp.written'));
    } catch (value) { setError(errorText(value)); }
    finally { if (mounted.current) setBusy(false); }
  }
  function onKey(event: KeyboardEvent<HTMLElement>) {
    if (!withMod(event) || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    if (event.repeat || busy || !opened) return;
    if (preview) { if (committable && (!conflicted || allowReplace)) void commit(); return; }
    if (draft.name.trim() && !(scope === 'project' && !project)) void save();
  }

  const canAdd = !(busy || (scope === 'project' && !project));
  const conflicted = !!preview && preview.targets.some(item => item.status === 'conflict');
  const committable = !!preview && preview.targets.some(item => item.status === 'ready' || item.status === 'conflict');
  const where = [toolName, scopeLabel].filter(Boolean).join(' · ');

  let listBody: ReactNode;
  if (listLoading && !entries.length) listBody = <div className={styles.listWrap} role="status" aria-label={t('tools.mcp.loading')}><SkeletonRows count={3} /></div>;
  else if (loadError && !entries.length) listBody = <div className={styles.listWrap}><div className={styles.blocked}><StatusBanner tone="error">{loadError}</StatusBanner><p>{t('tools.mcp.blocked')}</p><Button icon={<Icon name="refresh" size={14} />} onClick={() => void refreshNative()}>{t('tools.plugins.rescan')}</Button></div></div>;
  else if (!entries.length) listBody = <div className={styles.listWrap}><EmptyState icon="connections" title={t('tools.mcp.emptyTitle')} detail={[t('tools.mcp.emptyDetail'), scope === 'project' && !project ? t('tools.mcp.pickProjectFirst') : ''].filter(Boolean).join(' ')} action={<div className={styles.emptyActions}><Button variant="primary" disabled={!canAdd} icon={<Icon name="plus" size={14} />} onClick={() => void startNew()}>{t('tools.mcp.add')}</Button><Button disabled={!canAdd} icon={<Icon name="clipboard" size={14} />} onClick={() => void startNew(true)}>{t('library.resources.pasteCreate')}</Button></div>} /></div>;
  else if (!shown.length) listBody = <div className={styles.listWrap}><div className={doc.noMatch}><Icon name="search" size={18} /><p>{t('tools.mcp.noMatch', { query: search.trim() })}</p><Button size="sm" onClick={() => setSearch('')}>{t('tools.mcp.clearSearch')}</Button></div></div>;
  else listBody = <div className={styles.listWrap}><ul className={doc.rows} aria-label={t('tools.mcp.title')}>{shown.map(item => {
    // The row opens the document; a double-click goes straight to editing.
    const summary = mcpSummary(item);
    const inLibrary = libraryFor(item.name);
    const remote = isRemoteMcp(item.transport);
    return <li key={item.name}>
      <button type="button" className={doc.row} aria-current={!creating && selected?.name === item.name ? 'true' : undefined} data-disabled={!item.enabled || undefined} aria-label={t('tools.mcp.rowOpen', { name: item.name })} title={t('tools.mcp.doubleClickHint')} disabled={busy} onClick={() => void openEntry(item)} onDoubleClick={() => void openEntry(item, true)}>
        <span className={doc.rowTitle}><Icon name={remote ? 'globe' : 'terminal'} size={14} /><strong>{item.name}</strong>{inLibrary && <Badge tone="info">{t('tools.mcp.inLibrary')}</Badge>}</span>
        <span className={doc.rowSummary}>{summary || t(remote ? 'library.resources.noUrl' : 'library.resources.noCommand')}</span>
        <span className={doc.rowMeta}>
          <Badge>{mcpTransportBadge(item.transport)}</Badge>
          {item.source && <Badge><Icon name="lock" size={10} />{item.source}</Badge>}
          {item.issue && <Badge tone="warning">{item.issue}</Badge>}
          <Badge tone={item.enabled ? 'success' : 'neutral'} dot>{item.enabled ? t('tools.plugins.enabled') : t('tools.quota.disabled')}</Badge>
          {item.protectedValues && <Badge><Icon name="lock" size={10} />{t('tools.mcp.detailProtected')}</Badge>}
        </span>
      </button>
    </li>;
  })}</ul></div>;

  const side = <aside className={styles.side} aria-label={t('tools.mcp.targetTitle')}>
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
  </aside>;

  // Editing keeps the same document: the form, where it writes to, and any earlier write result.
  const editor = <div className={doc.scroll}>
    <div className={styles.editor}>
      <div className={styles.editorForm}>
        {linkedInLibrary && <p className={styles.linkedNote}><Icon name="info" size={14} />{t('tools.mcp.linkedNote', { name: linked?.name ?? draft.name })}</p>}
        <fieldset className={styles.formFields} disabled={busy || !!preview}>
          <McpFormFields key={formKey} title={t('library.resources.connectionTitle')} draft={draft} onChange={setDraft} envRows={envRows} onEnvRowsChange={setEnvRows} headerRows={headerRows} onHeaderRowsChange={setHeaderRows} showIssues={showIssues} onImport={importJson} initialPasteOpen={pasteFirst} initialPasteText={importSource} />
        </fieldset>
      </div>
      {side}
    </div>
    {commitResults && <div className={styles.results}>{commitResults.targets.map((item, index) => <p key={index} data-status={item.status}>{item.status}: {item.detail}</p>)}</div>}
  </div>;

  // The preview is its own surface: the form is not being edited while a write is confirmed.
  const review = preview ? <div className={doc.scroll}>
    <div className={styles.review}>
      <div className={styles.preview} role="group" aria-label={t('tools.mcp.previewLabel')} data-conflict={conflicted || undefined}>
        <strong><Icon name={conflicted ? 'alert' : 'check'} size={14} />{conflicted ? t('tools.mcp.conflictTitle') : t('tools.mcp.previewTitle')}</strong>
        {preview.targets.map((item, index) => <div key={index} className={styles.previewTarget} data-status={item.status}><p>{item.detail}</p>{item.status === 'conflict' && <div className={styles.diff}><CodeEditor compact label={t('tools.mcp.conflictCurrent')} format="json" readOnly value={JSON.stringify(item.existing, null, 2)} /><CodeEditor compact label={t('tools.mcp.conflictNext')} format="json" readOnly value={JSON.stringify(item.proposed, null, 2)} /></div>}</div>)}
        {conflicted && <label className={styles.replace}><input type="checkbox" checked={allowReplace} disabled={busy} onChange={event => setAllowReplace(event.target.checked)} />{t('tools.mcp.batchReplace')}</label>}
      </div>
    </div>
  </div> : null;

  const foot = preview
    ? <div className={doc.foot}>
      <span className={doc.footNote} />
      <Button disabled={busy} onClick={() => { setPreview(null); setAllowReplace(false); }}>{t('library.resources.back')}</Button>
      <Button ref={confirmRef} variant="primary" disabled={busy || conflicted && !allowReplace || !committable} onClick={() => void commit()}>{t('tools.mcp.confirmWrite')}</Button>
    </div>
    : mode === 'edit' || creating || dirty
      ? <DocumentFoot dirty={dirty} note={t('common.document.saveHint', { mod: modLabel })}>
        <Button disabled={busy} onClick={() => void revertDraft()}>{creating ? t('common.dialog.cancel') : t('tools.mcp.cancelEdit')}</Button>
        <Button variant="primary" title={saveShortcutHint()} disabled={busy || !draft.name.trim() || scope === 'project' && !project} onClick={() => void save()}>{selected || draft.id ? t('home.launcher.save') : t('tools.mcp.addSubmit')}</Button>
      </DocumentFoot>
      : null;

  const errorStrip = error ? <p className={doc.strip} data-tone="error" role="alert"><Icon name="alert" size={14} /><span>{error}</span></p> : null;

  const document = creating
    ? <article className={doc.doc} aria-label={t('tools.mcp.newTitle')}>
      <DocumentHeader title={t('tools.mcp.newTitle')} badges={<Badge>{mcpTransportBadge(draft.transport)}</Badge>} meta={<><ToolIcon toolId={toolId} size={14} /><span>{where || toolId}</span></>} />
      {errorStrip}
      {review ?? editor}
      {foot}
    </article>
    : selected
      ? <article className={doc.doc} aria-label={selected.name}>
        <DocumentHeader
          title={selected.name}
          badges={<>
            <Badge tone={isRemoteMcp(selected.transport) ? 'info' : 'neutral'}>{mcpTransportBadge(selected.transport)}</Badge>
            <Badge tone={enabled ? 'success' : 'neutral'} dot>{enabled ? t('tools.plugins.enabled') : t('tools.quota.disabled')}</Badge>
            {selected.source && <Badge><Icon name="lock" size={10} />{selected.source}</Badge>}
            {selected.issue && <Badge tone="warning">{selected.issue}</Badge>}
            {linkedInLibrary && <Badge tone="info">{t('tools.mcp.inLibrary')}</Badge>}
            {selected.protectedValues && <Badge><Icon name="lock" size={10} />{t('tools.mcp.detailProtected')}</Badge>}
          </>}
          tools={<>
            {!remoteTargetId && !preview && selected.readOnly && selected.switchable && <Toggle checked={enabled} label={t('tools.mcp.enabledLabel')} text={enabled ? t('tools.skills.enabledNote') : t('tools.skills.disabledNote')} disabled={busy || !!preview} onChange={value => void toggleExternal(value)} />}
            {!preview && !selected.readOnly && <ModeSwitch mode={mode} editable disabled={busy} onChange={setMode} />}
            {openedLibrary && onOpenLibrary && <IconButton size="sm" className={doc.iconButton} aria-label={t('tools.mcp.openLibrary')} title={t('tools.mcp.openLibrary')} onClick={() => onOpenLibrary(openedLibrary.id)} icon={<Icon name="library" size={15} />} />}
            {!selected.readOnly && <IconButton size="sm" className={doc.iconButton} data-tone="danger" aria-label={t('tools.mcp.removeFromTool')} title={t('tools.mcp.removeFromTool')} disabled={busy} onClick={() => void removeNative(selected)} icon={<Icon name="trash" size={15} />} />}
          </>}
          meta={<><ToolIcon toolId={toolId} size={14} /><span>{where || toolId}</span>{remoteTargetId && <span>{t('tools.mcp.targetRemoteHint')}</span>}{selected.readOnly && selected.detail && <span>{selected.detail}</span>}</>}
        />
        {errorStrip}
        {review ?? (mode === 'read'
          ? <div className={doc.body}><div className={doc.readColumn}><section aria-label={t('tools.mcp.detailsLabel')}><McpDetails key={selected.name} statusInHeader item={shownEntryOf(selected)} /></section></div></div>
          : editor)}
        {foot}
      </article>
      : null;

  return <>
    <DocumentWorkspace
      documentKey={creating ? 'new' : selected?.name ?? null}
      label={t('tools.mcp.title')}
      toolbarLabel={t('tools.mcp.toolbar')}
      heading={t('tools.mcp.title')}
      count={entries.length > 0 ? needle ? t('tools.mcp.countFiltered', { filtered: shown.length, total: entries.length }) : t('tools.mcp.activeCount', { count: entries.length }) : undefined}
      actions={<>
        <IconButton size="sm" className={doc.iconButton} aria-label={t('tools.plugins.rescan')} title={t('tools.plugins.rescan')} disabled={listLoading || busy} data-spinning={listLoading || undefined} onClick={() => void refreshNative()} icon={<Icon name="refresh" size={15} />} />
        <IconButton variant="primary" size="sm" aria-label={t('tools.mcp.add')} title={t('tools.mcp.add')} disabled={!canAdd} onClick={() => void startNew()} icon={<Icon name="plus" size={16} />} />
      </>}
      search={<SearchField type="search" pageSearch title={searchShortcutHint()} label={t('tools.mcp.searchLabel')} placeholder={t('tools.mcp.searchPlaceholder')} value={search} onChange={setSearch} />}
      notices={<>
        <RemoteReadStatus state={remoteReads} />
        {remoteIssues.length > 0 && <StatusBanner tone="warning" action={<Button size="sm" onClick={() => void refreshNative()}>{t('tools.plugins.rescan')}</Button>}>{remoteIssues.map(issue => issue.message).join('；')}</StatusBanner>}
        {stale && <StatusBanner tone="warning" action={loadError ? <Button size="sm" onClick={() => void refreshNative()}>{t('tools.plugins.rescan')}</Button> : undefined}>{t('tools.mcp.stale')}</StatusBanner>}
        {loadError && entries.length > 0 && !stale && <StatusBanner tone="error" action={<Button size="sm" onClick={() => void refreshNative()}>{t('tools.plugins.rescan')}</Button>}>{loadError}</StatusBanner>}
      </>}
      list={listBody}
      listFooterLabel={t('library.secrets.mcp.title')}
      listFooter={remoteTargetId ? null : <SecretMcpPanel toolId={toolId} scope={scope} projectPath={project} contextId={contextId ?? null} />}
      placeholder={!opened && entries.length > 0 ? <div className={doc.placeholder}>
        <span className={doc.placeholderIcon} aria-hidden="true"><Icon name="connections" size={22} /></span>
        <strong>{t('tools.mcp.selectHint')}</strong>
        <p>{t('tools.mcp.selectDetail')}</p>
      </div> : null}
      document={document}
      backLabel={t('common.dialog.back')}
      onBack={() => { void closeDocument(); }}
      closeLabel={t('tools.workspace.closeDocument')}
      onKeyDown={onKey}
    />
    <GuideDialog wide open={!!batchItems} title={t('tools.mcp.batchTitle')} hint={t('tools.mcp.batchHint')} onClose={() => void closeBatch()}>
      {batchItems && <McpBatchImport items={batchItems} onCancel={() => setBatchItems(null)} onPreview={value => native.previewMcpDraft(linkDraft(value), [{ ...target, enabled }])}
        onCommit={(value, candidate, replace) => native.commitMcpDraft(value, candidate.targets.filter(item => item.status === 'ready' || replace && item.status === 'conflict').map(item => ({ toolId: item.toolId, scope: item.scope, projectPath: item.projectPath, contextId: item.contextId ?? contextId, enabled, baselineHash: item.baselineHash, previewToken: item.previewToken, allowReplace: replace && item.status === 'conflict' })))}
        onDefinitionSaved={result => { setDefinitions(current => [...current.filter(item => item.id !== result.definition.id), result.definition]); void refreshNative(); }}
        onComplete={() => setImportSource('')} />}
    </GuideDialog>
  </>;
}
