import { useEffect, useRef, useState } from 'react';
import { ToolIcon } from '../../components/ToolIcon';
import { confirmAction } from '../../lib/confirm';
import { native } from '../../lib/native';
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
  const mine = installations.filter((entry) => entry.packageId === item.id);
  const globalIds = mine.filter((entry) => entry.scope === 'global').map((entry) => entry.toolId);
  const firstProject = mine.find((entry) => entry.scope === 'project');
  const openOnProject = !initialTools.length && !globalIds.length && !!firstProject;
  const openProjectId = (openOnProject ? projects.find((entry) => samePath(entry.path, firstProject?.projectPath))?.id : undefined) ?? projects.find((entry) => entry.available)?.id ?? '';
  const [scope, setScope] = useState<Scope>(openOnProject ? 'project' : 'global');
  const [projectId, setProjectId] = useState(openProjectId);
  const [selected, setSelected] = useState<string[]>(initialTools.length ? initialTools : openOnProject ? mine.filter((entry) => entry.scope === 'project' && samePath(entry.projectPath, firstProject?.projectPath)).map((entry) => entry.toolId) : globalIds);
  const [pending, setPending] = useState<Array<SkillTargetPreview & { toolId: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const project = projects.find((entry) => entry.id === projectId);
  const projectPath = scope === 'project' ? project?.path ?? null : null;
  const placed = installations.filter((entry) => entry.packageId === item.id);

  async function install(allowTakeover: boolean, ids = selected) {
    if (scope === 'project' && !projectPath) { setError('请先选择项目。'); return; }
    if (!ids.length) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const conflicts: Array<SkillTargetPreview & { toolId: string }> = [];
      const notes: string[] = [];
      for (const toolId of ids) {
        const preview = allowTakeover ? pending.find((entry) => entry.toolId === toolId) ?? null : await native.previewSkillTarget(item.id, toolId, scope, projectPath);
        if (!allowTakeover && preview?.status === 'conflict') { conflicts.push({ ...preview, toolId }); continue; }
        const outcome = await native.installSkill(item.id, toolId, scope, projectPath, preview?.previewToken ?? null, allowTakeover && preview?.status === 'conflict');
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
      await native.removeSkill(item.id, entry.toolId, entry.scope, entry.projectPath);
      await onChanged();
    } catch (value) { setError(text(value)); }
    finally { setBusy(false); }
  }

  return <div className={styles.skillAdd}>
    <section className={styles.skillSection}>
      <h3>已经装在</h3>
      {placed.length ? <ul className={styles.installed}>{placed.map((entry) => <li key={`${entry.toolId}:${entry.scope}:${entry.projectPath ?? ''}`}>
        <ToolIcon toolId={entry.toolId} size={22} />
        <span><strong>{tools.find((tool) => tool.id === entry.toolId)?.name ?? entry.toolId}</strong><small>{scopeLabel(entry.scope, entry.projectPath, projects)} · {stateLabel[entry.state]}</small></span>
        <button type="button" disabled={busy} onClick={() => void remove(entry)}>移除</button>
      </li>)}</ul> : <p>还没有安装到任何 CLI。</p>}
    </section>
    <section className={styles.skillSection}>
      <h3>再安装到</h3>
      <div className={styles.fields}>
        <label>范围<select aria-label="分发范围" value={scope} onChange={(event) => { const next = event.target.value as Scope; const path = next === 'project' ? projects.find((entry) => entry.id === projectId)?.path ?? null : null; setScope(next); setSelected(mine.filter((entry) => entry.scope === next && (next === 'global' || samePath(entry.projectPath, path))).map((entry) => entry.toolId)); setPending([]); }}><option value="global">全局</option><option value="project">项目</option></select></label>
        {scope === 'project' && <label>项目<select aria-label="分发项目" value={projectId} onChange={(event) => { const path = projects.find((entry) => entry.id === event.target.value)?.path ?? null; setProjectId(event.target.value); setSelected(mine.filter((entry) => entry.scope === 'project' && samePath(entry.projectPath, path)).map((entry) => entry.toolId)); setPending([]); }}><option value="">选择项目</option>{projects.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{entry.available ? '' : ' · 目录失效'}</option>)}</select></label>}
      </div>
      <div className={styles.targets}>{tools.map((tool) => <label key={tool.id}><input type="checkbox" checked={selected.includes(tool.id)} onChange={(event) => { setSelected(event.target.checked ? [...selected, tool.id] : selected.filter((id) => id !== tool.id)); setPending([]); }} /><ToolIcon toolId={tool.id} size={18} />{tool.name}</label>)}</div>
      <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy || !selected.length} onClick={() => void install(false)}>安装到所选 CLI</button></div>
    </section>
    {!!pending.length && <section className={styles.skillSection}>
      <h3>这些 CLI 上已有同名内容</h3>
      <p>确认后才会替换现有文件。</p>
      {pending.map((entry) => <p key={entry.toolId}>{tools.find((tool) => tool.id === entry.toolId)?.name ?? entry.toolId} · {entry.detail}</p>)}
      <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy} onClick={() => void install(true)}>确认替换并安装</button></div>
    </section>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </div>;
}
