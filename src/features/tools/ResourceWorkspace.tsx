import { CodeEditor } from '../../components/CodeEditor';
import { open } from '@tauri-apps/plugin-dialog';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import type { Scope } from '../../types/native';
import type { McpDefinition, McpDraft, McpTargetRequest, McpTargetResult, NativeMcpEntry, NativeSkillEntry, SkillImportPreview, SkillInstallation, SkillPackage, SkillRecoveryIssue, SkillTargetPreview, SkillTargetResult } from '../../types/resources';
import { displayPath, shortPath } from '../../lib/paths';
import { GuideDialog } from '../../components/GuideDialog';
import { saveShortcutHint } from '../../lib/shortcut';
import { Icon } from '../../components/Icon';
import { StatusBanner } from '../../components/StatusBanner';
import i18n from '../../i18n';
import styles from './ResourceWorkspace.module.css';

function errorText(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : i18n.t('common.operationFailed');
}
function blank(): McpDraft {
  return { id: null, name: '', transport: 'stdio', command: '', args: [], url: '', env: {}, headers: {}, inLibrary: false, expectedVersion: null };
}
function draftOf(item: McpDefinition): McpDraft {
  return { id: item.id, name: item.name, transport: item.transport, command: item.command, args: item.args, url: item.url, env: item.env, headers: item.headers, inLibrary: item.inLibrary !== false, expectedVersion: item.version };
}
function lines(value: Record<string, string>): string {
  return Object.entries(value).map(([key, item]) => `${key}=${item}`).join('\n');
}
function parseLines(value: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const line of value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const equals = line.indexOf('=');
    if (equals < 1) throw new Error(i18n.t('tools.mcp.parseError'));
    output[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
  }
  return output;
}

