import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import type { LaunchSettings, Project, TrayRepairTarget } from '../../types/launch';
import { preferredLaunchMode } from '../../types/launch';
import type { AdapterDescriptor } from '../../types/native';
import { displayPath, shortPath } from '../../lib/paths';
import { writeClipboard } from '../../lib/clipboard';
import { FilterSelect } from '../../components/FilterSelect';
import { SearchField } from '../../components/SearchField';
import { Icon } from '../../components/Icon';
import { ToolIcon, toolOptions } from '../../components/ToolIcon';
import { GuideDialog } from '../../components/GuideDialog';
import { SkeletonRows } from '../../components/Skeleton';
import { formatFailure } from '../../lib/feedback';
import styles from './ProjectLauncher.module.css';

export function ProjectLauncher({ tools, repair, spotlight }: { tools: AdapterDescriptor[]; repair?: TrayRepairTarget | null; spotlight?: { id: string; token: number } | null }) {
  const { t } = useTranslation();
  const projectNext = t('home.launcher.projectNext');
  const [projects, setProjects] = useState<Project[]>([]);
  const [listLoading, setListLoading] = useState(nativeAvailable);
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

  async function launch(toolId: string, projectId: string | null, mode: 'normal' | 'yolo', resumeId?: string, surface: 'page' | 'dialog' = 'page') {
    begin(projectId ?? 'global');
    const text = (resultMode: string) => t('home.launcher.launched', { action: t(resumeId?.trim() ? 'home.launcher.actionResume' : 'home.launcher.actionLaunch'), mode: resultMode === 'yolo' ? ' YOLO' : '' });
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

  if (!nativeAvailable) return <p className={styles.note}>{t('home.launcher.nativeOnly')}</p>;
  const projectNeedle = projectQuery.trim().toLowerCase();
  const visibleProjects = projectNeedle ? projects.filter((project) => `${project.name} ${project.path ?? ''}`.toLowerCase().includes(projectNeedle)) : projects;
  return <section className={`${styles.workspace} home-launcher`} aria-label={t('home.launcher.label')}>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {feedback && <div className={styles.feedback} role="status">{feedback}</div>}
    {!managed.length && <p className={styles.note}>{t('home.launcher.enableFirst')}</p>}
    <div className={styles.heading}><strong>{t('home.projects.title')}{!!projects.length && <span className="count-chip" aria-hidden="true">{projects.length}</span>}</strong><button type="button" className={styles.secondary} disabled={!!busy} onClick={() => void chooseDirectory()}><Icon name="plus" size={14} strokeWidth={2.2} />{t('home.launcher.add')}</button></div>
    {projects.length > 4 && <SearchField className={styles.projectSearch} label={t('home.launcher.searchLabel')} value={projectQuery} placeholder={t('home.launcher.searchPlaceholder')} onChange={setProjectQuery} />}
    {listLoading && !projects.length ? <SkeletonRows count={2} /> : projects.length ? (visibleProjects.length ? <div className={styles.projectGrid}>
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
        <div className={styles.controls}><FilterSelect className={styles.toolSelect} label={t('home.launcher.toolFor', { name: project.name })} value={toolId} options={[{ value: '', label: t('home.launcher.pickTool') }, ...toolOptions(managed)]} placeholder={t('home.launcher.pickTool')} disabled={busy === project.id || !managed.length} searchLabel={t('home.launcher.searchTool')} onChange={(value) => void updateTool(project, value)} triggerRef={repair?.projectId === project.id ? repairToolSelect : undefined} /><div className={styles.actions}><button type="button" disabled={!!busy || !project.available || !toolId} title={!project.available ? t('home.launcher.dirUnavailable') : projectMode === 'yolo' ? t('home.tools.launchYolo') : launchSettings?.projectMode === 'yolo' ? t('home.tools.launchYoloFallback') : undefined} onClick={() => void launch(toolId, project.id, projectMode)}>{t('home.tools.launch')}</button><button type="button" className={styles.iconAction} aria-label={t('home.launcher.openDirAria', { name: project.name })} title={t('home.launcher.openDirTitle')} disabled={!!busy || !project.available} onClick={() => void openProject(project)}><Icon name="folder" size={15} /></button><button type="button" className={styles.secondary} onClick={() => setEditingId(project.id)}>{t('home.launcher.edit')}</button></div></div>
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
          <div className={styles.extra}><span>{t('home.launcher.onceNote')}</span>{projectMode === 'yolo' ? <button type="button" className={styles.secondary} disabled={!!busy || !project.available || !toolId} onClick={() => void launch(toolId, project.id, 'normal', undefined, 'dialog')}>{t('home.launcher.onceNormal')}</button> : <button type="button" className={styles.secondary} disabled={!!busy || !project.available || !toolId || !descriptor?.yoloAvailable} title={descriptor?.yoloAvailable ? t('home.tools.launchYolo') : t('home.launcher.yoloUnavailable')} onClick={() => void launch(toolId, project.id, 'yolo', undefined, 'dialog')}>{t('home.launcher.onceYolo')}</button>}</div>
        </GuideDialog>
      </div>;
    })}
    </div> : <p className={styles.noMatch}>{t('home.launcher.noMatch', { query: projectQuery.trim() })}</p>) : <div className={styles.emptyProjects}><strong>{t('home.launcher.emptyTitle')}</strong><span>{t('home.launcher.emptyDetail')}</span><button type="button" disabled={!!busy} onClick={() => void chooseDirectory()}>{t('home.launcher.addProject')}</button></div>}
    {!!managed.length && <details className={styles.quick}><summary><span>{t('home.launcher.resumeTitle')}</span><small>{t('home.launcher.resumeHint')}</small></summary><div className={styles.quickContent}>
      <div><strong>{t('home.launcher.resumeById')}</strong><span>{directMode === 'yolo' ? t('home.launcher.resumeDescYolo') : t('home.launcher.resumeDescNormal')}</span></div>
      <FilterSelect className={styles.quickTool} label={t('home.launcher.resumeTool')} value={defaultTool} options={toolOptions(managed)} placeholder={t('home.launcher.pickTool')} searchLabel={t('home.launcher.searchTool')} onChange={setGlobalTool} />
      <input aria-label={t('home.launcher.resumeIdLabel')} value={sessionId} placeholder={t('home.launcher.resumeIdPlaceholder')} onChange={(event) => setSessionId(event.target.value)} />
      <div className={styles.actions}><button type="button" disabled={!!busy || !sessionId.trim()} onClick={() => void launch(defaultTool, null, directMode, sessionId)}>{t('home.launcher.resume')}</button>{directMode === 'yolo' ? <button type="button" className={styles.secondary} disabled={!!busy || !sessionId.trim()} onClick={() => void launch(defaultTool, null, 'normal', sessionId)}>{t('home.launcher.resumeNormal')}</button> : <button type="button" className={styles.secondary} disabled={!!busy || !sessionId.trim() || !directTool?.yoloAvailable} title={directTool?.yoloAvailable ? t('home.tools.launchYolo') : t('home.launcher.yoloUnavailable')} onClick={() => void launch(defaultTool, null, 'yolo', sessionId)}>{t('home.launcher.resumeYolo')}</button>}</div>
    </div></details>}
  </section>;
}
