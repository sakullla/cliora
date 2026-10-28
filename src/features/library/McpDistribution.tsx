import { useResourceContexts, useAccountLabels } from './resourceContexts';
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CodeEditor } from '../../components/CodeEditor';
import { FilterSelect } from '../../components/FilterSelect';
import { native } from '../../lib/native';
import { shortPath } from '../../lib/paths';
import type { Project } from '../../types/launch';
import type { AdapterDescriptor, Scope } from '../../types/native';
import type { McpDefinition, McpDraft, McpDraftTargetRequest, McpPlacement, McpTargetRequest, McpTargetResult } from '../../types/resources';
import { samePath, scopeLabel } from './CliMarks';
import { ToolIcon } from '../../components/ToolIcon';
import { Icon } from '../../components/Icon';
import { Badge, Button, Switch } from '../../components/ui';
import type { Tone } from '../../lib/statusTone';
import i18n from '../../i18n';
import styles from './LibraryMcp.module.css';

type TargetState = 'loading' | 'blocked' | 'placed' | 'removing' | 'adding' | 'idle';
const targetTone: Record<TargetState, Tone> = { loading: 'neutral', blocked: 'danger', placed: 'accent', removing: 'warning', adding: 'success', idle: 'neutral' };

function text(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : i18n.t('common.operationFailed');
}

export type McpConfirmation = 'none' | 'ready' | 'conflict';
export type McpDistributeOutcome = { status: 'written'; notice: string; definition: McpDefinition } | { status: 'pending'; conflict: boolean } | { status: 'failed'; message: string; definition?: McpDefinition } | { status: 'stale' };
export type McpDistributeHandle = {
  run: (draft: McpDraft) => Promise<McpDistributeOutcome>;
  commit: () => Promise<McpDistributeOutcome>;
  dismiss: () => void;
};

