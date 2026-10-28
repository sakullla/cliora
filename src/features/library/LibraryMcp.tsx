import { removalContext, useAccountLabels } from './resourceContexts';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GuideDialog } from '../../components/GuideDialog';
import { ConflictCompare } from '../../components/configuration/ConflictCompare';
import { SearchField } from '../../components/SearchField';
import { Icon } from '../../components/Icon';
import { EmptyState } from '../../components/EmptyState';
import { SkeletonRows } from '../../components/Skeleton';
import { ScopeMarks, samePath, scopeLabel } from './CliMarks';
import { confirmAction } from '../../lib/confirm';
import { blankMcpDraft, editableRowsOf, hasMcpIssues, keptMcpArgs, mcpCopyName, mcpDraftIssues, mcpDraftOf, mcpSummary, recordOfRows, type KeyValueRow, type McpParsedServer } from '../../lib/mcp';
import { McpFormFields } from '../../components/mcp/McpFormFields';
import { McpBatchImport, type McpBatchItem } from '../../components/mcp/McpBatchImport';
import { native } from '../../lib/native';
import { useFeedback } from '../../lib/toast';
import { saveShortcutHint, searchShortcutHint } from '../../lib/shortcut';
import type { Project } from '../../types/launch';
import type { AdapterDescriptor, Scope } from '../../types/native';
import type { McpDefinition, McpDraft, McpDraftTargetRequest, McpPlacement, McpTargetRequest, McpTargetResult, NativeMcpEntry } from '../../types/resources';
import { McpDistribution, type McpConfirmation, type McpDistributeHandle } from './McpDistribution';
import { Badge, Button } from '../../components/ui';
import i18n from '../../i18n';
import styles from './LibraryMcp.module.css';

function failure(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : i18n.t('tools.workspace.operationFailed');
}

type EditorState = { draft: McpDraft; envRows: KeyValueRow[]; headerRows: KeyValueRow[] };
const fingerprint = (state: EditorState) => JSON.stringify([state.draft.name, state.draft.transport, state.draft.command, keptMcpArgs(state.draft.args), state.draft.url, recordOfRows(state.envRows), recordOfRows(state.headerRows)]);

