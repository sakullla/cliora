import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import type { LaunchSettings, Project, TrayRepairTarget } from '../../types/launch';
import { preferredLaunchMode } from '../../types/launch';
import type { AdapterDescriptor } from '../../types/native';
import type { RemoteProject, RemoteTarget } from '../../types/remote';
import { displayPath, shortPath } from '../../lib/paths';
import { writeClipboard } from '../../lib/clipboard';
import { FilterSelect } from '../../components/FilterSelect';
import { SearchField } from '../../components/SearchField';
import { Icon } from '../../components/Icon';
import { ToolIcon, toolOptions } from '../../components/ToolIcon';
import { GuideDialog } from '../../components/GuideDialog';
import { SkeletonRows } from '../../components/Skeleton';
import { RemoteProjectDialog } from '../remote/RemoteProjectDialog';
import { formatFailure } from '../../lib/feedback';
import { failedInWorkbench, workbenchSessionId, type WorkbenchFailure } from '../sessions/SessionWorkbench';
import styles from './ProjectLauncher.module.css';

export function ProjectLauncher({ tools, repair, spotlight, remoteSshEnabled = false, remoteTargetId = 'local', onWorkbenchSession, onWorkbenchFailure }: { tools: AdapterDescriptor[]; repair?: TrayRepairTarget | null; spotlight?: { id: string; token: number } | null; remoteSshEnabled?: boolean; remoteTargetId?: string; onWorkbenchSession?: (sessionId: string) => void; onWorkbenchFailure?: (failure: WorkbenchFailure) => void }) {
  const { t } = useTranslation();
  const projectNext = t('home.launcher.projectNext');
  const [projects, setProjects] = useState<Project[]>([]);
  const [listLoading, setListLoading] = useState(nativeAvailable);
  const [projectQuery, setProjectQuery] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});
  const [globalTool, setGlobalTool] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [projectSessions, setProjectSessions] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [dialogFeedback, setDialogFeedback] = useState('');
  const [launchSettings, setLaunchSettings] = useState<LaunchSettings | null>(null);
  const [remoteTargets, setRemoteTargets] = useState<RemoteTarget[]>([]);
  const [remoteProjects, setRemoteProjects] = useState<RemoteProject[]>([]);
  const [remoteDialogOpen, setRemoteDialogOpen] = useState(false);
  const [relink, setRelink] = useState<Record<string, string>>({});
  const [pasteOpen, setPasteOpen] = useState<Record<string, boolean>>({});
  const [modelEdits, setModelEdits] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState('');
  const copiedTimer = useRef(0);
  const repairDirectoryInput = useRef<HTMLInputElement>(null);
  const repairToolSelect = useRef<HTMLButtonElement>(null);
  const repairCard = useRef<HTMLDivElement>(null);
  const focusedRepair = useRef(0);
  const latestProjects = useRef(projects); latestProjects.current = projects;
  const mounted = useRef(true);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (feedbackTimer.current) clearTimeout(feedbackTimer.current); }; }, []);
  function showPageError(value: unknown) { setFeedback(''); setError(formatFailure(value, t('home.launcher.operationFailed'), projectNext)); }
  function showPageFeedback(text: string) {
    setError('');
    setFeedback(text);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => { feedbackTimer.current = null; setFeedback((current) => current === text ? '' : current); }, 5000);
  }
  function showDialogError(value: unknown) { setDialogFeedback(''); setDialogError(formatFailure(value, t('home.launcher.operationFailed'), projectNext)); }
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
  const revealedSpotlight = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!spotlight || revealedSpotlight.current === spotlight.token) return;
    if (projectQuery) {
      setProjectQuery('');
      return;
    }
    const card = document.querySelector<HTMLElement>(`[data-project-id="${CSS.escape(spotlight.id)}"]`);
    if (!card) return;
    revealedSpotlight.current = spotlight.token;
    const reveal = () => card.scrollIntoView({ block: 'center', behavior: 'auto' });
    reveal();
    const frame = requestAnimationFrame(() => {
      reveal();
      card.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [spotlight?.id, spotlight?.token, projects, projectQuery]);

  async function refresh() {
    if (!nativeAvailable) return;
    try {
      const result = await native.listProjects();
      if (!Array.isArray(result)) throw new Error(t('home.launcher.invalidData'));
      setProjects(result);
    }
    catch (value) { setError((current) => current || formatFailure(value, t('home.launcher.listFailed'), projectNext)); }
    finally { setListLoading(false); }
  }

  useEffect(() => {
    if (!nativeAvailable) return;
    let active = true;
    void native.getLaunchSettings().then((value) => { if (active) setLaunchSettings(value); }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!nativeAvailable || !remoteSshEnabled) { setRemoteTargets([]); setRemoteProjects([]); return; }
    let active = true;
    void Promise.all([native.listRemoteTargets(), native.listRemoteProjects()]).then(([targets, projects]) => {
      if (!active) return;
      setRemoteTargets(targets.filter((target) => target.enabled));
      setRemoteProjects(projects);
    }).catch(() => {});
    return () => { active = false; };
  }, [remoteSshEnabled]);

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
  const resumable = managed.filter((tool) => tool.resume?.state === 'available' && tool.history?.state !== 'unsupported');
  const unindexedResume = managed.filter((tool) => tool.resume?.state === 'available' && tool.history?.state === 'unsupported');
  const resumeTool = resumable.some((tool) => tool.id === globalTool) ? globalTool : resumable[0]?.id ?? '';
  const resumeDescriptor = resumable.find((tool) => tool.id === resumeTool);
  const directMode = preferredLaunchMode(launchSettings, 'cli', !!resumeDescriptor?.yoloAvailable);
  async function remove(project: Project) {
    if (!await confirmAction(t('home.launcher.removeConfirm', { name: project.name }), () => mounted.current && latestProjects.current.some(item => item.id === project.id && JSON.stringify(item) === JSON.stringify(project)), { title: t('home.launcher.removeAction'), confirmLabel: t('home.launcher.removeAction'), destructive: true })) return;
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
      showPageFeedback(t('home.launcher.renamed'));
    } catch (value) { showDialogError(value); } finally { setBusy(''); }
  }
  async function chooseDirectory(project?: Project) {
    // The project action follows the global host context. A remote host must
    // never fall through to the native file picker, which only knows local
    // filesystem paths.
    if (!project && remoteTargetId !== 'local') {
      setRemoteDialogOpen(true);
      return;
    }
    try {
      const picked = await open({ directory: true, multiple: false, title: project ? t('home.launcher.relinkTitle') : t('home.launcher.pickTitle') });
      if (typeof picked !== 'string') return;
      if (!project) { begin('add'); await native.addProject(picked, undefined, defaultTool || undefined); await refresh(); showPageFeedback(t('home.launcher.added')); return; }
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
      showPageFeedback(model ? t('home.launcher.modelSaved') : t('home.launcher.modelCleared'));
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

  async function copyPath(project: Project) {
    if (!project.path) return;
    const value = displayPath(project.path);
    const copied = await writeClipboard(value);
    window.clearTimeout(copiedTimer.current);
    setCopiedPath(copied ? value : `fail:${value}`);
    copiedTimer.current = window.setTimeout(() => setCopiedPath(''), 1600);
  }

  async function applySelected(project: Project, toolId: string) {
    const profileId = project.selectedProfiles[toolId];
    if (!profileId || !project.path) return;
    begin(project.id);
    try {
      await native.applyRegisteredNativeProfile(toolId, profileId, 'project', project.path, false);
      await refresh();
      showPageFeedback(t('home.launcher.applied'));
    } catch (value) { showPageError(value); }
    finally { setBusy(''); }
  }

  async function launch(toolId: string, projectId: string | null, mode: 'normal' | 'yolo', resumeId?: string, surface: 'page' | 'dialog' = 'page', resumeLatest = false) {
    begin(projectId ?? 'global');
    const request = { toolId, projectId, sessionId: resumeLatest ? null : (resumeId?.trim() || null), mode, directory: null, ...(resumeLatest ? { resumeLatest: true } : {}) };
    const text = (resultMode: string) => t('home.launcher.launched', { action: t(resumeLatest || resumeId?.trim() ? 'home.launcher.actionResume' : 'home.launcher.actionLaunch'), mode: resultMode === 'yolo' ? ' YOLO' : '' });
    try {
      const result = await native.launchCli(request);
      const opened = workbenchSessionId(result);
      if (opened) {
        onWorkbenchSession?.(opened);
        // Keep the project card state current without delaying workbench entry.
        void refresh();
        return;
      }
      const launchedTool = managed.find((item) => item.id === toolId);
      const message = launchedTool?.launchForm === 'desktop'
        ? t('home.tools.launchedDesktop', { name: launchedTool.name })
        : text(result.mode);
      if (surface === 'dialog') {
        showDialogFeedback(message);
        setFeedback(message);
      } else showPageFeedback(message);
      // Keep the project card state current without delaying the launch result.
      void refresh();
    } catch (value) {
      const desktop = managed.find((item) => item.id === toolId)?.launchForm === 'desktop';
      if (await failedInWorkbench(desktop)) {
        onWorkbenchFailure?.({ detail: formatFailure(value, t('home.launcher.operationFailed'), projectNext), retry: { kind: 'launch', request } });
        return;
      }
      if (surface === 'dialog') showDialogError(value); else showPageError(value);
    }
    finally { setBusy(''); }
  }

  async function removeRemote(project: RemoteProject) {
    if (!await confirmAction(t('home.remote.removeConfirm', { name: project.name }), () => mounted.current, { title: t('home.remote.remove'), confirmLabel: t('home.remote.remove'), destructive: true })) return;
    begin(`remote:${project.id}`);
    try {
      await native.deleteRemoteProject(project.id);
      setRemoteProjects((items) => items.filter((item) => item.id !== project.id));
      showPageFeedback(t('home.remote.removed'));
    } catch (value) { showPageError(value); }
    finally { setBusy(''); }
  }

  if (!nativeAvailable) return <p className={styles.note}>{t('home.launcher.nativeOnly')}</p>;
  const projectNeedle = projectQuery.trim().toLowerCase();
  const scopedProjects = remoteTargetId === 'local' ? projects : [];
  const scopedRemoteProjects = remoteTargetId === 'local' ? [] : remoteProjects.filter((project) => project.targetId === remoteTargetId);
  const visibleProjects = projectNeedle ? scopedProjects.filter((project) => `${project.name} ${project.path ?? ''}`.toLowerCase().includes(projectNeedle)) : scopedProjects;
  const visibleRemoteProjects = projectNeedle ? scopedRemoteProjects.filter((project) => `${project.name} ${project.path} ${remoteTargets.find((target) => target.id === project.targetId)?.host ?? ''}`.toLowerCase().includes(projectNeedle)) : scopedRemoteProjects;
  const totalProjects = scopedProjects.length + scopedRemoteProjects.length;
  return <section className={`${styles.workspace} home-launcher`} aria-label={t('home.launcher.label')}>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {feedback && <div className={styles.feedback} role="status">{feedback}</div>}
    {!managed.length && <p className={styles.note}>{t('home.launcher.enableFirst')}</p>}
    <div className={styles.heading}><strong>{t('home.projects.title')}{!!totalProjects && <span className="count-chip" aria-hidden="true">{totalProjects}</span>}</strong><span className={styles.actions}><button type="button" className={styles.secondary} disabled={!!busy} onClick={() => void chooseDirectory()}><Icon name="plus" size={14} />{t('home.launcher.add')}</button></span></div>
    {totalProjects > 4 && <SearchField className={styles.projectSearch} label={t('home.launcher.searchLabel')} value={projectQuery} placeholder={t('home.launcher.searchPlaceholder')} onChange={setProjectQuery} />}
    {listLoading && !totalProjects ? <SkeletonRows count={2} /> : (visibleProjects.length || visibleRemoteProjects.length) ? <>
    {visibleProjects.length > 0 && <div className={styles.projectGrid}>
    {visibleProjects.map((project) => {
      const toolId = managed.some((tool) => tool.id === project.preferredTool) ? project.preferredTool! : '';
      const descriptor = managed.find((tool) => tool.id === toolId);
      const modelKey = `${project.id}:${toolId}`;
      const pendingProfile = !!project.selectedProfiles[toolId] && project.selectedProfiles[toolId] !== project.appliedProfiles[toolId];
      const projectMode = preferredLaunchMode(launchSettings, 'project', !!descriptor?.yoloAvailable);
      const marked = repair?.projectId === project.id || spotlight?.id === project.id;
      const pasteExpanded = project.id in pasteOpen ? !!pasteOpen[project.id] : repair?.projectId === project.id;
      return <div ref={repair?.projectId === project.id ? repairCard : undefined} tabIndex={marked ? -1 : undefined} data-project-id={project.id} className={`${styles.project}${repair?.projectId === project.id ? ` ${styles.repair}` : ''}${spotlight?.id === project.id ? ` ${styles.spotlight}` : ''}`} key={project.id}>
        <div className={styles.identity}><div className={styles.projectTitle}><ToolIcon toolId={toolId} size={26} /><strong title={project.name}>{project.name}</strong></div><span title={project.path ? displayPath(project.path) : ''}>{project.path ? shortPath(project.path) : t('home.launcher.noDirectory')}</span></div>
        <div className={styles.controls}><FilterSelect className={styles.toolSelect} label={t('home.launcher.toolFor', { name: project.name })} value={toolId} options={[{ value: '', label: t('home.launcher.pickTool') }, ...toolOptions(managed)]} placeholder={t('home.launcher.pickTool')} disabled={busy === project.id || !managed.length} searchLabel={t('home.launcher.searchTool')} onChange={(value) => void updateTool(project, value)} triggerRef={repair?.projectId === project.id ? repairToolSelect : undefined} /><div className={styles.actions}><button type="button" disabled={!!busy || !project.available || !toolId} title={!project.available ? t('home.launcher.dirUnavailable') : projectMode === 'yolo' ? t('home.tools.launchYolo') : launchSettings?.projectMode === 'yolo' ? t('home.tools.launchYoloFallback') : undefined} onClick={() => void launch(toolId, project.id, projectMode)}>{t('home.tools.launch')}</button>{descriptor?.resumeLatestAvailable && <button type="button" className={styles.secondary} disabled={!!busy || !project.available || !toolId} onClick={() => void launch(toolId, project.id, 'normal', undefined, 'page', true)}>{t('home.launcher.resumeLatest')}</button>}<button type="button" className={styles.iconAction} aria-label={t('home.launcher.openDirAria', { name: project.name })} title={t('home.launcher.openDirTitle')} disabled={!!busy || !project.available} onClick={() => void openProject(project)}><Icon name="folder" size={16} /></button><button type="button" className={styles.secondary} onClick={() => setEditingId(project.id)}>{t('home.launcher.edit')}</button></div></div>
        {descriptor?.resume?.state === 'available' && descriptor.history?.state === 'unsupported' && <div className={styles.extra}><label>{t('home.launcher.projectSessionLabel')}<input aria-label={t('home.launcher.projectSessionAria', { name: project.name })} value={projectSessions[project.id] ?? ''} placeholder={t('home.launcher.resumeIdPlaceholder')} disabled={!!busy || !project.available} onChange={(event) => setProjectSessions((old) => ({ ...old, [project.id]: event.target.value }))} /></label><button type="button" className={styles.secondary} disabled={!!busy || !project.available || !toolId || !(projectSessions[project.id] ?? '').trim()} title={!project.available ? t('home.launcher.dirUnavailable') : descriptor.history.reason} onClick={() => void launch(toolId, project.id, 'normal', projectSessions[project.id], 'page', false)}>{t('home.launcher.resumeById')}</button><span>{t('home.launcher.projectSessionHint', { reason: descriptor.history.reason })}</span></div>}
        {!toolId && <div className={styles.hint}>{t('home.launcher.toolUnmanaged')}</div>}
        {pendingProfile && <div className={styles.extra} data-tone="pending"><span>{project.reapplyProfiles?.[toolId] ? t('home.launcher.reapplyRelinked') : t('home.launcher.pendingProfile')}</span><button type="button" className={styles.secondary} disabled={!!busy || !project.available} onClick={() => void applySelected(project, toolId)}>{t('home.launcher.apply')}</button></div>}
        <GuideDialog open={editingId === project.id} title={t('home.launcher.editTitle', { name: project.name })} hint={t('home.launcher.editHint')} onClose={() => { setEditingId(null); setDialogError(''); setDialogFeedback(''); }}>
          {dialogError && <div className={styles.error} role="alert">{dialogError}</div>}
          {dialogFeedback && <div className={styles.feedback} role="status">{dialogFeedback}</div>}
          {project.path && <div className={styles.projectPath}><small>{displayPath(project.path)}</small><button type="button" className={styles.secondary} data-copied={copiedPath === displayPath(project.path) || undefined} onClick={() => void copyPath(project)}>{copiedPath === displayPath(project.path) ? t('home.launcher.copied') : copiedPath === `fail:${displayPath(project.path)}` ? t('home.launcher.copyFailed') : t('home.launcher.copyPath')}</button></div>}
          <div className={styles.extra}><label>{t('home.launcher.nameLabel')}<input aria-label={t('home.launcher.nameAria', { name: project.name })} value={names[project.id] ?? project.name} onChange={event => setNames({ ...names,[project.id]:event.target.value })} /></label><button type="button" disabled={!!busy || !names[project.id]?.trim()} onClick={() => void rename(project)}>{t('home.launcher.saveName')}</button><button type="button" className={styles.secondary} disabled={!!busy} onClick={() => void remove(project)}>{t('home.launcher.removeAction')}</button></div>
          <button type="button" className={styles.secondary} disabled={!!busy || !project.available} onClick={() => void openProject(project)}>{t('home.launcher.openDir')}</button>
          {descriptor?.projectModelOverride && <div className={styles.extra}><label>{t('home.launcher.modelLabel')} <input aria-label={t('home.launcher.modelAria', { name: project.name })} value={modelEdits[modelKey] ?? project.modelOverrides[toolId] ?? ''} placeholder={t('home.launcher.modelPlaceholder')} onChange={(event) => setModelEdits((old) => ({ ...old, [modelKey]: event.target.value }))} /></label><button type="button" disabled={busy === project.id} onClick={() => void saveModel(project, toolId)}>{t('home.launcher.save')}</button></div>}
          <div className={styles.extra}><span>{project.available ? t('home.launcher.relink') : t('home.launcher.relinkMoved')}</span><button type="button" className={styles.secondary} disabled={busy === project.id} onClick={() => void chooseDirectory(project)}>{t('home.launcher.chooseDir')}</button><button type="button" className={styles.secondary} aria-expanded={pasteExpanded} onClick={() => setPasteOpen((old) => ({ ...old, [project.id]: !pasteExpanded }))}>{t('home.launcher.pastePath')}</button>{pasteExpanded && <><input ref={repair?.projectId === project.id ? repairDirectoryInput : undefined} aria-label={t('home.launcher.newDirAria', { name: project.name })} value={relink[project.id] ?? ''} placeholder={t('home.launcher.newDirPlaceholder')} onChange={(event) => setRelink((old) => ({ ...old, [project.id]: event.target.value }))} /><button type="button" disabled={busy === project.id || !relink[project.id]?.trim()} onClick={() => void relinkProject(project)}>{t('home.launcher.link')}</button></>}</div>
          {(descriptor?.yoloAvailable || projectMode === 'yolo') && <div className={styles.extra}><span>{t('home.launcher.onceNote')}</span>{projectMode === 'yolo' ? <button type="button" className={styles.secondary} disabled={!!busy || !project.available || !toolId} onClick={() => void launch(toolId, project.id, 'normal', undefined, 'dialog')}>{t('home.launcher.onceNormal')}</button> : <button type="button" className={styles.secondary} disabled={!!busy || !project.available || !toolId || !descriptor?.yoloAvailable} title={descriptor?.yoloAvailable ? t('home.tools.launchYolo') : t('home.launcher.yoloUnavailable')} onClick={() => void launch(toolId, project.id, 'yolo', undefined, 'dialog')}>{t('home.launcher.onceYolo')}</button>}</div>}
        </GuideDialog>
      </div>;
    })}
    </div>}
    {visibleRemoteProjects.length > 0 && <div className={styles.projectGrid}>
      {visibleRemoteProjects.map((project) => {
        const target = remoteTargets.find((item) => item.id === project.targetId);
        const toolId = managed.some((tool) => tool.id === project.preferredTool) ? project.preferredTool! : defaultTool;
        const descriptor = managed.find((tool) => tool.id === toolId);
        const projectMode = preferredLaunchMode(launchSettings, 'project', !!descriptor?.yoloAvailable);
        return <div className={`${styles.project} ${styles.remoteProject}`} key={`remote:${project.id}`} data-project-id={`remote:${project.id}`}>
          <div className={styles.identity}><div className={styles.projectTitle}><Icon name="globe" size={24} /><strong title={project.name}>{project.name}</strong><span className={styles.remoteBadge}>{t('home.remote.badge')}</span></div><span title={`${target?.user ?? ''}@${target?.host ?? ''}:${target?.port ?? ''} · ${project.path}`}>{target ? `${target.user}@${target.host}:${target.port} · ${project.path}` : project.path}</span></div>
          <div className={styles.controls}><FilterSelect className={styles.toolSelect} label={t('home.launcher.toolFor', { name: project.name })} value={toolId} options={[{ value: '', label: t('home.launcher.pickTool') }, ...toolOptions(managed)]} placeholder={t('home.launcher.pickTool')} disabled={!!busy || !managed.length} searchLabel={t('home.launcher.searchTool')} onChange={(value) => setRemoteProjects((items) => items.map((item) => item.id === project.id ? { ...item, preferredTool: value || null } : item))} /><div className={styles.actions}><button type="button" disabled={!!busy || !toolId} title={projectMode === 'yolo' ? t('home.tools.launchYolo') : undefined} onClick={() => void launch(toolId, `remote:${project.id}`, projectMode)}><Icon name="play" size={14} />{t('home.tools.launch')}</button><button type="button" className={styles.secondary} onClick={() => void removeRemote(project)}>{t('home.remote.remove')}</button></div></div>
        </div>;
      })}
    </div>}
    {!visibleProjects.length && !visibleRemoteProjects.length && totalProjects > 0 ? <p className={styles.noMatch}>{t('home.launcher.noMatch', { query: projectQuery.trim() })}</p> : null}
    {!totalProjects && <div className={styles.emptyProjects}><strong>{t('home.launcher.emptyTitle')}</strong><span>{t('home.launcher.emptyDetail')}</span><button type="button" disabled={!!busy} onClick={() => void chooseDirectory()}>{t('home.launcher.addProject')}</button></div>}
    </> : <div className={styles.emptyProjects}><strong>{t('home.launcher.emptyTitle')}</strong><span>{t('home.launcher.emptyDetail')}</span><button type="button" disabled={!!busy} onClick={() => void chooseDirectory()}>{t('home.launcher.addProject')}</button></div>}
    {!!managed.length && <details className={styles.quick}><summary><span>{t('home.launcher.resumeTitle')}</span><small>{t('home.launcher.resumeHint')}</small></summary><div className={styles.quickContent}>
      {resumable.length ? <><div><strong>{t('home.launcher.resumeById')}</strong><span>{directMode === 'yolo' ? t('home.launcher.resumeDescYolo') : t('home.launcher.resumeDescNormal')}</span></div>
      <FilterSelect className={styles.quickTool} label={t('home.launcher.resumeTool')} value={resumeTool} options={toolOptions(resumable)} placeholder={t('home.launcher.pickTool')} searchLabel={t('home.launcher.searchTool')} onChange={setGlobalTool} />
      <input aria-label={t('home.launcher.resumeIdLabel')} value={sessionId} placeholder={t('home.launcher.resumeIdPlaceholder')} onChange={(event) => setSessionId(event.target.value)} />
      <div className={styles.actions}><button type="button" disabled={!!busy || !sessionId.trim() || !resumeTool} onClick={() => void launch(resumeTool, null, directMode, sessionId)}>{t('home.launcher.resume')}</button>{directMode === 'yolo' ? <button type="button" className={styles.secondary} disabled={!!busy || !sessionId.trim() || !resumeTool} onClick={() => void launch(resumeTool, null, 'normal', sessionId)}>{t('home.launcher.resumeNormal')}</button> : <button type="button" className={styles.secondary} disabled={!!busy || !sessionId.trim() || !resumeTool || !resumeDescriptor?.yoloAvailable} title={resumeDescriptor?.yoloAvailable ? t('home.tools.launchYolo') : t('home.launcher.yoloUnavailable')} onClick={() => void launch(resumeTool, null, 'yolo', sessionId)}>{t('home.launcher.resumeYolo')}</button>}</div></> : !unindexedResume.length && <p>{t('home.launcher.resumeNone')}</p>}
      {unindexedResume.map((item) => <p key={item.id}>{item.name}：{item.history.reason} {t('home.launcher.resumeOnProject')}</p>)}
      {!resumable.length && managed.filter((item) => item.resume != null && item.resume.state !== 'available').map((item) => <p key={item.id}>{item.name}：{item.resume.reason}</p>)}
    </div></details>}
    <RemoteProjectDialog
      open={remoteDialogOpen}
      targets={remoteTargets}
      projects={remoteProjects}
      tools={managed}
      initialTargetId={remoteTargetId === 'local' ? undefined : remoteTargetId}
      onClose={() => setRemoteDialogOpen(false)}
      onSaved={(saved) => {
        setRemoteProjects((items) => {
          const index = items.findIndex((item) => item.id === saved.id);
          if (index < 0) return [...items, saved];
          const next = items.slice();
          next[index] = saved;
          return next;
        });
        showPageFeedback(t('home.remote.saved'));
      }}
    />
  </section>;
}
