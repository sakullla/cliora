import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import type { LaunchSettings } from '../../types/launch';
import { preferredLaunchMode } from '../../types/launch';
import type { AdapterDescriptor, ApplyComparison, RegisteredToolWorkspace } from '../../types/native';
import type { WorkspaceOpenIntent } from '../tools/ToolWorkspace';
import { ConflictCompare } from '../../components/configuration/ConflictCompare';
import { FilterSelect } from '../../components/FilterSelect';
import type { FilterSelectOption } from '../../components/FilterSelect';
import { GuideDialog } from '../../components/GuideDialog';
import { ToolIcon } from '../../components/ToolIcon';
import { displayPath } from '../../lib/paths';
import i18n from '../../i18n';
import styles from './ManagedTools.module.css';

type Notice = { tone: 'ok' | 'error' | 'pending'; text: string; title: string };
type Activity = 'launch' | 'apply' | null;
type Loaded = { workspace: RegisteredToolWorkspace | null; error: string | null; busy: boolean; activity: Activity; notice: Notice | null };

const rememberedHome = new Map<string, { workspace: RegisteredToolWorkspace; at: number }>();
function rememberHome(toolId: string, workspace: RegisteredToolWorkspace) {
  if (workspace.probe.selectedPath) rememberedHome.set(toolId, { workspace, at: Date.now() });
  else rememberedHome.delete(toolId);
}
const launchDirectories = new Map<string, string>();
let lastLaunchDirectory = '';

function message(value: unknown): string {
  return value && typeof value === 'object' && 'message' in value ? String(value.message) : i18n.t('home.tools.operationFailed');
}

function lineNotice(tone: Notice['tone'], text: string, detail = ''): Notice {
  const extra = detail && detail !== i18n.t('home.tools.operationFailed') ? detail.replace(/\s+/g, ' ').trim() : '';
  const full = extra ? `${text} ${extra}` : text;
  return { tone, text: full, title: full };
}

function settle(previous: Loaded, next: Notice | null): Loaded {
  return { ...previous, busy: false, activity: null, error: null, notice: next };
}

function profileLabel(name: string, connection: { model?: string | null } | null | undefined): string {
  const model = connection?.model?.trim();
  return model ? `${name} · ${model}` : name;
}

type SwitchableProfile = { id: string; name: string; connection: { model?: string | null } | null | undefined };

function StepGlyph({ direction }: { direction: 'left' | 'right' }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={direction === 'left' ? 'm15 6-6 6 6 6' : 'm9 6 6 6-6 6'} /></svg>;
}

function ProfileMenu({ label, profiles, selected, appliedCurrent, disabled, title, onSwitch }: {
  label: string;
  profiles: SwitchableProfile[];
  selected: SwitchableProfile | undefined;
  appliedCurrent: boolean;
  disabled: boolean;
  title?: string;
  onSwitch: (profileId: string) => void;
}) {
  const { t } = useTranslation();
  const options: FilterSelectOption[] = profiles.map((item) => ({ value: item.id, label: item.name, detail: item.connection?.model?.trim() || undefined, note: item.id === selected?.id && !appliedCurrent ? t('home.tools.pendingChanges') : undefined }));
  const selectedIndex = profiles.findIndex((item) => item.id === selected?.id);

  function move(direction: -1 | 1) {
    if (disabled || profiles.length < 2) return;
    const index = selectedIndex < 0 ? 0 : selectedIndex;
    const next = profiles[(index + direction + profiles.length) % profiles.length];
    if (next && (next.id !== selected?.id || !appliedCurrent)) onSwitch(next.id);
  }

  function onTriggerKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); return; }
    if (event.key === 'ArrowRight') { event.preventDefault(); move(1); return; }
  }

  return <div className={styles.switcher}>
    <button type="button" className={styles.step} aria-label={t('home.tools.prevProfile')} disabled={disabled || profiles.length < 2} title={t('home.tools.prevProfileTitle')} onClick={() => move(-1)}><StepGlyph direction="left" /></button>
    <FilterSelect className={styles.switchSelect} label={label} value={selected?.id ?? ''} options={options} placeholder={t('home.tools.pickProfile')} disabled={disabled} title={title} variant="accent" searchLabel={t('home.tools.searchProfile')} searchPlaceholder={t('home.tools.searchProfilePlaceholder')} onChange={(value) => { if (value !== selected?.id || !appliedCurrent) onSwitch(value); }} onTriggerKeyDown={onTriggerKey} />
    <button type="button" className={styles.step} aria-label={t('home.tools.nextProfile')} disabled={disabled || profiles.length < 2} title={t('home.tools.nextProfileTitle')} onClick={() => move(1)}><StepGlyph direction="right" /></button>
  </div>;
}

