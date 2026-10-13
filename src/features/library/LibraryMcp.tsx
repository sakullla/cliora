import { removalContext, useAccountLabels } from './resourceContexts';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GuideDialog } from '../../components/GuideDialog';
import { SearchField } from '../../components/SearchField';
import { Icon } from '../../components/Icon';
import { ScopeMarks, samePath, scopeLabel } from './CliMarks';
import { confirmAction } from '../../lib/confirm';
import { applyParsedServer, blankMcpDraft, editableRowsOf, hasMcpIssues, keptMcpArgs, mcpCopyName, mcpDraftIssues, mcpDraftOf, mcpSummary, recordOfRows, type KeyValueRow, type McpParsedServer } from '../../lib/mcp';
import { McpFormFields } from '../../components/mcp/McpFormFields';
import { native } from '../../lib/native';
import { useFeedback } from '../../lib/toast';
import { saveShortcutHint, searchShortcutHint } from '../../lib/shortcut';
import type { Project } from '../../types/launch';
import type { AdapterDescriptor, Scope } from '../../types/native';
import type { McpDefinition, McpDraft, McpPlacement, McpTargetRequest } from '../../types/resources';
import { McpDistribution, type McpDistributeHandle } from './McpDistribution';
import i18n from '../../i18n';
import styles from './LibraryMcp.module.css';

function failure(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : i18n.t('tools.workspace.operationFailed');
}

function filledCount(record: Record<string, string> | null | undefined) {
  return Object.keys(record ?? {}).filter((key) => key.trim()).length;
}

type EditorState = { draft: McpDraft; envRows: KeyValueRow[]; headerRows: KeyValueRow[] };
const fingerprint = (state: EditorState) => JSON.stringify([state.draft.name, state.draft.transport, state.draft.command, keptMcpArgs(state.draft.args), state.draft.url, recordOfRows(state.envRows), recordOfRows(state.headerRows)]);

