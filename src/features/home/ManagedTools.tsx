import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import type { LaunchSettings } from '../../types/launch';
import { preferredLaunchMode } from '../../types/launch';
import type { AdapterDescriptor, ApplyComparison, RegisteredToolWorkspace, ToolProbe } from '../../types/native';
import type { RemoteCliProbe } from '../../types/remote';
import type { WorkspaceOpenIntent } from '../tools/ToolWorkspace';
import { RowMenu } from '../../components/RowMenu';
import { ConflictCompare } from '../../components/configuration/ConflictCompare';
import { FilterSelect } from '../../components/FilterSelect';
import type { FilterSelectOption } from '../../components/FilterSelect';
import { GuideDialog } from '../../components/GuideDialog';
import { Icon } from '../../components/Icon';
import { ToolIcon } from '../../components/ToolIcon';
import { Button, StatusBadge } from '../../components/ui';
import { displayPath } from '../../lib/paths';
import { launchFailureDetail } from '../../lib/feedback';
import { failedInWorkbench, workbenchSessionId, type WorkbenchFailure } from '../sessions/SessionWorkbench';
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

// Home shows the tools in daily use first: recently launched ones and those with saved profiles.
// The rest fold behind one toggle so a long managed list does not push projects off screen.
const recentToolsKey = 'cliora:home-recent-tools';
const configuredToolsKey = 'cliora:home-configured-tools';
const otherToolsExpandedKey = 'cliora:home-tools-expanded';
// Starred tools are pinned above the rest and never fold away.
const favoriteToolsKey = 'cliora:home-favorite-tools';
const commonToolLimit = 6;
function readIds(key: string): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]'); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; } catch { return []; }
}
function writeIds(key: string, ids: string[]) {
  try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* The fold still works for this session. */ }
}
let lastLaunchDirectory = '';

function message(value: unknown): string {
  const routed = launchFailureDetail(value);
  if (routed) return routed;
  return value && typeof value === 'object' && 'message' in value ? String(value.message) : i18n.t('home.tools.operationFailed');
}

function errorCode(value: unknown): string {
  return value && typeof value === 'object' && typeof (value as { code?: unknown }).code === 'string'
    ? (value as { code: string }).code
    : '';
}

function lineNotice(tone: Notice['tone'], text: string, detail = ''): Notice {
  const extra = detail && detail !== i18n.t('home.tools.operationFailed') ? detail.replace(/\s+/g, ' ').trim() : '';
  const full = extra ? `${text} ${extra}` : text;
  return { tone, text: full, title: full };
}

function settle(previous: Loaded, next: Notice | null): Loaded {
  return { ...previous, busy: false, activity: null, error: null, notice: next };
}

function remoteWorkspace(tool: AdapterDescriptor, probe: RemoteCliProbe): RegisteredToolWorkspace {
  const toolProbe: ToolProbe = {
    latestVersionSupported: true,
    tool: tool.id as ToolProbe['tool'],
    installations: probe.installed ? [{ path: probe.executable, version: probe.version ?? null, source: 'native', status: 'available', detail: null }] : [],
    selectedPath: probe.installed ? probe.executable : null,
    nativeFiles: [],
    nativeWrites: { state: 'unsupported', reason: '远程配置写入由对应 CLI 适配器提供。', evidence: 'ssh' },
    interfaceFormats: tool.interfaceFormats,
    installUrl: '', upgradeHint: '', installCommand: probe.installed ? null : 'remote', upgradeCommand: probe.installed ? 'remote' : null,
    majorUpgrade: null, nativeInstallCommand: null, npmInstallCommand: null, providerPresets: [],
    connectionPolicy: { apiKey: { state: 'writable', reason: '' }, providerAddress: { state: 'configurable', reason: '' }, projection: 'single_connection' },
    dependencies: [],
  };
  return { probe: toolProbe, customPath: null, profiles: [], profileModelSummaries: {}, common: null, binding: null, effectiveContextId: null, nativeContextError: null, snapshots: [], recoveryNeeded: [] };
}