export function ManagedTools({ tools, onOpenTool }: { tools: AdapterDescriptor[]; onOpenTool: (toolId: string, intent?: WorkspaceOpenIntent) => void }) {
  const { t } = useTranslation();
  const [states, setStates] = useState<Record<string, Loaded>>(() => Object.fromEntries(tools.flatMap((tool) => {
    const cached = rememberedHome.get(tool.id);
    const workspace = cached && Date.now() - cached.at < 60_000 ? cached.workspace : null;
    return workspace ? [[tool.id, { workspace, error: null, busy: false, activity: null, notice: null }]] : [];
  })));
  const [launchSettings, setLaunchSettings] = useState<LaunchSettings | null>(null);
  const [conflict, setConflict] = useState<{ toolId: string; toolName: string; profileName: string; comparison: ApplyComparison } | null>(null);
  const [conflictError, setConflictError] = useState('');
  const generation = useRef(0);
  const requests = useRef(new Map<string, number>());
  const recheck = useRef<(toolId: string) => void>(() => {});
  const [checking, setChecking] = useState(new Set<string>());
  const acting = useRef(new Set<string>());
  const noticeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = noticeTimers.current;
    return () => { timers.forEach((timer) => clearTimeout(timer)); timers.clear(); };
  }, []);

  function clearNoticeLater(toolId: string, notice: Notice) {
    const timers = noticeTimers.current;
    const old = timers.get(toolId);
    if (old) clearTimeout(old);
    if (notice.tone !== 'ok') { timers.delete(toolId); return; }
    timers.set(toolId, setTimeout(() => {
      timers.delete(toolId);
      setStates((old) => {
        const current = old[toolId];
        if (!current || current.notice !== notice) return old;
        return { ...old, [toolId]: { ...current, notice: null } };
      });
    }, 5000));
  }

  useEffect(() => {
    if (!nativeAvailable) return;
    let active = true;
    void native.getLaunchSettings().then((value) => { if (active) setLaunchSettings(value); }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!nativeAvailable) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const clearRetries = () => { timers.forEach(timer => clearTimeout(timer)); timers.clear(); };
    const retry = (toolId: string, current: number, attempt: number, request: number) => {
      if (attempt >= 2 || !active || current !== generation.current) return;
      const timer = setTimeout(() => { timers.delete(timer); if (requests.current.get(toolId) === request) void load(toolId, current, true, attempt + 1); }, 8500);
      timers.add(timer);
    };
    const load = async (toolId: string, current: number, fresh = false, attempt = 0) => {
      if (!active || current !== generation.current || acting.current.has(toolId)) return;
      const request = (requests.current.get(toolId) ?? 0) + 1;
      requests.current.set(toolId, request);
      const valid = () => active && current === generation.current && requests.current.get(toolId) === request && !acting.current.has(toolId);
      setChecking(old => new Set(old).add(toolId));
      try {
        const workspace = await native.getRegisteredToolWorkspace(toolId, 'global', undefined, true, fresh);
        if (!valid()) return;
        rememberHome(toolId, workspace);
        setStates(old => ({ ...old, [toolId]: { workspace, error: null, busy: old[toolId]?.busy ?? false, activity: old[toolId]?.activity ?? null, notice: old[toolId]?.notice ?? null } }));
        if (!workspace.probe.selectedPath && workspace.probe.installations.some(item => item.status === 'probe_failed')) retry(toolId, current, attempt, request);
      } catch (error) {
        if (!valid()) return;
        rememberedHome.delete(toolId);
        setStates(old => ({ ...old, [toolId]: { workspace: null, error: message(error), busy: false, activity: null, notice: null } }));
        retry(toolId, current, attempt, request);
      } finally {
        if (active && requests.current.get(toolId) === request) setChecking(old => { const next = new Set(old); next.delete(toolId); return next; });
      }
    };
    recheck.current = toolId => { void load(toolId, generation.current, true); };
    const refresh = () => {
      clearRetries();
      const current = ++generation.current;
      let next = 0;
      const worker = async () => {
        while (active && current === generation.current && next < tools.length) {
          const tool = tools[next++];
          await load(tool.id, current);
        }
      };
      for (let index = 0; index < Math.min(3, tools.length); index++) void worker();
    };
    refresh();
    void listen('cliora:bindings-changed', refresh).then((stop) => {
      if (active) unsubscribe = stop; else stop();
    }).catch(() => {});
    return () => { active = false; generation.current++; clearRetries(); recheck.current = () => {}; unsubscribe?.(); };
  }, [tools.map((item) => item.id).join('|')]);

  async function launchTool(toolId: string, pickDirectory = false) {
    const previous = states[toolId];
    if (!previous || previous.busy || acting.current.has(toolId)) return;
    acting.current.add(toolId);
    requests.current.set(toolId, (requests.current.get(toolId) ?? 0) + 1);
    setChecking(old => { const next = new Set(old); next.delete(toolId); return next; });
    const toolName = tools.find((item) => item.id === toolId)?.name ?? toolId;
    setStates((old) => ({ ...old, [toolId]: { ...previous, busy: true, activity: 'launch', error: null, notice: null } }));
    try {
      const remembered = launchDirectories.get(toolId);
      let directory = pickDirectory ? undefined : remembered;
      if (!directory) {
        const picked = await open({ directory: true, multiple: false, title: t('home.tools.pickDirectoryTitle'), defaultPath: remembered || lastLaunchDirectory || undefined });
        if (typeof picked !== 'string') {
          setStates((old) => ({ ...old, [toolId]: settle(previous, null) }));
          return;
        }
        directory = picked;
        launchDirectories.set(toolId, picked);
        lastLaunchDirectory = picked;
      }
      await native.launchCli({ toolId, projectId: null, sessionId: null, mode: preferredLaunchMode(launchSettings, 'cli', !!tools.find((item) => item.id === toolId)?.yoloAvailable), directory });
      const notice = lineNotice('ok', tools.find((item) => item.id === toolId)?.launchForm === 'desktop' ? t('home.tools.launchedDesktop', { name: toolName }) : t('home.tools.launchedCli', { name: toolName }));
      setStates((old) => ({ ...old, [toolId]: settle(previous, notice) }));
      clearNoticeLater(toolId, notice);
    } catch (error) {
      setStates((old) => ({ ...old, [toolId]: settle(previous, lineNotice('error', t('home.tools.launchFailed', { name: toolName }), message(error))) }));
    } finally {
      acting.current.delete(toolId);
    }
  }

  async function switchProfile(toolId: string, profileId: string) {
    if (!profileId) return;
    const previous = states[toolId];
    if (!previous?.workspace || previous.busy || acting.current.has(toolId)) return;
    acting.current.add(toolId);
    requests.current.set(toolId, (requests.current.get(toolId) ?? 0) + 1);
    setChecking(old => { const next = new Set(old); next.delete(toolId); return next; });
    const toolName = tools.find((item) => item.id === toolId)?.name ?? toolId;
    setStates((old) => ({ ...old, [toolId]: { ...previous, busy: true, activity: 'apply', error: null, notice: null } }));
    try {
      await native.applyRegisteredNativeProfile(toolId, profileId, 'global', undefined, false);
      const notice = lineNotice('ok', t('home.tools.applied', { name: toolName }));
      setStates((old) => {
        const current = old[toolId];
        if (!current?.workspace) return old;
        const version = current.workspace.profiles.find((item) => item.id === profileId)?.version ?? current.workspace.binding?.profileVersion ?? 0;
        const workspace = { ...current.workspace, binding: { scopeKey: 'global', tool: toolId, profileId, profileVersion: version, managed: {} } };
        rememberHome(toolId, workspace);
        return { ...old, [toolId]: { ...current, busy: false, activity: null, error: null, notice, workspace } };
      });
      clearNoticeLater(toolId, notice);
    } catch (error) {
      const detail = message(error);
      const profile = previous.workspace?.profiles.find((item) => item.id === profileId);
      if (profile && (detail.includes('请确认接管') || detail.includes('外部修改'))) {
        try {
          const comparison = await native.compareRegisteredApplication(profileId, 'global', '');
          setConflict({ toolId, toolName, profileName: profile.name, comparison });
          setConflictError('');
          setStates((old) => ({ ...old, [toolId]: settle(previous, null) }));
          return;
        } catch (compareError) {
          const reason = message(compareError);
          const text = t('home.tools.compareFailed', { name: toolName, reason });
          setStates((old) => ({ ...old, [toolId]: settle(previous, { tone: 'error', text, title: text }) }));
          return;
        }
      }
      const text = t('home.tools.notSwitched', { name: toolName, detail });
      setStates((old) => ({ ...old, [toolId]: settle(previous, { tone: 'error', text, title: text }) }));
    } finally {
      acting.current.delete(toolId);
    }
  }

  async function useComparedFile() {
    if (!conflict) return;
    const { toolId, toolName, comparison } = conflict;
    requests.current.set(toolId, (requests.current.get(toolId) ?? 0) + 1);
    const previous = states[toolId];
    setConflictError('');
    try {
      await native.applyComparedApplication(comparison, 'global', '');
      setConflict(null);
      const notice = lineNotice('ok', t('home.tools.applied', { name: toolName }));
      setStates((old) => {
        const current = old[toolId];
        if (!current?.workspace) return old;
        const version = current.workspace.profiles.find((item) => item.id === comparison.profile.id)?.version ?? comparison.profile.version;
        const workspace = { ...current.workspace, binding: { scopeKey: 'global', tool: toolId, profileId: comparison.profile.id, profileVersion: version, managed: {} } };
        rememberHome(toolId, workspace);
        return { ...old, [toolId]: { ...current, busy: false, activity: null, error: null, notice, workspace } };
      });
      clearNoticeLater(toolId, notice);
    } catch (error) {
      setConflictError(message(error));
      if (previous) setStates((old) => ({ ...old, [toolId]: settle(previous, null) }));
    }
  }

  if (!tools.length) return <div className={styles.empty}>{t('home.tools.empty')}</div>;
  return <div className={styles.list} aria-label={t('home.managed.title')}>
    {tools.map((tool) => {
      const loaded = states[tool.id];
      const workspace = loaded?.workspace;
      const profiles = workspace?.profiles ?? [];
      const selected = profiles.find((item) => item.id === workspace?.binding?.profileId);
      const appliedCurrent = !!selected && workspace?.binding?.profileVersion === selected.version;
      const installed = !!workspace?.probe.selectedPath;
      const probeFailed = workspace?.probe.installations.some(item => item.status === 'probe_failed');
      const writable = workspace?.probe.nativeWrites.state === 'supported';
      const launchMode = preferredLaunchMode(launchSettings, 'cli', !!tool.yoloAvailable);
      const desktop = tool.launchForm === 'desktop';
      const rememberedDir = launchDirectories.get(tool.id);
      const switchTitle = !workspace ? undefined : !writable ? workspace.probe.nativeWrites.reason || t('home.tools.notWritable') : t('home.tools.switchHint');
      const launchTitle = !installed && workspace ? t('home.tools.launchRelaunch')
        : desktop ? [rememberedDir ? t('home.tools.launchOpenDir', { dir: displayPath(rememberedDir) }) : t('home.tools.launchDesktop')].join(t('home.tools.titleSeparator'))
        : [rememberedDir ? t('home.tools.launchInDir', { dir: displayPath(rememberedDir) }) : '', launchMode === 'yolo' ? t('home.tools.launchYolo') : launchSettings?.cliMode === 'yolo' ? t('home.tools.launchYoloFallback') : ''].filter(Boolean).join(t('home.tools.titleSeparator')) || undefined;
      const line = loaded?.error
        ? lineNotice('error', t('home.tools.probeFailedNotice', { name: tool.name }), loaded.error)
        : loaded?.activity === 'apply'
          ? lineNotice('pending', t('home.tools.applying', { name: tool.name }))
          : loaded?.notice ?? null;
      return <div className={styles.row} data-tool-row key={tool.id}>
        <div className={styles.name}><ToolIcon toolId={tool.id} size={34} /><span><strong title={tool.name}>{tool.name}</strong><small className={styles.status} data-state={loaded?.error ? 'error' : !workspace ? 'loading' : installed ? 'ok' : 'warn'}>{checking.has(tool.id) && !installed ? t('home.tools.statusChecking') : loaded?.error ? t('home.tools.statusFailed') : workspace ? installed ? workspace.probe.installations.find((item) => item.path === workspace.probe.selectedPath)?.version ?? t('home.tools.statusInstalled') : probeFailed ? t('home.tools.statusProbeFailed') : t('home.tools.statusNotFound') : t('home.tools.statusChecking')}</small></span></div>
        <div className={styles.switch}>
          {loaded?.error ? null
            : !workspace ? (nativeAvailable ? <><span className="sr-only">{t('home.tools.loadingConfig')}</span><span className={styles.loadingBar} aria-hidden="true" /></> : null)
            : profiles.length > 4 ? <ProfileMenu label={t('home.tools.switchProfileLabel', { name: tool.name })} profiles={profiles} selected={selected} appliedCurrent={appliedCurrent} disabled={!!loaded?.busy || !writable} title={switchTitle} onSwitch={(profileId) => void switchProfile(tool.id, profileId)} />
            : profiles.length ? <div role="radiogroup" aria-label={t('home.tools.switchProfileLabel', { name: tool.name })} title={switchTitle}>{profiles.map((item) => <button key={item.id} type="button" role="radio" aria-checked={item.id === selected?.id} className={item.id === selected?.id ? styles.activeConfig : ''} disabled={loaded?.busy || !writable} title={profileLabel(item.name, item.connection)} onClick={() => { if (item.id !== selected?.id || !appliedCurrent) void switchProfile(tool.id, item.id); }}>{item.name}{item.id === selected?.id && item.connection?.model?.trim() ? <em className={styles.modelHint}>{item.connection.model.trim()}</em> : null}</button>)}</div>
            : <button type="button" className={styles.addConfig} onClick={() => onOpenTool(tool.id, { create: true })}>{t('home.tools.newProfile')}</button>}
        </div>
        <div className={styles.rowActions}>{!installed && (workspace || loaded?.error) && <button type="button" disabled={checking.has(tool.id) || loaded?.busy} onClick={() => recheck.current(tool.id)}>{checking.has(tool.id) ? t('home.tools.statusChecking') : t('home.tools.recheck')}</button>}<button type="button" className={styles.launch} disabled={!installed || loaded?.busy} aria-busy={loaded?.activity === 'launch' || undefined} title={launchTitle} onClick={() => void launchTool(tool.id)} onContextMenu={(event) => { event.preventDefault(); void launchTool(tool.id, true); }}>{loaded?.activity === 'launch' ? t('home.tools.launching') : t('home.tools.launch')}</button><button type="button" className={styles.configure} onClick={() => onOpenTool(tool.id, { resource: 'config' })}>{t('home.tools.editConfig')}</button></div>
        {line && <div className={styles.note} data-tone={line.tone} role={line.tone === 'error' ? 'alert' : 'status'} title={line.title}>{line.text}</div>}
      </div>;
    })}
    <GuideDialog open={!!conflict} title={t('home.conflict.title')} hint={conflict ? t('home.conflict.hint', { tool: conflict.toolName, profile: conflict.profileName }) : undefined} onClose={() => { setConflict(null); setConflictError(''); }}>
      {conflict && <div aria-label={t('home.conflict.label')}>{conflict.comparison.files.map((file, index) => <ConflictCompare key={file.role} title={file.role} banner={index === 0 ? t('home.conflict.banner') : undefined} currentContent={file.current} nextContent={file.proposedText ?? ''} format={file.format} actions={false} onKeepCurrent={() => { setConflict(null); setConflictError(''); }} onUseNext={() => void useComparedFile()} />)}{conflictError && <p role="alert">{conflictError}</p>}<div className="file-conflict-actions"><button type="button" onClick={() => { setConflict(null); setConflictError(''); }}>{t('common.conflict.keepCurrent')}</button><button type="button" onClick={() => void useComparedFile()}>{t('common.conflict.useNext')}</button></div></div>}
    </GuideDialog>
  </div>;
}