export function LibraryMcp({ active, tools, projects, createSignal = 0, onCountChange, spotlight = null, onOpenConnections, remoteTargetId = null }: { active: boolean; tools: AdapterDescriptor[]; projects: Project[]; createSignal?: number; onCountChange?: (count: number) => void; spotlight?: { id: string; token: number } | null; onOpenConnections?: () => void; remoteTargetId?: string | null }) {
  const { t } = useTranslation();
  const contextLabel = useAccountLabels(!!remoteTargetId);
  const remoteToolId = tools[0]?.id ?? 'codex';
  const remoteToolIds = tools.length ? tools.map(tool => tool.id) : [remoteToolId];
  const remoteToolFor = (id: string | null | undefined) => id?.startsWith('remote:') ? id.split(':')[1] || remoteToolId : remoteToolId;
  const [definitions, setDefinitions] = useState<McpDefinition[]>([]);
  const [placements, setPlacements] = useState<McpPlacement[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);
  const [willDistribute, setWillDistribute] = useState(false);
  const [confirmation, setConfirmation] = useState<McpConfirmation>('none');
  const [formKey, setFormKey] = useState(0);
  const [pasteFirst, setPasteFirst] = useState(false);
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
  const [batchItems, setBatchItems] = useState<McpBatchItem[] | null>(null);
  const [importSource, setImportSource] = useState('');
  const [removalConflict, setRemovalConflict] = useState<{ draft: McpDraft; target: McpDraftTargetRequest; result: McpTargetResult } | null>(null);
  const [writeConflict, setWriteConflict] = useState<{ definitionId: string; name: string; target: McpTargetRequest; result: McpTargetResult } | null>(null);

  async function reload() {
    const request = ++loadRequest.current;
    setLoading(true);
    setError('');
    setLoadError('');
    try {
      if (remoteTargetId) {
        const bundle = await native.listRemoteResourceStores(remoteTargetId, remoteToolIds, 'mcp');
        const stores = remoteToolIds.map(toolId => (bundle.stores?.[toolId] ?? { entries: [] }) as { entries?: NativeMcpEntry[] });
        const items: McpDefinition[] = stores.flatMap((store, toolIndex) => (store.entries ?? []).map((entry, index) => ({ id: `remote:${remoteToolIds[toolIndex]}:${entry.name}`, name: entry.name, transport: entry.transport, command: entry.command, args: entry.args ?? [], url: entry.url ?? '', env: entry.env ?? {}, headers: entry.headers ?? {}, inLibrary: entry.inLibrary !== false, version: index + 1 })));
        if (request !== loadRequest.current) return;
        setDefinitions(items); setPlacements([]); setLoaded(true); setStale(false);
        return;
      }
      const [items, placed] = await Promise.all([native.listMcpDefinitions(), native.listMcpPlacements()]);
      if (request !== loadRequest.current) return;
      setDefinitions(items);
      setPlacements(placed);
      setLoaded(true);
      setStale(false);
    } catch (value) {
      if (request !== loadRequest.current) return;
      const detail = failure(value);
      setStale(true);
      setLoadError(detail);
      setError(detail);
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (!active) return;
    void reload();
    return () => { loadRequest.current++; };
  }, [active, remoteTargetId, remoteToolIds.join('|')]);

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
      if (remoteTargetId) {
        const targetToolId = remoteToolFor(item.id); const store = await native.getRemoteResourceStore(remoteTargetId, targetToolId, 'mcp') as { entries?: NativeMcpEntry[]; definitions?: McpDefinition[] };
        await native.saveRemoteResourceStore(remoteTargetId, targetToolId, 'mcp', { ...store, entries: (store.entries ?? []).filter(entry => entry.name !== item.name), definitions: (store.definitions ?? []).filter(entry => entry.name !== item.name) });
      } else await native.deleteMcpDefinition(item.id, item.version);
      setDefinitions(current => current.filter(entry => entry.id !== item.id));
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
      if (remoteTargetId) {
        const targetToolId = remoteToolFor(item.id); const store = await native.getRemoteResourceStore(remoteTargetId, targetToolId, 'mcp') as { entries?: NativeMcpEntry[]; definitions?: McpDefinition[] };
        const source = (store.entries ?? []).find(entry => entry.name === item.name);
        if (!source) throw new Error(t('library.resources.loadFailedDetail'));
        const copied = { ...source, name };
        await native.saveRemoteResourceStore(remoteTargetId, targetToolId, 'mcp', { ...store, entries: [...(store.entries ?? []), copied], definitions: [...(store.definitions ?? []), copied] });
        await reload();
      } else {
        const saved = await native.saveMcpDefinition({ ...mcpDraftOf(item), id: null, expectedVersion: null, name });
        setDefinitions(current => [...current.filter(entry => entry.id !== saved.id), saved]);
      }
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
      if (remoteTargetId) {
        const targetToolId = remoteToolFor(normalized.id); const store = await native.getRemoteResourceStore(remoteTargetId, targetToolId, 'mcp') as { entries?: NativeMcpEntry[]; definitions?: McpDefinition[] };
        const entries = (store.entries ?? []).filter(entry => entry.name !== normalized.name);
        const remoteEntry = { ...normalized, enabled: true, protectedValues: false };
        await native.saveRemoteResourceStore(remoteTargetId, targetToolId, 'mcp', { ...store, entries: [...entries, remoteEntry], definitions: [...(store.definitions ?? []).filter(entry => entry.name !== normalized.name), remoteEntry] });
        await reload();
        setDraft(null);
        setNotice(t('library.resources.saved'));
      } else if (willDistribute || alreadyPlaced) {
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
      if (remoteTargetId) {
        const targetToolId = remoteToolFor(item.id); const store = await native.getRemoteResourceStore(remoteTargetId, targetToolId, 'mcp') as { entries?: NativeMcpEntry[]; definitions?: McpDefinition[] };
        const entries = (store.entries ?? []).map(entry => entry.name === item.name ? { ...entry, enabled: !place } : entry);
        await native.saveRemoteResourceStore(remoteTargetId, targetToolId, 'mcp', { ...store, entries, definitions: store.definitions ?? [] });
        await reload();
      } else if (place) {
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
  const shown = library.filter((item) => !needle || `${item.name} ${item.command} ${item.args.join(' ')} ${item.url ?? ''}`.toLowerCase().includes(needle));

  const handledSpotlight = useRef<number | null>(null);
  useEffect(() => {
    if (!active || !spotlight || handledSpotlight.current === spotlight.token) return;
    if (search) { setSearch(''); return; }
    const item = definitions.find(entry => entry.id === spotlight.id && entry.inLibrary !== false);
    if (!item) return;
    handledSpotlight.current = spotlight.token;
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-mcp-id="' + CSS.escape(item.id) + '"]')?.scrollIntoView({ block: 'center' }));
  }, [active, spotlight?.id, spotlight?.token, definitions, search]);

  const empty = loading && !loaded
    ? <div role="status" aria-label={t('library.resources.loading')}><SkeletonRows count={3} /></div>
    : !loaded
      ? <EmptyState title={t('library.resources.loadFailedTitle')} detail={loadError || t('library.resources.loadFailedDetail')} action={<Button variant="primary" onClick={() => void reload()}>{t('library.resources.retry')}</Button>} icon="alert" />
      : needle && shown.length === 0
        ? <EmptyState title={t('library.resources.noMcpMatch', { query: search.trim() })} action={<Button onClick={() => setSearch('')}>{t('library.resources.clearSearch')}</Button>} icon="search" />
        : library.length === 0
          ? <EmptyState title={t('library.resources.emptyMcpTitle')} detail={t('library.resources.emptyMcpDetail')} action={<div className={styles.emptyActions}><Button variant="primary" icon={<Icon name="plus" size={14} />} onClick={() => editMcp()}>{t('library.resources.emptyMcpCreate')}</Button><Button icon={<Icon name="clipboard" size={14} />} onClick={() => editMcp(undefined, true)}>{t('library.resources.pasteCreate')}</Button></div>} icon="connections" />
          : undefined;

  return <>
    <section className={styles.layout} aria-label={t('library.resources.mcpWorkspaceAria')}>
      <div className={styles.toolbar}>
        <SearchField className={styles.searchBox} label={t('library.page.searchLabel')} pageSearch title={searchShortcutHint()} value={search} onChange={setSearch} placeholder={t('library.resources.searchMcpPlaceholder')} />
        <div className={styles.headActions}>
          {onOpenConnections && <Button icon={<Icon name="arrowLeft" size={14} />} onClick={onOpenConnections}>{t('tools.mcp.returnConnections')}</Button>}
          <Button disabled={loading || busy} icon={<Icon name="refresh" size={14} />} onClick={() => void reload()}>{t('library.resources.refresh')}</Button>
        </div>
      </div>
      <p className={styles.hint}>{t('library.resources.mcpDescription')}</p>
      {loading && loaded && <p className={styles.progress} role="status">{t('library.resources.refreshing')}</p>}
      {stale && loaded && <div className={styles.stale} role="status"><strong>{t('library.resources.staleTitle')}</strong><span>{t('library.resources.staleDetail')}</span><Button size="sm" disabled={loading} onClick={() => void reload()}>{t('library.resources.retry')}</Button></div>}
      {empty ?? <ul className={styles.list} aria-label={t('library.resources.mcpListAria')}>
        {shown.map((item) => {
          const places = placements.filter(entry => entry.definitionId === item.id);
          const summary = mcpSummary(item);
          return <li className={styles.row} data-mcp-id={item.id} data-placed={places.length > 0 || undefined} data-spotlight={spotlight?.id === item.id || undefined} key={item.id}>
            <span className={styles.glyph} data-transport={item.transport} aria-hidden="true"><Icon name={item.transport === 'http' ? 'globe' : 'terminal'} size={18} /></span>
            <div className={styles.main}>
              <strong>{item.name}</strong>
              <Badge className={styles.transport} tone={item.transport === 'http' ? 'info' : 'neutral'}>{item.transport === 'http' ? 'HTTP' : 'stdio'}</Badge>
            </div>
            <Badge className={styles.count} tone={places.length ? 'accent' : 'neutral'} dot={places.length > 0}>{places.length ? t('library.resources.placedCount', { count: places.length }) : t('library.resources.notPlaced')}</Badge>
            <code className={styles.command} title={summary}>{summary || t(item.transport === 'http' ? 'library.resources.noUrl' : 'library.resources.noCommand')}</code>
            <div className={styles.foot}>
              <ScopeMarks className={styles.marks} contextLabel={contextLabel} accountContexts label={t('library.page.cliMarks', { title: item.name })} tools={tools} places={places} projects={projects} busy={busy} onToggle={(toolId, scope, projectPath, contextId) => void toggleMcp(item, toolId, scope, projectPath, contextId)} mark={(place) => {
                if (!place) return { pressed: false, state: 'off', status: t('library.page.markOff') };
                if (!place.enabled) return { pressed: true, state: 'unavailable', status: t('library.resources.markDisabled') };
                return { pressed: true, state: 'current', status: t('library.page.markCurrent') };
              }} />
              <div className={styles.rowActions}>
              <Button variant="ghost" size="sm" disabled={busy} icon={<Icon name="pencil" size={14} />} onClick={() => editMcp(item)}>{t('library.resources.edit')}</Button>
              <Button variant="ghost" size="sm" disabled={busy} icon={<Icon name="copy" size={14} />} onClick={() => void duplicateMcp(item)}>{t('library.resources.duplicate')}</Button>
              <Button variant="ghost" size="sm" className={styles.danger} disabled={busy} icon={<Icon name="trash" size={14} />} onClick={() => void remove(item)}>{t('tools.agents.delete')}</Button>
              </div>
            </div>
          </li>;
        })}
      </ul>}
    </section>
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
          <Button disabled={busy} onClick={() => setWriteConflict(null)}>{t('common.conflict.keepCurrent')}</Button>
          <span className="dialog-footer-gap" />
          <Button variant="primary" disabled={busy} onClick={() => void confirmWriteConflict()}>{t('library.page.replaceAction')}</Button>
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
          <Button disabled={busy} onClick={() => setRemovalConflict(null)}>{t('common.conflict.keepCurrent')}</Button>
          <span className="dialog-footer-gap" />
          <Button variant="danger" disabled={busy} onClick={() => void confirmRemovalConflict()}>{t('library.skillDist.removeAction')}</Button>
        </div>
      </>}
    </GuideDialog>
    <GuideDialog wide open={!!draft && !batchItems} title={draft?.id ? t('tools.mcp.editTitle') : t('library.resources.newMcpTitle')} hint={t('library.resources.mcpDialogHint')} onClose={() => void closeEditor()}>
      {draft && <>
        <div className={styles.editor}>
          <div className={styles.editorForm}>
            <McpFormFields key={formKey} title={t('library.resources.connectionTitle')} draft={draft} onChange={setDraft} envRows={envRows} onEnvRowsChange={setEnvRows} headerRows={headerRows} onHeaderRowsChange={setHeaderRows} showIssues={showIssues} onImport={importJson} initialPasteOpen={pasteFirst} initialPasteText={importSource} />
          </div>
          {!remoteTargetId && <McpDistribution key={formKey} ref={distributeRef} definition={definitions.find((item) => item.id === draft.id) ?? { ...draft, id: draft.id ?? '', version: draft.expectedVersion ?? 0 }} tools={tools} projects={projects} placements={placements} formStamp={JSON.stringify([draft.name, draft.transport, draft.command, draft.args, draft.url, envRows, headerRows])} onWillDistribute={setWillDistribute} onConfirmationChange={setConfirmation} />}
        </div>
        {dialogError && <p className={styles.error} role="alert">{dialogError}</p>}
        <div className="dialog-footer">
          {draft.id && <Button variant="ghost" className={styles.danger} disabled={busy} icon={<Icon name="trash" size={14} />} onClick={() => { const found = definitions.find((item) => item.id === draft.id); if (found) void remove(found); }}>{t('tools.agents.delete')}</Button>}
          <span className="dialog-footer-gap" />
          {dirty && confirmation === 'none' && <span className={styles.dirty}>{t('library.page.dirtyState')}</span>}
          {confirmation !== 'none' && <Button disabled={busy} onClick={() => { setConfirmation('none'); distributeRef.current?.dismiss(); }}>{t(confirmation === 'conflict' ? 'common.conflict.keepCurrent' : 'library.resources.back')}</Button>}
          <Button variant="primary" data-dialog-save title={saveShortcutHint()} disabled={busy || !draft.name.trim()} onClick={() => void (confirmation !== 'none' ? confirmDistribution() : save())}>{confirmation === 'conflict' ? t('library.resources.replaceDistribute') : confirmation === 'ready' ? t('library.resources.confirmDistribute') : willDistribute ? t('library.resources.saveDistribute') : t('home.launcher.save')}</Button>
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