export function LibraryMcp({ active, tools, projects, createSignal = 0, onCountChange }: { active: boolean; tools: AdapterDescriptor[]; projects: Project[]; createSignal?: number; onCountChange?: (count: number) => void }) {
  const { t } = useTranslation();
  const contextLabel = useAccountLabels();
  const [definitions, setDefinitions] = useState<McpDefinition[]>([]);
  const [placements, setPlacements] = useState<McpPlacement[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [willDistribute, setWillDistribute] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [pasteFirst, setPasteFirst] = useState(false);
  const distributeRef = useRef<McpDistributeHandle>(null);
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [envRows, setEnvRows] = useState<KeyValueRow[]>([{ key: '', value: '' }]);
  const [headerRows, setHeaderRows] = useState<KeyValueRow[]>([{ key: '', value: '' }]);
  const [baseline, setBaseline] = useState('');
  const [showIssues, setShowIssues] = useState(false);
  const [busy, setBusy] = useState(false);
  // Page results float as toasts so the card grid never jumps.
  const { setError, setNotice } = useFeedback();
  const [dialogError, setDialogError] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!active) return;
    let live = true;
    void Promise.all([native.listMcpDefinitions(), native.listMcpPlacements()])
      .then(([items, placed]) => { if (live) { setDefinitions(items); setPlacements(placed); setLoaded(true); } })
      .catch((value) => { if (live) { setError(failure(value)); setLoaded(true); } });
    return () => { live = false; };
  }, [active]);

  useEffect(() => {
    onCountChange?.(definitions.filter((item) => item.inLibrary !== false).length);
  }, [definitions, onCountChange]);

  const current: EditorState | null = draft ? { draft, envRows, headerRows } : null;
  const dirty = !!current && fingerprint(current) !== baseline;

  function editMcp(item?: McpDefinition, paste = false) {
    const next: EditorState = { draft: item ? mcpDraftOf(item) : blankMcpDraft(), envRows: editableRowsOf(item?.env ?? {}), headerRows: editableRowsOf(item?.headers ?? {}) };
    setDraft(next.draft);
    setEnvRows(next.envRows);
    setHeaderRows(next.headerRows);
    setBaseline(fingerprint(next));
    setDialogError('');
    setShowIssues(false);
    setWillDistribute(false);
    setConflict(false);
    setPasteFirst(paste);
    setFormKey((value) => value + 1);
  }
  const formKeyRef = useRef(formKey); formKeyRef.current = formKey;
  async function closeEditor() {
    if (dirty) {
      const opened = formKey;
      const keep = !await confirmAction(t('library.resources.confirmDiscard'), () => opened === formKeyRef.current, { title: t('common.app.leaveDirtyTitle'), confirmLabel: t('common.app.leaveDirtyConfirm') });
      if (keep) return;
    }
    setDraft(null);
    setConflict(false);
  }

  const handledCreate = useRef(createSignal);
  useEffect(() => {
    if (createSignal === handledCreate.current) return;
    handledCreate.current = createSignal;
    editMcp();
  }, [createSignal]);

  function importJson(parsed: McpParsedServer) {
    if (!draft) return;
    const next = applyParsedServer(draft, parsed);
    setDraft(next.draft);
    setEnvRows(next.envRows);
    setHeaderRows(next.headerRows);
    setDialogError('');
  }

  async function remove(item: McpDefinition) {
    if (busy || !await confirmAction(t('library.resources.confirmRemoveMcp', { name: item.name }), () => true, { title: t('tools.mcp.removeTitle'), confirmLabel: t('tools.agents.delete'), destructive: true })) return;
    setBusy(true); setError('');
    try {
      await native.deleteMcpDefinition(item.id, item.version);
      setDefinitions(await native.listMcpDefinitions());
      setDraft(null);
      setNotice(t('library.resources.removed'));
    } catch (value) { setError(failure(value)); }
    finally { setBusy(false); }
  }

  async function duplicateMcp(item: McpDefinition) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const name = mcpCopyName(item.name, definitions.map((entry) => entry.name));
      await native.saveMcpDefinition({ ...mcpDraftOf(item), id: null, expectedVersion: null, name });
      setDefinitions(await native.listMcpDefinitions());
      setNotice(t('library.resources.duplicated', { name }));
    } catch (value) { setError(failure(value)); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!draft || busy) return;
    if (hasMcpIssues(mcpDraftIssues(draft))) { setShowIssues(true); return; }
    setBusy(true); setDialogError('');
    try {
      const saved = await native.saveMcpDefinition({ ...draft, name: draft.name.trim(), args: keptMcpArgs(draft.args), inLibrary: true, env: recordOfRows(envRows), headers: recordOfRows(headerRows) });
      setDefinitions(await native.listMcpDefinitions());
      const savedDraft = mcpDraftOf(saved);
      setDraft(savedDraft);
      setBaseline(fingerprint({ draft: savedDraft, envRows, headerRows }));
      const alreadyPlaced = placements.some((item) => item.definitionId === saved.id);
      if (willDistribute || alreadyPlaced) {
        const outcome = await distributeRef.current?.run(saved);
        setPlacements(await native.listMcpPlacements().catch(() => []));
        if (outcome?.status === 'written') { setConflict(false); setDialogError(''); setDraft(null); setNotice(outcome.notice); }
        else if (outcome?.status === 'pending') setConflict(true);
        else {
          setConflict(false);
          setDialogError(outcome?.status === 'failed' ? outcome.message : t('library.resources.savedNotDistributed'));
        }
      } else {
        setPlacements(await native.listMcpPlacements().catch(() => []));
        setDraft(null);
        setNotice(t('library.resources.saved'));
      }
      setError('');
    } catch (value) { setDialogError(failure(value)); }
    finally { setBusy(false); }
  }

  async function replaceDistribution() {
    if (busy) return;
    setBusy(true); setDialogError('');
    try {
      const outcome = await distributeRef.current?.commit();
      setPlacements(await native.listMcpPlacements().catch(() => []));
      if (outcome?.status === 'written') { setConflict(false); setDraft(null); setNotice(outcome.notice); setError(''); }
    } catch (value) { setDialogError(failure(value)); }
    finally { setBusy(false); }
  }

  async function toggleMcp(item: McpDefinition, toolId: string, scope: Scope, projectPath: string | null, contextId: string | null) {
    if (busy) return;
    const toolName = tools.find((tool) => tool.id === toolId)?.name ?? toolId;
    const where = scope === 'project' ? t('library.page.whereScope', { scope: scopeLabel(scope, projectPath, projects) }) : '';
    const place = placements.find((entry) => entry.definitionId === item.id && entry.toolId === toolId && entry.scope === scope && (entry.contextId ?? null) === contextId && (scope === 'global' || samePath(entry.projectPath, projectPath)));
    setBusy(true); setError(''); setNotice('');
    try {
      if (place) {
        await native.removeNativeMcp({ toolId, scope, projectPath: place.projectPath, contextId: await removalContext(place), enabled: place.enabled }, item.name);
        setNotice(t('library.page.removed', { where, tool: toolName }));
      } else {
        const target: McpTargetRequest = { toolId, scope, projectPath, enabled: true };
        const preview = await native.previewMcpTargets(item.id, [target]);
        const first = preview[0];
        if (!first || (first.status !== 'ready' && first.status !== 'conflict')) { setError(first?.detail || t('library.resources.cannotWrite', { tool: toolName })); return; }
        if (first.status === 'conflict' && !await confirmAction(t('library.resources.confirmReplace', { name: item.name, tool: toolName }), () => true, { title: t('library.resources.replaceMcpTitle'), confirmLabel: t('library.page.replaceAction') })) return;
        await native.distributeMcp(item.id, [{ ...target, contextId: first.contextId, baselineHash: first.baselineHash, previewToken: first.previewToken, allowReplace: first.status === 'conflict' }]);
        setNotice(t('library.page.written', { where, tool: toolName }));
      }
      setPlacements(await native.listMcpPlacements().catch(() => placements));
    } catch (value) { setError(failure(value)); }
    finally { setBusy(false); }
  }

  const needle = search.trim().toLowerCase();
  const library = definitions.filter((item) => item.inLibrary !== false);
  const shown = library.filter((item) => !needle || `${item.name} ${item.command} ${item.args.join(' ')} ${item.url ?? ''}`.toLowerCase().includes(needle));

  return <div className={styles.layout}>
    <SearchField className={styles.searchBox} label={t('library.page.searchLabel')} pageSearch title={searchShortcutHint()} value={search} onChange={setSearch} placeholder={t('library.resources.searchMcpPlaceholder')} />
    <div className={styles.list} aria-label={t('library.resources.mcpListAria')}>
      {shown.length ? shown.map((item) => {
        const places = placements.filter((entry) => entry.definitionId === item.id);
        const envCount = filledCount(item.env);
        const headerCount = filledCount(item.headers);
        const summary = mcpSummary(item);
        return <article className={styles.card} key={item.id}>
          <div className={styles.cardHead}>
            <span className={styles.cardIcon} data-transport={item.transport} aria-hidden="true"><Icon name={item.transport === 'http' ? 'globe' : 'terminal'} size={16} /></span>
            <div className={styles.cardHeading}>
              <button className={styles.cardTitle} type="button" onClick={() => editMcp(item)}>{item.name}</button>
              <span className={styles.cardMeta}>
                <span className={styles.badge} data-accent={item.transport === 'http' || undefined}>{item.transport === 'http' ? 'HTTP' : 'stdio'}</span>
                {envCount > 0 && <span className={styles.metaChip}>{t('library.resources.envCount', { count: envCount })}</span>}
                {headerCount > 0 && <span className={styles.metaChip}>{t('library.resources.headerCount', { count: headerCount })}</span>}
                <span className={styles.placedNote} data-empty={!places.length || undefined}>{places.length ? t('library.resources.placedCount', { count: places.length }) : t('library.resources.notPlaced')}</span>
              </span>
            </div>
            <div className={styles.iconActions}>
              <button type="button" aria-label={t('library.resources.duplicate')} title={t('library.resources.duplicate')} disabled={busy} onClick={() => void duplicateMcp(item)}><Icon name="copy" size={15} /></button>
              <button type="button" className={styles.danger} aria-label={t('tools.agents.delete')} title={t('tools.agents.delete')} disabled={busy} onClick={() => void remove(item)}><Icon name="trash" size={15} /></button>
            </div>
          </div>
          <code className={styles.command} title={summary}>{summary || (item.transport === 'http' ? t('library.resources.noUrl') : t('library.resources.noCommand'))}</code>
          <div className={styles.cardBar}>
            <ScopeMarks contextLabel={contextLabel} accountContexts label={t('library.page.cliMarks', { title: item.name })} tools={tools} places={places} projects={projects} busy={busy} onToggle={(toolId, scope, projectPath, contextId) => void toggleMcp(item, toolId, scope, projectPath, contextId)} mark={(place) => {
              if (!place) return { pressed: false, state: 'off', status: t('library.page.markOff') };
              if (!place.enabled) return { pressed: true, state: 'unavailable', status: t('library.resources.markDisabled') };
              return { pressed: true, state: 'current', status: t('library.page.markCurrent') };
            }} />
            <button type="button" className={styles.editButton} onClick={() => editMcp(item)}><Icon name="pencil" size={13} />{t('library.resources.edit')}</button>
          </div>
        </article>;
      }) : needle
        ? <div className={styles.empty}><Icon name="search" size={28} strokeWidth={1.3} />{t('library.resources.noMcpMatch', { query: search.trim() })}</div>
        : loaded ? <div className={styles.empty}>
          <span className={styles.emptyIcon}><Icon name="connections" size={22} strokeWidth={1.5} /></span>
          <strong>{t('library.resources.emptyMcpTitle')}</strong>
          {t('library.resources.emptyMcpDetail')}
          <div className={styles.emptyActions}>
            <button type="button" className={styles.primary} onClick={() => editMcp()}><Icon name="plus" size={14} strokeWidth={2.2} />{t('library.resources.emptyMcpCreate')}</button>
            <button type="button" onClick={() => editMcp(undefined, true)}><Icon name="clipboard" size={14} />{t('library.resources.pasteCreate')}</button>
          </div>
        </div> : null}
    </div>
    <GuideDialog wide open={!!draft} title={draft?.id ? t('tools.mcp.editTitle') : t('library.resources.newMcpTitle')} hint={t('library.resources.mcpDialogHint')} onClose={() => void closeEditor()}>
      {draft && <>
        <div className={styles.editor}>
          <div className={styles.editorForm}>
            <McpFormFields key={formKey} title={t('library.resources.connectionTitle')} draft={draft} onChange={setDraft} envRows={envRows} onEnvRowsChange={setEnvRows} headerRows={headerRows} onHeaderRowsChange={setHeaderRows} showIssues={showIssues} onImport={importJson} initialPasteOpen={pasteFirst} />
          </div>
          <McpDistribution key={formKey} ref={distributeRef} definition={definitions.find((item) => item.id === draft.id) ?? { ...draft, id: draft.id ?? '', version: draft.expectedVersion ?? 0 }} tools={tools} projects={projects} placements={placements} formStamp={JSON.stringify([draft.name, draft.transport, draft.command, draft.args, draft.url, envRows, headerRows])} onWillDistribute={setWillDistribute} onConflictChange={setConflict} />
        </div>
        {dialogError && <p className={styles.error} role="alert">{dialogError}</p>}
        <div className="dialog-footer">
          {draft.id && <button type="button" className={styles.dangerQuiet} disabled={busy} onClick={() => { const found = definitions.find((item) => item.id === draft.id); if (found) void remove(found); }}><Icon name="trash" size={14} />{t('tools.agents.delete')}</button>}
          <span className="dialog-footer-gap" />
          {dirty && !conflict && <span className={styles.dirty}>{t('library.page.dirtyState')}</span>}
          {conflict && <button type="button" disabled={busy} onClick={() => { setConflict(false); distributeRef.current?.dismiss(); }}>{t('common.conflict.keepCurrent')}</button>}
          <button type="button" className={styles.primary} data-dialog-save title={saveShortcutHint()} disabled={busy || !draft.name.trim()} onClick={() => void (conflict ? replaceDistribution() : save())}>{conflict ? t('library.resources.replaceDistribute') : willDistribute ? t('library.resources.saveDistribute') : t('home.launcher.save')}</button>
        </div>
      </>}
    </GuideDialog>
  </div>;
}