export function McpWorkspace({ toolId, scope, projectPath, contextId, onDirtyChange }: { toolId: string; scope: Scope; projectPath: string; contextId?: string | null; onDirtyChange?: (dirty: boolean) => void }) {
  const { t } = useTranslation();
  const [definitions, setDefinitions] = useState<McpDefinition[]>([]);
  const [draft, setDraft] = useState<McpDraft>(blank);
  const [envText, setEnvText] = useState('');
  const [headerText, setHeaderText] = useState('');
  const [savedFingerprint, setSavedFingerprint] = useState(JSON.stringify([blank(), '', '',true]));
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
  const project = scope === 'project' ? projectPath || null : null;
  const dirty = JSON.stringify([draft, envText, headerText,enabled]) !== savedFingerprint;
  const latestForm = useRef(''); latestForm.current = JSON.stringify([draft, envText, headerText, enabled]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current=true;return () => { mounted.current=false; }; },[]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const previewContext = JSON.stringify([draft, envText, headerText, toolId, scope, project, enabled]);
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

  function select(item: McpDefinition, nextEnabled = true) {
    const next = draftOf(item);
    setNativeOrigin(null); setCurrentConflict(null); setComposing(true);
    setDraft(next); setEnvText(lines(item.env)); setHeaderText(lines(item.headers));
    setEnabled(nextEnabled);setSavedFingerprint(JSON.stringify([next, lines(item.env), lines(item.headers),nextEnabled]));
    latestForm.current=JSON.stringify([next,lines(item.env),lines(item.headers),nextEnabled]);
    setError('');
  }
  async function canReplace() {
    const started = previewEpochRef.current;
    return !dirty || confirmAction(t('tools.mcp.confirmDiscard'), () => mounted.current && started === previewEpochRef.current, { title: t('common.app.leaveDirtyTitle'), confirmLabel: t('common.app.leaveDirtyConfirm') });
  }
  async function importNative(item: NativeMcpEntry) {
    if (!await canReplace()) return;
    setNativeOrigin(item); setCurrentConflict(null); setComposing(true);
    const found = definitions.find((definition) => definition.name === item.name);
    const next: McpDraft = { id: found?.id ?? null, name: item.name, transport: item.transport, command: item.command, args: item.args, url: item.url,
      env: item.env, headers: item.headers, inLibrary: found?.inLibrary === true, expectedVersion: found?.version ?? null };
    setSavedFingerprint(JSON.stringify([next, lines(item.env), lines(item.headers),item.enabled]));
    setDraft(next);
    setEnvText(lines(item.env)); setHeaderText(lines(item.headers)); setEnabled(item.enabled);
    setNotice(item.protectedValues ? t('tools.mcp.protectedNotice') : t('tools.mcp.importedNotice'));
  }
  async function startNew() {
    if (!await canReplace()) return;
    setDraft(blank()); setEnvText(''); setHeaderText(''); setEnabled(true); setNativeOrigin(null); setCurrentConflict(null); setSyncLibrary(false);
    setSavedFingerprint(JSON.stringify([blank(), '', '', true])); setComposing(true); setNotice(''); setError('');
  }
  async function closeCompose() {
    if (!await canReplace()) return;
    const next = blank();
    setDraft(next); setEnvText(''); setHeaderText(''); setEnabled(true); setNativeOrigin(null); setCurrentConflict(null);
    setSavedFingerprint(JSON.stringify([next, '', '', true])); setComposing(false); setNotice(''); setError('');
  }
  function leaveComposer() {
    const next = blank();
    setDraft(next); setEnvText(''); setHeaderText(''); setEnabled(true); setNativeOrigin(null); setCurrentConflict(null);
    setSavedFingerprint(JSON.stringify([next, '', '', true])); setComposing(false);
  }
  async function applyItems(id: string, items: McpTargetResult[], replace: boolean) {
    const targets = items.filter(item => item.status === 'ready' || item.status === 'conflict').map((item): McpTargetRequest => ({ toolId: item.toolId, scope: item.scope,
      projectPath: item.projectPath, contextId: item.contextId ?? contextId, enabled, baselineHash: item.baselineHash, previewToken: item.previewToken, allowReplace: replace && item.status === 'conflict' }));
    const outcome = await native.distributeMcp(id, targets);
    setNativeEntries(await native.listNativeMcp(target)); setCurrentConflict(null);
    const written = outcome.every(item => item.status === 'written');
    setNotice(written ? t('tools.mcp.written') : t('tools.mcp.partialFailed'));
    return written;
  }
  async function save() {
    if (scope === 'project' && !project) { setError(t('tools.mcp.pickProject')); return; }
    const origin = nativeOrigin; const started = latestForm.current;
    const editing = !!(draft.id || nativeOrigin);
    const linked = definitions.find((item) => item.id === draft.id) ?? definitions.find((item) => item.name === draft.name.trim());
    const inLibrary = editing ? linked?.inLibrary !== false : syncLibrary || linked?.inLibrary === true;
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await native.saveMcpDefinition({ ...draft, id: linked?.id ?? draft.id, expectedVersion: linked?.version ?? draft.expectedVersion, inLibrary, env: parseLines(envText), headers: parseLines(headerText) });
      setDefinitions(await native.listMcpDefinitions());
      if (!mounted.current || started !== latestForm.current) { setNotice(t('tools.mcp.dirtyAgain')); return; }
      select(saved,enabled);
      const savedForm=JSON.stringify([draftOf(saved),lines(saved.env),lines(saved.headers),enabled]);
      const items = await native.previewMcpTargets(saved.id, [target]);
      const fresh = origin ? await native.listNativeMcp(target) : [];
      if (!mounted.current || savedForm!==latestForm.current) {setNotice(t('tools.mcp.savedKeepEditing'));return;}
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

  const head = (canAdd: boolean) => <div className={styles.workspaceHead}><div><h2>{t('tools.mcp.title')}</h2><p>{t('tools.mcp.description')}</p></div>{canAdd && <button type="button" className={styles.primary} disabled={busy || (scope === 'project' && !project)} onClick={() => void startNew()}><Icon name="plus" size={14} strokeWidth={2.2} />{t('tools.mcp.add')}</button>}</div>;

  if (capabilityBlocked) {
    return <section className={styles.workspaceSection} aria-label={t('tools.mcp.title')}>{head(false)}<StatusBanner tone="error">{capabilityBlocked}</StatusBanner><p className={styles.muted}>{t('tools.mcp.blocked')}</p></section>;
  }

  if (empty) {
    return <section className={styles.workspaceSection} aria-label={t('tools.mcp.title')}>
      {head(true)}
      {notice && <StatusBanner tone="success" onDismiss={() => setNotice('')}>{notice}</StatusBanner>}
      {error && <StatusBanner tone="error" onDismiss={() => setError('')}>{error}</StatusBanner>}
      <div className={styles.emptyState}><Icon name="connections" size={26} strokeWidth={1.4} /><strong>{t('tools.mcp.emptyTitle')}</strong><p>{t('tools.mcp.emptyDetail')}</p>{scope === 'project' && !project && <p className={styles.muted}>{t('tools.mcp.pickProjectFirst')}</p>}</div>
    </section>;
  }

  return <section className={styles.workspaceSection} aria-label={t('tools.mcp.title')}>
    {head(true)}
    {!composing && notice && <StatusBanner tone="success" onDismiss={() => setNotice('')}>{notice}</StatusBanner>}
    {!composing && error && <StatusBanner tone="error" onDismiss={() => setError('')}>{error}</StatusBanner>}
    <div className={styles.layout}>
    <aside className={styles.list}>
      <div className={styles.listHead}><strong>{t('tools.mcp.activeCount', { count: nativeEntries.length })}</strong></div>
      {nativeEntries.map((item) => <button key={`native-${item.name}`} type="button" title={t('tools.mcp.clickEdit')} onClick={() => void importNative(item)}><strong>{item.name}<span className={styles.state} data-on={item.enabled || undefined}>{item.enabled ? t('tools.plugins.enabled') : t('tools.quota.disabled')}</span></strong><small className={styles.mono}>{(item.transport === 'http' ? item.url : [item.command, ...item.args].join(' ')) || item.transport}{item.protectedValues ? t('tools.mcp.credentialsHidden') : ''}</small></button>)}
      {!nativeEntries.length && <p>{t('tools.mcp.listEmpty')}</p>}
    </aside>
    <GuideDialog open={composing} title={draft.id || nativeOrigin ? t('tools.mcp.editTitle') : t('tools.mcp.add')} hint={t('tools.mcp.dialogHint')} onClose={() => void closeCompose()}>
    <div className={styles.panel}>
      <label>{t('tools.mcp.name')}<input aria-label={t('tools.mcp.nameAria')} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t('tools.mcp.namePlaceholder')} /></label>
      <div className={styles.typeField}><span>{t('tools.mcp.type')}</span><div className={styles.typeSwitch} role="radiogroup" aria-label={t('tools.mcp.transport')}>{([['http', 'HTTP'], ['stdio', 'stdio']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={draft.transport === value} onClick={() => setDraft({ ...draft, transport: value })}>{label}</button>)}</div></div>
      {draft.transport === 'stdio' ? <>
        <label>{t('tools.mcp.command')}<input aria-label={t('tools.mcp.command')} value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx" /></label>
        <label>{t('tools.mcp.args')}<textarea rows={3} value={draft.args.join('\n')} onChange={(event) => setDraft({ ...draft, args: event.target.value.split('\n').filter(Boolean) })} placeholder={'-y\nchrome-devtools-mcp@latest'} /></label>
        <label>{t('tools.mcp.env')}<textarea rows={4} value={envText} onChange={(event) => setEnvText(event.target.value)} placeholder={'KEY=value\nAPI_TOKEN=${API_TOKEN}'} /></label>
      </> : <>
        <label>URL<input aria-label={t('tools.mcp.urlAria')} value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp" /></label>
        <label>{t('tools.mcp.headers')}<textarea rows={4} value={headerText} onChange={(event) => setHeaderText(event.target.value)} placeholder="Authorization=Bearer ${API_TOKEN}" /></label>
      </>}
      <label className={styles.inline}><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />{t('tools.plugins.action.enable')}</label>
      {!(draft.id || nativeOrigin) && <label className={styles.inline}><input type="checkbox" checked={syncLibrary} onChange={(event) => setSyncLibrary(event.target.checked)} />{t('tools.mcp.quickSync')}<small className={styles.fieldHint}>{t('tools.mcp.quickSyncHint')}</small></label>}
      {currentConflict && <div className={styles.resultList} role="group" aria-label={t('tools.mcp.conflictLabel')}><strong>{t('tools.mcp.conflictTitle')}</strong>{currentConflict.items.map(item => <div className={styles.fileDiff} key={item.toolId}><CodeEditor compact label={t('tools.mcp.conflictCurrent')} format="json" readOnly value={JSON.stringify(item.existing, null, 2)} /><CodeEditor compact label={t('tools.mcp.conflictNext')} format="json" readOnly value={JSON.stringify(item.proposed, null, 2)} /></div>)}<div className={styles.actions}><button type="button" onClick={() => setCurrentConflict(null)}>{t('common.conflict.keepCurrent')}</button><button type="button" disabled={busy} onClick={() => { setBusy(true); void applyItems(currentConflict.id, currentConflict.items, true).then(ok => { if (ok) leaveComposer(); }).catch(value => setError(errorText(value))).finally(() => setBusy(false)); }}>{t('tools.mcp.useNext')}</button></div></div>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      <div className="dialog-footer">{(draft.id || nativeOrigin) && <button type="button" disabled={busy} onClick={() => void removeSaved()}>{t('tools.mcp.removeFromTool')}</button>}<span className="dialog-footer-gap" /><button type="button" className={styles.primary} data-dialog-save title={saveShortcutHint()} disabled={busy || !draft.name.trim() || (scope === 'project' && !project)} onClick={() => void save()}>{draft.id || nativeOrigin ? t('home.launcher.save') : t('tools.mcp.addSubmit')}</button></div>
    </div>
    </GuideDialog>
  </div>
  </section>;
}

export function SkillsWorkspace({ toolId, scope, projectPath, contextId, onDirtyChange }: { toolId: string; scope: Scope; projectPath: string; contextId?: string | null; onDirtyChange?: (dirty: boolean) => void }) {
  const { t } = useTranslation();
  const [packages, setPackages] = useState<SkillPackage[]>([]);
  const [nativeEntries, setNativeEntries] = useState<NativeSkillEntry[]>([]);
  const [recoveryIssues, setRecoveryIssues] = useState<SkillRecoveryIssue[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installations, setInstallations] = useState<SkillInstallation[]>([]);
  const [url, setUrl] = useState('');
  const [archiveSelection, setArchiveSelection] = useState<{ source: string; local: boolean; entries: string[]; chosen: string | null } | null>(null);
  const [pendingImport, setPendingImport] = useState<{ preview: SkillImportPreview; kind: 'local' | 'zip' | 'local_zip'; source: string; subdirectory: string | null; installAfter: boolean } | null>(null);
  const [dependencyChecked, setDependencyChecked] = useState(false);
  const [skillEnabled, setSkillEnabled] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<SkillTargetPreview | null>(null);
  const [adding, setAdding] = useState(false);
  const [guide, setGuide] = useState(false);
  const [syncLibrary, setSyncLibrary] = useState(false);
  const [external, setExternal] = useState<NativeSkillEntry | null>(null);
  useLayoutEffect(() => { onDirtyChange?.(!!url.trim() || !!archiveSelection || !!pendingImport || adding); }, [url, archiveSelection, pendingImport, adding, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SkillTargetResult | null>(null);
  useEffect(() => {
    if (!result || result.status === 'failed') return;
    const timer = window.setTimeout(() => setResult(null), 5000);
    return () => window.clearTimeout(timer);
  }, [result]);
  const selected = packages.find((item) => item.id === selectedId);
  const project = scope === 'project' ? projectPath || null : null;
  const visibleIssues = recoveryIssues.filter((issue) => issue.toolId === toolId && (issue.scope === 'project' || (issue.contextId ?? null) === (contextId ?? null)));
  const empty = !nativeEntries.length && !adding && !guide && !pendingImport && !archiveSelection;
  useEffect(() => { setPendingTarget(null); }, [toolId, scope, project, selectedId]);
  useEffect(() => {
    let live = true;
    void native.listSkillRecoveryIssues().then((issues) => { if (live) setRecoveryIssues(issues); })
      .catch((value) => { if (live) setError(errorText(value)); });
    return () => { live = false; };
  }, [toolId, scope, project]);
  useEffect(() => {
    if (!toolId || (scope === 'project' && !project)) { setNativeEntries([]); return; }
    let live = true;
    void native.scanNativeSkills(toolId, scope, project).then((entries) => { if (live) setNativeEntries(entries); })
      .catch((value) => { if (live) setError(errorText(value)); });
    return () => { live = false; };
  }, [toolId, scope, project]);
  const installed = installations.find((item) => item.toolId === toolId && item.scope === scope && item.projectPath === project && (item.contextId ?? null) === (scope === 'global' ? contextId ?? null : null));
  useEffect(() => { void native.listSkillPackages().then(setPackages).catch((value) => setError(errorText(value))); }, []);
  useEffect(() => {
    if (!selectedId) return;
    let live = true;
    void Promise.all([native.listSkillInstallations(selectedId),native.getSkillEnabled(selectedId,toolId,scope,project)]).then(([items,enabled]) => { if (live) {setInstallations(items);setSkillEnabled(enabled);} })
      .catch((value) => { if (live) setError(errorText(value)); });
    return () => { live = false; };
  }, [selectedId, toolId, scope, project]);

  async function installPackage(packageId: string) {
    if (scope === 'project' && !project) { setError(t('tools.skills.pickProjectFirst')); return; }
    const item = (await native.listSkillPackages()).find((entry) => entry.id === packageId);
    if (!item) return;
    if (item.compatibility && !dependencyChecked) { setError(t('tools.skills.dependencyFirst')); setSelectedId(packageId); return; }
    const targetPreview = await native.previewSkillTarget(packageId, toolId, scope, project);
    if (targetPreview.status === 'conflict') { setPendingTarget(targetPreview); setSelectedId(packageId); return; }
    const outcome = await native.installSkill(packageId, toolId, scope, project, targetPreview.previewToken, false);
    setResult(outcome);
    setInstallations(await native.listSkillInstallations(packageId));
    setNativeEntries(await native.scanNativeSkills(toolId, scope, project));
    setSkillEnabled(await native.getSkillEnabled(packageId, toolId, scope, project));
    setRecoveryIssues(await native.listSkillRecoveryIssues());
    if (outcome.status !== 'failed') { setGuide(false); setAdding(false); }
  }

  async function place(item: SkillPackage, existed: boolean) {
    if (syncLibrary) await native.setSkillInLibrary(item.id, true);
    else if (!existed) await native.setSkillInLibrary(item.id, false);
    await finishImported(item, true);
  }

  async function finishImported(item: SkillPackage, installAfter: boolean) {
    setPackages(await native.listSkillPackages());
    setSelectedId(item.id);
    setResult(null);
    setAdding(false);
    if (installAfter) await installPackage(item.id);
    else setGuide(false);
  }

  async function local() {
    try {
      const source = await open({ directory: true, multiple: false, title: t('tools.skills.pickDirTitle') });
      if (typeof source !== 'string') return;
      setBusy(true); setError('');
      const preview = await native.previewSkillLocal(source);
      if (preview.existingDigest && preview.existingDigest !== preview.digest) {
        setPendingImport({ preview, kind: 'local', source, subdirectory: null, installAfter: true }); return;
      }
      const item = await native.importSkillLocal(source, preview.digest, preview.existingDigest);
      await place(item, !!preview.existingDigest);
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function archive(source: string, localZip: boolean, chosen?: string) {
    setBusy(true); setError('');
    try {
      let child = chosen ?? null;
      if (chosen === undefined) {
        const entries = await native.listSkillZipEntries(source, localZip);
        if (entries.length > 1) { setArchiveSelection({ source, local: localZip, entries, chosen: null }); return; }
        child = entries[0] || null;
      }
      const preview = localZip ? await native.previewSkillLocalZip(source, child) : await native.previewSkillHttpsZip(source, child);
      if (preview.existingDigest && preview.existingDigest !== preview.digest) {
        setPendingImport({ preview, kind: localZip ? 'local_zip' : 'zip', source, subdirectory: child, installAfter: true }); setArchiveSelection(null); return;
      }
      const item = localZip ? await native.importSkillLocalZip(source, child, preview.digest, preview.existingDigest) : await native.importSkillHttpsZip(source, child, preview.digest, preview.existingDigest);
      await place(item, !!preview.existingDigest);
      if (!localZip) setUrl('');
      setArchiveSelection(null);
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function localZip() {
    try {
      const source = await open({ directory: false, multiple: false, title: t('tools.skills.pickZipTitle'), filters: [{ name: 'ZIP', extensions: ['zip'] }] });
      if (typeof source === 'string') await archive(source, true);
    } catch (value) { setError(errorText(value)); }
  }
  async function confirmImport() {
    if (!pendingImport) return;
    setBusy(true); setError('');
    try {
      const { preview, kind, source, subdirectory, installAfter } = pendingImport;
      const item = kind === 'local'
        ? await native.importSkillLocal(source, preview.digest, preview.existingDigest)
        : kind === 'local_zip' ? await native.importSkillLocalZip(source, subdirectory, preview.digest, preview.existingDigest)
        : await native.importSkillHttpsZip(source, subdirectory, preview.digest, preview.existingDigest);
      setPendingImport(null);
      if (kind === 'zip') setUrl('');
      if (installAfter) await place(item, !!preview.existingDigest);
      else { await native.setSkillInLibrary(item.id, true); setGuide(false); setExternal(null); setResult({ toolId, scope, projectPath: project, path: item.name, status: 'installed', detail: t('tools.skills.addedToLibrary') }); }
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function openNative(entry: NativeSkillEntry) {
    if (entry.state === 'unreadable') { setError(entry.detail); return; }
    setAdding(false);
    setExternal(entry.packageId ? null : entry);
    setSelectedId(entry.packageId);
    setGuide(true);
  }
  async function syncExternal() {
    if (!external) return;
    setBusy(true); setError('');
    try {
      const preview = await native.previewSkillLocal(external.path);
      if (preview.existingDigest && preview.existingDigest !== preview.digest) {
        setPendingImport({ preview, kind: 'local', source: external.path, subdirectory: null, installAfter: false }); return;
      }
      const item = await native.importSkillLocal(external.path, preview.digest, preview.existingDigest);
      await native.setSkillInLibrary(item.id, true);
      setResult({ toolId, scope, projectPath: project, path: item.name, status: 'installed', detail: t('tools.skills.addedToLibrary') });
      setGuide(false); setExternal(null);
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function change(remove: boolean) {
    if (!selected) return;
    if (scope === 'project' && !project) { setError(t('tools.skills.pickProjectFirst')); return; }
    if (!remove && selected.compatibility && !dependencyChecked) { setError(t('tools.skills.dependencyFirst')); return; }
    setBusy(true); setError(''); setResult(null);
    try {
      const targetPreview = !remove ? pendingTarget ?? await native.previewSkillTarget(selected.id, toolId, scope, project) : null;
      if (!remove && !pendingTarget && targetPreview?.status === 'conflict') { setPendingTarget(targetPreview); return; }
      const outcome = remove ? await native.removeSkill(selected.id, toolId, scope, project, contextId)
        : await native.installSkill(selected.id, toolId, scope, project, targetPreview?.previewToken ?? null, targetPreview?.status === 'conflict');
      setResult(outcome);
      setPendingTarget(null);
      setInstallations(await native.listSkillInstallations(selected.id));
      setNativeEntries(await native.scanNativeSkills(toolId, scope, project));
      setSkillEnabled(await native.getSkillEnabled(selected.id,toolId,scope,project));
      setRecoveryIssues(await native.listSkillRecoveryIssues());
      if (outcome.status !== 'failed') { setGuide(false); setAdding(false); }
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function toggleSkill(next: boolean) {
    if (!selected) return; setBusy(true);setError('');
    try {await native.setSkillEnabled(selected.id,toolId,scope,project,next,contextId);setSkillEnabled(await native.getSkillEnabled(selected.id,toolId,scope,project));setInstallations(await native.listSkillInstallations(selected.id));setNativeEntries(await native.scanNativeSkills(toolId,scope,project));}
    catch(value){setError(errorText(value));}finally{setBusy(false);}
  }
  async function checkRecovery() {
    try { setRecoveryIssues(await native.listSkillRecoveryIssues()); setError(''); }
    catch (value) { setError(errorText(value)); }
  }

  const recovery = !!visibleIssues.length && <div className={styles.error} role="alert"><strong>{t('tools.skills.recoveryTitle')}</strong><p>{t('tools.skills.recoveryDetail')}</p>{visibleIssues.map((issue) => <div key={issue.operationId} className={styles.fileChange}><strong>{issue.scope === 'global' ? t('tools.apply.global') : t('tools.skills.recoveryProject', { path: issue.projectPath ?? '' })}</strong><p>{issue.detail}</p><p>{t('tools.skills.recoveryTarget', { path: issue.targetPath })}</p><p>{t('tools.skills.recoveryBackup', { path: issue.backupPath })}</p><button type="button" onClick={() => void navigator.clipboard.writeText(issue.backupPath).catch((value) => setError(errorText(value)))}>{t('tools.skills.recoveryCopy')}</button></div>)}<button type="button" onClick={() => void checkRecovery()}>{t('tools.skills.recoveryRecheck')}</button></div>;
  const outcome = result && (result.status === 'failed' ? result.detail : result.detail === t('tools.skills.addedToLibrary') ? t('tools.skills.addedToLibraryNote') : result.status === 'removed' ? t('tools.skills.removed', { path: result.path ?? '' }) : t('tools.skills.installed', { path: result.path ?? '' }));
  const installState: { label: string; tone: 'on' | 'warn' | undefined } = installed?.state === 'current' ? { label: t('tools.skills.stateInstalled'), tone: 'on' }
    : installed?.state === 'update_available' ? { label: t('tools.skills.stateUpdate'), tone: 'warn' }
    : installed?.state === 'conflict' ? { label: t('tools.skills.stateConflict'), tone: 'warn' }
    : installed?.state === 'disabled' ? { label: t('tools.skills.stateDisabled'), tone: undefined }
    : installed?.state === 'missing' ? { label: t('tools.skills.stateMissing'), tone: 'warn' }
    : { label: t('tools.skills.stateNotInstalled'), tone: undefined };

  const head = <div className={styles.workspaceHead}><div><h2>Skill</h2><p>{t('tools.skills.description')}</p></div><button type="button" className={styles.primary} disabled={busy || (scope === 'project' && !project)} onClick={() => { setAdding(true); setSyncLibrary(false); setExternal(null); setGuide(true); }}><Icon name="plus" size={14} strokeWidth={2.2} />{t('tools.skills.add')}</button></div>;

  if (empty) {
    return <section className={styles.workspaceSection} aria-label="Skill">
      {head}
      {recovery}
      {outcome && <StatusBanner tone={result?.status === 'failed' ? 'warning' : 'success'} onDismiss={() => setResult(null)}>{outcome}</StatusBanner>}
      {error && <StatusBanner tone="error" onDismiss={() => setError('')}>{error}</StatusBanner>}
      <div className={styles.emptyState}><Icon name="sparkle" size={26} strokeWidth={1.4} /><strong>{t('tools.skills.emptyTitle')}</strong><p>{t('tools.skills.emptyDetail')}</p>{scope === 'project' && !project && <p className={styles.muted}>{t('tools.mcp.pickProjectFirst')}</p>}</div>
    </section>;
  }

  return <section className={styles.workspaceSection} aria-label="Skill">
    {head}
    {recovery}
    {!guide && outcome && <StatusBanner tone={result?.status === 'failed' ? 'warning' : 'success'} onDismiss={() => setResult(null)}>{outcome}</StatusBanner>}
    {!guide && error && <StatusBanner tone="error" onDismiss={() => setError('')}>{error}</StatusBanner>}
    <div className={styles.layout}>
    <aside className={styles.list}>
      <div className={styles.listHead}><strong>{t('tools.mcp.activeCount', { count: nativeEntries.length })}</strong></div>
      {nativeEntries.map((entry) => <button type="button" key={entry.path} title={entry.state === 'unreadable' ? entry.detail : entry.path} onClick={() => void openNative(entry)}><strong>{entry.name}<span className={styles.state} data-on={entry.state === 'managed' || undefined} data-warn={entry.state === 'unreadable' || undefined}>{entry.state === 'managed' ? t('tools.skills.stateInstalled') : entry.state === 'external' ? t('tools.skills.stateExternal') : t('tools.skills.stateUnreadable')}</span></strong><small className={styles.mono}>{displayPath(entry.path)}</small></button>)}
      {!nativeEntries.length && <p>{t('tools.skills.listEmpty')}</p>}
    </aside>
    <GuideDialog open={guide} title={adding ? t('tools.skills.add') : t('tools.skills.currentTitle')} hint={adding ? t('tools.skills.addHint') : t('tools.skills.currentHint')} onClose={() => { setGuide(false); setAdding(false); setSyncLibrary(false); setExternal(null); setArchiveSelection(null); setPendingImport(null); }}>
    <div className={styles.panel}>
      {!adding && <div className={styles.heading}><div><small>Skill</small><h2>{selected?.name ?? 'Skill'}</h2></div></div>}
      {adding && <>
        <label className={styles.inline}><input type="checkbox" checked={syncLibrary} onChange={(event) => setSyncLibrary(event.target.checked)} />{t('tools.mcp.quickSync')}<small className={styles.fieldHint}>{t('tools.mcp.quickSyncHint')}</small></label>
        <div className={styles.sources}>
          <button type="button" aria-label={t('tools.skills.pickFolder')} disabled={busy} onClick={() => void local()}><strong>{t('tools.skills.pickFolder')}</strong><span>{t('tools.skills.pickFolderHint')}</span></button>
          <button type="button" aria-label={t('tools.skills.importZip')} disabled={busy} onClick={() => void localZip()}><strong>{t('tools.skills.importZip')}</strong><span>{t('tools.skills.importZipHint')}</span></button>
        </div>
        <label className={styles.urlField}>{t('tools.skills.zipUrl')}<span className={styles.urlRow}><input aria-label={t('tools.skills.zipUrlAria')} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/skill.zip" /><button type="button" disabled={busy || !url.trim()} onClick={() => void archive(url.trim(), false)}>{t('tools.skills.importUrl')}</button></span></label>
      </>}
      {external && !adding && <div className={styles.addChooser}><p className={styles.muted}>{t('tools.skills.externalNote')}</p><button type="button" className={styles.primary} disabled={busy} onClick={() => void syncExternal()}>{t('tools.skills.addToLibrary')}</button></div>}
      {outcome && <p role="status" className={result?.status === 'failed' ? styles.error : styles.notice}>{outcome}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {selected && !adding && <>
        <p className={styles.muted}>{selected.description || t('tools.skills.fullPackage')} · {t('tools.skills.fileCount', { count: selected.fileCount })}</p><details className={styles.source}><summary title={displayPath(selected.source)}>{t('tools.skills.sourceLabel', { source: shortPath(selected.source) })}</summary><p>{displayPath(selected.source)}</p></details>
        {selected.compatibility && <label className={styles.inline}><input type="checkbox" checked={dependencyChecked} onChange={(event) => setDependencyChecked(event.target.checked)} />{t('tools.skills.compatibilityChecked', { requirement: selected.compatibility })}</label>}
        <label className={styles.inline}><input type="checkbox" aria-label={t('tools.skills.enableAria')} checked={skillEnabled} disabled={busy || !installed && !nativeEntries.some(item=>item.name===selected.name) && !skillEnabled} onChange={event => void toggleSkill(event.target.checked)} />{skillEnabled ? t('tools.skills.enabledNote') : t('tools.skills.disabledNote')}</label>
        <p className={styles.muted}><span className={styles.state} data-on={installState.tone === 'on' || undefined} data-warn={installState.tone === 'warn' || undefined}>{installState.label}</span>{skillEnabled ? t('tools.skills.enabledHint') : t('tools.skills.disabledHint')}</p>
        {pendingTarget && <div className={styles.resultList} role="group" aria-label={t('tools.skills.previewLabel')}><strong>{pendingTarget.status === 'conflict' ? t('tools.skills.conflictTitle') : t('tools.skills.confirmTitle')}</strong><p>{pendingTarget.detail} · {pendingTarget.path}</p>
          {pendingTarget.changes.map((change) => <details key={change.path} className={styles.fileChange}><summary>{change.path}</summary><div className={styles.fileDiff}><div><strong>{t('tools.skills.currentLabel')}</strong>{change.before !== null ? <pre>{change.before}</pre> : <small>{change.beforeSize === null ? t('tools.skills.notExists') : t('tools.skills.fileMeta', { size: change.beforeSize, digest: change.beforeDigest })}</small>}</div><div><strong>{t('tools.skills.afterLabel')}</strong>{change.after !== null ? <pre>{change.after}</pre> : <small>{change.afterSize === null ? t('tools.agents.delete') : t('tools.skills.fileMeta', { size: change.afterSize, digest: change.afterDigest })}</small>}</div></div></details>)}
          <div className={styles.actions}><button type="button" onClick={() => setPendingTarget(null)}>{t('common.dialog.cancel')}</button><button type="button" className={styles.primary} disabled={busy} onClick={() => void change(false)}>{pendingTarget.status === 'conflict' ? t('tools.skills.confirmTakeover') : t('tools.skills.confirmInstall')}</button></div>
        </div>}
        <div className="dialog-footer">{installed && <button type="button" disabled={busy} onClick={() => void change(true)}>{t('tools.mcp.removeFromTool')}</button>}<span className="dialog-footer-gap" />{installed?.state === 'update_available' && <button type="button" className={styles.primary} disabled={busy || (scope === 'project' && !project)} onClick={() => void change(false)}>{t('tools.skills.updateToScope')}</button>}</div>
      </>}
      {archiveSelection && <div className={styles.distribution}><label>{t('tools.skills.archiveLabel')}<select aria-label={t('tools.skills.archiveAria')} value={archiveSelection.chosen ?? '__choose__'} onChange={event => setArchiveSelection({ ...archiveSelection, chosen: event.target.value === '__choose__' ? null : event.target.value })}><option value="__choose__">{t('tools.skills.archivePlaceholder')}</option>{archiveSelection.entries.map(entry => <option key={entry} value={entry}>{entry || t('tools.skills.archiveRoot')}</option>)}</select></label><div className={styles.actions}><button type="button" onClick={() => setArchiveSelection(null)}>{t('common.dialog.cancel')}</button><button type="button" disabled={busy || archiveSelection.chosen === null} onClick={() => void archive(archiveSelection.source, archiveSelection.local, archiveSelection.chosen ?? undefined)}>{t('tools.skills.archiveImport')}</button></div></div>}
      {pendingImport && <div className={styles.resultList} role="group" aria-label={t('tools.skills.importLabel')}>
        <strong>{t('tools.skills.importTitle', { name: pendingImport.preview.name })}</strong>
        <p>{pendingImport.installAfter ? t('tools.skills.importInstallNote') : t('tools.skills.importLibraryNote')}</p>
        <p>{t('tools.skills.importSource', { source: pendingImport.preview.source, count: pendingImport.preview.fileCount })}</p>
        {pendingImport.preview.compatibility && <p>{t('tools.skills.importCompat', { requirement: pendingImport.preview.compatibility })}</p>}
        <p>{t('tools.skills.importChangesNote')}</p>
        {pendingImport.preview.changes.map((change) => <details key={change.path} className={styles.fileChange}>
          <summary>{change.path}</summary>
          <div className={styles.fileDiff}>
            <div><strong>{t('tools.skills.currentLabel')}</strong>{change.before !== null ? <pre>{change.before}</pre> : <small>{change.beforeSize === null ? t('tools.skills.notExists') : t('tools.skills.fileMeta', { size: change.beforeSize, digest: change.beforeDigest })}</small>}</div>
            <div><strong>{t('tools.skills.importAfterLabel')}</strong>{change.after !== null ? <pre>{change.after}</pre> : <small>{change.afterSize === null ? t('tools.agents.delete') : t('tools.skills.fileMeta', { size: change.afterSize, digest: change.afterDigest })}</small>}</div>
          </div>
        </details>)}
        <div className={styles.actions}><button type="button" onClick={() => setPendingImport(null)}>{t('tools.skills.importCancel')}</button><button type="button" className={styles.primary} disabled={busy} onClick={() => void confirmImport()}>{pendingImport.installAfter ? t('tools.skills.importConfirmInstall') : t('tools.skills.importConfirmLibrary')}</button></div>
      </div>}
    </div>
    </GuideDialog>
  </div>
  </section>;
}