function profileLabel(name: string, connection: { model?: string | null } | null | undefined): string {
  const model = connection?.model?.trim();
  return model ? `${name} · ${model}` : name;
}

type SwitchableProfile = { id: string; name: string; connection: { model?: string | null } | null | undefined };


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

  // One line like the chip group: the model stays in the tooltip and the open list.
  const hover = [selected ? profileLabel(selected.name, selected.connection) : '', title].filter(Boolean).join(t('home.tools.titleSeparator'));
  return <div className={styles.switcher}>
    <FilterSelect className={styles.switchSelect} label={label} value={selected?.id ?? ''} options={options} placeholder={t('home.tools.pickProfile')} disabled={disabled} title={hover || undefined} variant="accent" triggerDetail={false} searchLabel={t('home.tools.searchProfile')} searchPlaceholder={t('home.tools.searchProfilePlaceholder')} onChange={(value) => { if (value !== selected?.id || !appliedCurrent) onSwitch(value); }} onTriggerKeyDown={onTriggerKey} />
  </div>;
}

export function ManagedTools({ tools, remoteTargetId = 'local', onOpenTool, onWorkbenchSession, onWorkbenchFailure }: { tools: AdapterDescriptor[]; remoteTargetId?: string; onOpenTool: (toolId: string, intent?: WorkspaceOpenIntent) => void; onWorkbenchSession?: (sessionId: string) => void; onWorkbenchFailure?: (failure: WorkbenchFailure) => void }) {
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
  const [remoteStates, setRemoteStates] = useState<Record<string, RemoteCliProbe | null>>({});
  const [remoteChecking, setRemoteChecking] = useState(new Set<string>());
  const [remoteProbeRetry, setRemoteProbeRetry] = useState(0);
  const acting = useRef(new Set<string>());
  const [recent, setRecent] = useState(() => readIds(recentToolsKey));
  const [configured, setConfigured] = useState(() => readIds(configuredToolsKey));
  const [favorites, setFavorites] = useState(() => readIds(favoriteToolsKey));
  const [othersOpen, setOthersOpen] = useState(() => { try { return localStorage.getItem(otherToolsExpandedKey) === 'true'; } catch { return false; } });
  const toolKey = tools.map((item) => item.id).join('|');

  // Remember which tools have saved profiles so the fold is stable on the next start, before
  // every workspace has been read again.
  useEffect(() => {
    if (remoteTargetId !== 'local') return;
    setConfigured((old) => {
      const next = new Set(old);
      for (const tool of tools) {
        const workspace = states[tool.id]?.workspace;
        if (!workspace) continue;
        if (workspace.profiles.length) next.add(tool.id); else next.delete(tool.id);
      }
      const list = [...next];
      if (list.length === old.length && list.every((id, index) => id === old[index])) return old;
      writeIds(configuredToolsKey, list);
      return list;
    });
  }, [states, remoteTargetId, toolKey]);

  function markRecent(toolId: string) {
    setRecent((old) => {
      const next = [toolId, ...old.filter((id) => id !== toolId)].slice(0, 12);
      writeIds(recentToolsKey, next);
      return next;
    });
  }

  function toggleFavorite(toolId: string) {
    setFavorites((old) => {
      const next = old.includes(toolId) ? old.filter((id) => id !== toolId) : [...old, toolId];
      writeIds(favoriteToolsKey, next);
      return next;
    });
  }

  function toggleOthers() {
    setOthersOpen((old) => {
      try { localStorage.setItem(otherToolsExpandedKey, String(!old)); } catch { /* Folding works without storage. */ }
      return !old;
    });
  }
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
    if (!nativeAvailable || remoteTargetId !== 'local') return;
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
  }, [remoteTargetId, tools.map((item) => item.id).join('|')]);

  useEffect(() => {
    if (!nativeAvailable || remoteTargetId === 'local') {
      setRemoteStates({});
      setRemoteChecking(new Set());
      return;
    }
    let active = true;
    const ids = tools.map((item) => item.id);
    setRemoteStates({});
    setRemoteChecking(new Set(ids));
    setStates(Object.fromEntries(ids.map((toolId) => [toolId, { workspace: null, error: null, busy: false, activity: null, notice: null }])));
    // Probe the complete list through one SSH command. This avoids a burst of
    // handshakes on high-latency hosts and makes the result atomic for the UI.
    void native.probeRemoteClis(remoteTargetId, ids).then((results) => {
      if (!active) return;
      setRemoteStates(Object.fromEntries(results.map((result) => [result.toolId, result])));
      setStates((current) => {
        const next = { ...current };
        for (const result of results) next[result.toolId] = { workspace: remoteWorkspace(tools.find((item) => item.id === result.toolId) ?? tools[0], result), error: result.detail ?? null, busy: current[result.toolId]?.busy ?? false, activity: current[result.toolId]?.activity ?? null, notice: current[result.toolId]?.notice ?? null };
        return next;
      });
      setRemoteChecking(new Set());
    }).catch((error) => {
      if (!active) return;
      setRemoteStates(Object.fromEntries(ids.map((toolId) => [toolId, { targetId: remoteTargetId, toolId, executable: toolId, installed: false, version: null, detail: message(error) }])));
      setStates(Object.fromEntries(ids.map((toolId) => [toolId, { workspace: null, error: message(error), busy: false, activity: null, notice: null }])));
      setRemoteChecking(new Set());
    });
    return () => { active = false; };
  }, [remoteTargetId, remoteProbeRetry, tools.map((item) => item.id).join('|')]);

  async function launchTool(toolId: string, pickDirectory = false) {
    const previous = states[toolId];
    if (!previous || previous.busy || acting.current.has(toolId)) return;
    acting.current.add(toolId);
    requests.current.set(toolId, (requests.current.get(toolId) ?? 0) + 1);
    setChecking(old => { const next = new Set(old); next.delete(toolId); return next; });
    const tool = tools.find((item) => item.id === toolId);
    const toolName = tool?.name ?? toolId;
    const desktop = tool?.launchForm === 'desktop';
    let directory: string | null = null;
    setStates((old) => ({ ...old, [toolId]: { ...previous, busy: true, activity: 'launch', error: null, notice: null } }));
    try {
      if (!desktop) {
        const remembered = launchDirectories.get(toolId);
        directory = pickDirectory ? null : remembered ?? null;
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
      }
      const request = { toolId, projectId: null, sessionId: null, mode: preferredLaunchMode(launchSettings, 'cli', !!tool?.yoloAvailable), directory };
      const result = await native.launchCli(request);
      markRecent(toolId);
      const opened = workbenchSessionId(result);
      if (opened) { onWorkbenchSession?.(opened); setStates((old) => ({ ...old, [toolId]: settle(previous, null) })); return; }
      const notice = lineNotice('ok', desktop ? t('home.tools.launchedDesktop', { name: toolName }) : t('home.tools.launchedCli', { name: toolName }));
      setStates((old) => ({ ...old, [toolId]: settle(previous, notice) }));
      clearNoticeLater(toolId, notice);
    } catch (error) {
      if (await failedInWorkbench(desktop)) {
        onWorkbenchFailure?.({ detail: `${t('home.tools.launchFailed', { name: toolName })} ${message(error)}`, retry: { kind: 'launch', request: { toolId, projectId: null, sessionId: null, mode: preferredLaunchMode(launchSettings, 'cli', !!tool?.yoloAvailable), directory: directory ?? null } } });
        setStates((old) => ({ ...old, [toolId]: settle(previous, null) }));
        return;
      }
      setStates((old) => ({ ...old, [toolId]: settle(previous, lineNotice('error', t('home.tools.launchFailed', { name: toolName }), message(error))) }));
    } finally {
      acting.current.delete(toolId);
    }
  }

  function clearRememberedDir(toolId: string) {
    launchDirectories.delete(toolId);
    setStates((old) => {
      const current = old[toolId];
      return current ? { ...old, [toolId]: { ...current } } : old;
    });
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
      // Takeover errors are recognized by their stable code first; the text checks stay
      // as the fallback for payloads without a code.
      if (profile && (errorCode(error) === 'native_takeover_required' || detail.includes('请确认接管') || detail.includes('外部修改'))) {
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
  const present = new Set(tools.map((item) => item.id));
  // Starred tools lead in the order they were starred; the daily-use list fills in after them.
  const pinned = favorites.flatMap((id) => tools.filter((item) => item.id === id));
  const unpinned = tools.filter((item) => !pinned.includes(item));
  const ranked = [...new Set([...recent, ...configured])].filter((id) => present.has(id) && !favorites.includes(id)).slice(0, commonToolLimit);
  const daily = tools.length <= commonToolLimit ? unpinned
    : ranked.length ? unpinned.filter((item) => ranked.includes(item.id))
    : pinned.length ? []
    : unpinned.slice(0, commonToolLimit);
  const common = [...pinned, ...daily];
  const others = unpinned.filter((item) => !daily.includes(item));
  const shown = othersOpen ? [...common, ...others] : common;
  return <div className={styles.list} aria-label={t('home.managed.title')}>
    {shown.map((tool) => {
      const loaded = states[tool.id];
      const isRemote = remoteTargetId !== 'local';
      const remote = remoteStates[tool.id];
      const workspace = loaded?.workspace;
      const profiles = workspace?.profiles ?? [];
      const selected = profiles.find((item) => item.id === workspace?.binding?.profileId);
      const appliedCurrent = !!selected && workspace?.binding?.profileVersion === selected.version;
      const installed = isRemote ? remote?.installed === true : !!workspace?.probe.selectedPath;
      const probeFailed = isRemote ? remote !== undefined && remote?.installed === false : workspace?.probe.installations.some(item => item.status === 'probe_failed');
      const writable = workspace?.probe.nativeWrites.state === 'supported';
      const launchMode = preferredLaunchMode(launchSettings, 'cli', !!tool.yoloAvailable);
      const desktop = tool.launchForm === 'desktop';
      const rememberedDir = launchDirectories.get(tool.id);
      const switchTitle = !workspace ? undefined : !writable ? workspace.probe.nativeWrites.reason || t('home.tools.notWritable') : t('home.tools.switchHint');
      const launchTitle = !installed && workspace ? t('home.tools.launchRelaunch')
        : desktop ? t('home.tools.launchDesktop')
        : [rememberedDir ? t('home.tools.launchInDir', { dir: displayPath(rememberedDir) }) : '', launchMode === 'yolo' ? t('home.tools.launchYolo') : launchSettings?.cliMode === 'yolo' ? t('home.tools.launchYoloFallback') : ''].filter(Boolean).join(t('home.tools.titleSeparator')) || undefined;
      const line = isRemote && remote?.detail
        ? lineNotice('error', t('home.tools.probeFailedNotice', { name: tool.name }), remote.detail)
        : loaded?.error
        ? lineNotice('error', t('home.tools.probeFailedNotice', { name: tool.name }), loaded.error)
        : loaded?.activity === 'apply'
          ? lineNotice('pending', t('home.tools.applying', { name: tool.name }))
          : loaded?.notice ?? null;
      const statusState: 'ok' | 'warn' | 'error' | 'loading' | 'missing' = isRemote
        ? remoteChecking.has(tool.id) ? 'loading' : installed ? 'ok' : remote?.detail ? 'error' : remote ? 'missing' : 'loading'
        : checking.has(tool.id) && !installed ? 'loading' : loaded?.error ? 'error' : !workspace ? 'loading' : installed ? 'ok' : probeFailed ? 'warn' : 'missing';
      const version = statusState !== 'ok' ? null : isRemote ? remote?.version || null : workspace?.probe.installations.find((item) => item.path === workspace.probe.selectedPath)?.version ?? null;
      const status = version
        ? <span className={styles.version} data-status="managedTool.ok" title={t('home.tools.versionTitle', { version })}>{version}</span>
        : <StatusBadge className={styles.status} dot domain="managedTool" state={statusState} />;
      // Install guidance and the edit entry after a failure are recovery paths, so they stay on the row;
      // for a healthy tool the edit entry sits in the row menu.
      const recovery = (workspace && !installed) || !!loaded?.error || line?.tone === 'error';
      const configureLabel = workspace && !installed ? t('home.tools.goInstall') : t('home.tools.editConfig');
      const openConfig = () => onOpenTool(tool.id, { resource: 'config' });
      const chooseDir = () => isRemote ? window.dispatchEvent(new CustomEvent('cliora:open-remote-session-request', { detail: { toolId: tool.id, targetId: remoteTargetId, quickLaunch: true, chooseDirectory: true } })) : void launchTool(tool.id, true);
      const menuItems = [
        !desktop && <button key="dir" type="button" role="menuitem" disabled={!installed || !!loaded?.busy} onClick={chooseDir}>{t('home.tools.chooseOtherDir')}</button>,
        !desktop && rememberedDir && !isRemote && <button key="clear" type="button" role="menuitem" onClick={() => clearRememberedDir(tool.id)}>{t('home.tools.clearRememberedDir')}</button>,
        installed && workspace && !loaded?.error && profiles.length === 0 && <button key="new" type="button" role="menuitem" onClick={() => onOpenTool(tool.id, { create: true })}>{t('home.tools.newProfile')}</button>,
        !recovery && <button key="config" type="button" role="menuitem" onClick={openConfig}>{t('home.tools.editConfigItem')}</button>,
      ].filter(Boolean);
      return <div className={styles.row} data-tool-row key={tool.id}>
        <div className={styles.name}><ToolIcon toolId={tool.id} size={24} /><strong title={tool.name}>{tool.name}</strong>{status}</div>
        <div className={styles.switch}>
          {loaded?.error ? null
            : !workspace ? (nativeAvailable ? <><span className="sr-only">{t('home.tools.loadingConfig')}</span><span className={styles.loadingBar} aria-hidden="true" /></> : null)
            : profiles.length > 4 ? <ProfileMenu label={t('home.tools.switchProfileLabel', { name: tool.name })} profiles={profiles} selected={selected} appliedCurrent={appliedCurrent} disabled={!!loaded?.busy || !writable} title={switchTitle} onSwitch={(profileId) => void switchProfile(tool.id, profileId)} />
            : profiles.length ? <div role="radiogroup" aria-label={t('home.tools.switchProfileLabel', { name: tool.name })} title={switchTitle}>{profiles.map((item) => <button key={item.id} type="button" role="radio" aria-checked={item.id === selected?.id} className={item.id === selected?.id ? styles.activeConfig : ''} disabled={loaded?.busy || !writable} title={profileLabel(item.name, item.connection)} onClick={() => { if (item.id !== selected?.id || !appliedCurrent) void switchProfile(tool.id, item.id); }}>{item.name}</button>)}</div>
            : <span className={styles.unset}>{t('home.tools.unconfigured')}</span>}
        </div>
        <div className={styles.rowActions}>
          <button type="button" className={styles.favorite} aria-pressed={favorites.includes(tool.id)} aria-label={t('home.tools.favorite', { name: tool.name })} title={favorites.includes(tool.id) ? t('home.tools.unfavoriteTitle') : t('home.tools.favoriteTitle')} onClick={() => toggleFavorite(tool.id)}><Icon name="star" size={14} /></button>
          {isRemote && remote?.detail ? <Button size="sm" className={styles.recheck} icon={<Icon name="refresh" size={14} />} disabled={remoteChecking.has(tool.id)} onClick={() => setRemoteProbeRetry((value) => value + 1)}>{remoteChecking.has(tool.id) ? t('home.tools.statusChecking') : t('home.tools.recheck')}</Button>
            : !installed && (workspace || loaded?.error) ? <Button size="sm" className={styles.recheck} icon={<Icon name="refresh" size={14} />} disabled={checking.has(tool.id) || remoteChecking.has(tool.id) || loaded?.busy} onClick={() => isRemote ? setRemoteProbeRetry((value) => value + 1) : recheck.current(tool.id)}>{checking.has(tool.id) || remoteChecking.has(tool.id) ? t('home.tools.statusChecking') : t('home.tools.recheck')}</Button>
            : <Button size="sm" className={styles.launch} icon={<Icon name="play" size={14} />} disabled={!installed || loaded?.busy} loading={loaded?.activity === 'launch'} title={launchTitle} onClick={() => isRemote ? window.dispatchEvent(new CustomEvent('cliora:open-remote-session-request', { detail: { toolId: tool.id, targetId: remoteTargetId, quickLaunch: true, chooseDirectory: false } })) : void launchTool(tool.id)} onContextMenu={(event) => { event.preventDefault(); if (!installed || loaded?.busy) return; if (isRemote) { window.dispatchEvent(new CustomEvent('cliora:open-remote-session-request', { detail: { toolId: tool.id, targetId: remoteTargetId, quickLaunch: true, chooseDirectory: true } })); return; } void launchTool(tool.id, true); }}>{loaded?.activity === 'launch' ? t('home.tools.launching') : t('home.tools.launch')}</Button>}
          {recovery && <Button size="sm" variant="ghost" className={styles.configure} onClick={openConfig}>{configureLabel}</Button>}
          {menuItems.length > 0 && <div className={styles.menu}><RowMenu label={t('home.tools.rowMenu', { name: tool.name })}>{menuItems}</RowMenu></div>}
        </div>
        {line && <div className={styles.note} data-tone={line.tone} role={line.tone === 'error' ? 'alert' : 'status'} title={line.title}>{line.text}</div>}
      </div>;
    })}
    {others.length > 0 && <div className={styles.more}><button type="button" aria-expanded={othersOpen} onClick={toggleOthers}><Icon name={othersOpen ? 'arrowUp' : 'more'} size={14} />{othersOpen ? t('home.tools.otherToolsLess') : t('home.tools.otherTools', { count: others.length })}</button></div>}
    <GuideDialog open={!!conflict} title={t('home.conflict.title')} hint={conflict ? t('home.conflict.hint', { tool: conflict.toolName, profile: conflict.profileName }) : undefined} onClose={() => { setConflict(null); setConflictError(''); }}>
      {conflict && <div aria-label={t('home.conflict.label')}>{conflict.comparison.files.map((file, index) => <ConflictCompare key={file.role} title={file.role} banner={index === 0 ? t('home.conflict.banner') : undefined} currentContent={file.current} nextContent={file.proposedText ?? ''} format={file.format} actions={false} onKeepCurrent={() => { setConflict(null); setConflictError(''); }} onUseNext={() => void useComparedFile()} />)}{conflictError && <p role="alert">{conflictError}</p>}<div className="file-conflict-actions"><Button onClick={() => { setConflict(null); setConflictError(''); }}>{t('common.conflict.keepCurrent')}</Button><Button variant="primary" onClick={() => void useComparedFile()}>{t('common.conflict.useNext')}</Button></div></div>}
    </GuideDialog>
  </div>;
}
