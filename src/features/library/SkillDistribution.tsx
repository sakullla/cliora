import { removalContext, skillWriteState, useResourceContexts, useAccountLabels, type SkillWriteState } from './resourceContexts';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FilterSelect } from '../../components/FilterSelect';
import { ToolIcon } from '../../components/ToolIcon';
import { confirmAction } from '../../lib/confirm';
import { native } from '../../lib/native';
import { shortPath } from '../../lib/paths';
import type { Project } from '../../types/launch';
import type { AdapterDescriptor, Scope } from '../../types/native';
import type { SkillInstallation, SkillPackage, SkillTargetPreview } from '../../types/resources';
import { samePath, scopeLabel } from './CliMarks';
import { CliTargetGrid } from './CliTargetGrid';
import { Button } from '../../components/ui';
import { Icon } from '../../components/Icon';
import i18n from '../../i18n';
import styles from './LibraryPage.module.css';

function text(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : i18n.t('common.operationFailed');
}

function stateLabel(state: SkillInstallation['state']): string {
  return i18n.t(`library.resources.installState.${state}`);
}

/** One target of the last write in this dialog. `detail` is the native message
 * (or the reason nothing changed), never an inferred success. */
type TargetRow = { toolId: string; state: SkillWriteState | 'conflict'; detail: string; op: 'install' | 'remove' };