export const McpDistribution = forwardRef<McpDistributeHandle, {
  definition: McpDefinition;
  tools: AdapterDescriptor[];
  projects: Project[];
  placements: McpPlacement[];
  formStamp: string;
  onWillDistribute: (active: boolean) => void;
  onConfirmationChange: (state: McpConfirmation) => void;
}>(function McpDistribution({ definition, tools, projects, placements, formStamp, onWillDistribute, onConfirmationChange }, ref) {
  const { t } = useTranslation();
  const panelId = useId();
  const placedFor = (nextScope: Scope, nextPath: string | null) => placements.filter((item) => item.definitionId === definition.id && contexts.matches(item) && item.scope === nextScope && (nextScope === 'global' || samePath(item.projectPath, nextPath)));
  const idsFor = (nextScope: Scope, nextPath: string | null) => placedFor(nextScope, nextPath).map((item) => item.toolId);
  const contextLabel = useAccountLabels();
  const mine = placements.filter((item) => item.definitionId === definition.id);
  const globalPlaced = mine.filter((item) => item.scope === 'global');
  const firstProject = mine.find((item) => item.scope === 'project');
  const openOnProject = !globalPlaced.length && !!firstProject;
  const openScope: Scope = openOnProject ? 'project' : 'global';
  const openPath = openOnProject ? firstProject?.projectPath ?? null : null;
  const initialPlaced = mine.filter((item) => item.scope === openScope && (openScope === 'global' || samePath(item.projectPath, openPath)));
  const [scope, setScope] = useState<Scope>(openScope);
  const [projectPath, setProjectPath] = useState<string | null>(openPath ?? projects.find((item) => item.available && item.path)?.path ?? null);
  const [selected, setSelected] = useState<string[]>(() => initialPlaced.map((item) => item.toolId));
  const [enabled, setEnabled] = useState(() => initialPlaced.length === 0 || initialPlaced.some((item) => item.enabled));
  const [previewState, setPreview] = useState<{ epoch: number; draft: McpDraft; items: McpTargetResult[] } | null>(null);
  const [results, setResults] = useState<McpTargetResult[] | null>(null);
  const [error, setError] = useState('');
  const activePath = scope === 'project' ? projectPath : null;
  const contexts = useResourceContexts(tools, mine, { scope, projectPath: activePath });
  const targetFor = (toolId: string) => ({ toolId, scope, projectPath: activePath });
  const context = JSON.stringify([scope, activePath, selected, enabled]);
  const epochRef = useRef({ context, epoch: 0 });
  if (epochRef.current.context !== context) epochRef.current = { context, epoch: epochRef.current.epoch + 1 };
  const requestRef = useRef(0);
  const preview = previewState?.epoch === epochRef.current.epoch ? previewState.items : null;
  const stampRef = useRef(formStamp);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onWillDistribute(willDistribute(selected, scope, activePath)); }, [selected, scope, activePath, placements, definition.id]);
  useEffect(() => {
    if (stampRef.current === formStamp) return;
    stampRef.current = formStamp;
    if (!previewState) return;
    setPreview(null);
    setResults(null);
    onConfirmationChange('none');
  }, [formStamp, previewState, onConfirmationChange]);

  const initialized = useRef(new Set<string>());
  useEffect(() => {
    const newlyReady = tools.filter((tool) => contexts.ready(targetFor(tool.id)) && !initialized.current.has(JSON.stringify(targetFor(tool.id))));
    for (const tool of newlyReady) initialized.current.add(JSON.stringify(targetFor(tool.id)));
    setSelected((previous) => [...new Set([...previous.filter((id) => contexts.ready(targetFor(id))), ...newlyReady.filter((tool) => placedFor(scope, activePath).some((place) => place.toolId === tool.id)).map((tool) => tool.id)])]);
    if (newlyReady.length) {
      const placed = placedFor(scope, activePath);
      setEnabled(placed.length === 0 || placed.some((item) => item.enabled));
    }
  }, [contexts.stamp, scope, activePath]);

  function toolName(id: string) {
    return tools.find((item) => item.id === id)?.name ?? id;
  }
  function outsidePlacements(nextScope = scope, nextPath = activePath) {
    return placements.filter((item) => item.definitionId === definition.id && contexts.matches(item) && (item.scope !== nextScope || (nextScope === 'project' && !samePath(item.projectPath, nextPath))));
  }
  function willDistribute(ids: string[], nextScope: Scope, nextPath: string | null) {
    const placed = idsFor(nextScope, nextPath);
    return ids.length > 0 || placed.some((id) => !ids.includes(id)) || outsidePlacements(nextScope, nextPath).length > 0;
  }
  function droppedIds(ids = selected) {
    return idsFor(scope, activePath).filter((id) => !ids.includes(id));
  }
  function placeLabel(toolId: string, nextScope: Scope, nextPath: string | null) {
    const where = nextScope === 'project' ? t('library.page.whereScope', { scope: scopeLabel(nextScope, nextPath, projects) }) : '';
    return `${where}${toolName(toolId)}`;
  }
  function noticeFor(written: McpTargetResult[], removed: McpTargetResult[]) {
    const parts: string[] = [];
    if (written.length) parts.push(t('library.distribute.written', { targets: written.map((item) => placeLabel(item.toolId, item.scope, item.projectPath)).join('、') }));
    if (removed.length) parts.push(t('library.distribute.removed', { where: scope === 'project' ? t('library.page.whereScope', { scope: scopeLabel(scope, activePath, projects) }) : '', names: removed.map((item) => toolName(item.toolId)).join('、') }));
    return parts.join('');
  }
  function targets(ids = selected): McpTargetRequest[] {
    const current = ids.filter((id) => contexts.ready(targetFor(id))).map((toolId) => ({ toolId, scope, projectPath: activePath, contextId: contexts.context({ toolId, scope, projectPath: activePath }), enabled }));
    const outside = outsidePlacements().map((item): McpTargetRequest => ({ toolId: item.toolId, scope: item.scope, projectPath: item.projectPath, contextId: contexts.context(item), enabled: item.enabled }));
    return [...current, ...outside];
  }
  function removalTargets(ids: string[]): McpDraftTargetRequest[] {
    return ids.map((toolId) => {
      const place = placedFor(scope, activePath).find((entry) => entry.toolId === toolId);
      if (!place) throw new Error(t('library.distribute.changedError'));
      return { toolId, scope, projectPath: activePath, contextId: contexts.context(place), enabled: place.enabled, operation: 'remove' };
    });
  }
  function choose(ids: string[], nextScope = scope, nextPath = activePath) {
    setSelected(ids);
    onWillDistribute(willDistribute(ids, nextScope, nextPath));
    setPreview(null);
    setResults(null);
    onConfirmationChange('none');
  }
  function applyScope(nextScope: Scope, nextPath = projectPath) {
    const placed = placedFor(nextScope, nextScope === 'project' ? nextPath : null);
    const ids = placed.map((item) => item.toolId);
    initialized.current.clear();
    setScope(nextScope);
    if (nextScope === 'project') setProjectPath(nextPath);
    setEnabled(placed.length === 0 || placed.some((item) => item.enabled));
    choose(ids, nextScope, nextScope === 'project' ? nextPath : null);
  }
  async function finish(saved: McpDefinition, committed: McpTargetResult[]): Promise<McpDistributeOutcome> {
    setResults(committed);
    const failed = committed.filter((item) => item.status !== 'written' && item.status !== 'removed');
    if (failed.length) {
      const message = failed.map((item) => t('library.distribute.writeEntry', { target: placeLabel(item.toolId, item.scope, item.projectPath), detail: item.detail || t('library.distribute.noWrite') })).join(t('tools.quota.errorSeparator'));
      setError(message);
      return { status: 'failed', message, definition: saved };
    }
    onConfirmationChange('none');
    return { status: 'written', notice: noticeFor(committed.filter((item) => item.status === 'written'), committed.filter((item) => item.status === 'removed')), definition: saved };
  }
  async function inspect(draft: McpDraft): Promise<McpDistributeOutcome> {
    const ids = selected.filter((id) => contexts.ready(targetFor(id)));
    const removed = droppedIds(ids);
    const requested: McpDraftTargetRequest[] = [...targets(ids), ...removalTargets(removed)];
    if (!requested.length && !removed.length) return { status: 'failed', message: t('library.distribute.noneSelected') };
    if (scope === 'project' && !projectPath && ids.length) { const message = t('tools.mcp.pickProject'); setError(message); return { status: 'failed', message }; }
    const epoch = epochRef.current.epoch;
    const request = ++requestRef.current;
    setPreview(null); setResults(null); setError('');
    onConfirmationChange('none');
    try {
      const candidate = await native.previewMcpDraft(draft, requested);
      if (!mounted.current || request !== requestRef.current || epoch !== epochRef.current.epoch) return { status: 'stale' };
      const items = candidate.targets;
      const writable = items.filter((item) => item.status === 'ready' || item.status === 'conflict');
      if (!writable.length) {
        const message = items.map((item) => item.detail).filter(Boolean).join(t('tools.quota.errorSeparator')) || t('library.distribute.noWritable');
        setError(message);
        return { status: 'failed', message };
      }
      stampRef.current = formStamp;
      setPreview({ epoch, draft: candidate.draft, items });
      const hasConflict = items.some((item) => item.status === 'conflict');
      onConfirmationChange(hasConflict ? 'conflict' : 'ready');
      return { status: 'pending', conflict: hasConflict };
    } catch (value) {
      const message = text(value);
      if (request === requestRef.current && epoch === epochRef.current.epoch) setError(message);
      return { status: 'failed', message };
    }
  }
  async function commit(): Promise<McpDistributeOutcome> {
    const current = preview;
    const candidate = previewState;
    if (!current || !candidate) return { status: 'failed', message: t('library.distribute.noPreview') };
    const epoch = epochRef.current.epoch;
    const request = ++requestRef.current;
    const blocked = current.filter((item) => item.status === 'failed' || item.status === 'unsupported');
    if (blocked.length) {
      const message = blocked.map((item) => t('library.distribute.writeEntry', { target: placeLabel(item.toolId, item.scope, item.projectPath), detail: item.detail || t('library.distribute.noWrite') })).join(t('tools.quota.errorSeparator'));
      setError(message);
      return { status: 'failed', message };
    }
    const active = current.filter((item) => item.status === 'ready' || item.status === 'conflict');
    setError('');
    try {
      const committed = await native.commitMcpDraft(candidate.draft, active.map((item): McpDraftTargetRequest => {
        const inView = item.scope === scope && (scope === 'global' || samePath(item.projectPath, activePath));
        const placed = placements.find((entry) => entry.definitionId === definition.id && entry.toolId === item.toolId && entry.scope === item.scope && (item.scope === 'project' || (entry.contextId ?? null) === (item.contextId ?? null)) && samePath(entry.projectPath, item.projectPath));
        return { toolId: item.toolId, scope: item.scope, projectPath: item.projectPath, contextId: item.contextId, enabled: item.operation === 'remove' ? placed?.enabled ?? false : inView ? enabled : placed?.enabled ?? enabled, operation: item.operation, baselineHash: item.baselineHash, previewToken: item.previewToken, allowReplace: item.status === 'conflict' };
      }));
      if (!mounted.current || request !== requestRef.current || epoch !== epochRef.current.epoch) return { status: 'stale' };
      setPreview(null);
      onConfirmationChange('none');
      return finish(committed.definition, committed.targets);
    } catch (value) {
      const message = text(value);
      if (request === requestRef.current && epoch === epochRef.current.epoch) {
        setPreview(null);
        onConfirmationChange('none');
        setError(message);
      }
      return { status: 'failed', message };
    }
  }

  useImperativeHandle(ref, () => ({
    run: inspect,
    commit,
    dismiss: () => { setPreview(null); setResults(null); onConfirmationChange('none'); },
  }), [selected, scope, activePath, enabled, definition, placements, formStamp, preview, contexts.stamp]);

  const placedHere = placedFor(scope, activePath);
  const scopeName = scopeLabel(scope, activePath, projects);
  const rows = tools.map((tool) => {
    const target = targetFor(tool.id);
    const result = contexts.result(target);
    const place = placedHere.find((item) => item.toolId === tool.id);
    const checked = selected.includes(tool.id);
    const state: TargetState = result.status === 'pending' ? 'loading' : result.status === 'failed' ? 'blocked' : place && checked ? 'placed' : place ? 'removing' : checked ? 'adding' : 'idle';
    const status = state === 'loading' ? t('library.distribute.stateLoading')
      : result.status === 'failed' ? result.error
      : state === 'placed' ? (place?.enabled === false ? t('library.distribute.statePlacedDisabled') : t('library.distribute.statePlaced'))
      : state === 'removing' ? t('library.distribute.stateRemoving')
      : state === 'adding' ? t('library.distribute.stateAdding')
      : t('library.distribute.stateIdle');
    return { tool, state, status, checked };
  });
  const inView = (issue: { toolId: string; scope: Scope; projectPath: string | null }) => issue.scope === scope && samePath(issue.projectPath, activePath) && tools.some((tool) => tool.id === issue.toolId);
  const otherAccounts = mine.filter((item) => contexts.ready(item) && !contexts.matches(item));
  const adding = rows.filter((row) => row.state === 'adding').map((row) => row.tool.name);
  const removing = rows.filter((row) => row.state === 'removing').map((row) => row.tool.name);
  const outside = outsidePlacements().length;
  const readyToolIds = rows.filter((row) => row.state !== 'loading' && row.state !== 'blocked').map((row) => row.tool.id);
  const allReadySelected = readyToolIds.length > 0 && readyToolIds.every((id) => selected.includes(id));
  const summary = [
    adding.length ? t('library.distribute.summaryAdd', { names: adding.join('、') }) : '',
    removing.length ? t('library.distribute.summaryRemove', { names: removing.join('、') }) : '',
    outside ? t('library.distribute.summaryOutside', { count: outside }) : '',
  ].filter(Boolean);

  return <div className={styles.distributeContents}>
    <section className={styles.targetPanel} aria-labelledby={`${panelId}-title`} data-mcp-targets>
      <div className={styles.panelHead}>
        <div className={styles.panelTitleRow}>
          <h3 id={`${panelId}-title`}><Icon name="connections" size={16} />{t('library.distribute.title')}<Badge tone="accent" aria-hidden="true">{selected.length}/{tools.length}</Badge></h3>
          {readyToolIds.length > 1 && <Button variant="ghost" size="sm" onClick={() => choose(allReadySelected ? [] : readyToolIds)}>{t(allReadySelected ? 'settings.migration.deselectAll' : 'settings.migration.selectAll')}</Button>}
        </div>
        <p>{t('library.distribute.description')}</p>
      </div>
      <FilterSelect className={styles.scopePick} label={t('library.distribute.scopeLabel')} triggerDetail={false} value={scope === 'global' ? '__global__' : projectPath ?? ''} options={[
        { value: '__global__', label: t('tools.apply.global') },
        ...projects.map((item) => ({ value: item.path ?? `id:${item.id}`, label: item.name, detail: item.path ? shortPath(item.path) : undefined, note: item.available && item.path ? undefined : t('library.page.staleDir'), disabled: !item.available || !item.path })),
        ...(scope === 'project' && projectPath && !projects.some((item) => samePath(item.path, projectPath)) ? [{ value: projectPath, label: projectPath.split(/[\\/]/).filter(Boolean).at(-1) || projectPath, detail: shortPath(projectPath), note: t('library.distribute.projectUnlinked') }] : []),
      ]} placeholder={t('library.distribute.projectPlaceholder')} searchLabel={t('home.launcher.searchLabel')} onChange={(value) => { if (value === '__global__') applyScope('global'); else applyScope('project', value); }} />
      <ul className={styles.targetList} aria-label={t('library.distribute.targetsAria', { scope: scopeName })}>{rows.map((row) => <li key={row.tool.id} data-state={row.state}>
        <label title={row.state === 'placed' ? t('library.distribute.placedTitle') : row.state === 'idle' ? t('library.distribute.unplacedTitle') : undefined}>
          <ToolIcon toolId={row.tool.id} size={22} />
          <span className={styles.targetName}>{row.tool.name}</span>
          <Badge className={styles.targetState} tone={targetTone[row.state]} id={`${panelId}-${row.tool.id}`} title={row.status}>{row.status}</Badge>
          <input type="checkbox" aria-label={row.tool.name} aria-describedby={`${panelId}-${row.tool.id}`} disabled={row.state === 'loading' || row.state === 'blocked'} checked={row.checked} onChange={(event) => choose(event.target.checked ? [...selected, row.tool.id] : selected.filter((item) => item !== row.tool.id))} />
        </label>
      </li>)}</ul>
      <div className={styles.panelFoot}>
        <Switch className={styles.choice} checked={enabled} onChange={(checked) => { setEnabled(checked); setPreview(null); setResults(null); onConfirmationChange('none'); }} label={<span className={styles.choiceText}><strong>{t('library.distribute.enableAfterWrite')}</strong><small>{t('library.distribute.enableAfterWriteHint')}</small></span>} />
        {summary.length === 0 && !selected.length && !mine.length && <p className={styles.summary} data-quiet>{t('library.distribute.summaryNone')}</p>}
        {summary.length > 0 && <p className={styles.summary}>{summary.join('；')}</p>}
      </div>
      {otherAccounts.length > 0 && <div className={styles.notes}>
        <p>{t('library.distribute.otherAccountHint')}</p>
        {otherAccounts.map((item) => <p key={JSON.stringify([item.toolId, item.scope, item.projectPath, item.contextId])}>{toolName(item.toolId)} · {scopeLabel(item.scope, item.projectPath, projects)} · {contextLabel(item.contextId)}{t('library.distribute.otherAccountSuffix')}</p>)}
      </div>}
      {contexts.issues.some((issue) => !inView(issue)) && <div className={styles.notes} data-tone="warning">
        {contexts.issues.filter((issue) => !inView(issue)).map((issue) => <p key={issue.key} role="status">{t('library.distribute.issue', { tool: toolName(issue.toolId), scope: scopeLabel(issue.scope, issue.projectPath, projects), detail: issue.detail })}</p>)}
      </div>}
      {results && <div className={styles.notes} role="status">{results.map((item) => <p key={JSON.stringify([item.toolId, item.scope, item.projectPath, item.contextId])}>{t('library.distribute.resultEntry', { tool: toolName(item.toolId), result: item.status === 'written' ? t('library.distribute.resultWritten') : item.status === 'removed' ? t('library.distribute.resultRemoved') : item.detail })}</p>)}</div>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </section>
    {preview && <div className={styles.conflict} data-conflict={preview.some(item => item.status === 'conflict') || undefined} role="group" aria-label={t('tools.mcp.previewLabel')}>
      <div className={styles.conflictHead}><Icon name={preview.some(item => item.status === 'conflict') ? 'alert' : 'eye'} size={16} /><p><strong>{t(preview.some(item => item.status === 'conflict') ? 'library.distribute.conflictTitle' : 'library.distribute.previewTitle')}</strong>{t(preview.some(item => item.status === 'conflict') ? 'library.distribute.conflictHint' : 'library.distribute.previewHint')}</p></div>
      {preview.map((item) => <div className={styles.conflictItem} key={JSON.stringify([item.toolId, item.scope, item.projectPath, item.contextId])}>
        <div className={styles.conflictTarget}>
          <ToolIcon toolId={item.toolId} size={18} />
          <strong>{toolName(item.toolId)}</strong>
          <Badge tone={item.status === 'conflict' ? 'warning' : item.status === 'ready' ? 'neutral' : 'danger'}>{item.status === 'conflict' ? t('library.distribute.statusConflict') : item.status === 'ready' ? t(item.operation === 'remove' ? 'library.distribute.statusReadyRemove' : 'library.distribute.statusReady') : t('library.distribute.statusBlocked')}</Badge>
          {item.path && <code title={item.path}>{item.path}</code>}
        </div>
        {item.detail && <p>{item.detail}</p>}
        {(item.existing !== null || item.proposed !== null) && <div className={styles.diff}><CodeEditor compact label={t('tools.mcp.conflictCurrent')} format="json" readOnly value={item.existing === null ? 'null' : JSON.stringify(item.existing, null, 2)} /><CodeEditor compact label={t('library.distribute.writtenMcp')} format="json" readOnly value={item.proposed === null ? 'null' : JSON.stringify(item.proposed, null, 2)} /></div>}
      </div>)}
    </div>}
  </div>;
});
