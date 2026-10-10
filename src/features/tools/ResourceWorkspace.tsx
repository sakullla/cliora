import type { FeedbackOperation } from '../../lib/notifications';
import { useFeedback, FeedbackRegion } from '../../components/Feedback';
import { ResourceList } from '../../components/resources/ResourceList';
import { ResourceBatch, type BatchJob } from '../../components/resources/ResourceBatch';
import { McpDocumentPanel } from '../../components/resources/McpDocumentPanel';
import { McpPaste } from '../../components/resources/McpPaste';
import { readResourceStates } from '../../lib/resources';
import { writeClipboard } from '../../lib/clipboard';
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
function keptArgs(args: string[]) {
  return args.map((item) => item.trim()).filter((item) => item.length > 0);
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
  const [configOpen, setConfigOpen] = useState(false);
  const [configDirty, setConfigDirty] = useState(false);
  const [addedName, setAddedName] = useState<string | null>(null);
  const [batchAction, setBatchAction] = useState('disable');
  const [draft, setDraft] = useState<McpDraft>(blank);
  const [envText, setEnvText] = useState('');
  const [headerText, setHeaderText] = useState('');
  const [savedFingerprint, setSavedFingerprint] = useState(JSON.stringify([blank(), '', '',true]));
  const [nativeEntries, setNativeEntries] = useState<NativeMcpEntry[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [nativeOrigin, setNativeOrigin] = useState<NativeMcpEntry | null>(null);
  const [currentConflict, setCurrentConflict] = useState<{ id: string; items: McpTargetResult[]; generation: number; revision: number; form: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const feedback = useFeedback(JSON.stringify(['mcp', toolId, scope, projectPath, contextId]));
  const [capabilityBlocked, setCapabilityBlocked] = useState('');
  const [composing, setComposing] = useState(false);
  const [syncLibrary, setSyncLibrary] = useState(false);
  const project = scope === 'project' ? projectPath || null : null;
  const formDirty = JSON.stringify([draft, envText, headerText,enabled]) !== savedFingerprint;
  const dirty = formDirty || configDirty;
  const editorGeneration = useRef(0);
  const editorRevision = useRef(0);
  const latestForm = useRef(''); latestForm.current = JSON.stringify([draft, envText, headerText, enabled]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current=true;return () => { mounted.current=false; }; },[]);
  const previewContext = JSON.stringify([draft, envText, headerText, toolId, scope, project, enabled]);
  const previewEpochRef = useRef({ context: previewContext, epoch: 0 });
  if (previewEpochRef.current.context !== previewContext) {
    previewEpochRef.current = { context: previewContext, epoch: previewEpochRef.current.epoch + 1 };
  }
  useLayoutEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
  const target = useMemo<McpTargetRequest>(() => ({ toolId, scope, projectPath: project, enabled, contextId }), [toolId, scope, project, enabled, contextId]);

  useEffect(() => {
    const result = feedback.begin('definitions'); void native.listMcpDefinitions().then(value => { setDefinitions(value); result.complete(); }).catch(value => result.error(errorText(value)));
  }, []);
  useEffect(() => {
    if (!toolId || (scope === 'project' && !project)) { setNativeEntries([]); setCapabilityBlocked(''); return; }
    let live = true;
    setCapabilityBlocked('');
    void native.listNativeMcp(target).then((value) => { if (live) { setNativeEntries(value); setCapabilityBlocked(''); } })
      .catch((value) => { if (live) { setNativeEntries([]); setCapabilityBlocked(errorText(value)); } });
    return () => { live = false; };
  }, [target, toolId, scope, project]);


  function select(item: McpDefinition, nextEnabled = true) {
    const next = draftOf(item);
    setNativeOrigin(null); setCurrentConflict(null); setComposing(true);
    setDraft(next); setEnvText(lines(item.env)); setHeaderText(lines(item.headers));
    setEnabled(nextEnabled);setSavedFingerprint(JSON.stringify([next, lines(item.env), lines(item.headers),nextEnabled]));
    latestForm.current=JSON.stringify([next,lines(item.env),lines(item.headers),nextEnabled]);
    }
  async function canReplace() {
    const started = previewEpochRef.current;
    return !dirty || confirmAction(t('tools.mcp.confirmDiscard'), () => mounted.current && started === previewEpochRef.current, { title: t('common.app.leaveDirtyTitle'), confirmLabel: t('common.app.leaveDirtyConfirm') });
  }
  async function importNative(item: NativeMcpEntry) {
    const operationFeedback = feedback.begin('importNative:' + item.name);
    if (!await canReplace()) return;
    editorGeneration.current++;
    setNativeOrigin(item); setCurrentConflict(null); setComposing(true);
    const found = definitions.find((definition) => definition.name === item.name);
    const next: McpDraft = { id: found?.id ?? null, name: item.name, transport: item.transport, command: item.command, args: item.args, url: item.url,
      env: item.env, headers: item.headers, inLibrary: found?.inLibrary === true, expectedVersion: found?.version ?? null };
    setSavedFingerprint(JSON.stringify([next, lines(item.env), lines(item.headers),item.enabled]));
    setDraft(next);
    setEnvText(lines(item.env)); setHeaderText(lines(item.headers)); setEnabled(item.enabled);
    operationFeedback.success(t('tools.mcp.importedNotice'));
  }
  async function startNew() {
    if (!await canReplace()) return;
    editorGeneration.current++;
    setDraft(blank()); setEnvText(''); setHeaderText(''); setEnabled(true); setNativeOrigin(null); setCurrentConflict(null); setSyncLibrary(false);
    setSavedFingerprint(JSON.stringify([blank(), '', '', true])); setComposing(true); }
  async function closeCompose() {
    if (!await canReplace()) return;
    editorGeneration.current++; setConfigDirty(false); setConfigOpen(false);
    const next = blank();
    setDraft(next); setEnvText(''); setHeaderText(''); setEnabled(true); setNativeOrigin(null); setCurrentConflict(null);
    setSavedFingerprint(JSON.stringify([next, '', '', true])); setComposing(false); }
  function leaveComposer() {
    editorGeneration.current++; setConfigDirty(false); setConfigOpen(false);
    const next = blank();
    setDraft(next); setEnvText(''); setHeaderText(''); setEnabled(true); setNativeOrigin(null); setCurrentConflict(null);
    setSavedFingerprint(JSON.stringify([next, '', '', true])); setComposing(false);
  }
  async function applyItems(id: string, items: McpTargetResult[], replace: boolean, operationFeedback: FeedbackOperation, current: () => boolean) {
    const targets = items.filter(item => item.status === 'ready' || item.status === 'conflict').map((item): McpTargetRequest => ({ toolId: item.toolId, scope: item.scope,
      projectPath: item.projectPath, contextId: item.contextId ?? contextId, enabled, baselineHash: item.baselineHash, previewToken: item.previewToken, allowReplace: replace && item.status === 'conflict' }));
    const outcome = await native.distributeMcp(id, targets);
    const written = outcome.every(item => item.status === 'written');
    const savedNotice = t('tools.mcp.definitionSaved');
    const failures = outcome.filter(item => item.status !== 'written').map(item => item.detail).join(' · ');
    function report(result: FeedbackOperation, readFailure?: unknown) {
      const summary = written ? t('tools.mcp.written') : `${savedNotice} ${t('tools.mcp.partialFailed')}`;
      if (readFailure === undefined) {
        if (written) result.success(summary);
        else result.partial(summary, { detail: failures });
        return;
      }
      result.partial(summary, { detail: [failures, errorText(readFailure)].filter(Boolean).join(' · '), recovery: {
        label: t('common.feedback.retry'), valid: current,
        run: async () => {
          if (!current()) return;
          await refresh(feedback.resume(result));
        },
      } });
    }
    async function refresh(result: FeedbackOperation) {
      try {
        const entries = await native.listNativeMcp(target);
        if (current()) setNativeEntries(entries);
        report(result);
        return true;
      } catch (value) { report(result, value); return false; }
    }
    // Each retry reuses immutable write outcomes and only reads the list. It
    // never repeats a successful target or removes the remaining write errors.
    const refreshed = await refresh(operationFeedback);
    if (current() && refreshed) setCurrentConflict(null);
    return written && refreshed;
  }

  async function applyConflict() {
    if (!currentConflict || busy) return;
    const conflict = currentConflict;
    const { generation, revision, form } = conflict;
    const current = () => mounted.current && generation === editorGeneration.current && revision === editorRevision.current && form === latestForm.current;
    const result = feedback.begin('save:' + conflict.id);
    result.committed(t('tools.mcp.definitionSaved'));
    if (!current()) { result.error(t('common.feedback.stale')); return; }
    setBusy(true);
    try {
      if (await applyItems(conflict.id, conflict.items, true, result, current) && current()) leaveComposer();
    } catch (value) { result.error(errorText(value)); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function save() {
    const operationFeedback = feedback.begin('save:' + (draft.id ?? draft.name));
    if (scope === 'project' && !project) { operationFeedback.error(t('tools.mcp.pickProject')); return; }
    const origin = nativeOrigin; let acceptedForm = latestForm.current;
    const generation = editorGeneration.current;
    const revision = editorRevision.current;
    const current = () => mounted.current && generation === editorGeneration.current && revision === editorRevision.current && acceptedForm === latestForm.current;
    const editing = !!(draft.id || nativeOrigin);
    const linked = draft.id ? definitions.find(item => item.id === draft.id) : definitions.find(item => item.name === draft.name.trim());
    const inLibrary = editing ? linked?.inLibrary !== false : syncLibrary || linked?.inLibrary === true;
    let saved: McpDefinition | null = null;
    async function finish(result: FeedbackOperation) {
      if (!saved) return;
      const definitions = await native.listMcpDefinitions();
      if (!current()) { result.partial(t('tools.mcp.savedKeepEditing')); return; }
      setDefinitions(definitions);
      const items = await native.previewMcpTargets(saved.id, [target]);
      if (!current()) { result.partial(t('tools.mcp.savedKeepEditing')); return; }
      const fresh = origin ? await native.listNativeMcp(target) : [];
      if (!current()) { result.partial(t('tools.mcp.savedKeepEditing')); return; }
      const sameOrigin = !!origin && JSON.stringify(fresh.find(item => item.name === origin.name)) === JSON.stringify(origin);
      if (items.some(item => item.status === 'conflict') && !sameOrigin) {
        setCurrentConflict({ id: saved.id, items, generation, revision, form: acceptedForm }); result.partial(t('tools.mcp.savedKeepEditing')); return;
      }
      if (!items.some(item => item.status === 'ready' || item.status === 'conflict')) { result.error(items.map(item => item.detail).join(t('tools.quota.errorSeparator'))); return; }
      if (await applyItems(saved.id, items, sameOrigin, result, current) && current()) leaveComposer();
    }
    function reportFailure(result: FeedbackOperation, value: unknown) {
      result.error(errorText(value), saved ? { recovery: {
        label: t('common.feedback.retry'), valid: current,
        run: async () => {
          if (!current()) return;
          const retry = feedback.resume(result); retry.committed(t('tools.mcp.savedKeepEditing')); setBusy(true);
          try {
            const definitions = await native.listMcpDefinitions();
            if (current()) setDefinitions(definitions);
            const entries = await native.listNativeMcp(target);
            if (current()) setNativeEntries(entries);
            retry.partial(t('tools.mcp.savedKeepEditing'));
          } catch (error) { reportFailure(retry, error); }
          finally { if (mounted.current) setBusy(false); }
        },
      } } : undefined);
    }
    setBusy(true); try {
      if (origin) {
        const document = await native.readMcpDocument({ target, name: origin.name, definitionId: null });
        if (document.protectedValues) throw new Error(t('library.experience.maskedConversion'));
        if (document.unmappedFields.length) throw new Error(t('library.experience.unmapped', { fields: document.unmappedFields.join(', ') }));
      }
      saved = await native.saveMcpDefinition({ ...draft, args: keptArgs(draft.args), id: draft.id ?? linked?.id ?? null, expectedVersion: draft.id ? draft.expectedVersion : linked?.version ?? draft.expectedVersion, inLibrary, env: parseLines(envText), headers: parseLines(headerText) });
      operationFeedback.identify('save:' + saved.id);
      operationFeedback.committed(t('tools.mcp.savedKeepEditing'));
      const accepted = saved;
      if (!editing) setAddedName(accepted.name);
      if (mounted.current && editorGeneration.current === generation) {
        // Keep the saved snapshot in the list, while the draft retains the
        // revision it actually edited as its CAS baseline for the next save.
        setDefinitions(items => items.some(item => item.id === accepted.id) ? items.map(item => item.id === accepted.id && item.version <= accepted.version ? accepted : item) : [accepted, ...items]);
      }
      if (!current()) {
        if (mounted.current && editorGeneration.current === generation) setDraft(previous => ({ ...previous, id: accepted.id, expectedVersion: accepted.version }));
        operationFeedback.partial(t('tools.mcp.dirtyAgain')); return;
      }
      select(accepted, enabled);
      acceptedForm = latestForm.current;
      await finish(operationFeedback);
    } catch (value) { reportFailure(operationFeedback, value); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function removeSaved() {
    const operationFeedback = feedback.begin('removeSaved:' + (draft.id ?? draft.name));
    const onTool = !!nativeOrigin || nativeEntries.some((entry) => entry.name === draft.name);
    const inLibrary = definitions.find((item) => item.id === draft.id)?.inLibrary === true;
    if (!onTool && !inLibrary) return;
    const name = draft.name || nativeOrigin?.name || t('tools.mcp.thisMcp');
    const message = inLibrary
      ? t('tools.mcp.confirmRemoveLibrary', { name })
      : t('tools.mcp.confirmRemove', { name });
    if (!await confirmAction(message, () => mounted.current, { title: t('tools.mcp.removeTitle'), confirmLabel: t('tools.agents.delete'), destructive: true })) return;
    setBusy(true); try {
      if (onTool) await native.removeNativeMcp({ ...target, enabled }, name);
      if (!inLibrary && draft.id && draft.expectedVersion !== null) await native.deleteMcpDefinition(draft.id, draft.expectedVersion);
      if (mounted.current) {
        setDefinitions(await native.listMcpDefinitions());
        setNativeEntries(await native.listNativeMcp(target));
        operationFeedback.success(t('tools.mcp.deleted'));
        leaveComposer();
      }
    } catch (value) { if (mounted.current) operationFeedback.error(errorText(value)); }
    finally { if (mounted.current) setBusy(false); }
  }

  async function refreshMcp() { setNativeEntries(await native.listNativeMcp(target)); setDefinitions(await native.listMcpDefinitions()); }
  function acceptConfiguration(value: McpDraft, copy: boolean) {
    setConfigOpen(false); setConfigDirty(false);
    editorRevision.current++;
    if (copy) { editorGeneration.current++; setNativeOrigin(null); setCurrentConflict(null); }
    setDraft({ ...value, id: copy ? null : draft.id, expectedVersion: copy ? null : draft.expectedVersion });
    setEnvText(lines(value.env)); setHeaderText(lines(value.headers)); setComposing(true);
  }
  function mcpBatch(ids: string[]) {
    const jobs: BatchJob[] = ids.map(name => ({ id: name, name, run: async () => {
      if (batchAction === 'remove') { await native.removeNativeMcp(target, name); return; }
      const document = await native.readMcpDocument({ target, name, definitionId: null });
      if (document.protectedValues || document.unmappedFields.length) throw new Error(t('library.experience.maskedConversion'));
      const parsed = await native.parseMcpPaste(target, name, document.text);
      if (parsed.length !== 1 || !parsed[0].draft) throw new Error(parsed.flatMap(item => item.diagnostics).join(' · '));
      const known = definitions.find(item => item.name === name);
      const item = await native.saveMcpDefinition({ ...parsed[0].draft, id: known?.id ?? null, expectedVersion: known?.version ?? null, inLibrary: known?.inLibrary === true });
      const outcome = await native.runResourceBatch(crypto.randomUUID(), [{ action: 'mcp_apply', definitionId: item.id, target: { ...target, enabled: batchAction === 'enable' } }]);
      return outcome.items[0] ?? { status: 'failed', detail: t('library.experience.invalidConfig') };
    } }));
    return <><select aria-label={t('library.experience.batchAction')} value={batchAction} onChange={event => setBatchAction(event.target.value)}>{['enable', 'disable', 'remove'].map(action => <option key={action} value={action}>{t(`library.experience.${action}`)}</option>)}</select><ResourceBatch key={batchAction} context={feedback.context + ':batch:' + batchAction} jobs={jobs} action={t(`library.experience.${batchAction}`)} destructive={batchAction !== 'enable'} onChanged={refreshMcp} /></>;
  }
  const head = (canAdd: boolean) => <div className={styles.workspaceHead}><div><h2>{t('tools.mcp.title')}</h2><p>{t('tools.mcp.description')}</p></div>{canAdd && <button type="button" className={styles.primary} disabled={busy || (scope === 'project' && !project)} onClick={() => void startNew()}><Icon name="plus" size={14} strokeWidth={2.2} />{t('tools.mcp.add')}</button>}</div>;

  if (capabilityBlocked) {
    return <section className={styles.workspaceSection} aria-label={t('tools.mcp.title')}>{head(false)}<StatusBanner tone="error">{capabilityBlocked}</StatusBanner><p className={styles.muted}>{t('tools.mcp.blocked')}</p></section>;
  }


  return <section className={styles.workspaceSection} aria-label={t('tools.mcp.title')}>
    {head(true)}
    <FeedbackRegion context={feedback.context} />
    <div className={styles.layout}>
    <ResourceList key={feedback.context} context={feedback.context} label={t('library.resources.mcpListAria')} addedId={addedName} toolbarActions={<McpPaste onAdded={item => setAddedName(item.name)} key={feedback.context} context={feedback.context} target={target} definitions={definitions} onDraft={value => acceptConfiguration(value, true)} onChanged={refreshMcp} />}
      rows={nativeEntries.map(item => ({ id: item.name, name: item.name, description: item.transport === 'http' ? item.url : [item.command, ...item.args].join(' '), metadata: `${toolId} · ${scope} · ${item.enabled ? t('tools.plugins.enabled') : t('tools.quota.disabled')}`, state: item.enabled ? 'enable' : 'disable' }))}
      actions={name => <button type="button" onClick={() => { const result = feedback.begin('copy:' + name); void native.readMcpDocument({ target, name, definitionId: null }).then(async document => { if (!await writeClipboard(document.text)) throw new Error(t('library.experience.copyFailed')); result.success(t('library.experience.copiedEntry')); }).catch(error => result.error(errorText(error))); }}>{t('library.experience.copy')}</button>}
      filters={['enable', 'disable'].map(value => ({ value, label: t(`library.experience.${value}`) }))} bulk={mcpBatch}
      onRefresh={() => void refreshMcp().catch(error => feedback.begin('refresh').error(errorText(error)))} onOpen={id => { const item = nativeEntries.find(item => item.name === id); if (item) void importNative(item); }} />
    <GuideDialog wide open={composing} title={draft.id || nativeOrigin ? t('tools.mcp.editTitle') : t('tools.mcp.add')} hint={t('tools.mcp.dialogHint')} onClose={() => void closeCompose()}>
    <div className={styles.panel} onChangeCapture={() => { editorRevision.current++; }}>
      <McpDocumentPanel key={JSON.stringify([feedback.context, editorGeneration.current])} target={target} name={draft.name} sourceName={nativeOrigin?.name} getDraft={() => ({ ...draft, env: parseLines(envText), headers: parseLines(headerText) })} validateNative={async () => { const current = (await native.listNativeMcp(target)).find(item => item.name === nativeOrigin?.name); if (JSON.stringify(current) !== JSON.stringify(nativeOrigin)) throw new Error(t('library.experience.nativeChanged')); }} onModeChange={setConfigOpen} onDirtyChange={setConfigDirty} formDirty={formDirty} onDraft={acceptConfiguration} onChanged={refreshMcp} />
      <div hidden={configOpen} className={styles.fields}><label>{t('tools.mcp.name')}<input aria-label={t('tools.mcp.nameAria')} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t('tools.mcp.namePlaceholder')} /></label>
      <div className={styles.typeField}><span>{t('tools.mcp.type')}</span><div className={styles.typeSwitch} role="radiogroup" aria-label={t('tools.mcp.transport')}>{([['http', 'HTTP'], ['stdio', 'stdio']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={draft.transport === value} onClick={() => { editorRevision.current++; setDraft({ ...draft, transport: value }); }}>{label}</button>)}</div></div>
      {draft.transport === 'stdio' ? <>
        <label>{t('tools.mcp.command')}<input aria-label={t('tools.mcp.command')} value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx" /></label>
        <label>{t('tools.mcp.args')}<textarea rows={3} value={draft.args.join('\n')} onChange={(event) => setDraft({ ...draft, args: event.target.value.split(/\r?\n/) })} placeholder={'-y\nchrome-devtools-mcp@latest'} /></label>
        <label>{t('tools.mcp.env')}<textarea rows={4} value={envText} onChange={(event) => setEnvText(event.target.value)} placeholder={'KEY=value\nAPI_TOKEN=${API_TOKEN}'} /></label>
      </> : <>
        <label>URL<input aria-label={t('tools.mcp.urlAria')} value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp" /></label>
        <label>{t('tools.mcp.headers')}<textarea rows={4} value={headerText} onChange={(event) => setHeaderText(event.target.value)} placeholder="Authorization=Bearer ${API_TOKEN}" /></label>
      </>}
      <label className={styles.inline}><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />{t('tools.plugins.action.enable')}</label>
      {!(draft.id || nativeOrigin) && <label className={styles.inline}><input type="checkbox" checked={syncLibrary} onChange={(event) => setSyncLibrary(event.target.checked)} />{t('tools.mcp.quickSync')}<small className={styles.fieldHint}>{t('tools.mcp.quickSyncHint')}</small></label>}
      {currentConflict && <div className={styles.resultList} role="group" aria-label={t('tools.mcp.conflictLabel')}><strong>{t('tools.mcp.conflictTitle')}</strong>{currentConflict.items.map(item => <div className={styles.fileDiff} key={item.toolId}><CodeEditor compact label={t('tools.mcp.conflictCurrent')} format="json" readOnly value={JSON.stringify(item.existing, null, 2)} /><CodeEditor compact label={t('tools.mcp.conflictNext')} format="json" readOnly value={JSON.stringify(item.proposed, null, 2)} /></div>)}<div className={styles.actions}><button type="button" onClick={() => setCurrentConflict(null)}>{t('common.conflict.keepCurrent')}</button><button type="button" disabled={busy} onClick={() => void applyConflict()}>{t('tools.mcp.useNext')}</button></div></div>}

      </div><FeedbackRegion context={feedback.context} />
      <div hidden={configOpen} className="dialog-footer">{(draft.id || nativeOrigin) && <button type="button" disabled={busy} onClick={() => void removeSaved()}>{t('tools.mcp.removeFromTool')}</button>}<span className="dialog-footer-gap" /><button type="button" className={styles.primary} data-dialog-save title={saveShortcutHint()} disabled={busy || configOpen || !draft.name.trim() || (scope === 'project' && !project)} onClick={() => void save()}>{draft.id || nativeOrigin ? t('home.launcher.save') : t('tools.mcp.addSubmit')}</button></div>
    </div>
    </GuideDialog>
  </div>
  </section>;
}

export function SkillsWorkspace({ toolId, scope, projectPath, contextId, onDirtyChange }: { toolId: string; scope: Scope; projectPath: string; contextId?: string | null; onDirtyChange?: (dirty: boolean) => void }) {
  const { t } = useTranslation();
  const [packages, setPackages] = useState<SkillPackage[]>([]);
  const [addedSkill, setAddedSkill] = useState<string | null>(null);
  const [nativeEntries, setNativeEntries] = useState<NativeSkillEntry[]>([]);
  const [recoveryIssues, setRecoveryIssues] = useState<SkillRecoveryIssue[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installations, setInstallations] = useState<SkillInstallation[]>([]);
  const [url, setUrl] = useState('');
  const [archiveSelection, setArchiveSelection] = useState<{ source: string; local: boolean; entries: string[]; chosen: string | null } | null>(null);
  const [pendingImport, setPendingImport] = useState<{ preview: SkillImportPreview; kind: 'local' | 'zip' | 'local_zip'; source: string; subdirectory: string | null; installAfter: boolean } | null>(null);
  const [dependencyChecked, setDependencyChecked] = useState(false);
  const [skillEnabled, setSkillEnabled] = useState<boolean | null>(null);
  const [installationLoadedFor, setInstallationLoadedFor] = useState<string | null>(null);
  const [pendingTarget, setPendingTarget] = useState<SkillTargetPreview | null>(null);
  const [adding, setAdding] = useState(false);
  const [guide, setGuide] = useState(false);
  const [syncLibrary, setSyncLibrary] = useState(false);
  const [external, setExternal] = useState<NativeSkillEntry | null>(null);
  const [skillDoc, setSkillDoc] = useState<{ path: string; baseline: string; draft: string } | null>(null);
  const [skillLoading, setSkillLoading] = useState(false);
  const skillRequest = useRef(0);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [stateVersion, setStateVersion] = useState(0);
  const [stateErrors, setStateErrors] = useState<Record<string, string>>({});
  const [batchAction, setBatchAction] = useState('disable');
  const skillDirty = !!skillDoc && skillDoc.draft !== skillDoc.baseline;
  useLayoutEffect(() => { onDirtyChange?.(!!url.trim() || !!archiveSelection || !!pendingImport || adding || skillDirty); }, [url, archiveSelection, pendingImport, adding, skillDirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
  const [busy, setBusy] = useState(false);
  const feedback = useFeedback(JSON.stringify(['skills', toolId, scope, projectPath, contextId]));
  function setResult(operation: FeedbackOperation, result: SkillTargetResult) {
    if (!result) return;
    const text = result.status === 'failed' || result.detail === t('tools.skills.saved') ? result.detail : result.detail === t('tools.skills.addedToLibrary') ? t('tools.skills.addedToLibraryNote') : result.status === 'removed' ? t('tools.skills.removed', { path: result.path ?? '' }) : t('tools.skills.installed', { path: result.path ?? '' });
    if (result.status === 'failed') operation.error(text); else operation.success(text);
  }
  const selected = packages.find((item) => item.id === selectedId);
  const project = scope === 'project' ? projectPath || null : null;
  const visibleIssues = recoveryIssues.filter((issue) => issue.toolId === toolId && (issue.scope === 'project' || (issue.contextId ?? null) === (contextId ?? null)));
  const skillTarget = useMemo<McpTargetRequest>(() => ({ toolId, scope, projectPath: project, contextId, enabled: true }), [toolId, scope, project, contextId]);
  async function refreshSkills() { setNativeEntries(await native.listNativeSkillMetadata(skillTarget)); setStateErrors({}); setStateVersion(value => value + 1); }
  useEffect(() => {
    let live = true;
    const ids = [...new Set([...visibleIds, ...selectedIds])];
    void (async () => {
      for (let offset = 0; offset < ids.length && live; offset += 50) {
        const chunk = ids.slice(offset, offset + 50);
        const requests = chunk.map(path => ({ kind: 'native_skill' as const, target: skillTarget, name: nativeEntries.find(entry => entry.path === path)?.name ?? '' }));
        try {
          const results = await readResourceStates(requests, () => live);
          if (!live) return;
          for (const result of results) {
            const path = chunk[result.index]; if (!path) continue;
            if (result.status === 'ready' && result.value) {
              setNativeEntries(old => old.map(entry => entry.path === path ? { ...entry, ...result.value as NativeSkillEntry, detail: entry.detail } : entry));
              setStateErrors(old => { const next = { ...old }; delete next[path]; return next; });
            } else setStateErrors(old => ({ ...old, [path]: result.detail || t('library.experience.failedState') }));
          }
        } catch (error) { if (live) setStateErrors(old => ({ ...old, ...Object.fromEntries(chunk.map(path => [path, errorText(error)])) })); }
      }
    })();
    return () => { live = false; };
  }, [skillTarget, JSON.stringify(visibleIds), JSON.stringify(selectedIds), stateVersion]);
  function skillBatch(ids: string[]) {
    const jobs: BatchJob[] = ids.map(path => {
      const entry = nativeEntries.find(entry => entry.path === path)!;
      if (!entry.packageId) return { id: path, name: entry.name, run: async () => { throw new Error(stateErrors[path] || t('library.experience.unknown')); } };
      return { id: path, name: entry.name, operation: { action: batchAction === 'remove' ? 'skill_remove' : 'skill_enable', packageId: entry.packageId, target: { ...skillTarget, enabled: batchAction === 'enable' } } };
    });
    return <><select aria-label={t('library.experience.batchAction')} value={batchAction} onChange={event => setBatchAction(event.target.value)}>{['enable', 'disable', 'remove'].map(action => <option key={action} value={action}>{t(`library.experience.${action}`)}</option>)}</select><ResourceBatch key={batchAction} context={feedback.context + ':batch:' + batchAction} jobs={jobs} action={t(`library.experience.${batchAction}`)} destructive={batchAction !== 'enable'} onChanged={refreshSkills} /></>;
  }
  useEffect(() => { setPendingTarget(null); }, [toolId, scope, project, selectedId]);
  useEffect(() => {
    skillRequest.current += 1;
    setGuide(false);
    setAdding(false);
    setExternal(null);
    setSkillDoc(null);
    setSkillLoading(false);
  }, [toolId, scope, project]);
  useEffect(() => {
    let live = true; const result = feedback.begin('recovery');
    void native.listSkillRecoveryIssues().then((issues) => { if (live) { setRecoveryIssues(issues); result.complete(); } })
      .catch((value) => { if (live) result.error(errorText(value)); });
    return () => { live = false; };
  }, [toolId, scope, project]);
  useEffect(() => {
    if (!toolId || (scope === 'project' && !project)) { setNativeEntries([]); return; }
    let live = true; const result = feedback.begin('scan');
    void native.listNativeSkillMetadata(skillTarget).then((entries) => { if (live) { setNativeEntries(entries); result.complete(); } })
      .catch((value) => { if (live) result.error(errorText(value)); });
    return () => { live = false; };
  }, [toolId, scope, project]);
  const installed = installations.find((item) => item.packageId === selectedId && item.toolId === toolId && item.scope === scope && item.projectPath === project && (item.contextId ?? null) === (scope === 'global' ? contextId ?? null : null));
  useEffect(() => { const result = feedback.begin('packages'); void native.listSkillPackages().then(value => { setPackages(value); result.complete(); }).catch(value => result.error(errorText(value))); }, []);
  useEffect(() => {
    setSkillEnabled(null); setInstallationLoadedFor(null);
    if (!selectedId) return;
    let live = true; const result = feedback.begin('installations:' + selectedId);
    void Promise.all([native.listSkillInstallations(selectedId),native.getSkillEnabled(selectedId,toolId,scope,project)]).then(([items,enabled]) => { if (live) {setInstallations(items);setSkillEnabled(enabled);setInstallationLoadedFor(selectedId);result.complete();} })
      .catch((value) => { if (live) result.error(errorText(value)); });
    return () => { live = false; };
  }, [selectedId, toolId, scope, project]);

  async function installPackage(packageId: string, operationFeedback: FeedbackOperation) {
    if (scope === 'project' && !project) { operationFeedback.error(t('tools.skills.pickProjectFirst')); return; }
    const item = (await native.listSkillPackages()).find((entry) => entry.id === packageId);
    if (!item) return;
    if (item.compatibility && !dependencyChecked) { operationFeedback.error(t('tools.skills.dependencyFirst')); setSelectedId(packageId); return; }
    const targetPreview = await native.previewSkillTarget(packageId, toolId, scope, project);
    if (targetPreview.status === 'conflict') { setPendingTarget(targetPreview); setSelectedId(packageId); return; }
    const outcome = await native.installSkill(packageId, toolId, scope, project, targetPreview.previewToken, false);
    setResult(operationFeedback, outcome);
    setInstallations(await native.listSkillInstallations(packageId));
    setNativeEntries(await native.listNativeSkillMetadata(skillTarget)); setStateVersion(value => value + 1);
    setSkillEnabled(await native.getSkillEnabled(packageId, toolId, scope, project));
    setRecoveryIssues(await native.listSkillRecoveryIssues());
    if (outcome.status !== 'failed') { setGuide(false); setAdding(false); }
  }

  async function place(item: SkillPackage, existed: boolean, operationFeedback: FeedbackOperation) {
    if (syncLibrary) await native.setSkillInLibrary(item.id, true);
    else if (!existed) await native.setSkillInLibrary(item.id, false);
    await finishImported(item, true, operationFeedback);
  }

  async function finishImported(item: SkillPackage, installAfter: boolean, operationFeedback: FeedbackOperation) {
    setPackages(await native.listSkillPackages());
    setAddedSkill(item.name);
    setSelectedId(item.id);

    setAdding(false);
    if (installAfter) await installPackage(item.id, operationFeedback);
    else setGuide(false);
  }

  async function local() {
    const operationFeedback = feedback.begin('local');
    try {
      const source = await open({ directory: true, multiple: false, title: t('tools.skills.pickDirTitle') });
      if (typeof source !== 'string') return;
      setBusy(true); const preview = await native.previewSkillLocal(source);
      if (preview.existingDigest && preview.existingDigest !== preview.digest) {
        setPendingImport({ preview, kind: 'local', source, subdirectory: null, installAfter: true }); return;
      }
      const item = await native.importSkillLocal(source, preview.digest, preview.existingDigest);
      await place(item, !!preview.existingDigest, operationFeedback);
    } catch (value) { operationFeedback.error(errorText(value)); }
    finally { setBusy(false); }
  }
  async function archive(source: string, localZip: boolean, chosen?: string) {
    const operationFeedback = feedback.begin(JSON.stringify(['archive', source, chosen]));
    setBusy(true); try {
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
      await place(item, !!preview.existingDigest, operationFeedback);
      if (!localZip) setUrl('');
      setArchiveSelection(null);
    } catch (value) { operationFeedback.error(errorText(value)); }
    finally { setBusy(false); }
  }
  async function localZip() {
    const operationFeedback = feedback.begin('localZip');
    try {
      const source = await open({ directory: false, multiple: false, title: t('tools.skills.pickZipTitle'), filters: [{ name: 'ZIP', extensions: ['zip'] }] });
      if (typeof source === 'string') await archive(source, true);
    } catch (value) { operationFeedback.error(errorText(value)); }
  }
  async function confirmImport() {
    const operationFeedback = feedback.begin(JSON.stringify(['confirmImport', pendingImport?.source]));
    if (!pendingImport) return;
    setBusy(true); try {
      const { preview, kind, source, subdirectory, installAfter } = pendingImport;
      const item = kind === 'local'
        ? await native.importSkillLocal(source, preview.digest, preview.existingDigest)
        : kind === 'local_zip' ? await native.importSkillLocalZip(source, subdirectory, preview.digest, preview.existingDigest)
        : await native.importSkillHttpsZip(source, subdirectory, preview.digest, preview.existingDigest);
      setPendingImport(null);
      if (kind === 'zip') setUrl('');
      if (installAfter) await place(item, !!preview.existingDigest, operationFeedback);
      else { await native.setSkillInLibrary(item.id, true); setGuide(false); setExternal(null); setResult(operationFeedback, { toolId, scope, projectPath: project, path: item.name, status: 'installed', detail: t('tools.skills.addedToLibrary') }); }
    } catch (value) { operationFeedback.error(errorText(value)); }
    finally { setBusy(false); }
  }
  function closeGuide() {
    skillRequest.current += 1;
    setGuide(false);
    setAdding(false);
    setSyncLibrary(false);
    setExternal(null);
    setArchiveSelection(null);
    setPendingImport(null);
    setSkillDoc(null);
    setSkillLoading(false);
  }
  async function openNative(entry: NativeSkillEntry) {
    const operationFeedback = feedback.begin(JSON.stringify(['openNative', entry.path]));
    const request = ++skillRequest.current;
    setAdding(false);
    setExternal(entry.packageId ? null : entry);
    setSelectedId(entry.packageId);
    setSkillDoc(null);
    setSkillLoading(true);
    setGuide(true);
    try {
      const document = await native.readNativeSkill(toolId, scope, project, entry.path);
      if (skillRequest.current !== request) return;
      setSkillDoc({ path: entry.path, baseline: document.content, draft: document.content }); operationFeedback.complete();
    } catch (value) {
      if (skillRequest.current === request) operationFeedback.error(errorText(value));
    } finally {
      if (skillRequest.current === request) setSkillLoading(false);
    }
  }
  useEffect(() => {
    if (!guide || !skillDoc) return;
    const entry = nativeEntries.find(entry => entry.path === skillDoc.path);
    if (entry?.packageId && entry.packageId !== selectedId) { setSelectedId(entry.packageId); setExternal(null); }
  }, [guide, skillDoc?.path, nativeEntries, selectedId]);
  async function saveSkill() {
    const operationFeedback = feedback.begin(JSON.stringify(['saveSkill', skillDoc?.path]));
    if (!skillDoc || skillDoc.draft === skillDoc.baseline) return;
    const request = skillRequest.current;
    const saved = skillDoc;
    setBusy(true); try {
      await native.saveNativeSkill(toolId, scope, project, saved.path, saved.baseline, saved.draft);
      if (skillRequest.current !== request) return;
      setSkillDoc(current => current?.path === saved.path ? { ...current, baseline: saved.draft } : current);
      setNativeEntries(await native.listNativeSkillMetadata(skillTarget)); setStateVersion(value => value + 1);
      setResult(operationFeedback, { toolId, scope, projectPath: project, path: saved.path, status: 'installed', detail: t('tools.skills.saved') });
    } catch (value) {
      if (skillRequest.current === request) operationFeedback.error(errorText(value));
    } finally {
      if (skillRequest.current === request) setBusy(false);
    }
  }
  async function syncExternal() {
    const operationFeedback = feedback.begin(JSON.stringify(['syncExternal', external?.path]));
    if (!external) return;
    setBusy(true); try {
      const preview = await native.previewSkillLocal(external.path);
      if (preview.existingDigest && preview.existingDigest !== preview.digest) {
        setPendingImport({ preview, kind: 'local', source: external.path, subdirectory: null, installAfter: false }); return;
      }
      const item = await native.importSkillLocal(external.path, preview.digest, preview.existingDigest);
      await native.setSkillInLibrary(item.id, true);
      setResult(operationFeedback, { toolId, scope, projectPath: project, path: item.name, status: 'installed', detail: t('tools.skills.addedToLibrary') });
      setGuide(false); setExternal(null);
    } catch (value) { operationFeedback.error(errorText(value)); }
    finally { setBusy(false); }
  }
  async function change(remove: boolean) {
    const operationFeedback = feedback.begin(JSON.stringify(['change', selected?.id, remove]));
    if (!selected) return;
    if (scope === 'project' && !project) { operationFeedback.error(t('tools.skills.pickProjectFirst')); return; }
    if (!remove && selected.compatibility && !dependencyChecked) { operationFeedback.error(t('tools.skills.dependencyFirst')); return; }
    setBusy(true);
    try {
      const targetPreview = !remove ? pendingTarget ?? await native.previewSkillTarget(selected.id, toolId, scope, project) : null;
      if (!remove && !pendingTarget && targetPreview?.status === 'conflict') { setPendingTarget(targetPreview); return; }
      const outcome = remove ? await native.removeSkill(selected.id, toolId, scope, project, contextId)
        : await native.installSkill(selected.id, toolId, scope, project, targetPreview?.previewToken ?? null, targetPreview?.status === 'conflict');
      setResult(operationFeedback, outcome);
      setPendingTarget(null);
      setInstallations(await native.listSkillInstallations(selected.id));
      setNativeEntries(await native.listNativeSkillMetadata(skillTarget)); setStateVersion(value => value + 1);
      setSkillEnabled(await native.getSkillEnabled(selected.id,toolId,scope,project));
      setRecoveryIssues(await native.listSkillRecoveryIssues());
      if (outcome.status !== 'failed') { setGuide(false); setAdding(false); }
    } catch (value) { operationFeedback.error(errorText(value)); }
    finally { setBusy(false); }
  }
  async function toggleSkill(next: boolean) {
    const operationFeedback = feedback.begin(JSON.stringify(['toggle', selected?.id, next]));
    if (!selected) return; setBusy(true);try {await native.setSkillEnabled(selected.id,toolId,scope,project,next,contextId);setSkillEnabled(await native.getSkillEnabled(selected.id,toolId,scope,project));setInstallations(await native.listSkillInstallations(selected.id));setNativeEntries(await native.listNativeSkillMetadata(skillTarget)); setStateVersion(value => value + 1);operationFeedback.complete();}
    catch(value){operationFeedback.error(errorText(value));}finally{setBusy(false);}
  }
  async function checkRecovery() {
    const operationFeedback = feedback.begin('recovery');
    try { setRecoveryIssues(await native.listSkillRecoveryIssues()); operationFeedback.complete(); }
    catch (value) { operationFeedback.error(errorText(value)); }
  }

  const recovery = !!visibleIssues.length && <div className={styles.error} role="alert"><strong>{t('tools.skills.recoveryTitle')}</strong><p>{t('tools.skills.recoveryDetail')}</p>{visibleIssues.map((issue) => <div key={issue.operationId} className={styles.fileChange}><strong>{issue.scope === 'global' ? t('tools.apply.global') : t('tools.skills.recoveryProject', { path: issue.projectPath ?? '' })}</strong><p>{issue.detail}</p><p>{t('tools.skills.recoveryTarget', { path: issue.targetPath })}</p><p>{t('tools.skills.recoveryBackup', { path: issue.backupPath })}</p><button type="button" onClick={() => { const result = feedback.begin('copyRecovery:' + issue.operationId); void navigator.clipboard.writeText(issue.backupPath).then(() => result.success(t('records.reader.copied'))).catch(value => result.error(errorText(value))); }}>{t('tools.skills.recoveryCopy')}</button></div>)}<button type="button" onClick={() => void checkRecovery()}>{t('tools.skills.recoveryRecheck')}</button></div>;
  const installState: { label: string; tone: 'on' | 'warn' | undefined } = installed?.state === 'current' ? { label: t('tools.skills.stateInstalled'), tone: 'on' }
    : installed?.state === 'update_available' ? { label: t('tools.skills.stateUpdate'), tone: 'warn' }
    : installed?.state === 'conflict' ? { label: t('tools.skills.stateConflict'), tone: 'warn' }
    : installed?.state === 'disabled' ? { label: t('tools.skills.stateDisabled'), tone: undefined }
    : installed?.state === 'missing' ? { label: t('tools.skills.stateMissing'), tone: 'warn' }
    : { label: selectedId && installationLoadedFor !== selectedId ? t('library.experience.unknown') : t('tools.skills.stateNotInstalled'), tone: undefined };

  const head = <div className={styles.workspaceHead}><div><h2>Skill</h2><p>{t('tools.skills.description')}</p></div><button type="button" className={styles.primary} disabled={busy || (scope === 'project' && !project)} onClick={() => { setAdding(true); setSyncLibrary(false); setExternal(null); setGuide(true); }}><Icon name="plus" size={14} strokeWidth={2.2} />{t('tools.skills.add')}</button></div>;


  return <section className={styles.workspaceSection} aria-label="Skill">
    {head}
    {recovery}
    <FeedbackRegion context={feedback.context} />

    <div className={styles.layout}>
    <ResourceList key={feedback.context} context={feedback.context} label={t('library.resources.skillListAria')} addedId={nativeEntries.find(entry => entry.name === addedSkill)?.path}
      rows={nativeEntries.map(entry => ({ id: entry.path, name: entry.name, description: entry.detail || displayPath(entry.path), search: entry.path, metadata: `${toolId} · ${scope} · ${stateErrors[entry.path] ? t('library.experience.failedState') : entry.state === 'unknown' ? t('library.experience.unknown') : entry.state === 'managed' ? t('tools.skills.stateInstalled') : entry.state === 'external' ? t('tools.skills.stateExternal') : t('tools.skills.stateUnreadable')}`, state: stateErrors[entry.path] ? 'failed' : entry.state }))}
      filters={['managed', 'external', 'unknown', 'failed'].map(value => ({ value, label: value === 'managed' ? t('tools.skills.stateInstalled') : value === 'external' ? t('tools.skills.stateExternal') : t(`library.experience.${value === 'failed' ? 'failedState' : value}`) }))}
      actions={path => <button type="button" onClick={() => { const result = feedback.begin('copy:' + path); void native.readNativeSkill(toolId, scope, project, path).then(async document => { if (!await writeClipboard(document.content)) throw new Error(t('library.experience.copyFailed')); result.success(t('library.page.copied')); }).catch(error => result.error(errorText(error))); }}>{t('library.experience.copy')}</button>}
      onVisible={setVisibleIds} onSelected={setSelectedIds} bulk={skillBatch} onRefresh={() => void refreshSkills().catch(error => feedback.begin('refresh').error(errorText(error)))} onOpen={id => { const entry = nativeEntries.find(entry => entry.path === id); if (entry) void openNative(entry); }} />
    <GuideDialog wide={!adding} open={guide} title={adding ? t('tools.skills.add') : t('tools.skills.currentTitle')} hint={adding ? t('tools.skills.addHint') : t('tools.skills.currentHint')} onClose={() => { void (async () => { if (skillDirty && !await confirmAction(t('tools.mcp.confirmDiscard'), () => true, { title: t('common.app.leaveDirtyTitle'), confirmLabel: t('common.app.leaveDirtyConfirm') })) return; closeGuide(); })(); }}>
    <div className={styles.panel}>
      {!adding && <div className={styles.heading}><div><small>Skill</small><h2>{selected?.name ?? external?.name ?? t('tools.skills.currentTitle')}</h2></div></div>}
      {adding && <>
        <label className={styles.inline}><input type="checkbox" checked={syncLibrary} onChange={(event) => setSyncLibrary(event.target.checked)} />{t('tools.mcp.quickSync')}<small className={styles.fieldHint}>{t('tools.mcp.quickSyncHint')}</small></label>
        <div className={styles.sources}>
          <button type="button" aria-label={t('tools.skills.pickFolder')} disabled={busy} onClick={() => void local()}><strong>{t('tools.skills.pickFolder')}</strong><span>{t('tools.skills.pickFolderHint')}</span></button>
          <button type="button" aria-label={t('tools.skills.importZip')} disabled={busy} onClick={() => void localZip()}><strong>{t('tools.skills.importZip')}</strong><span>{t('tools.skills.importZipHint')}</span></button>
        </div>
        <label className={styles.urlField}>{t('tools.skills.zipUrl')}<span className={styles.urlRow}><input aria-label={t('tools.skills.zipUrlAria')} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/skill.zip" /><button type="button" disabled={busy || !url.trim()} onClick={() => void archive(url.trim(), false)}>{t('tools.skills.importUrl')}</button></span></label>
      </>}
      {!adding && skillLoading && <p className={styles.muted} role="status">{t('tools.skills.loading')}</p>}
      {!adding && skillDoc && <><p className={styles.muted}>{t('tools.skills.editorNote')}</p><CodeEditor format="markdown" label={t('tools.skills.editorLabel')} documentId={skillDoc.path} value={skillDoc.draft} onChange={(value) => setSkillDoc((current) => current ? { ...current, draft: value } : current)} readOnly={busy} /><button type="button" onClick={() => { const result = feedback.begin('copySkill:' + skillDoc.path); void writeClipboard(skillDoc.draft).then(ok => ok ? result.success(t('library.page.copied')) : result.error(t('library.experience.copyFailed'))); }}>{t('library.experience.copySkill')}</button></>}
      <FeedbackRegion context={feedback.context} />

      {selected && !adding && <>
        <p className={styles.muted}>{selected.description || t('tools.skills.fullPackage')} · {t('tools.skills.fileCount', { count: selected.fileCount })}</p><details className={styles.source}><summary title={displayPath(selected.source)}>{t('tools.skills.sourceLabel', { source: shortPath(selected.source) })}</summary><p>{displayPath(selected.source)}</p></details>
        {selected.compatibility && <label className={styles.inline}><input type="checkbox" checked={dependencyChecked} onChange={(event) => setDependencyChecked(event.target.checked)} />{t('tools.skills.compatibilityChecked', { requirement: selected.compatibility })}</label>}
        <label className={styles.inline}><input type="checkbox" aria-label={t('tools.skills.enableAria')} checked={skillEnabled === true} disabled={busy || skillEnabled === null || !installed && !nativeEntries.some(item=>item.name===selected.name) && !skillEnabled} onChange={event => void toggleSkill(event.target.checked)} />{skillEnabled === null ? t('library.experience.unknown') : skillEnabled ? t('tools.skills.enabledNote') : t('tools.skills.disabledNote')}</label>
        <p className={styles.muted}><span className={styles.state} data-on={installState.tone === 'on' || undefined} data-warn={installState.tone === 'warn' || undefined}>{installState.label}</span>{skillEnabled === null ? '' : skillEnabled ? t('tools.skills.enabledHint') : t('tools.skills.disabledHint')}</p>
        {pendingTarget && <div className={styles.resultList} role="group" aria-label={t('tools.skills.previewLabel')}><strong>{pendingTarget.status === 'conflict' ? t('tools.skills.conflictTitle') : t('tools.skills.confirmTitle')}</strong><p>{pendingTarget.detail} · {pendingTarget.path}</p>
          {pendingTarget.changes.map((change) => <details key={change.path} className={styles.fileChange}><summary>{change.path}</summary><div className={styles.fileDiff}><div><strong>{t('tools.skills.currentLabel')}</strong>{change.before !== null ? <pre>{change.before}</pre> : <small>{change.beforeSize === null ? t('tools.skills.notExists') : t('tools.skills.fileMeta', { size: change.beforeSize, digest: change.beforeDigest })}</small>}</div><div><strong>{t('tools.skills.afterLabel')}</strong>{change.after !== null ? <pre>{change.after}</pre> : <small>{change.afterSize === null ? t('tools.agents.delete') : t('tools.skills.fileMeta', { size: change.afterSize, digest: change.afterDigest })}</small>}</div></div></details>)}
          <div className={styles.actions}><button type="button" onClick={() => setPendingTarget(null)}>{t('common.dialog.cancel')}</button><button type="button" className={styles.primary} disabled={busy} onClick={() => void change(false)}>{pendingTarget.status === 'conflict' ? t('tools.skills.confirmTakeover') : t('tools.skills.confirmInstall')}</button></div>
        </div>}
      </>}
      {!adding && (skillDoc || selected) && <div className="dialog-footer">{external && <button type="button" disabled={busy} onClick={() => void syncExternal()}>{t('tools.skills.addToLibrary')}</button>}{installed && <button type="button" disabled={busy} onClick={() => void change(true)}>{t('tools.mcp.removeFromTool')}</button>}<span className="dialog-footer-gap" />{installed?.state === 'update_available' && <button type="button" disabled={busy || (scope === 'project' && !project)} onClick={() => void change(false)}>{t('tools.skills.updateToScope')}</button>}<button type="button" className={styles.primary} data-dialog-save title={saveShortcutHint()} disabled={busy || !skillDoc || skillDoc.draft === skillDoc.baseline} onClick={() => void saveSkill()}>{t('tools.skills.save')}</button></div>}
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
