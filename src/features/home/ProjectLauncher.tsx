import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import type { LaunchRequest, LaunchSettings, Project, TrayRepairTarget } from '../../types/launch';
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
import { RowMenu } from '../../components/RowMenu';
import { SkeletonRows } from '../../components/Skeleton';
import { Badge, Button, Card, SplitButton, Toolbar } from '../../components/ui';
import { ensureRemoteProject, useRemoteFolderPicker } from '../remote/remoteLaunch';
import { formatFailure } from '../../lib/feedback';
import { failedInWorkbench, workbenchSessionId, type WorkbenchFailure } from '../sessions/workbenchLaunch';
import styles from './ProjectLauncher.module.css';

export function ProjectLauncher({ tools, repair, spotlight, remoteSshEnabled = false, remoteTargetId = 'local', onWorkbenchSession, onWorkbenchFailure }: { tools: AdapterDescriptor[]; repair?: TrayRepairTarget | null; spotlight?: { id: string; token: number } | null; remoteSshEnabled?: boolean; remoteTargetId?: string; onWorkbenchSession?: (sessionId: string) => void; onWorkbenchFailure?: (failure: WorkbenchFailure) => void }) {
  const { t, i18n } = useTranslation();
  const projectNext = t('home.launcher.projectNext');
  // Recent work is identified with real project data: the backend returns projects by last_opened.
  const relative = new Intl.RelativeTimeFormat(i18n.language || 'zh-CN', { numeric: 'auto' });
  function lastUsed(stamp: number): string | null {
    // Values before 2001 are not real timestamps; showing "20,000 days ago" would invent precision.
    if (!stamp || stamp < 1_000_000_000) return null;
    const minutes = Math.round((stamp * 1000 - Date.now()) / 60000);
    const abs = Math.abs(minutes);
    if (abs < 60) return relative.format(minutes, 'minute');
    if (abs < 1440) return relative.format(Math.round(minutes / 60), 'hour');
    return relative.format(Math.round(minutes / 1440), 'day');
  }
  const [projects, setProjects] = useState<Project[]>([]);
  const [listLoading, setListLoading] = useState(nativeAvailable);
  const [listFailed, setListFailed] = useState(false);
  const listFailedRef = useRef(false);
  // Counts reload attempts that failed again, so a repeated native message still reads as new.
  const [reloadFailures, setReloadFailures] = useState(0);
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
  const remotePicker = useRemoteFolderPicker();
  const [relink, setRelink] = useState<Record<string, string>>({});
  const [pasteOpen, setPasteOpen] = useState<Record<string, boolean>>({});
  const [modelEdits, setModelEdits] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState('');
  const copiedTimer = useRef(0);
  const launchPending = useRef(false);
  const repairDirectoryInput = useRef<HTMLInputElement>(null);
  const repairToolSelect = useRef<HTMLButtonElement>(null);
  const editToolSelect = useRef<HTMLButtonElement>(null);
  const repairCard = useRef<HTMLElement>(null);
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
    // Repair now lands in the project editor, where tool, directory and model share one context.
    setEditingId(project.id);
    repairCard.current?.scrollIntoView({ block: 'center' });
  }, [repair?.sequence, projects]);
  useLayoutEffect(() => {
    if (!repair?.projectId || editingId !== repair.projectId || focusedRepair.current === repair.sequence) return;
    const project = projects.find((item) => item.id === repair.projectId);
    const target = project?.available ? repairToolSelect.current : repairDirectoryInput.current;
    if (!target || target.disabled) return;
    target.focus();
    focusedRepair.current = repair.sequence;
  }, [editingId, repair?.projectId, repair?.sequence, projects]);
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
    // A manual reload re-enters the loading state so the retry itself stays perceivable.
    const retry = listFailedRef.current;
    setListLoading(true);
    try {
      const result = await native.listProjects();
      if (!Array.isArray(result)) throw new Error(t('home.launcher.invalidData'));
      setProjects(result);
      // A successful reload retires the read failure it was offered for; other errors stay.
      if (listFailedRef.current) {
        listFailedRef.current = false;
        setListFailed(false);
        setReloadFailures(0);
        setError('');
      }
    }
    catch (value) {
      // The read failure keeps its own flag so the page offers a reload next to the message.
      listFailedRef.current = true;
      setListFailed(true);
      // A retry that fails again says so, even when the native message repeats word for word.
      if (retry) setReloadFailures((count) => count + 1);
      setError((current) => current || formatFailure(value, t('home.launcher.listFailed'), projectNext));
    }
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
      const path = await remotePicker.pick(remoteTargetId);
      if (!path) return;
      begin('add');
      try {
        const saved = await ensureRemoteProject(remoteTargetId, path, defaultTool || null, remoteProjects);
        setRemoteProjects((items) => [...items.filter((item) => item.id !== saved.id), saved]);
        showPageFeedback(t('home.launcher.added'));
      } catch (value) { showPageError(value); }
      finally { setBusy(''); }
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

  /** Saves in the editor or launch menu without moving its error outside the active context. */
  async function updateTool(project: Project, toolId: string): Promise<boolean> {
    const inEditor = editingId === project.id;
    begin(project.id);
    try {
      const updated = await native.setProjectTool(project.id, toolId || null);
      setProjects((old) => old.map((item) => item.id === project.id ? updated : item));
      return true;
    } catch (value) { if (inEditor) showDialogError(value); else showPageError(value); return false; }
    finally {
      setBusy('');
      if (inEditor) requestAnimationFrame(() => (repair?.projectId === project.id ? repairToolSelect : editToolSelect).current?.focus());
    }
  }

  /** The launch menu: another tool is saved to the project first, then launched with its own mode. */
  async function launchWith(project: Project, currentToolId: string, toolId: string) {
    if (toolId !== currentToolId && !await updateTool(project, toolId)) return;
    const descriptor = managed.find((tool) => tool.id === toolId);
    await launch(toolId, project.id, preferredLaunchMode(launchSettings, 'project', !!descriptor?.yoloAvailable));
  }

  /** Remote projects keep the chosen tool in memory only, as the card's tool picker does. */
  async function launchRemoteWith(project: RemoteProject, toolId: string) {
    setRemoteProjects((items) => items.map((item) => item.id === project.id ? { ...item, preferredTool: toolId } : item));
    const descriptor = managed.find((tool) => tool.id === toolId);
    await launch(toolId, `remote:${project.id}`, preferredLaunchMode(launchSettings, 'project', !!descriptor?.yoloAvailable));
  }

  function launchMenu(currentToolId: string, choose: (toolId: string) => void) {
    return managed.map((tool) => <button key={tool.id} type="button" role="menuitem" aria-current={tool.id === currentToolId || undefined} onClick={() => choose(tool.id)}>
      <ToolIcon toolId={tool.id} size={16} /><span>{tool.name}</span>{tool.id === currentToolId && <small className={styles.currentTool}>{t('home.launcher.currentTool')}</small>}
    </button>);
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
    if (launchPending.current) return;
    launchPending.current = true;
    begin(projectId ?? 'global');
    const request: LaunchRequest = { toolId, projectId, sessionId: resumeLatest ? null : (resumeId?.trim() || null), mode, directory: null, ...(projectId?.startsWith('remote:') ? { remoteIntent: { kind: 'new' as const } } : {}), ...(resumeLatest ? { resumeLatest: true } : {}) };
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
    finally { launchPending.current = false; setBusy(''); }
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
    <Toolbar className={styles.heading} title={t('home.continue.title')} count={totalProjects || undefined} actions={totalProjects ? <Button size="sm" icon={<Icon name="plus" size={14} />} disabled={!!busy} onClick={() => void chooseDirectory()}>{t('home.launcher.add')}</Button> : undefined} />
    {error && <div className={styles.error} role="alert" aria-busy={listLoading || undefined}><span className={styles.errorText}>{error}</span>{listFailed && reloadFailures > 0 && !listLoading && <span className={styles.errorHint}>{t('home.launcher.reloadFailed')}</span>}{listFailed && <Button size="sm" variant="ghost" className={styles.errorAction} loading={listLoading} disabled={listLoading || !!busy} onClick={() => void refresh()}>{t('home.launcher.reload')}</Button>}</div>}
    {feedback && <div className={styles.feedback} role="status">{feedback}</div>}
    {!managed.length && <p className={styles.note}>{t('home.launcher.enableFirst')}</p>}
    {totalProjects > 0 && <p className={styles.sectionHint}>{t('home.continue.hint')}</p>}
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
      const used = lastUsed(project.lastOpened);
      const profileId = project.selectedProfiles[toolId] ?? project.appliedProfiles[toolId];
      return <Card padding="compact" ref={repair?.projectId === project.id ? repairCard : undefined} tabIndex={marked ? -1 : undefined} data-project-id={project.id} className={`${styles.project}${repair?.projectId === project.id ? ` ${styles.repair}` : ''}${spotlight?.id === project.id ? ` ${styles.spotlight}` : ''}`} key={project.id}>
        <div className={styles.identity}>
          <div className={styles.projectTitle}><ToolIcon toolId={toolId} size={24} /><strong title={project.name}>{project.name}</strong>{projectMode === 'yolo' && descriptor?.yoloAvailable && <Badge tone="warning">YOLO</Badge>}</div>
          <div className={styles.contextLine}><span>{descriptor?.name ?? t('home.launcher.pickTool')}</span>{profileId && <span className={styles.contextProfile} title={profileId}>{t('home.launcher.currentProfile', { id: profileId })}</span>}</div>
          <div className={styles.metaLine}><span className={styles.cardPath} title={project.path ? displayPath(project.path) : ''}>{project.path ? shortPath(project.path) : t('home.launcher.noDirectory')}</span>{used && <span className={styles.lastUsed}>{t('home.continue.lastUsed', { when: used })}</span>}</div>
        </div>
        <div className={styles.controls}>
          <div className={styles.actions}>
            <SplitButton size="sm" icon={<Icon name="play" size={14} />} disabled={!!busy || !project.available || !toolId} title={!project.available ? t('home.launcher.dirUnavailable') : projectMode === 'yolo' ? t('home.tools.launchYolo') : launchSettings?.projectMode === 'yolo' ? t('home.tools.launchYoloFallback') : undefined} menuLabel={t('home.launcher.launchMenu', { name: project.name })} menuDisabled={!!busy || !project.available || !managed.length} menu={launchMenu(toolId, (next) => void launchWith(project, toolId, next))} onClick={() => void launch(toolId, project.id, projectMode)}>{t('home.tools.launch')}</SplitButton>
            {descriptor?.resumeLatestAvailable && <Button size="sm" variant="ghost" disabled={!!busy || !project.available || !toolId} onClick={() => void launch(toolId, project.id, 'normal', undefined, 'page', true)}>{t('home.launcher.resumeLatest')}</Button>}
            <RowMenu label={t('home.launcher.moreActions', { name: project.name })}>
              <button type="button" role="menuitem" onClick={() => setEditingId(project.id)}><Icon name="pencil" size={14} /><span>{t('home.launcher.edit')}</span></button>
              <button type="button" role="menuitem" aria-label={t('home.launcher.openDirAria', { name: project.name })} title={t('home.launcher.openDirTitle')} disabled={!!busy || !project.available} onClick={() => void openProject(project)}><Icon name="folder" size={14} /><span>{t('home.launcher.openDir')}</span></button>
            </RowMenu>
          </div>
        </div>
        {descriptor?.resume?.state === 'available' && descriptor.history?.state === 'unsupported' && <div className={styles.extra}><label>{t('home.launcher.projectSessionLabel')}<input aria-label={t('home.launcher.projectSessionAria', { name: project.name })} value={projectSessions[project.id] ?? ''} placeholder={t('home.launcher.resumeIdPlaceholder')} disabled={!!busy || !project.available} onChange={(event) => setProjectSessions((old) => ({ ...old, [project.id]: event.target.value }))} /></label><Button size="sm" disabled={!!busy || !project.available || !toolId || !(projectSessions[project.id] ?? '').trim()} title={!project.available ? t('home.launcher.dirUnavailable') : descriptor.history.reason} onClick={() => void launch(toolId, project.id, 'normal', projectSessions[project.id], 'page', false)}>{t('home.launcher.resumeById')}</Button><span>{t('home.launcher.projectSessionHint', { reason: descriptor.history.reason })}</span></div>}
        {!toolId && <div className={styles.hint}>{t('home.launcher.toolUnmanaged')}</div>}
        {pendingProfile && <div className={styles.extra} data-tone="pending"><span>{project.reapplyProfiles?.[toolId] ? t('home.launcher.reapplyRelinked') : t('home.launcher.pendingProfile')}</span><Button size="sm" disabled={!!busy || !project.available} onClick={() => void applySelected(project, toolId)}>{t('home.launcher.apply')}</Button></div>}
        <GuideDialog open={editingId === project.id} title={t('home.launcher.editTitle', { name: project.name })} hint={t('home.launcher.editHint')} onClose={() => { setEditingId(null); setDialogError(''); setDialogFeedback(''); }}>
          {dialogError && <div className={styles.error} role="alert">{dialogError}</div>}
          {dialogFeedback && <div className={styles.feedback} role="status">{dialogFeedback}</div>}
          <div className={styles.editSections}>
          <section className={styles.editSection} aria-labelledby={`${project.id}-basics`}>
            <h3 id={`${project.id}-basics`}>{t('home.launcher.sectionBasics')}</h3>
            <div className={styles.editField}><span>{t('home.launcher.toolFor', { name: project.name })}</span><FilterSelect label={t('home.launcher.toolFor', { name: project.name })} value={toolId} options={[{ value: '', label: t('home.launcher.pickTool') }, ...toolOptions(managed)]} placeholder={t('home.launcher.pickTool')} disabled={busy === project.id || !managed.length} searchLabel={t('home.launcher.searchTool')} onChange={(value) => void updateTool(project, value)} triggerRef={repair?.projectId === project.id ? repairToolSelect : editToolSelect} /></div>
            <label className={styles.editField}><span>{t('home.launcher.nameLabel')}</span><span className={styles.editInline}><input aria-label={t('home.launcher.nameAria', { name: project.name })} value={names[project.id] ?? project.name} onChange={event => setNames({ ...names,[project.id]:event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && names[project.id]?.trim() && !busy) { event.preventDefault(); void rename(project); } }} /><Button disabled={!!busy || !names[project.id]?.trim() || names[project.id]?.trim() === project.name} onClick={() => void rename(project)}>{t('home.launcher.saveName')}</Button></span></label>
            {descriptor?.projectModelOverride && <label className={styles.editField}><span>{t('home.launcher.modelLabel')}</span><span className={styles.editInline}><input aria-label={t('home.launcher.modelAria', { name: project.name })} value={modelEdits[modelKey] ?? project.modelOverrides[toolId] ?? ''} placeholder={t('home.launcher.modelPlaceholder')} onChange={(event) => setModelEdits((old) => ({ ...old, [modelKey]: event.target.value }))} /><Button disabled={busy === project.id} onClick={() => void saveModel(project, toolId)}>{t('home.launcher.save')}</Button></span></label>}
          </section>
          <section className={styles.editSection} aria-labelledby={`${project.id}-directory`}>
            <h3 id={`${project.id}-directory`}>{t('home.launcher.sectionDirectory')}</h3>
            {project.path && <div className={styles.projectPath}><Icon name="folder" size={15} /><small>{displayPath(project.path)}</small><span className={styles.pathActions}><Button size="sm" variant="ghost" icon={<Icon name="copy" size={13} />} data-copied={copiedPath === displayPath(project.path) || undefined} onClick={() => void copyPath(project)}>{copiedPath === displayPath(project.path) ? t('home.launcher.copied') : copiedPath === `fail:${displayPath(project.path)}` ? t('home.launcher.copyFailed') : t('home.launcher.copyPath')}</Button><Button size="sm" variant="ghost" icon={<Icon name="arrowUpRight" size={13} />} disabled={!!busy || !project.available} onClick={() => void openProject(project)}>{t('home.launcher.openDir')}</Button></span></div>}
            <div className={styles.editRow} data-tone={project.available ? undefined : 'warning'}><span>{project.available ? t('home.launcher.relink') : t('home.launcher.relinkMoved')}</span><span className={styles.editRowActions}><Button size="sm" disabled={busy === project.id} onClick={() => void chooseDirectory(project)}>{t('home.launcher.chooseDir')}</Button><Button size="sm" aria-expanded={pasteExpanded} onClick={() => setPasteOpen((old) => ({ ...old, [project.id]: !pasteExpanded }))}>{t('home.launcher.pastePath')}</Button></span></div>
            {pasteExpanded && <div className={styles.editInline}><input ref={repair?.projectId === project.id ? repairDirectoryInput : undefined} aria-label={t('home.launcher.newDirAria', { name: project.name })} value={relink[project.id] ?? ''} placeholder={t('home.launcher.newDirPlaceholder')} onChange={(event) => setRelink((old) => ({ ...old, [project.id]: event.target.value }))} /><Button disabled={busy === project.id || !relink[project.id]?.trim()} onClick={() => void relinkProject(project)}>{t('home.launcher.link')}</Button></div>}
          </section>
          {(descriptor?.yoloAvailable || projectMode === 'yolo') && <section className={styles.editSection} aria-labelledby={`${project.id}-once`}>
            <h3 id={`${project.id}-once`}>{t('home.launcher.sectionOnce')}</h3>
            <div className={styles.editRow}><span>{t('home.launcher.onceNote')}</span><span className={styles.editRowActions}>{projectMode === 'yolo' ? <Button size="sm" icon={<Icon name="play" size={13} />} disabled={!!busy || !project.available || !toolId} onClick={() => void launch(toolId, project.id, 'normal', undefined, 'dialog')}>{t('home.launcher.onceNormal')}</Button> : <Button size="sm" icon={<Icon name="play" size={13} />} disabled={!!busy || !project.available || !toolId || !descriptor?.yoloAvailable} title={descriptor?.yoloAvailable ? t('home.tools.launchYolo') : t('home.launcher.yoloUnavailable')} onClick={() => void launch(toolId, project.id, 'yolo', undefined, 'dialog')}>{t('home.launcher.onceYolo')}</Button>}</span></div>
          </section>}
          <section className={styles.dangerZone} aria-labelledby={`${project.id}-danger`}>
            <div><h3 id={`${project.id}-danger`}>{t('home.launcher.removeAction')}</h3><p>{t('home.launcher.removeHint')}</p></div>
            <Button size="sm" className={styles.removeProject} icon={<Icon name="trash" size={13} />} disabled={!!busy} onClick={() => void remove(project)}>{t('home.launcher.removeAction')}</Button>
          </section>
          </div>
        </GuideDialog>
      </Card>;
    })}
    </div>}
    {visibleRemoteProjects.length > 0 && <div className={styles.projectGrid}>
      {visibleRemoteProjects.map((project) => {
        const target = remoteTargets.find((item) => item.id === project.targetId);
        const toolId = managed.some((tool) => tool.id === project.preferredTool) ? project.preferredTool! : defaultTool;
        const descriptor = managed.find((tool) => tool.id === toolId);
        const projectMode = preferredLaunchMode(launchSettings, 'project', !!descriptor?.yoloAvailable);
        return <Card padding="compact" className={`${styles.project} ${styles.remoteProject}`} key={`remote:${project.id}`} data-project-id={`remote:${project.id}`}>
          <div className={styles.identity}>
            <div className={styles.projectTitle}><Icon name="globe" size={22} /><strong title={project.name}>{project.name}</strong><Badge tone="accent">{t('home.remote.badge')}</Badge>{projectMode === 'yolo' && descriptor?.yoloAvailable && <Badge tone="warning">YOLO</Badge>}</div>
            <div className={styles.contextLine}><span>{descriptor?.name ?? t('home.launcher.pickTool')}</span></div>
            <div className={styles.metaLine}><span className={styles.cardPath} title={`${target?.user ?? ''}@${target?.host ?? ''}:${target?.port ?? ''} · ${project.path}`}>{target ? `${target.user}@${target.host}:${target.port} · ${project.path}` : project.path}</span></div>
          </div>
          <div className={styles.controls}>
            <FilterSelect className={styles.toolSelect} label={t('home.launcher.toolFor', { name: project.name })} value={toolId} options={[{ value: '', label: t('home.launcher.pickTool') }, ...toolOptions(managed)]} placeholder={t('home.launcher.pickTool')} disabled={!!busy || !managed.length} searchLabel={t('home.launcher.searchTool')} onChange={(value) => setRemoteProjects((items) => items.map((item) => item.id === project.id ? { ...item, preferredTool: value || null } : item))} />
            <div className={styles.actions}>
              <SplitButton size="sm" icon={<Icon name="play" size={14} />} disabled={!!busy || !toolId} title={projectMode === 'yolo' ? t('home.tools.launchYolo') : undefined} menuLabel={t('home.launcher.launchMenu', { name: project.name })} menuDisabled={!!busy || !managed.length} menu={launchMenu(toolId, (next) => void launchRemoteWith(project, next))} onClick={() => void launch(toolId, `remote:${project.id}`, projectMode)}>{t('home.tools.launch')}</SplitButton>
              <RowMenu label={t('home.launcher.moreActions', { name: project.name })}><button type="button" role="menuitem" data-danger="true" onClick={() => void removeRemote(project)}><Icon name="trash" size={14} /><span>{t('home.remote.remove')}</span></button></RowMenu>
            </div>
          </div>
        </Card>;
      })}
    </div>}
    {/* A failed read keeps its own error band above; only a successful empty read offers the empty state. */}
    </> : projectQuery.trim() ? <p className={styles.noMatch}>{t('home.launcher.noMatch', { query: projectQuery.trim() })}</p>
    : listFailed ? null
    : <div className={styles.emptyProjects}><span className={styles.emptyIcon} aria-hidden="true"><Icon name="folder" size={18} /></span><span className={styles.emptyCopy}><strong>{t('home.launcher.emptyTitle')}</strong><span>{t('home.launcher.emptyDetail')}</span>{!!managed.length && <span className={styles.emptyNext}>{t('home.continue.emptyNext')}</span>}</span><Button size="sm" icon={<Icon name="plus" size={14} />} disabled={!!busy} onClick={() => void chooseDirectory()}>{t('home.launcher.addProject')}</Button></div>}
    {!!managed.length && <details className={styles.quick}><summary><span>{t('home.launcher.resumeTitle')}</span><small>{t('home.launcher.resumeHint')}</small></summary><div className={styles.quickContent}>
      {resumable.length ? <><div><strong>{t('home.launcher.resumeById')}</strong><span>{directMode === 'yolo' ? t('home.launcher.resumeDescYolo') : t('home.launcher.resumeDescNormal')}</span></div>
      <FilterSelect className={styles.quickTool} label={t('home.launcher.resumeTool')} value={resumeTool} options={toolOptions(resumable)} placeholder={t('home.launcher.pickTool')} searchLabel={t('home.launcher.searchTool')} onChange={setGlobalTool} />
      <input aria-label={t('home.launcher.resumeIdLabel')} value={sessionId} placeholder={t('home.launcher.resumeIdPlaceholder')} onChange={(event) => setSessionId(event.target.value)} />
      <div className={styles.actions}><Button variant="primary" disabled={!!busy || !sessionId.trim() || !resumeTool} onClick={() => void launch(resumeTool, null, directMode, sessionId)}>{t('home.launcher.resume')}</Button>{directMode === 'yolo' ? <Button disabled={!!busy || !sessionId.trim() || !resumeTool} onClick={() => void launch(resumeTool, null, 'normal', sessionId)}>{t('home.launcher.resumeNormal')}</Button> : <Button disabled={!!busy || !sessionId.trim() || !resumeTool || !resumeDescriptor?.yoloAvailable} title={resumeDescriptor?.yoloAvailable ? t('home.tools.launchYolo') : t('home.launcher.yoloUnavailable')} onClick={() => void launch(resumeTool, null, 'yolo', sessionId)}>{t('home.launcher.resumeYolo')}</Button>}</div></> : !unindexedResume.length && <p>{t('home.launcher.resumeNone')}</p>}
      {unindexedResume.map((item) => <p key={item.id}>{item.name}：{item.history.reason} {t('home.launcher.resumeOnProject')}</p>)}
      {!resumable.length && managed.filter((item) => item.resume != null && item.resume.state !== 'available').map((item) => <p key={item.id}>{item.name}：{item.resume.reason}</p>)}
    </div></details>}
    {remotePicker.element}
  </section>;
}
