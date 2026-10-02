import { removalContext, useResourceContexts, useAccountLabels } from './resourceContexts';
import { useEffect, useRef, useState } from 'react';
import { FilterSelect } from '../../components/FilterSelect';
import { ToolIcon } from '../../components/ToolIcon';
import { confirmAction } from '../../lib/confirm';
import { native } from '../../lib/native';
import { shortPath } from '../../lib/paths';
import type { Project } from '../../types/launch';
import type { AdapterDescriptor, Scope } from '../../types/native';
import type { SkillInstallation, SkillPackage, SkillTargetPreview } from '../../types/resources';
import { samePath, scopeLabel } from './CliMarks';
import styles from './LibraryPage.module.css';

function text(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : '操作失败，请重试';
}

const stateLabel: Record<SkillInstallation['state'], string> = {
  current: '已安装',
  update_available: '有更新',
  missing: '目录缺失',
  conflict: '有外部修改',
  unavailable: '暂不可用',
  disabled: '已停用',
};

export function SkillDistribution({ item, tools, projects, installations, initialTools = [], autoRun = false, onChanged }: { item: SkillPackage; tools: AdapterDescriptor[]; projects: Project[]; installations: SkillInstallation[]; initialTools?: string[]; autoRun?: boolean; onChanged: () => Promise<void> }) {
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
  const [notice, setNotice] = useState('');
  const activePath = scope === 'project' ? projectPath : null;
  const contexts = useResourceContexts(tools, mine);
  const placed = installations.filter((entry) => entry.packageId === item.id);

  useEffect(() => {
    if (contexts.ready && !initialTools.length) setSelected(mine.filter((entry) => entry.scope === scope && (scope === 'global' || samePath(entry.projectPath, activePath)) && contexts.matches(entry)).map((entry) => entry.toolId));
  }, [contexts.ready, contexts.stamp, scope, activePath]);

  async function install(allowTakeover: boolean, ids = selected) {
    if (scope === 'project' && !projectPath) { setError('请先选择项目。'); return; }
    if (!ids.length) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const conflicts: Array<SkillTargetPreview & { toolId: string }> = [];
      const notes: string[] = [];
      for (const toolId of ids) {
        const preview = allowTakeover ? pending.find((entry) => entry.toolId === toolId) ?? null : await native.previewSkillTarget(item.id, toolId, scope, activePath);
        if (!allowTakeover && preview?.status === 'conflict') { conflicts.push({ ...preview, toolId }); continue; }
        const outcome = await native.installSkill(item.id, toolId, scope, activePath, preview?.previewToken ?? null, allowTakeover && preview?.status === 'conflict');
        notes.push(`${tools.find((tool) => tool.id === toolId)?.name ?? toolId}：${outcome.status === 'failed' ? outcome.detail : '已安装'}`);
      }
      setPending(conflicts);
      if (notes.length) setNotice(notes.join('；'));
      await onChanged();
    } catch (value) { setError(text(value)); }
    finally { setBusy(false); }
  }
  const started = useRef(false);
  useEffect(() => {
    if (!autoRun || started.current || !initialTools.length) return;
    started.current = true;
    void install(false, initialTools);
  }, [autoRun, initialTools]);
  async function remove(entry: SkillInstallation) {
    if (!await confirmAction(`从${tools.find((tool) => tool.id === entry.toolId)?.name ?? entry.toolId}移除「${item.name}」？资料库里的包会保留。`, () => true, { title: '从该工具移除', confirmLabel: '移除', destructive: true })) return;
    setBusy(true); setError('');
    try {
      await native.removeSkill(item.id, entry.toolId, entry.scope, entry.projectPath, await removalContext(entry));
      await onChanged();
    } catch (value) { setError(text(value)); }
    finally { setBusy(false); }
  }

  return <div className={styles.skillAdd}>
    <section className={styles.skillSection}>
      <h3>已经装在</h3>
      {placed.length ? <ul className={styles.installed}>{placed.map((entry) => <li key={`${entry.toolId}:${entry.scope}:${entry.projectPath ?? ''}:${entry.contextId ?? 'default'}`}>
        <ToolIcon toolId={entry.toolId} size={22} />
        <span><strong>{tools.find((tool) => tool.id === entry.toolId)?.name ?? entry.toolId}</strong><small>{scopeLabel(entry.scope, entry.projectPath, projects)} · {stateLabel[entry.state]}{` · ${contextLabel(entry.contextId)}`}</small></span>
        <button type="button" disabled={busy} onClick={() => void remove(entry)}>移除</button>
      </li>)}</ul> : <p>还没有安装到任何 CLI。</p>}
    </section>
    <section className={styles.skillSection}>
      <h3>再安装到</h3>
      <p>安装使用当前生效账号。移除其它账号的安装前，请先应用该账号的配置。</p>
      <div className={styles.fields}>
        <FilterSelect className={styles.scopePick} label="分发范围" triggerDetail={false} value={scope === 'global' ? '__global__' : projectPath ?? ''} options={[
          { value: '__global__', label: '全局' },
          ...projects.map((entry) => ({ value: entry.path ?? `id:${entry.id}`, label: entry.name, detail: entry.path ? shortPath(entry.path) : undefined, note: entry.available && entry.path ? undefined : '目录失效', disabled: !entry.available || !entry.path })),
          ...(scope === 'project' && projectPath && !projects.some((entry) => samePath(entry.path, projectPath)) ? [{ value: projectPath, label: projectPath.split(/[\\/]/).filter(Boolean).at(-1) || projectPath, detail: shortPath(projectPath), note: '项目未关联' }] : []),
        ]} placeholder="选择项目…" searchLabel="搜索项目" onChange={(value) => {
          const next: Scope = value === '__global__' ? 'global' : 'project';
          const path = next === 'project' ? value : null;
          setScope(next);
          if (path) setProjectPath(path);
          setSelected(mine.filter((entry) => entry.scope === next && contexts.matches(entry) && (next === 'global' || samePath(entry.projectPath, path))).map((entry) => entry.toolId));
          setPending([]);
        }} />
      </div>
      <div className={styles.targets}>{tools.map((tool) => <label key={tool.id}><input type="checkbox" disabled={!contexts.ready} checked={selected.includes(tool.id)} onChange={(event) => { setSelected(event.target.checked ? [...selected, tool.id] : selected.filter((id) => id !== tool.id)); setPending([]); }} /><ToolIcon toolId={tool.id} size={18} />{tool.name}</label>)}</div>
      <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy || !contexts.ready || !selected.length} onClick={() => void install(false)}>{selected.some((id) => mine.some((entry) => entry.toolId === id && entry.scope === scope && contexts.matches(entry) && (scope === 'global' || samePath(entry.projectPath, activePath)) && (entry.state === 'update_available' || entry.state === 'missing'))) ? '同步到所选 CLI' : '安装到所选 CLI'}</button></div>
    </section>
    {!!pending.length && <section className={styles.skillSection}>
      <h3>这些 CLI 上已有同名内容</h3>
      <p>确认后才会替换现有文件。</p>
      {pending.map((entry) => <p key={entry.toolId}>{tools.find((tool) => tool.id === entry.toolId)?.name ?? entry.toolId} · {entry.detail}</p>)}
      <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy} onClick={() => void install(true)}>确认替换并安装</button></div>
    </section>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {contexts.error && <p role="alert">{contexts.error}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </div>;
}