export function SkillDistribution({ item, tools, projects, installations, initialTools = [], autoRun = false, onChanged }: { item: SkillPackage; tools: AdapterDescriptor[]; projects: Project[]; installations: SkillInstallation[]; initialTools?: string[]; autoRun?: boolean;   onChanged: () => Promise<void> }) {
  const { t } = useTranslation();
  const contextLabel = useAccountLabels();
  const mine = installations.filter((entry) => entry.packageId === item.id);
  const globalIds = mine.filter((entry) => entry.scope === 'global').map((entry) => entry.toolId);
  const firstProject = mine.find((entry) => entry.scope === 'project');
  const openOnProject = !initialTools.length && !globalIds.length && !!firstProject;
  const [scope, setScope] = useState<Scope>(openOnProject ? 'project' : 'global');
  const [projectPath, setProjectPath] = useState<string | null>((openOnProject ? firstProject?.projectPath ?? null : null) ?? projects.find((item) => item.available && item.path)?.path ?? null);
  const [selected, setSelected] = useState<string[]>(initialTools.length ? initialTools : openOnProject ? mine.filter((entry) => entry.scope === 'project' && samePath(entry.projectPath, firstProject?.projectPath)).map((entry) => entry.toolId) : globalIds);
  const [pending, setPending] = useState<Array<SkillTargetPreview & { toolId: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rows, setRows] = useState<TargetRow[]>([]);
  const activePath = scope === 'project' ? projectPath : null;
  const contexts = useResourceContexts(tools, mine, { scope, projectPath: activePath });
  const placed = installations.filter((entry) => entry.packageId === item.id);

  const targetFor = (toolId: string) => ({ toolId, scope, projectPath: activePath });
  const initialized = useRef(new Set<string>());
  useEffect(() => {
    const newlyReady = tools.filter((tool) => contexts.ready(targetFor(tool.id)) && !initialized.current.has(JSON.stringify(targetFor(tool.id))));
    for (const tool of newlyReady) initialized.current.add(JSON.stringify(targetFor(tool.id)));
    setSelected((previous) => [...new Set([...previous.filter((id) => contexts.ready(targetFor(id))), ...newlyReady.filter((tool) => initialTools.includes(tool.id) || mine.some((entry) => entry.toolId === tool.id && entry.scope === scope && (scope === 'global' || samePath(entry.projectPath, activePath)) && contexts.matches(entry))).map((tool) => tool.id)])]);
  }, [contexts.stamp, scope, activePath]);

  async function install(allowTakeover: boolean, ids = selected) {
    if (scope === 'project' && !projectPath) { setError(t('tools.mcp.pickProject')); return; }
    ids = ids.filter((id) => contexts.ready(targetFor(id)));
    if (!ids.length) return;
    setBusy(true); setError(''); setRows([]);
    try {
      const conflicts: Array<SkillTargetPreview & { toolId: string }> = [];
      const written: TargetRow[] = [];
      for (const toolId of ids) {
        const preview = allowTakeover ? pending.find((entry) => entry.toolId === toolId) ?? null : await native.previewSkillTarget(item.id, toolId, scope, activePath);
        if (!allowTakeover && preview?.status === 'conflict') { conflicts.push({ ...preview, toolId }); continue; }
        const outcome = await native.installSkill(item.id, toolId, scope, activePath, preview?.previewToken ?? null, allowTakeover && preview?.status === 'conflict');
        const state = skillWriteState(outcome);
        written.push({ toolId, state, op: 'install', detail: state === 'ok' ? t('tools.skills.stateInstalled') : state === 'unchanged' ? t('library.skillDist.unchanged') : outcome.detail || t('library.distribute.noWrite') });
      }
      setPending(conflicts);
      setRows([...written, ...conflicts.map((entry): TargetRow => ({ toolId: entry.toolId, state: 'conflict', op: 'install', detail: entry.detail || t('library.resources.resultConflictDetail') }))]);
      await onChanged();
    } catch (value) { setError(text(value)); }
    finally { setBusy(false); }
  }
  const started = useRef(new Set<string>());
  useEffect(() => {
    if (!autoRun) return;
    const ids = initialTools.filter((id) => contexts.ready(targetFor(id)) && !started.current.has(id));
    for (const id of ids) started.current.add(id);
    if (ids.length) void install(false, ids);
  }, [autoRun, initialTools, contexts.stamp]);
  async function remove(entry: SkillInstallation) {
    if (!contexts.ready(entry)) return;
    if (!await confirmAction(t('library.skillDist.confirmRemove', { tool: tools.find((tool) => tool.id === entry.toolId)?.name ?? entry.toolId, name: item.name }), () => true, { title: t('library.skillDist.removeTitle'), confirmLabel: t('library.skillDist.removeAction'), destructive: true })) return;
    setBusy(true); setError(''); setRows([]);
    try {
      const outcome = await native.removeSkill(item.id, entry.toolId, entry.scope, entry.projectPath, await removalContext(entry));
      // A returned result is the only evidence of removal; anything but `removed`
      // keeps the installation and says why instead of announcing a removal that did not happen.
      if (outcome && outcome.status !== 'removed') {
        setRows([{ toolId: entry.toolId, state: 'failed', op: 'remove', detail: outcome.detail || t('library.distribute.noWrite') }]);
        setError(outcome.detail || t('library.resources.cannotWrite', { tool: toolName(entry.toolId) }));
        await onChanged();
        return;
      }
      if (outcome) setRows([{ toolId: entry.toolId, state: 'removed', op: 'remove', detail: t('library.distribute.resultRemoved') }]);
      await onChanged();
    } catch (value) { setError(text(value)); }
    finally { setBusy(false); }
  }

  const installFailedIds = rows.filter((row) => row.state === 'failed' && row.op === 'install').map((row) => row.toolId);
  // A failed removal is retried from its own 移除 button, which keeps the confirmation.
  const incomplete = rows.some((row) => row.state === 'failed' || row.state === 'conflict');
  const countOf = (states: Array<TargetRow['state']>) => rows.filter((row) => states.includes(row.state)).length;
  const toolName = (toolId: string) => tools.find((tool) => tool.id === toolId)?.name ?? toolId;
  // Pre-submit summary: the checked targets and what each one will change.
  const readySelected = selected.filter((id) => contexts.ready(targetFor(id)));
  const changeOf = (toolId: string) => {
    const place = placed.find((entry) => entry.toolId === toolId && entry.scope === scope && contexts.matches(entry) && (scope === 'global' || samePath(entry.projectPath, activePath)));
    if (!place) return 'add' as const;
    if (place.state === 'conflict') return 'conflict' as const;
    if (place.state === 'update_available' || place.state === 'missing') return 'update' as const;
    return 'current' as const;
  };
  const namesOf = (change: 'add' | 'update' | 'current' | 'conflict') => readySelected.filter((id) => changeOf(id) === change).map(toolName);
  const summary = [
    namesOf('add').length ? t('library.skillDist.summaryAdd', { names: namesOf('add').join('、') }) : '',
    namesOf('update').length ? t('library.skillDist.summaryUpdate', { names: namesOf('update').join('、') }) : '',
    namesOf('conflict').length ? t('library.skillDist.summaryConflict', { names: namesOf('conflict').join('、') }) : '',
    namesOf('current').length ? t('library.skillDist.summaryCurrent', { names: namesOf('current').join('、') }) : '',
  ].filter(Boolean);

  return <div className={styles.skillAdd}>
    <section className={styles.skillSection}>
      <h3>{t('library.skillDist.installedTitle')}</h3>
      {placed.length ? <ul className={styles.installed}>{placed.map((entry) => <li key={`${entry.toolId}:${entry.scope}:${entry.projectPath ?? ''}:${entry.contextId ?? 'default'}`}>
        <ToolIcon toolId={entry.toolId} size={22} />
        <span><strong>{tools.find((tool) => tool.id === entry.toolId)?.name ?? entry.toolId}</strong><small>{scopeLabel(entry.scope, entry.projectPath, projects)} · {stateLabel(entry.state)}{` · ${contextLabel(entry.contextId)}`}</small></span>
        <Button size="sm" disabled={busy || !contexts.ready(entry)} onClick={() => void remove(entry)}>{t('library.skillDist.removeAction')}</Button>
      </li>)}</ul> : <p>{t('library.skillDist.notInstalled')}</p>}
    </section>
    <section className={styles.skillSection}>
      <h3>{t('library.skillDist.installTitle')}</h3>
      <p>{t('library.skillDist.installHint')}</p>
      <div className={styles.fields}>
        <FilterSelect className={styles.scopePick} label={t('library.distribute.scopeLabel')} triggerDetail={false} value={scope === 'global' ? '__global__' : projectPath ?? ''} options={[
          { value: '__global__', label: t('tools.apply.global') },
          ...projects.map((entry) => ({ value: entry.path ?? `id:${entry.id}`, label: entry.name, detail: entry.path ? shortPath(entry.path) : undefined, note: entry.available && entry.path ? undefined : t('library.page.staleDir'), disabled: !entry.available || !entry.path })),
          ...(scope === 'project' && projectPath && !projects.some((entry) => samePath(entry.path, projectPath)) ? [{ value: projectPath, label: projectPath.split(/[\\/]/).filter(Boolean).at(-1) || projectPath, detail: shortPath(projectPath), note: t('library.distribute.projectUnlinked') }] : []),
        ]} placeholder={t('library.distribute.projectPlaceholder')} searchLabel={t('home.launcher.searchLabel')} onChange={(value) => {
          const next: Scope = value === '__global__' ? 'global' : 'project';
          const path = next === 'project' ? value : null;
          initialized.current.clear();
          setScope(next);
          if (path) setProjectPath(path);
          setSelected(mine.filter((entry) => entry.scope === next && contexts.matches(entry) && (next === 'global' || samePath(entry.projectPath, path))).map((entry) => entry.toolId));
          setPending([]);
        }} />
      </div>
      <CliTargetGrid tools={tools} selected={selected} disabled={(id) => !contexts.ready(targetFor(id))} onToggle={(id, checked) => { setSelected(checked ? [...selected, id] : selected.filter((item) => item !== id)); setPending([]); }} />
      <p data-skill-summary>{summary.length ? summary.join(t('library.skillDist.summaryJoin')) : t('library.skillDist.summaryNone')}</p>
      <div className={styles.actions}><Button variant={pending.length ? 'secondary' : 'primary'} disabled={busy || !selected.some((id) => contexts.ready(targetFor(id)))} onClick={() => void install(false)}>{selected.some((id) => mine.some((entry) => entry.toolId === id && entry.scope === scope && contexts.matches(entry) && (scope === 'global' || samePath(entry.projectPath, activePath)) && (entry.state === 'update_available' || entry.state === 'missing'))) ? t('library.skillDist.syncSelected') : t('library.skillDist.installSelected')}</Button></div>
    </section>
    {!!pending.length && <section className={styles.skillSection}>
      <h3>{t('library.skillDist.conflictTitle')}</h3>
      <p>{t('library.skillDist.conflictHint')}</p>
      {pending.map((entry) => <p key={entry.toolId}>{tools.find((tool) => tool.id === entry.toolId)?.name ?? entry.toolId} · {entry.detail}</p>)}
      <div className={styles.actions}><Button variant="primary" disabled={busy} onClick={() => void install(true)}>{t('library.skillDist.confirmReplace')}</Button></div>
    </section>}
    {!!rows.length && <section className={styles.result} data-tone={incomplete ? 'warning' : undefined} role="status" aria-label={t('library.skillDist.resultAria')}>
      <div className={styles.resultHead}><Icon name={incomplete ? 'alert' : 'check'} size={16} /><span>{t(incomplete ? 'library.skillDist.resultIncomplete' : 'library.skillDist.resultDone', { total: rows.length, ok: countOf(['ok', 'removed']), unchanged: countOf(['unchanged']), failed: countOf(['failed']), conflict: countOf(['conflict']) })}</span></div>
      <ul className={styles.resultList}>{rows.map((row) => <li key={row.toolId} data-state={row.state}><Icon name={row.state === 'failed' || row.state === 'conflict' ? 'alert' : 'check'} size={14} /><span className={styles.resultState}>{t('library.distribute.writeEntry', { target: toolName(row.toolId), detail: row.detail })}</span></li>)}</ul>
      {!!installFailedIds.length && <div className={styles.actions}><Button size="sm" disabled={busy} onClick={() => void install(false, installFailedIds)}>{t('library.skillDist.resultRetry')}</Button></div>}
    </section>}
    {contexts.issues.map((issue) => <p key={issue.key} role="status">{t('library.distribute.issue', { tool: tools.find((tool) => tool.id === issue.toolId)?.name ?? issue.toolId, scope: scopeLabel(issue.scope, issue.projectPath, projects), detail: issue.detail })}</p>)}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </div>;
}
