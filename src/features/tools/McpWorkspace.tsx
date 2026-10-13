import { CodeEditor } from '../../components/CodeEditor';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import type { Scope } from '../../types/native';
import type { McpDefinition, McpDraft, McpTargetRequest, McpTargetResult, NativeMcpEntry } from '../../types/resources';
import { GuideDialog } from '../../components/GuideDialog';
import { SearchField } from '../../components/SearchField';
import { saveShortcutHint } from '../../lib/shortcut';
import { Icon } from '../../components/Icon';
import { StatusBanner } from '../../components/StatusBanner';
import { applyParsedServer, blankMcpDraft, editableRowsOf, hasMcpIssues, keptMcpArgs, mcpDraftIssues, mcpDraftOf, mcpSummary, recordOfRows, type KeyValueRow, type McpParsedServer } from '../../lib/mcp';
import { McpFormFields } from '../../components/mcp/McpFormFields';
import i18n from '../../i18n';
import styles from './McpWorkspace.module.css';

function errorText(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : i18n.t('common.operationFailed');
}

const SEARCH_THRESHOLD = 6;

export function McpWorkspace({ toolId, scope, projectPath, contextId, onDirtyChange }: { toolId: string; scope: Scope; projectPath: string; contextId?: string | null; onDirtyChange?: (dirty: boolean) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [definitions, setDefinitions] = useState<McpDefinition[]>([]);
  const [draft, setDraft] = useState<McpDraft>(blankMcpDraft);
  const [envRows, setEnvRows] = useState<KeyValueRow[]>(editableRowsOf({}));
  const [headerRows, setHeaderRows] = useState<KeyValueRow[]>(editableRowsOf({}));
  const [savedFingerprint, setSavedFingerprint] = useState(JSON.stringify([blankMcpDraft(), editableRowsOf({}), editableRowsOf({}), true]));
  const [nativeEntries, setNativeEntries] = useState<NativeMcpEntry[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [nativeOrigin, setNativeOrigin] = useState<NativeMcpEntry | null>(null);
  const [currentConflict, setCurrentConflict] = useState<{ id: string; items: McpTargetResult[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [capabilityBlocked, setCapabilityBlocked] = useState('');
  const [composing, setComposing] = useState(false);
  const [syncLibrary, setSyncLibrary] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [search, setSearch] = useState('');
  const project = scope === 'project' ? projectPath || null : null;
  const dirty = JSON.stringify([draft, envRows, headerRows, enabled]) !== savedFingerprint;
  const latestForm = useRef(''); latestForm.current = JSON.stringify([draft, envRows, headerRows, enabled]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const previewContext = JSON.stringify([draft, envRows, headerRows, toolId, scope, project, enabled]);
  const previewEpochRef = useRef({ context: previewContext, epoch: 0 });
  if (previewEpochRef.current.context !== previewContext) {
    previewEpochRef.current = { context: previewContext, epoch: previewEpochRef.current.epoch + 1 };
  }
  useLayoutEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
  const target = useMemo<McpTargetRequest>(() => ({ toolId, scope, projectPath: project, enabled, contextId }), [toolId, scope, project, enabled, contextId]);

  useEffect(() => {
    void native.listMcpDefinitions().then(setDefinitions).catch((value) => setError(errorText(value)));
  }, []);
  useEffect(() => {
    if (!toolId || (scope === 'project' && !project)) { setNativeEntries([]); setCapabilityBlocked(''); return; }
    let live = true;
    setCapabilityBlocked('');
    void native.listNativeMcp(target).then((value) => { if (live) { setNativeEntries(value); setCapabilityBlocked(''); } })
      .catch((value) => { if (live) { setNativeEntries([]); setCapabilityBlocked(errorText(value)); } });
    return () => { live = false; };
  }, [target, toolId, scope, project]);

  const empty = !nativeEntries.length && !composing && !draft.id && !nativeOrigin;
  const libraryFor = (name: string) => definitions.find((item) => item.name === name.trim() && item.inLibrary !== false);
  const linked = definitions.find((item) => item.id === draft.id) ?? definitions.find((item) => item.name === draft.name.trim());
  const linkedInLibrary = !!linked && linked.inLibrary !== false;
  const editing = !!(draft.id || nativeOrigin);
  const needle = search.trim().toLowerCase();
  const shown = needle ? nativeEntries.filter((item) => `${item.name} ${mcpSummary(item)}`.toLowerCase().includes(needle)) : nativeEntries;

  function resetForm(next: McpDraft, nextEnv: KeyValueRow[], nextHeaders: KeyValueRow[], nextEnabled: boolean) {
    setDraft(next); setEnvRows(nextEnv); setHeaderRows(nextHeaders); setEnabled(nextEnabled);
    setSavedFingerprint(JSON.stringify([next, nextEnv, nextHeaders, nextEnabled]));
    setShowIssues(false); setFormKey((value) => value + 1);
  }
  function select(item: McpDefinition, nextEnabled = true) {
    const next = mcpDraftOf(item);
    const nextEnvRows = editableRowsOf(item.env);
    const nextHeaderRows = editableRowsOf(item.headers);
    setNativeOrigin(null); setCurrentConflict(null); setComposing(true);
    setDraft(next); setEnvRows(nextEnvRows); setHeaderRows(nextHeaderRows);
    setEnabled(nextEnabled); setSavedFingerprint(JSON.stringify([next, nextEnvRows, nextHeaderRows, nextEnabled]));
    latestForm.current = JSON.stringify([next, nextEnvRows, nextHeaderRows, nextEnabled]);
    setError('');
  }
  async function canReplace() {
    const started = previewEpochRef.current;
    return !dirty || confirmAction(t('tools.mcp.confirmDiscard'), () => mounted.current && started === previewEpochRef.current, { title: t('common.app.leaveDirtyTitle'), confirmLabel: t('common.app.leaveDirtyConfirm') });
  }
  async function importNative(item: NativeMcpEntry) {
    if (!await canReplace()) return;
    setNativeOrigin(item); setCurrentConflict(null); setComposing(true); setSyncLibrary(false); setNotice(''); setError('');
    const found = definitions.find((definition) => definition.name === item.name);
    const next: McpDraft = { id: found?.id ?? null, name: item.name, transport: item.transport, command: item.command, args: item.args, url: item.url,
      env: item.env, headers: item.headers, inLibrary: found?.inLibrary === true, expectedVersion: found?.version ?? null };
    resetForm(next, editableRowsOf(item.env), editableRowsOf(item.headers), item.enabled);
  }
  async function startNew() {
    if (!await canReplace()) return;
    setNativeOrigin(null); setCurrentConflict(null); setSyncLibrary(false);
    resetForm(blankMcpDraft(), editableRowsOf({}), editableRowsOf({}), true);
    setComposing(true); setNotice(''); setError('');
  }
  async function closeCompose() {
    if (!await canReplace()) return;
    leaveComposer();
    setNotice(''); setError('');
  }
  function leaveComposer() {
    setNativeOrigin(null); setCurrentConflict(null);
    resetForm(blankMcpDraft(), editableRowsOf({}), editableRowsOf({}), true);
    setComposing(false);
  }
  function importJson(parsed: McpParsedServer) {
    const next = applyParsedServer(draft, parsed);
    setDraft(next.draft); setEnvRows(next.envRows); setHeaderRows(next.headerRows);
    setError('');
  }
  async function applyItems(definitionId: string, items: McpTargetResult[], replace: boolean) {
    const targets = items.filter(item => item.status === 'ready' || item.status === 'conflict').map((item): McpTargetRequest => ({ toolId: item.toolId, scope: item.scope,
      projectPath: item.projectPath, contextId: item.contextId ?? contextId, enabled, baselineHash: item.baselineHash, previewToken: item.previewToken, allowReplace: replace && item.status === 'conflict' }));
    const outcome = await native.distributeMcp(definitionId, targets);
    setNativeEntries(await native.listNativeMcp(target)); setCurrentConflict(null);
    const written = outcome.every(item => item.status === 'written');
    setNotice(written ? t('tools.mcp.written') : t('tools.mcp.partialFailed'));
    return written;
  }
  async function save() {
    if (scope === 'project' && !project) { setError(t('tools.mcp.pickProject')); return; }
    if (hasMcpIssues(mcpDraftIssues(draft))) { setShowIssues(true); return; }
    const origin = nativeOrigin; const started = latestForm.current;
    // A native entry only joins the library when it is already there or the user asks.
    const inLibrary = linkedInLibrary || syncLibrary;
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await native.saveMcpDefinition({ ...draft, name: draft.name.trim(), args: keptMcpArgs(draft.args), id: linked?.id ?? draft.id, expectedVersion: linked?.version ?? draft.expectedVersion, inLibrary, env: recordOfRows(envRows), headers: recordOfRows(headerRows) });
      setDefinitions(await native.listMcpDefinitions());
      if (!mounted.current || started !== latestForm.current) { setNotice(t('tools.mcp.dirtyAgain')); return; }
      select(saved, enabled);
      const savedForm = JSON.stringify([mcpDraftOf(saved), editableRowsOf(saved.env), editableRowsOf(saved.headers), enabled]);
      const items = await native.previewMcpTargets(saved.id, [target]);
      const fresh = origin ? await native.listNativeMcp(target) : [];
      if (!mounted.current || savedForm !== latestForm.current) { setNotice(t('tools.mcp.savedKeepEditing')); return; }
      const sameOrigin = !!origin && JSON.stringify(fresh.find(item => item.name === origin.name)) === JSON.stringify(origin);
      if (items.some(item => item.status === 'conflict') && !sameOrigin) { setCurrentConflict({ id: saved.id, items }); return; }
      if (!items.some(item => item.status === 'ready' || item.status === 'conflict')) { setError(items.map(item => item.detail).join(t('tools.quota.errorSeparator'))); return; }
      if (await applyItems(saved.id, items, sameOrigin)) leaveComposer();
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function removeSaved() {
    const onTool = !!nativeOrigin || nativeEntries.some((entry) => entry.name === draft.name);
    const inLibrary = definitions.find((item) => item.id === draft.id)?.inLibrary === true;
    if (!onTool && !inLibrary) return;
    const name = draft.name || nativeOrigin?.name || t('tools.mcp.thisMcp');
    const message = inLibrary
      ? t('tools.mcp.confirmRemoveLibrary', { name })
      : t('tools.mcp.confirmRemove', { name });
    if (!await confirmAction(message, () => mounted.current, { title: t('tools.mcp.removeTitle'), confirmLabel: t('tools.agents.delete'), destructive: true })) return;
    setBusy(true); setError('');
    try {
      if (onTool) await native.removeNativeMcp({ ...target, enabled }, name);
      if (!inLibrary && draft.id && draft.expectedVersion !== null) await native.deleteMcpDefinition(draft.id, draft.expectedVersion);
      if (mounted.current) {
        setDefinitions(await native.listMcpDefinitions());
        setNativeEntries(await native.listNativeMcp(target).catch(() => []));
        setNotice(t('tools.mcp.deleted'));
        leaveComposer();
      }
    } catch (value) { if (mounted.current) setError(errorText(value)); }
    finally { if (mounted.current) setBusy(false); }
  }

  const head = (canAdd: boolean) => <div className={styles.head}><div><h2>{t('tools.mcp.title')}</h2><p>{t('tools.mcp.description')}</p></div>{canAdd && <button type="button" className={styles.primary} disabled={busy || (scope === 'project' && !project)} onClick={() => void startNew()}><Icon name="plus" size={14} strokeWidth={2.2} />{t('tools.mcp.add')}</button>}</div>;

  if (capabilityBlocked) {
    return <section className={styles.section} aria-label={t('tools.mcp.title')}>{head(false)}<StatusBanner tone="error">{capabilityBlocked}</StatusBanner><p className={styles.muted}>{t('tools.mcp.blocked')}</p></section>;
  }

  const banners = <>
    {!composing && notice && <StatusBanner tone="success" onDismiss={() => setNotice('')}>{notice}</StatusBanner>}
    {!composing && error && <StatusBanner tone="error" onDismiss={() => setError('')}>{error}</StatusBanner>}
  </>;

  return <section className={styles.section} aria-label={t('tools.mcp.title')}>
    {head(true)}
    {banners}
    {empty ? <div className={styles.empty}>
      <span className={styles.emptyIcon}><Icon name="connections" size={22} strokeWidth={1.5} /></span>
      <strong>{t('tools.mcp.emptyTitle')}</strong>
      <p>{t('tools.mcp.emptyDetail')}</p>
      {scope === 'project' && !project && <p className={styles.muted}>{t('tools.mcp.pickProjectFirst')}</p>}
    </div> : <div className={styles.listCard}>
      <div className={styles.listHead}>
        <strong>{needle ? t('tools.mcp.countFiltered', { filtered: shown.length, total: nativeEntries.length }) : t('tools.mcp.activeCount', { count: nativeEntries.length })}</strong>
        {nativeEntries.length >= SEARCH_THRESHOLD && <SearchField className={styles.search} type="search" label={t('tools.mcp.searchLabel')} placeholder={t('tools.mcp.searchPlaceholder')} value={search} onChange={setSearch} />}
      </div>
      {shown.length > 0 && <ul className={styles.entries}>{shown.map((item) => {
        const library = libraryFor(item.name);
        const summary = mcpSummary(item);
        return <li key={`native-${item.name}`}>
          <button type="button" className={styles.entry} title={t('tools.mcp.clickEdit')} onClick={() => void importNative(item)}>
            <span className={styles.entryIcon} data-transport={item.transport}><Icon name={item.transport === 'http' ? 'globe' : 'terminal'} size={16} /></span>
            <span className={styles.entryBody}>
              <span className={styles.entryTitle}>
                <strong>{item.name}</strong>
                <span className={styles.state} data-on={item.enabled || undefined}>{item.enabled ? t('tools.plugins.enabled') : t('tools.quota.disabled')}</span>
                {library && <span className={styles.chip} title={t('tools.mcp.inLibraryTitle')}>{t('tools.mcp.inLibrary')}</span>}
              </span>
              <small className={styles.summary}><span className={styles.transport}>{item.transport === 'http' ? 'HTTP' : 'stdio'}</span><span className={styles.command}>{summary || '—'}</span></small>
            </span>
            <span className={styles.chevron} aria-hidden="true"><Icon name="chevronRight" size={14} /></span>
          </button>
        </li>;
      })}</ul>}
      {!nativeEntries.length && <p className={styles.listEmpty}>{t('tools.mcp.listEmpty')}</p>}
      {nativeEntries.length > 0 && !shown.length && <p className={styles.listEmpty}>{t('tools.mcp.noMatch', { query: search.trim() })} <button type="button" className={styles.linkButton} onClick={() => setSearch('')}>{t('tools.mcp.clearSearch')}</button></p>}
    </div>}
    <GuideDialog open={composing} title={editing ? t('tools.mcp.editTitle') : t('tools.mcp.newTitle')} hint={t('tools.mcp.dialogHint')} onClose={() => void closeCompose()}>
      <div className={styles.panel}>
        {editing && linkedInLibrary && <p className={styles.linkedNote}><Icon name="info" size={14} />{t('tools.mcp.linkedNote', { name: linked?.name ?? draft.name })}</p>}
        <McpFormFields key={formKey} title={t('library.resources.connectionTitle')} draft={draft} onChange={setDraft} envRows={envRows} onEnvRowsChange={setEnvRows} headerRows={headerRows} onHeaderRowsChange={setHeaderRows} showIssues={showIssues} onImport={importJson} />
        <div className={styles.options}>
          <div className={styles.option}>
            <label><input type="checkbox" checked={enabled} aria-describedby={`${id}-enabled`} onChange={event => setEnabled(event.target.checked)} />{t('tools.mcp.enabledLabel')}</label>
            <small id={`${id}-enabled`}>{t('tools.mcp.enabledHint')}</small>
          </div>
          {!linkedInLibrary && <div className={styles.option}>
            <label><input type="checkbox" checked={syncLibrary} aria-describedby={`${id}-library`} onChange={(event) => setSyncLibrary(event.target.checked)} />{t('tools.mcp.alsoLibrary')}</label>
            <small id={`${id}-library`}>{t('tools.mcp.alsoLibraryHint')}</small>
          </div>}
        </div>
        {currentConflict && <div className={styles.conflict} role="group" aria-label={t('tools.mcp.conflictLabel')}>
          <strong><Icon name="alert" size={14} />{t('tools.mcp.conflictTitle')}</strong>
          {currentConflict.items.map(item => <div className={styles.diff} key={item.toolId}>
            <CodeEditor compact label={t('tools.mcp.conflictCurrent')} format="json" readOnly value={JSON.stringify(item.existing, null, 2)} />
            <CodeEditor compact label={t('tools.mcp.conflictNext')} format="json" readOnly value={JSON.stringify(item.proposed, null, 2)} />
          </div>)}
          <div className={styles.actions}><button type="button" onClick={() => setCurrentConflict(null)}>{t('common.conflict.keepCurrent')}</button><button type="button" className={styles.primary} disabled={busy} onClick={() => { setBusy(true); void applyItems(currentConflict.id, currentConflict.items, true).then(ok => { if (ok) leaveComposer(); }).catch(value => setError(errorText(value))).finally(() => setBusy(false)); }}>{t('tools.mcp.useNext')}</button></div>
        </div>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        {notice && <p className={styles.notice} role="status">{notice}</p>}
        <div className="dialog-footer">
          {editing && <button type="button" className={styles.dangerQuiet} disabled={busy} onClick={() => void removeSaved()}><Icon name="trash" size={14} />{t('tools.mcp.removeFromTool')}</button>}
          <span className="dialog-footer-gap" />
          <button type="button" className={styles.primary} data-dialog-save title={saveShortcutHint()} disabled={busy || !draft.name.trim() || (scope === 'project' && !project)} onClick={() => void save()}>{editing ? t('home.launcher.save') : t('tools.mcp.addSubmit')}</button>
        </div>
      </div>
    </GuideDialog>
  </section>;
}
