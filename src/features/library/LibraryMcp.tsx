import { removalContext, useAccountLabels } from './resourceContexts';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GuideDialog } from '../../components/GuideDialog';
import { ConflictCompare } from '../../components/configuration/ConflictCompare';
import { SearchField } from '../../components/SearchField';
import { Icon } from '../../components/Icon';
import { EmptyState } from '../../components/EmptyState';
import { SkeletonRows } from '../../components/Skeleton';
import { ResourceWorkspace } from '../../components/resource/ResourceWorkspace';
import { ScopeMarks, samePath, scopeLabel } from './CliMarks';
import { confirmAction } from '../../lib/confirm';
import { blankMcpDraft, editableRowsOf, hasMcpIssues, keptMcpArgs, mcpCopyName, mcpDraftIssues, mcpDraftOf, mcpSummary, recordOfRows, type KeyValueRow, type McpParsedServer } from '../../lib/mcp';
import { McpFormFields } from '../../components/mcp/McpFormFields';
import { McpDetails } from '../../components/mcp/McpDetails';
import { McpBatchImport, type McpBatchItem } from '../../components/mcp/McpBatchImport';
import { native } from '../../lib/native';
import { useFeedback } from '../../lib/toast';
import { saveShortcutHint, searchShortcutHint } from '../../lib/shortcut';
import type { Project } from '../../types/launch';
import type { AdapterDescriptor, Scope } from '../../types/native';
import type { McpDefinition, McpDraft, McpDraftTargetRequest, McpPlacement, McpTargetRequest, McpTargetResult } from '../../types/resources';
import { McpDistribution, type McpConfirmation, type McpDistributeHandle } from './McpDistribution';
import i18n from '../../i18n';
import styles from './LibraryMcp.module.css';

function failure(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : i18n.t('tools.workspace.operationFailed');
}

type EditorState = { draft: McpDraft; envRows: KeyValueRow[]; headerRows: KeyValueRow[] };
const fingerprint = (state: EditorState) => JSON.stringify([state.draft.name, state.draft.transport, state.draft.command, keptMcpArgs(state.draft.args), state.draft.url, recordOfRows(state.envRows), recordOfRows(state.headerRows)]);

