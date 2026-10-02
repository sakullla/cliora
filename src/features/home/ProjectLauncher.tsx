import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import type { LaunchSettings, Project, TrayRepairTarget } from '../../types/launch';
import { preferredLaunchMode } from '../../types/launch';
import type { AdapterDescriptor } from '../../types/native';
import { displayPath, shortPath } from '../../lib/paths';
import { FilterSelect } from '../../components/FilterSelect';
import { Icon } from '../../components/Icon';
import { ToolIcon, toolOptions } from '../../components/ToolIcon';
import { GuideDialog } from '../../components/GuideDialog';
import styles from './ProjectLauncher.module.css';

function formatFailure(error: unknown, objectText: string, nextText: string): string {
  const fallback = `${objectText}。${nextText}`;
  if (typeof error === 'string') {
    const text = error.trim();
    return !text || text.replace(/[。！？，,\s]/g, '') === '操作失败请重试' ? fallback : text;
  }
  if (!error || typeof error !== 'object') return fallback;
  const value = error as { message?: unknown; action?: unknown };
  const raw = 'message' in value && value.message != null ? String(value.message).trim() : '';
  const action = typeof value.action === 'string' ? value.action.trim() : '';
  if (!raw || raw.replace(/[。！？，,\s]/g, '') === '操作失败请重试' || /^操作失败[。！]?$/.test(raw)) {
    const next = action && !/^请重试[。！]?$/.test(action) ? action : nextText;
    const step = /[。！？]$/.test(next) ? next : `${next}。`;
    return `${objectText}。${step}`;
  }
  const detail = raw.replace(/[。！？\s]+$/, '');
  const next = action || nextText;
  const bare = next.replace(/[。！？\s]+$/, '');
  if (!bare || detail.includes(bare)) return /[。！？]$/.test(raw) ? raw : `${detail}。`;
  return `${detail}。${/[。！？]$/.test(next) ? next : `${next}。`}`;
}

const projectNext = '可再次启动，或在设置中检查终端。';

