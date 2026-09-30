import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import type { Project, TrayRepairTarget } from '../../types/launch';
import type { AdapterDescriptor } from '../../types/native';
import { displayPath, shortPath } from '../../lib/paths';
import { ToolIcon } from '../../components/ToolIcon';
import styles from './ProjectLauncher.module.css';

function errorText(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : '操作失败，请重试';
}

export function ProjectLauncher({ tools, repair }: { tools: AdapterDescriptor[]; repair?: TrayRepairTarget | null }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [globalTool, setGlobalTool] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [launchDirectory, setLaunchDirectory] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [relink, setRelink] = useState<Record<string, string>>({});
  const [modelEdits, setModelEdits] = useState<Record<string, string>>({});
  const repairDirectoryInput = useRef<HTMLInputElement>(null);
  const repairToolSelect = useRef<HTMLSelectElement>(null);
  const repairCard = useRef<HTMLDivElement>(null);
  const focusedRepair = useRef(0);
  const latestProjects = useRef(projects); latestProjects.current = projects;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!repair?.projectId || focusedRepair.current === repair.sequence) return;
    const project = projects.find((item) => item.id === repair.projectId);
    if (!project || !repairCard.current) return;
    const target = project.available ? repairToolSelect.current : repairDirectoryInput.current;
    repairCard.current.scrollIntoView({ block: 'center' });
    if (target && !target.disabled) target.focus(); else repairCard.current.focus();
    focusedRepair.current = repair.sequence;
  }, [repair?.sequence, projects]);

  async function refresh() {
    if (!nativeAvailable) return;
    try {
      const result = await native.listProjects();
      if (!Array.isArray(result)) throw new Error('项目数据格式无效，请重新读取');
      setProjects(result);
    }
    catch (value) { setError(errorText(value)); }
  }

  useEffect(() => {
    if (!nativeAvailable) return;
    void refresh();
    let active = true;
    const unsubscribe: Array<() => void> = [];
    for (const event of ['cliora:projects-changed', 'cliora:bindings-changed']) {
      void listen(event, () => { if (active) void refresh(); }).then((stop) => {
        if (active) unsubscribe.push(stop); else stop();
      }).catch(() => {});
    }
    return () => { active = false; unsubscribe.forEach((stop) => stop()); };
  }, []);

  const managed = tools.filter((tool) => !!tool.id);
  const defaultTool = managed.some((tool) => tool.id === globalTool) ? globalTool : managed[0]?.id ?? '';

  async function remove(project: Project) {
    if (!await confirmAction(`从 Cliora 移除“${project.name}”？磁盘文件保留。`, () => mounted.current && latestProjects.current.some(item => item.id === project.id && JSON.stringify(item) === JSON.stringify(project)), { title: '移除项目', confirmLabel: '移除项目', destructive: true })) return;
    setBusy(project.id); setError('');
    try { await native.removeProject(project.id); await refresh(); }
    catch (value) { setError(errorText(value)); } finally { setBusy(''); }
  }
  async function rename(project: Project) {
    setBusy(project.id); setError('');
    try { await native.renameProject(project.id, names[project.id] ?? project.name); await refresh(); }
    catch (value) { setError(errorText(value)); } finally { setBusy(''); }
  }
  async function chooseDirectory(project?: Project) {
    setError('');
    try {
      const picked = await open({ directory: true, multiple: false, title: project ? '重新关联项目目录' : '选择项目目录' });
      if (typeof picked !== 'string') return;
      if (!project) { setBusy('add'); await native.addProject(picked, undefined, defaultTool || undefined); await refresh(); return; }
      setBusy(project.id);
      const updated = await native.relinkProject(project.id, picked);
      setProjects((old) => old.map((item) => item.id === project.id ? updated : item));
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(''); }
  }

  async function updateTool(project: Project, toolId: string) {
    setBusy(project.id); setError('');
    try {
      const updated = await native.setProjectTool(project.id, toolId || null);
      setProjects((old) => old.map((item) => item.id === project.id ? updated : item));
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(''); }
  }

  async function saveModel(project: Project, toolId: string) {
    const key = `${project.id}:${toolId}`;
    const model = (modelEdits[key] ?? project.modelOverrides[toolId] ?? '').trim();
    setBusy(project.id); setError('');
    try {
      const updated = await native.setProjectModelOverride(project.id, toolId, model || null);
      setProjects((old) => old.map((item) => item.id === project.id ? updated : item));
      setFeedback(model ? '项目模型已保存；下次启动时通过 CLI 参数选择。' : '已清除项目模型覆盖。');
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(''); }
  }

  async function relinkProject(project: Project) {
    const next = relink[project.id]?.trim();
    if (!next) return;
    setBusy(project.id); setError('');
    try {
      const updated = await native.relinkProject(project.id, next);
      setProjects((old) => old.map((item) => item.id === project.id ? updated : item));
      setRelink((old) => ({ ...old, [project.id]: '' }));
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(''); }
  }

  async function openProject(project: Project) {
    setError('');
    try { await native.openProjectDirectory(project.id); }
    catch (value) { setError(errorText(value)); }
  }

  async function applySelected(project: Project, toolId: string) {
    const profileId = project.selectedProfiles[toolId];
    if (!profileId || !project.path) return;
    setBusy(project.id); setError(''); setFeedback('');
    try {
      await native.applyRegisteredNativeProfile(toolId, profileId, 'project', project.path, false);
      await refresh();
      setFeedback('项目配置已写入原生文件；新会话将读取该配置。');
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(''); }
  }

  async function launch(toolId: string, projectId: string | null, mode: 'normal' | 'yolo', resumeId?: string) {
    setBusy(projectId ?? 'global'); setError(''); setFeedback('');
    try {
      const result = await native.launchCli({ toolId, projectId, sessionId: resumeId?.trim() || null, mode, directory: projectId ? null : launchDirectory.trim() || null });
      setFeedback(`已向外部终端发送${resumeId?.trim() ? '恢复' : '启动'}${result.mode === 'yolo' ? ' YOLO' : ''}请求。`);
      await refresh();
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(''); }
  }

  if (!nativeAvailable) return <p className={styles.note}>项目与外部终端仅在桌面应用中可用。</p>;
  return <section className={styles.workspace} aria-label="项目与启动">
    {error && <div className={styles.error} role="alert">{error}</div>}
    {feedback && <div className={styles.feedback} role="status">{feedback}</div>}
    {!managed.length && <p className={styles.note}>先在设置中启用 CLI；已有项目仍可查看和重新关联。</p>}
    {!!managed.length && <details className={styles.quick}><summary>恢复已有会话 · YOLO 启动</summary><div className={styles.quickContent}>
      <div><strong>直接启动</strong><span>默认普通模式；YOLO 会按 CLI 原生参数跳过审批。</span></div>
      <select aria-label="直接启动的工具" value={defaultTool} onChange={(event) => setGlobalTool(event.target.value)}>{managed.map((tool) => <option value={tool.id} key={tool.id}>{tool.name}</option>)}</select>
      <input aria-label="恢复会话 ID" value={sessionId} placeholder="会话 ID（可选）" onChange={(event) => setSessionId(event.target.value)} />
      <div className={styles.launchDirectory}><input aria-label="启动工作目录" value={launchDirectory} placeholder="工作目录（恢复时使用原会话目录）" onChange={(event) => setLaunchDirectory(event.target.value)} /><button type="button" className={styles.secondary} disabled={!!busy} onClick={() => { void open({ directory: true, multiple: false, title: '选择启动工作目录' }).then((picked) => { if (typeof picked === 'string') setLaunchDirectory(picked); }).catch((value) => setError(errorText(value))); }}>选目录</button></div>
      <div className={styles.actions}><button type="button" disabled={!!busy} onClick={() => void launch(defaultTool, null, 'normal', sessionId)}>{sessionId.trim() ? '恢复' : '启动'}</button><button type="button" className={styles.secondary} disabled={!!busy || !managed.find((tool) => tool.id === defaultTool)?.yoloAvailable} title={managed.find((tool) => tool.id === defaultTool)?.yoloAvailable ? '按此 CLI 的原生参数跳过审批' : '此 CLI 未提供已确认的 YOLO 参数'} onClick={() => void launch(defaultTool, null, 'yolo', sessionId)}>{sessionId.trim() ? 'YOLO 恢复' : 'YOLO'}</button></div>
    </div></details>}
    <div className={styles.heading}><strong>最近项目</strong><button type="button" className={styles.secondary} disabled={!!busy} onClick={() => void chooseDirectory()}>＋ 添加项目</button></div>
    <div className={styles.projectGrid}>
    {projects.map((project) => {
      const toolId = managed.some((tool) => tool.id === project.preferredTool) ? project.preferredTool! : '';
      const descriptor = managed.find((tool) => tool.id === toolId);
      const modelKey = `${project.id}:${toolId}`;
      const pendingProfile = !!project.selectedProfiles[toolId] && project.selectedProfiles[toolId] !== project.appliedProfiles[toolId];
      return <div ref={repair?.projectId === project.id ? repairCard : undefined} tabIndex={repair?.projectId === project.id ? -1 : undefined} className={`${styles.project} ${repair?.projectId === project.id ? styles.repair : ''}`} key={project.id}>
        <div className={styles.identity}><div className={styles.projectTitle}><ToolIcon toolId={toolId} size={26} /><strong>{project.name}</strong></div><span title={project.path ? displayPath(project.path) : ''}>{project.path ? shortPath(project.path) : '尚未关联目录'}</span></div>
        <div className={styles.controls}><select ref={repair?.projectId === project.id ? repairToolSelect : undefined} aria-label={`${project.name} 的工具`} value={toolId} disabled={busy === project.id || !managed.length} onChange={(event) => void updateTool(project, event.target.value)}><option value="">选择工具</option>{managed.map((tool) => <option key={tool.id} value={tool.id}>{tool.name}</option>)}</select><div className={styles.actions}><button type="button" disabled={!!busy || !project.available || !toolId} onClick={() => void launch(toolId, project.id, 'normal')}>启动</button><button type="button" className={styles.secondary} disabled={!!busy || !project.available || !toolId || !descriptor?.yoloAvailable} title={descriptor?.yoloAvailable ? '按此 CLI 的原生参数跳过审批' : '此 CLI 未提供已确认的 YOLO 参数'} onClick={() => void launch(toolId, project.id, 'yolo')}>YOLO</button></div></div>
        {!toolId && <div className={styles.hint}>此项目原来选择的工具未纳入管理。选择一个工具即可继续启动。</div>}
        {pendingProfile && <div className={styles.extra}><span>{project.reapplyProfiles?.[toolId] ? '目录已重新关联，启动时会恢复所选配置' : '此项目配置有待应用内容；普通启动保留已应用的原生文件'}</span><button type="button" className={styles.secondary} disabled={!!busy || !project.available} onClick={() => void applySelected(project, toolId)}>应用配置</button></div>}
        <details className={styles.projectMore} open={!project.available || repair?.projectId === project.id || undefined}><summary>项目选项{project.modelOverrides[toolId] ? ' · 已设置模型' : ''}</summary>{project.path && <div className={styles.projectPath}><small>{displayPath(project.path)}</small><button type="button" className={styles.secondary} onClick={() => void navigator.clipboard.writeText(displayPath(project.path!))}>复制路径</button></div>}<div className={styles.extra}><label>项目名称<input aria-label={`${project.name} 项目名称`} value={names[project.id] ?? project.name} onChange={event => setNames({ ...names,[project.id]:event.target.value })} /></label><button type="button" disabled={!!busy || !names[project.id]?.trim()} onClick={() => void rename(project)}>保存名称</button><button type="button" className={styles.secondary} disabled={!!busy} onClick={() => void remove(project)}>移除项目</button></div><button type="button" className={styles.secondary} disabled={!!busy || !project.available} onClick={() => void openProject(project)}>打开目录</button>
        {descriptor?.projectModelOverride && <div className={styles.extra}><label>项目模型 <input aria-label={`${project.name} 项目模型`} value={modelEdits[modelKey] ?? project.modelOverrides[toolId] ?? ''} placeholder="留空则使用原生默认模型" onChange={(event) => setModelEdits((old) => ({ ...old, [modelKey]: event.target.value }))} /></label><button type="button" disabled={busy === project.id} onClick={() => void saveModel(project, toolId)}>保存</button></div>}
        <div className={styles.extra}><span>{project.available ? '重新关联目录' : '目录已移动，请重新关联'}</span><button type="button" className={styles.secondary} disabled={busy === project.id} onClick={() => void chooseDirectory(project)}>选目录</button><input ref={repair?.projectId === project.id ? repairDirectoryInput : undefined} aria-label={`${project.name} 新目录`} value={relink[project.id] ?? ''} placeholder="或粘贴新的本机目录路径" onChange={(event) => setRelink((old) => ({ ...old, [project.id]: event.target.value }))} /><button type="button" disabled={busy === project.id || !relink[project.id]?.trim()} onClick={() => void relinkProject(project)}>关联</button></div></details>
      </div>;
    })}
    </div>
    {!projects.length && <p className={styles.note}>关联常用项目，即可在对应目录打开 CLI。</p>}

  </section>;
}