export function LibraryMcp({ active, tools, projects, createSignal = 0, onCountChange, spotlight = null, onOpenConnections }: { active: boolean; tools: AdapterDescriptor[]; projects: Project[]; createSignal?: number; onCountChange?: (count: number) => void; spotlight?: { id: string; token: number } | null; onOpenConnections?: () => void }) {
  const { t } = useTranslation();
  const contextLabel = useAccountLabels();
  const [definitions, setDefinitions] = useState<McpDefinition[]>([]);
  const [placements, setPlacements] = useState<McpPlacement[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [willDistribute, setWillDistribute] = useState(false);
  const [confirmation, setConfirmation] = useState<McpConfirmation>('none');
  const [formKey, setFormKey] = useState(0);
  const [pasteFirst, setPasteFirst] = useState(false);
  const [editorIntent, setEditorIntent] = useState<'edit' | 'distribute'>('edit');
  const distributeRef = useRef<McpDistributeHandle>(null);
  const loadRequest = useRef(0);
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [envRows, setEnvRows] = useState<KeyValueRow[]>([{ key: '', value: '' }]);
  const [headerRows, setHeaderRows] = useState<KeyValueRow[]>([{ key: '', value: '' }]);
  const [baseline, setBaseline] = useState('');
  const [showIssues, setShowIssues] = useState(false);
  const [busy, setBusy] = useState(false);
  const { setError, setNotice } = useFeedback();
  const [dialogError, setDialogError] = useState('');
  const [search, setSearch] = useState('');
  const [placementFilter, setPlacementFilter] = useState<'all' | 'placed' | 'unplaced'>('all');
  const [batchItems, setBatchItems] = useState<McpBatchItem[] | null>(null);
  const [importSource, setImportSource] = useState('');
  const [removalConflict, setRemovalConflict] = useState<{ draft: McpDraft; target: McpDraftTargetRequest; result: McpTargetResult } | null>(null);
  const [writeConflict, setWriteConflict] = useState<{ definitionId: string; name: string; target: McpTargetRequest; result: McpTargetResult } | null>(null);

  async function reload() {
    const request = ++loadRequest.current;
    setLoading(true);
    setError('');
    try {
      const [items, placed] = await Promise.all([native.listMcpDefinitions(), native.listMcpPlacements()]);
      if (request !== loadRequest.current) return;
      setDefinitions(items);
      setPlacements(placed);
      setSelectedId(current => current && items.some(item => item.id === current && item.inLibrary !== false) ? current : items.find(item => item.inLibrary !== false)?.id ?? null);
      setLoaded(true);
      setStale(false);
    } catch (value) {
      if (request !== loadRequest.current) return;
      setStale(true);
      setError(failure(value));
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (!active) return;
    void reload();
    return () => { loadRequest.current++; };
  }, [active]);

  useEffect(() => {
    onCountChange?.(definitions.filter((item) => item.inLibrary !== false).length);
  }, [definitions, onCountChange]);

  const current: EditorState | null = draft ? { draft, envRows, headerRows } : null;
  const dirty = !!current && fingerprint(current) !== baseline;

  function editMcp(item?: McpDefinition, paste = false, intent: 'edit' | 'distribute' = 'edit') {
    const next: EditorState = { draft: item ? mcpDraftOf(item) : blankMcpDraft(), envRows: editableRowsOf(item?.env ?? {}), headerRows: editableRowsOf(item?.headers ?? {}) };
    setEditorIntent(intent);
    setDraft(next.draft);
    setEnvRows(next.envRows);
    setHeaderRows(next.headerRows);
    setBaseline(fingerprint(next));
    setDialogError('');
    setShowIssues(false);
    setWillDistribute(false);
    setConfirmation('none');
    setPasteFirst(paste);
    setImportSource('');
    setFormKey((value) => value + 1);
  }

  const formKeyRef = useRef(formKey);
  formKeyRef.current = formKey;

  async function closeEditor() {
    if (dirty || batchItems) {
      const opened = formKey;
      const keep = !await confirmAction(t('library.resources.confirmDiscard'), () => opened === formKeyRef.current, { title: t('common.app.leaveDirtyTitle'), confirmLabel: t('common.app.leaveDirtyConfirm') });
      if (keep) return;
    }
    setBatchItems(null);
    setImportSource('');
    setDraft(null);
    setConfirmation('none');
  }

  const handledCreate = useRef(createSignal);
  useEffect(() => {
    if (createSignal === handledCreate.current) return;
    handledCreate.current = createSignal;
    editMcp();
  }, [createSignal]);

  // "Edit and distribute" lands on the CLI targets; the narrow editor stacks them
  // below the form, so focus also scrolls the dialog to the right section.
  useEffect(() => {
    if (!draft || editorIntent !== 'distribute') return;
    const timer = window.setTimeout(() => {
      const panel = document.querySelector<HTMLElement>('dialog[open] [data-mcp-targets]');
      const first = panel?.querySelector<HTMLInputElement>('input[type="checkbox"]:not(:disabled)');
      first?.focus({ preventScroll: true });
      panel?.scrollIntoView({ block: 'nearest' });
    }, 30);
    return () => window.clearTimeout(timer);
  }, [editorIntent, formKey]);

  function importJson(parsed: McpParsedServer[], source: string) {
    const seen = new Set<string>();
    const items = parsed.map((server, index): McpBatchItem => {
      const name = server.name.trim() || (parsed.length === 1 ? draft?.name.trim() ?? '' : '');
      const duplicate = !!name && (seen.has(name) || definitions.some(item => item.name === name));
      seen.add(name);
      const blocked = [duplicate ? t('tools.mcp.batchDuplicate', { name }) : '', ...server.invalid.map(issue => t('tools.mcp.parseIssue.' + issue))].filter(Boolean).join(' ');
      return { key: index + ':' + name, blocked: blocked || undefined,
        draft: { ...blankMcpDraft(), name, transport: server.transport, command: server.command, args: server.args, url: server.url,
          env: server.env, headers: server.headers, inLibrary: true } };
    });
    setBatchItems(items);
    setImportSource(source);
    setDialogError('');
    return true;
  }

  function keepDefinition(saved: McpDefinition) {
    setDefinitions(current => [...current.filter(item => item.id !== saved.id), saved]);
    setSelectedId(saved.id);
  }

  async function refreshPlacements() {
    try {
      setPlacements(await native.listMcpPlacements());
      setStale(false);
    } catch (value) {
      setStale(true);
      setError(failure(value));
    }
  }

  async function remove(item: McpDefinition) {
    if (busy || !await confirmAction(t('library.resources.confirmRemoveMcp', { name: item.name }), () => true, { title: t('tools.mcp.removeTitle'), confirmLabel: t('tools.agents.delete'), destructive: true })) return;
    setBusy(true); setError('');
    try {
      await native.deleteMcpDefinition(item.id, item.version);
      setDefinitions(current => current.filter(entry => entry.id !== item.id));
      if (selectedId === item.id) setSelectedId(null);
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
      const saved = await native.saveMcpDefinition({ ...mcpDraftOf(item), id: null, expectedVersion: null, name });
      setDefinitions(current => [...current.filter(entry => entry.id !== saved.id), saved]);
      setNotice(t('library.resources.duplicated', { name }));
    } catch (value) { setError(failure(value)); }
    finally { setBusy(false); }
  }

  function keepCommittedDefinition(saved: McpDefinition) {
    keepDefinition(saved);
    const savedDraft = mcpDraftOf(saved);
    setDraft(savedDraft);
    setBaseline(fingerprint({ draft: savedDraft, envRows, headerRows }));
  }

  async function save() {
    if (!draft || busy) return;
    if (hasMcpIssues(mcpDraftIssues(draft))) { setShowIssues(true); return; }
    setBusy(true); setDialogError('');
    const normalized = { ...draft, name: draft.name.trim(), args: keptMcpArgs(draft.args), inLibrary: true, env: recordOfRows(envRows), headers: recordOfRows(headerRows) };
    try {
      const alreadyPlaced = !!draft.id && placements.some((item) => item.definitionId === draft.id);
      if (willDistribute || alreadyPlaced) {
        const outcome = await distributeRef.current?.run(normalized);
        if (outcome?.status === 'failed') setDialogError(outcome.message);
        else if (outcome?.status === 'stale') setDialogError(t('library.distribute.changedError'));
      } else {
        const saved = await native.saveMcpDefinition(normalized);
        keepCommittedDefinition(saved);
        await refreshPlacements();
        setDraft(null);
        setNotice(t('library.resources.saved'));
      }
      setError('');
    } catch (value) { setDialogError(failure(value)); }
    finally { setBusy(false); }
  }

  async function confirmDistribution() {
    if (busy) return;
    setBusy(true); setDialogError('');
    try {
      const outcome = await distributeRef.current?.commit();
      if (outcome && 'definition' in outcome && outcome.definition) keepCommittedDefinition(outcome.definition);
      await refreshPlacements();
      if (outcome?.status === 'written') {
        setConfirmation('none');
        setDraft(null);
        setNotice(outcome.notice);
        setError('');
      } else if (outcome?.status === 'failed') setDialogError(outcome.message);
      else if (outcome?.status === 'stale') setDialogError(t('library.distribute.changedError'));
    } catch (value) { setDialogError(failure(value)); }
    finally { setBusy(false); }
  }

  async function confirmRemovalConflict() {
    const current = removalConflict;
    if (!current || busy) return;
    const { result } = current;
    const toolName = tools.find((tool) => tool.id === result.toolId)?.name ?? result.toolId;
    const where = result.scope === 'project' ? t('library.page.whereScope', { scope: scopeLabel(result.scope, result.projectPath, projects) }) : '';
    setRemovalConflict(null);
    setBusy(true); setError(''); setNotice('');
    try {
      const committed = await native.commitMcpDraft(current.draft, [{ ...current.target, contextId: result.contextId, baselineHash: result.baselineHash, previewToken: result.previewToken, allowReplace: true }]);
      keepDefinition(committed.definition);
      const failed = committed.targets.find(target => target.status !== 'removed');
      if (failed) setError(failed.detail || t('library.resources.cannotWrite', { tool: toolName }));
      else setNotice(t('library.page.removed', { where, tool: toolName }));
      await refreshPlacements();
    } catch (value) { setError(failure(value)); }
    finally { setBusy(false); }
  }

  async function confirmWriteConflict() {
    const current = writeConflict;
    if (!current || busy) return;
    const { result } = current;
    const toolName = tools.find((tool) => tool.id === result.toolId)?.name ?? result.toolId;
    const where = result.scope === 'project' ? t('library.page.whereScope', { scope: scopeLabel(result.scope, result.projectPath, projects) }) : '';
    setWriteConflict(null);
    setBusy(true); setError(''); setNotice('');
    try {
      const results = await native.distributeMcp(current.definitionId, [{ ...current.target, contextId: result.contextId, baselineHash: result.baselineHash, previewToken: result.previewToken, allowReplace: true }]);
      const failed = results.find(target => target.status !== 'written');
      if (failed) setError(failed.detail || t('library.resources.cannotWrite', { tool: toolName }));
      else setNotice(t('library.page.written', { where, tool: toolName }));
      await refreshPlacements();
    } catch (value) { setError(failure(value)); }
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
        const target: McpDraftTargetRequest = { toolId, scope, projectPath: place.projectPath, contextId: await removalContext(place), enabled: place.enabled, operation: 'remove' };
        const candidate = await native.previewMcpDraft(mcpDraftOf(item), [target]);
        const first = candidate.targets[0];
        if (!first || (first.status !== 'ready' && first.status !== 'conflict')) { setError(first?.detail || t('library.resources.cannotWrite', { tool: toolName })); return; }
        if (first.status === 'conflict') {
          setRemovalConflict({ draft: candidate.draft, target, result: first });
          return;
        }
        if (!await confirmAction(t('library.resources.confirmRemoveMcpPlacement', { name: item.name, tool: toolName }), () => true, { title: t('library.resources.removeMcpPlacementTitle'), confirmLabel: t('library.skillDist.removeAction'), destructive: true })) return;
        const committed = await native.commitMcpDraft(candidate.draft, [{ ...target, contextId: first.contextId, baselineHash: first.baselineHash, previewToken: first.previewToken }]);
        keepDefinition(committed.definition);
        const failed = committed.targets.find(result => result.status !== 'removed');
        if (failed) setError(failed.detail || t('library.resources.cannotWrite', { tool: toolName }));
        else setNotice(t('library.page.removed', { where, tool: toolName }));
      } else {
        const target: McpTargetRequest = { toolId, scope, projectPath, enabled: true };
        const preview = await native.previewMcpTargets(item.id, [target]);
        const first = preview[0];
        if (!first || (first.status !== 'ready' && first.status !== 'conflict')) { setError(first?.detail || t('library.resources.cannotWrite', { tool: toolName })); return; }
        if (first.status === 'conflict') {
          setWriteConflict({ definitionId: item.id, name: item.name, target, result: first });
          return;
        }
        const results = await native.distributeMcp(item.id, [{ ...target, contextId: first.contextId, baselineHash: first.baselineHash, previewToken: first.previewToken }]);
        const failed = results.find(result => result.status !== 'written');
        if (failed) setError(failed.detail || t('library.resources.cannotWrite', { tool: toolName }));
        else setNotice(t('library.page.written', { where, tool: toolName }));
      }
      await refreshPlacements();
    } catch (value) { setError(failure(value)); }
    finally { setBusy(false); }
  }

  const needle = search.trim().toLowerCase();
  const library = definitions.filter((item) => item.inLibrary !== false);
  const placementCount = new Map<string, number>();
  for (const place of placements) placementCount.set(place.definitionId, (placementCount.get(place.definitionId) ?? 0) + 1);
  const placedTotal = library.reduce((total, item) => total + (placementCount.get(item.id) ? 1 : 0), 0);
  const totalPlacements = library.reduce((total, item) => total + (placementCount.get(item.id) ?? 0), 0);
  const shown = library.filter((item) => {
    if (needle && !`${item.name} ${item.command} ${item.args.join(' ')} ${item.url ?? ''}`.toLowerCase().includes(needle)) return false;
    const count = placementCount.get(item.id) ?? 0;
    if (placementFilter === 'placed') return count > 0;
    if (placementFilter === 'unplaced') return count === 0;
    return true;
  });

  const handledSpotlight = useRef<number | null>(null);
  useEffect(() => {
    if (!active || !spotlight || handledSpotlight.current === spotlight.token) return;
    if (search) { setSearch(''); return; }
    const item = definitions.find(entry => entry.id === spotlight.id && entry.inLibrary !== false);
    if (!item) return;
    handledSpotlight.current = spotlight.token;
    setSelectedId(item.id);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-mcp-id="' + CSS.escape(item.id) + '"]')?.scrollIntoView({ block: 'center' }));
  }, [active, spotlight?.id, spotlight?.token, definitions, search]);

  const empty = loading && !loaded
    ? <div role="status" aria-label={t('library.resources.loading')}><SkeletonRows count={3} /></div>
    : !loaded
      ? <EmptyState title={t('library.resources.loadFailedTitle')} detail={t('library.resources.loadFailedDetail')} action={<button className="button primary" onClick={() => void reload()}>{t('library.resources.retry')}</button>} icon="alert" />
      : needle && shown.length === 0
        ? <EmptyState title={t('library.resources.noMcpMatch', { query: search.trim() })} action={<button onClick={() => setSearch('')}>{t('library.resources.clearSearch')}</button>} icon="search" />
        : placementFilter !== 'all' && shown.length === 0
          ? <EmptyState title={t('library.resources.filterEmpty')} action={<button onClick={() => setPlacementFilter('all')}>{t('library.resources.clearFilter')}</button>} icon="search" />
          : library.length === 0
            ? <EmptyState title={t('library.resources.emptyMcpTitle')} detail={t('library.resources.emptyMcpDetail')} action={<div className={styles.emptyActions}><button className={styles.primary} onClick={() => editMcp()}><Icon name="plus" size={14} />{t('library.resources.emptyMcpCreate')}</button><button onClick={() => editMcp(undefined, true)}><Icon name="clipboard" size={14} />{t('library.resources.pasteCreate')}</button></div>} icon="connections" />
            : undefined;

  const selected = shown.find(item => item.id === selectedId) ?? null;
  return <>
    <ResourceWorkspace<McpDefinition>
      ariaLabel={t('library.resources.mcpWorkspaceAria')}
      title={t('library.resources.mcpTitle')}
      listLabel={t('library.resources.mcpListAria')}
      description={t('library.resources.mcpDescription')}
      headerActions={<>{onOpenConnections && <button type="button" onClick={onOpenConnections}><Icon name="arrowLeft" size={14} />{t('tools.mcp.returnConnections')}</button>}<button type="button" className={styles.refreshButton} disabled={loading || busy} onClick={() => void reload()}><Icon name="refresh" size={14} />{t('library.resources.refresh')}</button></>}
      toolbar={<div className={styles.mcpToolbar}>
        <SearchField className={styles.searchBox} label={t('library.page.searchLabel')} pageSearch title={searchShortcutHint()} value={search} onChange={setSearch} placeholder={t('library.resources.searchMcpPlaceholder')} />
        {library.length > 0 && <div className={styles.filterGroup} role="group" aria-label={t('library.resources.filterLabel')}>
          {([['all', library.length], ['placed', placedTotal], ['unplaced', library.length - placedTotal]] as const).map(([value, count]) => <button key={value} type="button" aria-pressed={placementFilter === value} data-value={value} onClick={() => setPlacementFilter(value)}>{t(`library.resources.filter${value === 'all' ? 'All' : value === 'placed' ? 'Placed' : 'Unplaced'}`)}<span aria-hidden="true">{count}</span></button>)}
        </div>}
      </div>}
      status={<>
        {loaded && <p className={styles.summaryLine}><span className={styles.summaryCount}>{t('library.resources.summary', { definitions: library.length, placements: totalPlacements })}</span>{!totalPlacements && <span data-quiet>{t('library.resources.summaryEmpty')}</span>}{library.length > 0 && <span className={styles.editHint}><Icon name="pencil" size={11} />{t('library.resources.doubleClickHint')}</span>}</p>}
        {loading && loaded && <p className={styles.progress} role="status">{t('library.resources.refreshing')}</p>}
        {stale && loaded && <div className={styles.stale} role="status"><strong>{t('library.resources.staleTitle')}</strong><span>{t('library.resources.staleDetail')}</span><button disabled={loading} onClick={() => void reload()}>{t('library.resources.retry')}</button></div>}
      </>}
      items={shown}
      getItemKey={item => item.id}
      getItemLabel={item => item.name}
      selectedKey={selectedId}
      onSelect={item => setSelectedId(item.id)}
      onOpenItem={item => { if (!busy) editMcp(item); }}
      openItemHint={t('library.resources.doubleClickHint')}
      onCloseDetails={() => setSelectedId(null)}
      detailsLabel={t('tools.mcp.detailsLabel')}
      closeDetailsLabel={t('tools.mcp.closeDetails')}
      detailsSuspended={!!draft || !!batchItems}
      empty={empty}
      detailsActions={selected && <>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => editMcp(selected, false, 'distribute')}><Icon name="connections" size={14} />{t('library.resources.distribute')}</button>
        <button type="button" disabled={busy} onClick={() => editMcp(selected)}><Icon name="pencil" size={14} />{t('library.resources.edit')}</button>
        <button type="button" disabled={busy} onClick={() => void duplicateMcp(selected)}><Icon name="copy" size={14} />{t('library.resources.duplicate')}</button>
        <button type="button" className={styles.danger} disabled={busy} onClick={() => void remove(selected)}><Icon name="trash" size={14} />{t('tools.agents.delete')}</button>
      </>}
      renderItem={item => {
        const places = placements.filter(entry => entry.definitionId === item.id);
        return <span className={styles.resourceBody} data-mcp-id={item.id} data-placed={places.length > 0 || undefined}>
          <span className={styles.rowIcon} data-transport={item.transport} aria-hidden="true"><Icon name={item.transport === 'http' ? 'globe' : 'terminal'} size={17} /></span>
          <span className={styles.rowMain}>
            <span className={styles.resourceTitle}><strong>{item.name}</strong><span className={styles.badge} data-accent={item.transport === 'http' || undefined}>{item.transport === 'http' ? 'HTTP' : 'stdio'}</span></span>
            <code className={styles.command} title={mcpSummary(item)}>{mcpSummary(item) || t(item.transport === 'http' ? 'library.resources.noUrl' : 'library.resources.noCommand')}</code>
          </span>
          <span className={styles.rowSide}>
            <span className={styles.placedNote} data-placed={places.length > 0 || undefined}>{places.length ? t('library.resources.placedCount', { count: places.length }) : t('library.resources.notPlaced')}</span>
          </span>
        </span>;
      }}
      renderDetails={item => {
        const places = placements.filter(entry => entry.definitionId === item.id);
        return <McpDetails item={item}>
          <section className={styles.placementDetails} aria-label={t('library.resources.distributionTitle')}>
            <div className={styles.placementHeading}><h4>{t('library.resources.distributionTitle')}</h4><span>{places.length ? t('library.resources.placedCount', { count: places.length }) : t('library.resources.notPlaced')}</span></div>
            <ScopeMarks contextLabel={contextLabel} accountContexts label={t('library.page.cliMarks', { title: item.name })} tools={tools} places={places} projects={projects} busy={busy} onToggle={(toolId, scope, projectPath, contextId) => void toggleMcp(item, toolId, scope, projectPath, contextId)} mark={(place) => {
              if (!place) return { pressed: false, state: 'off', status: t('library.page.markOff') };
              if (!place.enabled) return { pressed: true, state: 'unavailable', status: t('library.resources.markDisabled') };
              return { pressed: true, state: 'current', status: t('library.page.markCurrent') };
            }} />
          </section>
        </McpDetails>;
      }}
    />
    <GuideDialog wide open={!!writeConflict} title={t('library.resources.replaceMcpTitle')} hint={writeConflict ? t('library.resources.confirmReplace', { name: writeConflict.name, tool: tools.find(tool => tool.id === writeConflict.result.toolId)?.name ?? writeConflict.result.toolId }) : undefined} onClose={() => setWriteConflict(null)}>
      {writeConflict && <>
        <ConflictCompare
          title={tools.find(tool => tool.id === writeConflict.result.toolId)?.name ?? writeConflict.result.toolId}
          banner={writeConflict.result.detail}
          currentContent={JSON.stringify(writeConflict.result.existing, null, 2)}
          nextContent={JSON.stringify(writeConflict.result.proposed, null, 2)}
          format="json"
          busy={busy}
          actions={false}
          onUseNext={() => undefined}
          onKeepCurrent={() => undefined}
        />
        <div className="dialog-footer">
          <button type="button" disabled={busy} onClick={() => setWriteConflict(null)}>{t('common.conflict.keepCurrent')}</button>
          <span className="dialog-footer-gap" />
          <button type="button" className={styles.primary} disabled={busy} onClick={() => void confirmWriteConflict()}>{t('library.page.replaceAction')}</button>
        </div>
      </>}
    </GuideDialog>
    <GuideDialog wide open={!!removalConflict} title={t('library.resources.removeMcpPlacementTitle')} hint={removalConflict ? t('library.resources.confirmRemoveMcpPlacement', { name: removalConflict.draft.name, tool: tools.find(tool => tool.id === removalConflict.result.toolId)?.name ?? removalConflict.result.toolId }) : undefined} onClose={() => setRemovalConflict(null)}>
      {removalConflict && <>
        <ConflictCompare
          title={tools.find(tool => tool.id === removalConflict.result.toolId)?.name ?? removalConflict.result.toolId}
          banner={removalConflict.result.detail}
          currentContent={JSON.stringify(removalConflict.result.existing, null, 2)}
          nextContent={JSON.stringify(removalConflict.result.proposed, null, 2)}
          format="json"
          busy={busy}
          actions={false}
          onUseNext={() => undefined}
          onKeepCurrent={() => undefined}
        />
        <div className="dialog-footer">
          <button type="button" disabled={busy} onClick={() => setRemovalConflict(null)}>{t('common.conflict.keepCurrent')}</button>
          <span className="dialog-footer-gap" />
          <button type="button" className={styles.danger} disabled={busy} onClick={() => void confirmRemovalConflict()}>{t('library.skillDist.removeAction')}</button>
        </div>
      </>}
    </GuideDialog>
    <GuideDialog wide open={!!draft && !batchItems} title={draft?.id ? t('tools.mcp.editTitle') : t('library.resources.newMcpTitle')} hint={t('library.resources.mcpDialogHint')} onClose={() => void closeEditor()}>
      {draft && <>
        <div className={styles.editor}>
          <div className={styles.editorForm}>
            <McpFormFields key={formKey} title={t('library.resources.connectionTitle')} draft={draft} onChange={setDraft} envRows={envRows} onEnvRowsChange={setEnvRows} headerRows={headerRows} onHeaderRowsChange={setHeaderRows} showIssues={showIssues} onImport={importJson} initialPasteOpen={pasteFirst} initialPasteText={importSource} />
          </div>
          <McpDistribution key={formKey} ref={distributeRef} definition={definitions.find((item) => item.id === draft.id) ?? { ...draft, id: draft.id ?? '', version: draft.expectedVersion ?? 0 }} tools={tools} projects={projects} placements={placements} formStamp={JSON.stringify([draft.name, draft.transport, draft.command, draft.args, draft.url, envRows, headerRows])} onWillDistribute={setWillDistribute} onConfirmationChange={setConfirmation} />
        </div>
        {dialogError && <p className={styles.error} role="alert">{dialogError}</p>}
        <div className="dialog-footer">
          {draft.id && <button type="button" className={styles.dangerQuiet} disabled={busy} onClick={() => { const found = definitions.find((item) => item.id === draft.id); if (found) void remove(found); }}><Icon name="trash" size={14} />{t('tools.agents.delete')}</button>}
          <span className="dialog-footer-gap" />
          {dirty && confirmation === 'none' && <span className={styles.dirty}>{t('library.page.dirtyState')}</span>}
          {confirmation !== 'none' && <button type="button" disabled={busy} onClick={() => { setConfirmation('none'); distributeRef.current?.dismiss(); }}>{t(confirmation === 'conflict' ? 'common.conflict.keepCurrent' : 'library.resources.back')}</button>}
          <button type="button" className={styles.primary} data-dialog-save title={saveShortcutHint()} disabled={busy || !draft.name.trim()} onClick={() => void (confirmation !== 'none' ? confirmDistribution() : save())}>{confirmation === 'conflict' ? t('library.resources.replaceDistribute') : confirmation === 'ready' ? t('library.resources.confirmDistribute') : willDistribute ? t('library.resources.saveDistribute') : t('home.launcher.save')}</button>
        </div>
      </>}
    </GuideDialog>
    <GuideDialog wide open={!!batchItems} title={t('tools.mcp.batchTitle')} hint={t('tools.mcp.batchLibraryHint')} onClose={() => void closeEditor()}>
      {batchItems && <McpBatchImport items={batchItems} onCancel={() => setBatchItems(null)}
        onPreview={value => native.previewMcpDraft(value, [])}
        onCommit={(value, candidate, replace) => native.commitMcpDraft(value, candidate.targets.filter(item => item.status === 'ready' || replace && item.status === 'conflict').map(item => ({ toolId: item.toolId, scope: item.scope, projectPath: item.projectPath, contextId: item.contextId, enabled: true, baselineHash: item.baselineHash, previewToken: item.previewToken, allowReplace: replace && item.status === 'conflict' })))}
        onDefinitionSaved={result => { keepDefinition(result.definition); setNotice(t('library.resources.saved')); }}
        onComplete={() => setImportSource('')} />}
    </GuideDialog>
  </>;
}