export function ProjectLauncher({ tools, repair }: { tools: AdapterDescriptor[]; repair?: TrayRepairTarget | null }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectQuery, setProjectQuery] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});
  const [globalTool, setGlobalTool] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [dialogFeedback, setDialogFeedback] = useState('');
  const [launchSettings, setLaunchSettings] = useState<LaunchSettings | null>(null);
  const [relink, setRelink] = useState<Record<string, string>>({});
  const [modelEdits, setModelEdits] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const repairDirectoryInput = useRef<HTMLInputElement>(null);
  const repairToolSelect = useRef<HTMLButtonElement>(null);
  const repairCard = useRef<HTMLDivElement>(null);
  const focusedRepair = useRef(0);
  const latestProjects = useRef(projects); latestProjects.current = projects;
  const mounted = useRef(true);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (feedbackTimer.current) clearTimeout(feedbackTimer.current); }; }, []);
  function showPageError(value: unknown) { setFeedback(''); setError(formatFailure(value, '项目操作失败', projectNext)); }
  function showPageFeedback(text: string) {
    setError('');
    setFeedback(text);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => { feedbackTimer.current = null; setFeedback((current) => current === text ? '' : current); }, 5000);
  }
  function showDialogError(value: unknown) { setDialogFeedback(''); setDialogError(formatFailure(value, '项目操作失败', projectNext)); }
  function showDialogFeedback(text: string) { setDialogError(''); setDialogFeedback(text); }
  function begin(id: string) { setBusy(id); setError(''); setFeedback(''); setDialogError(''); setDialogFeedback(''); }

  useEffect(() => {
    if (!repair?.projectId || focusedRepair.current === repair.sequence) return;
    const project = projects.find((item) => item.id === repair.projectId);
    if (!project) return;
    if (!project.available) setEditingId(project.id);
    repairCard.current?.scrollIntoView({ block: 'center' });
    if (project.available) {
      const target = repairToolSelect.current;
      if (target && !target.disabled) target.focus(); else repairCard.current?.focus();
      focusedRepair.current = repair.sequence;
    }
  }, [repair?.sequence, projects]);
  useLayoutEffect(() => {
    if (!repair?.projectId || editingId !== repair.projectId || focusedRepair.current === repair.sequence) return;
    const target = repairDirectoryInput.current;
    if (target && !target.disabled) target.focus();
    focusedRepair.current = repair.sequence;
  }, [editingId, repair?.projectId, repair?.sequence]);

  async function refresh() {
    if (!nativeAvailable) return;
    try {
      const result = await native.listProjects();
      if (!Array.isArray(result)) throw new Error('项目数据格式无效，请重新读取');
      setProjects(result);
    }
    catch (value) { setError((current) => current || formatFailure(value, '项目列表读取失败', projectNext)); }
  }

  useEffect(() => {
    if (!nativeAvailable) return;
    let active = true;
    void native.getLaunchSettings().then((value) => { if (active) setLaunchSettings(value); }).catch(() => {});
    return () => { active = false; };
  }, []);

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
  const directTool = managed.find((tool) => tool.id === defaultTool);
  const directMode = preferredLaunchMode(launchSettings, 'cli', !!directTool?.yoloAvailable);

  async function remove(project: Project) {
    if (!await confirmAction(`从 Cliora 移除“${project.name}”？磁盘文件保留。`, () => mounted.current && latestProjects.current.some(item => item.id === project.id && JSON.stringify(item) === JSON.stringify(project)), { title: '移除项目', confirmLabel: '移除项目', destructive: true })) return;
    begin(project.id);
    try { await native.removeProject(project.id); await refresh(); }
    catch (value) { showDialogError(value); } finally { setBusy(''); }
  }
  async function rename(project: Project) {
    begin(project.id);
    try {
      await native.renameProject(project.id, names[project.id] ?? project.name);
      await refresh();
      setEditingId(null); setDialogError(''); setDialogFeedback('');
      showPageFeedback('项目名称已保存。');
    } catch (value) { showDialogError(value); } finally { setBusy(''); }
  }
  async function chooseDirectory(project?: Project) {
    try {
      const picked = await open({ directory: true, multiple: false, title: project ? '重新关联项目目录' : '选择项目目录' });
      if (typeof picked !== 'string') return;
      if (!project) { begin('add'); await native.addProject(picked, undefined, defaultTool || undefined); await refresh(); showPageFeedback('项目已添加，可立即启动。'); return; }
      begin(project.id);
      const updated = await native.relinkProject(project.id, picked);
      setProjects((old) => old.map((item) => item.id === project.id ? updated : item));
    } catch (value) { if (project) showDialogError(value); else showPageError(value); }
    finally { setBusy(''); }
  }

  async function updateTool(project: Project, toolId: string) {
    begin(project.id);
    try {
      const updated = await native.setProjectTool(project.id, toolId || null);
      setProjects((old) => old.map((item) => item.id === project.id ? updated : item));
    } catch (value) { showPageError(value); }
    finally { setBusy(''); }
  }

  async function saveModel(project: Project, toolId: string) {
    const key = `${project.id}:${toolId}`;
    const model = (modelEdits[key] ?? project.modelOverrides[toolId] ?? '').trim();
    begin(project.id);
    try {
      const updated = await native.setProjectModelOverride(project.id, toolId, model || null);
      setProjects((old) => old.map((item) => item.id === project.id ? updated : item));
      setEditingId(null); setDialogError(''); setDialogFeedback('');
      showPageFeedback(model ? '项目模型已保存；下次启动时通过 CLI 参数选择。' : '已清除项目模型覆盖。');
    } catch (value) { showDialogError(value); }
    finally { setBusy(''); }
  }

  async function relinkProject(project: Project) {
    const next = relink[project.id]?.trim();
    if (!next) return;
    begin(project.id);
    try {
      const updated = await native.relinkProject(project.id, next);
      setProjects((old) => old.map((item) => item.id === project.id ? updated : item));
      setRelink((old) => ({ ...old, [project.id]: '' }));
    } catch (value) { showDialogError(value); }
    finally { setBusy(''); }
  }

  async function openProject(project: Project) {
    setDialogError(''); setDialogFeedback('');
    try { await native.openProjectDirectory(project.id); }
    catch (value) { showDialogError(value); }
  }

  async function applySelected(project: Project, toolId: string) {
    const profileId = project.selectedProfiles[toolId];
    if (!profileId || !project.path) return;
    begin(project.id);
    try {
      await native.applyRegisteredNativeProfile(toolId, profileId, 'project', project.path, false);
      await refresh();
      showPageFeedback('项目配置已写入原生文件；新会话将读取该配置。');
    } catch (value) { showPageError(value); }
    finally { setBusy(''); }
  }

  async function launch(toolId: string, projectId: string | null, mode: 'normal' | 'yolo', resumeId?: string, surface: 'page' | 'dialog' = 'page') {
    begin(projectId ?? 'global');
    const text = (resultMode: string) => `已向外部终端发送${resumeId?.trim() ? '恢复' : '启动'}${resultMode === 'yolo' ? ' YOLO' : ''}请求。`;
    try {
      const result = await native.launchCli({ toolId, projectId, sessionId: resumeId?.trim() || null, mode, directory: null });
      const message = text(result.mode);
      if (surface === 'dialog') {
        showDialogFeedback(message);
        setFeedback(message);
      } else showPageFeedback(message);
      await refresh();
    } catch (value) { if (surface === 'dialog') showDialogError(value); else showPageError(value); }
    finally { setBusy(''); }
  }

  if (!nativeAvailable) return <p className={styles.note}>项目与外部终端仅在桌面应用中可用。</p>;
  const projectNeedle = projectQuery.trim().toLowerCase();
  const visibleProjects = projectNeedle ? projects.filter((project) => `${project.name} ${project.path ?? ''}`.toLowerCase().includes(projectNeedle)) : projects;
  return <section className={styles.workspace} aria-label="项目与启动">
    {error && <div className={styles.error} role="alert">{error}</div>}
    {feedback && <div className={styles.feedback} role="status">{feedback}</div>}
    {!managed.length && <p className={styles.note}>先在设置中启用 CLI；已有项目仍可查看和重新关联。</p>}
    {!!managed.length && <details className={styles.quick}><summary>恢复指定会话</summary><div className={styles.quickContent}>
      <div><strong>按会话 ID 恢复</strong><span>{directMode === 'yolo' ? '恢复会回到原会话的工作目录，默认 YOLO 模式。' : '恢复会回到原会话的工作目录；YOLO 按 CLI 原生参数跳过审批。'}</span></div>
      <FilterSelect className={styles.quickTool} label="恢复会话的工具" value={defaultTool} options={toolOptions(managed)} placeholder="选择工具" searchLabel="搜索工具" onChange={setGlobalTool} />
      <input aria-label="恢复会话 ID" value={sessionId} placeholder="会话 ID" onChange={(event) => setSessionId(event.target.value)} />
      <div className={styles.actions}><button type="button" disabled={!!busy || !sessionId.trim()} onClick={() => void launch(defaultTool, null, directMode, sessionId)}>恢复</button>{directMode === 'yolo' ? <button type="button" className={styles.secondary} disabled={!!busy || !sessionId.trim()} onClick={() => void launch(defaultTool, null, 'normal', sessionId)}>普通恢复</button> : <button type="button" className={styles.secondary} disabled={!!busy || !sessionId.trim() || !directTool?.yoloAvailable} title={directTool?.yoloAvailable ? '按此 CLI 的原生参数跳过审批' : '此 CLI 未提供已确认的 YOLO 参数'} onClick={() => void launch(defaultTool, null, 'yolo', sessionId)}>YOLO 恢复</button>}</div>
    </div></details>}
    <div className={styles.heading}><strong>最近项目{!!projects.length && <span className="count-chip" aria-hidden="true">{projects.length}</span>}</strong><button type="button" className={styles.secondary} disabled={!!busy} onClick={() => void chooseDirectory()}>＋ 添加项目</button></div>
    {projects.length > 4 && <div className={styles.projectSearch}><Icon name="search" size={14} /><input aria-label="搜索项目" value={projectQuery} placeholder="搜索项目名称或路径" onChange={(event) => setProjectQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && projectQuery) { event.preventDefault(); setProjectQuery(''); } }} /></div>}
    {projects.length ? (visibleProjects.length ? <div className={styles.projectGrid}>
    {visibleProjects.map((project) => {
      const toolId = managed.some((tool) => tool.id === project.preferredTool) ? project.preferredTool! : '';
      const descriptor = managed.find((tool) => tool.id === toolId);
      const modelKey = `${project.id}:${toolId}`;
      const pendingProfile = !!project.selectedProfiles[toolId] && project.selectedProfiles[toolId] !== project.appliedProfiles[toolId];
      const projectMode = preferredLaunchMode(launchSettings, 'project', !!descriptor?.yoloAvailable);
      return <div ref={repair?.projectId === project.id ? repairCard : undefined} tabIndex={repair?.projectId === project.id ? -1 : undefined} className={`${styles.project} ${repair?.projectId === project.id ? styles.repair : ''}`} key={project.id}>
        <div className={styles.identity}><div className={styles.projectTitle}><ToolIcon toolId={toolId} size={26} /><strong title={project.name}>{project.name}</strong></div><span title={project.path ? displayPath(project.path) : ''}>{project.path ? shortPath(project.path) : '尚未关联目录'}</span></div>
        <div className={styles.controls}><FilterSelect className={styles.toolSelect} label={`${project.name} 的工具`} value={toolId} options={[{ value: '', label: '选择工具' }, ...toolOptions(managed)]} placeholder="选择工具" disabled={busy === project.id || !managed.length} searchLabel="搜索工具" onChange={(value) => void updateTool(project, value)} triggerRef={repair?.projectId === project.id ? repairToolSelect : undefined} /><div className={styles.actions}><button type="button" disabled={!!busy || !project.available || !toolId} title={!project.available ? '目录不可用，请先重新关联' : projectMode === 'yolo' ? '按此 CLI 的原生参数跳过审批' : launchSettings?.projectMode === 'yolo' ? '此 CLI 未提供已确认的 YOLO 参数，将用普通模式启动' : undefined} onClick={() => void launch(toolId, project.id, projectMode)}>启动</button><button type="button" className={styles.iconAction} aria-label={`打开${project.name}的目录`} title="在文件管理器中打开" disabled={!!busy || !project.available} onClick={() => void openProject(project)}><Icon name="folder" size={15} /></button><button type="button" className={styles.secondary} onClick={() => setEditingId(project.id)}>修改</button></div></div>
        {!toolId && <div className={styles.hint}>此项目原来选择的工具未纳入管理。选择一个工具即可继续启动。</div>}
        {pendingProfile && <div className={styles.extra} data-tone="pending"><span>{project.reapplyProfiles?.[toolId] ? '目录已重新关联，启动时会恢复所选配置' : '此项目配置有待应用内容；普通启动保留已应用的原生文件'}</span><button type="button" className={styles.secondary} disabled={!!busy || !project.available} onClick={() => void applySelected(project, toolId)}>应用配置</button></div>}
        <GuideDialog open={editingId === project.id} title={`修改${project.name}`} hint="可以改名称、目录、模型和这次启动方式。启动按钮仍在卡片上。" onClose={() => { setEditingId(null); setDialogError(''); setDialogFeedback(''); }}>
          {dialogError && <div className={styles.error} role="alert">{dialogError}</div>}
          {dialogFeedback && <div className={styles.feedback} role="status">{dialogFeedback}</div>}
          {project.path && <div className={styles.projectPath}><small>{displayPath(project.path)}</small><button type="button" className={styles.secondary} onClick={() => void navigator.clipboard.writeText(displayPath(project.path!))}>复制路径</button></div>}
          <div className={styles.extra}><label>项目名称<input aria-label={`${project.name} 项目名称`} value={names[project.id] ?? project.name} onChange={event => setNames({ ...names,[project.id]:event.target.value })} /></label><button type="button" disabled={!!busy || !names[project.id]?.trim()} onClick={() => void rename(project)}>保存名称</button><button type="button" className={styles.secondary} disabled={!!busy} onClick={() => void remove(project)}>移除项目</button></div>
          <button type="button" className={styles.secondary} disabled={!!busy || !project.available} onClick={() => void openProject(project)}>打开目录</button>
          {descriptor?.projectModelOverride && <div className={styles.extra}><label>项目模型 <input aria-label={`${project.name} 项目模型`} value={modelEdits[modelKey] ?? project.modelOverrides[toolId] ?? ''} placeholder="留空则使用原生默认模型" onChange={(event) => setModelEdits((old) => ({ ...old, [modelKey]: event.target.value }))} /></label><button type="button" disabled={busy === project.id} onClick={() => void saveModel(project, toolId)}>保存</button></div>}
          <div className={styles.extra}><span>{project.available ? '重新关联目录' : '目录已移动，请重新关联'}</span><button type="button" className={styles.secondary} disabled={busy === project.id} onClick={() => void chooseDirectory(project)}>选目录</button><input ref={repair?.projectId === project.id ? repairDirectoryInput : undefined} aria-label={`${project.name} 新目录`} value={relink[project.id] ?? ''} placeholder="或粘贴新的本机目录路径" onChange={(event) => setRelink((old) => ({ ...old, [project.id]: event.target.value }))} /><button type="button" disabled={busy === project.id || !relink[project.id]?.trim()} onClick={() => void relinkProject(project)}>关联</button></div>
          <div className={styles.extra}><span>卡片上的启动用当前默认方式。这里只改这一次。</span>{projectMode === 'yolo' ? <button type="button" className={styles.secondary} disabled={!!busy || !project.available || !toolId} onClick={() => void launch(toolId, project.id, 'normal', undefined, 'dialog')}>这次用普通模式</button> : <button type="button" className={styles.secondary} disabled={!!busy || !project.available || !toolId || !descriptor?.yoloAvailable} title={descriptor?.yoloAvailable ? '按此 CLI 的原生参数跳过审批' : '此 CLI 未提供已确认的 YOLO 参数'} onClick={() => void launch(toolId, project.id, 'yolo', undefined, 'dialog')}>这次用 YOLO</button>}</div>
        </GuideDialog>
      </div>;
    })}
    </div> : <p className={styles.noMatch}>没有匹配「{projectQuery.trim()}」的项目。</p>) : <div className={styles.emptyProjects}><strong>还没有项目</strong><span>添加一个本机目录，之后就能用所选 CLI 一键在外部终端启动。</span><button type="button" disabled={!!busy} onClick={() => void chooseDirectory()}>添加项目</button></div>}

  </section>;
}
