import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import { configurationApplicationState } from '../../lib/configurationDraft';
import { confirmAction } from '../../lib/confirm';
import { useFillHeight } from '../../lib/fillHeight';
import { searchShortcutHint } from '../../lib/shortcut';
import type { AdapterDescriptor, RegisteredProfile, RegisteredToolWorkspace, RegisteredToolContext, Scope, ApplyComparison, MaintenanceProgress, ToolProbe } from '../../types/native';
import type { ConfigurationDraft, ConfigurationSaveResult, ConfigurationSubject } from '../../types/configuration';
import type { AccountImpactScope } from '../../types/accounts';
import type { Project, TrayRepairTarget } from '../../types/launch';
import type { RemoteCliProbe, RemoteToolStore } from '../../types/remote';
import { preferredLaunchMode } from '../../types/launch';
import { failedInWorkbench, workbenchSessionId, type WorkbenchFailure } from '../sessions/workbenchLaunch';
import type { UsageQuery } from '../../types/usage';
import { AccountsPanel, useAccounts } from './AccountsPanel';
import { ProfileQuota, QuotaEditor, useUsageQuota } from './UsageQuota';
import { InstallPanel } from './InstallPanel';
import { MaintenanceDialog, type MaintenanceAction, type MaintenanceState } from './MaintenanceDialog';
const ConfigurationWorkspaceEditor = lazy(() => import('./configuration/ConfigurationWorkspaceEditor').then(module => ({ default: module.ConfigurationWorkspaceEditor })));
const SkillsWorkspace = lazy(() => import('./ResourceWorkspace').then(module => ({ default: module.SkillsWorkspace })));
const MemoryWorkspace = lazy(() => import('../memory/MemoryWorkspace').then(module => ({ default: module.MemoryWorkspace })));
const McpWorkspace = lazy(() => import('./McpWorkspace').then(module => ({ default: module.McpWorkspace })));
const PluginsWorkspace = lazy(() => import('./PluginsWorkspace').then(module => ({ default: module.PluginsWorkspace })));
const AgentsWorkspace = lazy(() => import('./AgentsWorkspace').then(module => ({ default: module.AgentsWorkspace })));
import { ToolIcon } from '../../components/ToolIcon';
import { PageSkeleton } from '../../components/Skeleton';
import { Icon } from '../../components/Icon';
import { StatusBanner } from '../../components/StatusBanner';
import { ToastScope } from '../../components/Toast';
import { useToasts } from '../../lib/toast';
import { FilterSelect } from '../../components/FilterSelect';
import { SearchField } from '../../components/SearchField';
import { GuideDialog } from '../../components/GuideDialog';
import { RowMenu } from '../../components/RowMenu';
import { ConflictCompare } from '../../components/configuration/ConflictCompare';
import { shortPath } from '../../lib/paths';
import { navigateChoices } from '../../lib/choiceNavigation';
import { Badge, Button, StatusBadge, Toolbar } from '../../components/ui';
import i18n from '../../i18n';
import styles from './ToolWorkspace.module.css';

const errorText = (value: unknown) => value && typeof value === 'object' && 'message' in value ? String(value.message) : i18n.t('tools.workspace.operationFailed');
function host(address?: string) { try { return address ? new URL(address).host : ''; } catch { return i18n.t('tools.workspace.hostUnknown'); } }
function cleanRemoteVersion(value?: string | null) {
  const text = value?.trim() ?? '';
  return text.match(/\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? text;
}

type ResourceView = 'config' | 'accounts' | 'mcp' | 'skills' | 'plugins' | 'agents' | 'memory';
type EditFrame = { key: string; subject: ConfigurationSubject; profile: RegisteredProfile | null; title: string };
export type WorkspaceOpenIntent = { resource?: ResourceView; create?: boolean };

const resourceViews: ResourceView[] = ['config', 'accounts', 'mcp', 'skills', 'agents', 'plugins', 'memory'];
const contextStoreKey = 'cliora:workspace-context';
// Presentation-only snapshots. Always re-read bindings and native files;
// editor opens and mutations still obtain their own current baselines.
const workspaceSnapshots = new Map<string, RegisteredToolWorkspace>();
function rememberWorkspace(key: string, value: RegisteredToolWorkspace) {
  workspaceSnapshots.delete(key);
  workspaceSnapshots.set(key, value);
  if (workspaceSnapshots.size > 24) workspaceSnapshots.delete(workspaceSnapshots.keys().next().value!);
}
type StoredContext = { resource?: ResourceView; scope?: Scope; projectPath?: string };
function readStoredContexts(): Record<string, StoredContext> {
  try { return JSON.parse(localStorage.getItem(contextStoreKey) ?? '{}') as Record<string, StoredContext>; } catch { return {}; }
}

export function ToolWorkspacePage({ managedTools, remoteTargetId = 'local', initialTool, openSequence = 0, openIntent = null, active = true, repair, onDirtyChange, discardSignal = 0, onWorkbenchSession, onWorkbenchFailure, onOpenMcpLibrary, onToolChange, onPickTool }: { active?: boolean; managedTools: AdapterDescriptor[]; remoteTargetId?: string; initialTool?: string; openSequence?: number; openIntent?: WorkspaceOpenIntent | null; repair?: TrayRepairTarget | null; onDirtyChange?: (dirty: boolean) => void; discardSignal?: number; onWorkbenchSession?: (sessionId: string) => void; onWorkbenchFailure?: (failure: WorkbenchFailure) => void; onOpenMcpLibrary?: (definitionId: string) => void; onToolChange?: (toolId: string) => void; onPickTool?: (toolId: string) => void }) {
  const { t } = useTranslation();
  const [tool, setTool] = useState(repair?.toolId ?? initialTool ?? managedTools[0]?.id ?? '');
  const descriptor = managedTools.find(item => item.id === tool) ?? managedTools[0];
  const toolId = descriptor?.id ?? '';
  const [scope, setScope] = useState<Scope>(repair?.scope ?? readStoredContexts()[tool]?.scope ?? 'global');
  const [projectPath, setProjectPath] = useState(repair?.projectPath ?? readStoredContexts()[tool]?.projectPath ?? '');
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspace, setWorkspace] = useState<RegisteredToolWorkspace | null>(null);
  const [scopedContext, setScopedContext] = useState<{ key: string; value: RegisteredToolContext } | null>(null);
  const [loading, setLoading] = useState(true);
  // Action results float as toasts; persistent problems stay inline below.
  const toasts = useToasts();
  const [{ setError, setNotice }] = useState(() => ({
    setError: (text: string) => { if (text) toasts.showError(text); else toasts.dismiss('alert'); },
    setNotice: (text: string) => { if (text) toasts.showNotice(text); else toasts.dismiss('status'); },
  }));
  const [busy, setBusy] = useState(false);
  const [maintenance, setMaintenance] = useState<MaintenanceState | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [resource, setResource] = useState<ResourceView>(repair?.resourceView ?? readStoredContexts()[tool]?.resource ?? 'config');
  const [frame, setFrame] = useState<EditFrame | null>(null);
  const [dirty, setDirty] = useState(false);
  const [resourceDirty, setResourceDirty] = useState({ mcp: false, skills: false, agents: false, memory: false });
  const [resourceEpoch, setResourceEpoch] = useState(0);
  // A jump between tabs (a plugin's bundled agent or skill, an agent's owning plugin) opens the
  // target tab on that item once; `token` keeps a later revisit from re-applying it.
  const [resourceFocus, setResourceFocus] = useState<{ resource: ResourceView; key: string; token: number } | null>(null);
  const focusToken = useRef(0);
  const configBoard = useRef<HTMLDivElement>(null);
  const mcpDirty = useCallback((value: boolean) => setResourceDirty(previous => previous.mcp === value ? previous : { ...previous, mcp: value }), []);
  const skillsDirty = useCallback((value: boolean) => setResourceDirty(previous => previous.skills === value ? previous : { ...previous, skills: value }), []);
  const agentsDirty = useCallback((value: boolean) => setResourceDirty(previous => previous.agents === value ? previous : { ...previous, agents: value }), []);
  const memoryDirty = useCallback((value: boolean) => setResourceDirty(previous => previous.memory === value ? previous : { ...previous, memory: value }), []);
  const [comparison, setComparison] = useState<ApplyComparison | null>(null);
  // A failed "use this content" must be visible in the dialog; page toasts sit behind it.
  const [compareError, setCompareError] = useState('');
  const [filter, setFilter] = useState('');
  const [customPath, setCustomPath] = useState('');
  const [quotaAddFor, setQuotaAddFor] = useState<string | null>(null);
  const [accountUsageQuery, setAccountUsageQuery] = useState<UsageQuery | null>(null);
  const [launching, setLaunching] = useState(false);
  const quota = useUsageQuota(active && remoteTargetId === 'local' && (resource === 'config' || resource === 'accounts'));
  const accounts = useAccounts(toolId, active && (resource === 'config' || resource === 'accounts' || !!frame), remoteTargetId === 'local' ? null : remoteTargetId);
  const loadSequence = useRef(0);
  const alive = useRef(true);
  const epoch = useRef(0);
  const context = JSON.stringify([toolId, scope, projectPath]);
  const currentContext = useRef(context); currentContext.current = context;
  const currentFrame = useRef(frame); currentFrame.current = frame;
  const allDirty = dirty || Object.values(resourceDirty).some(Boolean);
  const currentDirty = useRef(allDirty); currentDirty.current = allDirty;
  const appliedRepair = useRef(0);
  const appliedOpen = useRef(0);
  const appliedDiscard = useRef(0);
  const pendingCreate = useRef(false);
  const management = descriptor?.management;
  const isRemote = remoteTargetId !== 'local';
  // The descriptor describes the local adapter installation.  A remote target
  // has its own CLI/resources and is intentionally exposed through the same
  // workspace surface; do not hide tabs while the remote probe is still
  // loading (or because a local adapter omitted a management flag).
  const supported = isRemote
    ? { config: true, accounts: true, mcp: true, skills: true, agents: true, plugins: true, memory: true }
    : { config: true, accounts: management?.accounts ?? true, mcp: management?.mcp ?? true, skills: management?.skills ?? true, agents: management?.agents ?? true, plugins: (management?.plugins ?? true) && (scope === 'global' || (management?.projectPlugins ?? true)), memory: !!management?.memory || !!management?.memoryReason };
  useEffect(() => { alive.current = true; return () => { alive.current = false; loadSequence.current++; }; }, []);
  useLayoutEffect(() => { onDirtyChange?.(allDirty); }, [allDirty, onDirtyChange]);
  // Report the CLI actually shown (first mount, open sequence, tray repair) so the sidebar follows it.
  useEffect(() => { if (toolId) onToolChange?.(toolId); }, [toolId, onToolChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => { if (!supported[resource]) setResource('config'); if (resource !== 'accounts') setAccountUsageQuery(null); }, [resource, supported.accounts, supported.mcp, supported.skills, supported.agents, supported.plugins, supported.memory]);
  function makeRemoteWorkspace(probe: RemoteCliProbe, store: RemoteToolStore, fileScope: Scope = scope): RegisteredToolWorkspace {
    const currentFiles = store.currentFiles ?? {};
    const declared = (descriptor?.remoteNativeFiles ?? []).filter(file => file.scope === fileScope);
    const nativeFormat = (format: string): 'toml' | 'json' | 'jsonc' | 'yaml' => format === 'toml' || format === 'json' || format === 'jsonc' || format === 'yaml' ? format : 'json';
    const nativeFiles = declared.length
      ? declared.map(file => ({ role: file.role, path: `remote:${file.relative}`, format: nativeFormat(file.format), writable: true, reason: null, sensitive: false }))
      : Object.keys(currentFiles).map((role) => ({ role, path: `remote:${role}`, format: 'toml' as const, writable: true, reason: null, sensitive: false }));
    const toolProbe: ToolProbe = {
      latestVersionSupported: true,
      tool: toolId as ToolProbe['tool'],
      installations: probe.installed ? [{ path: probe.executable, version: cleanRemoteVersion(probe.version) || null, source: 'native', status: 'available', detail: null }] : [],
      selectedPath: probe.installed ? probe.executable : null,
      nativeFiles,
      nativeWrites: declared.length ? { state: 'supported' as const, reason: '', evidence: 'adapter' } : { state: 'unsupported' as const, reason: i18n.t('tools.workspace.remoteWritesReason'), evidence: 'ssh' },
      interfaceFormats: descriptor?.interfaceFormats ?? [],
      installUrl: '',
      upgradeHint: '',
      installCommand: probe.installed ? null : 'remote',
      upgradeCommand: probe.installed ? 'remote' : null,
      majorUpgrade: null,
      nativeInstallCommand: null,
      npmInstallCommand: null,
      providerPresets: [],
      connectionPolicy: { apiKey: { state: 'writable', reason: '' }, providerAddress: { state: 'configurable', reason: '' }, projection: 'single_connection' },
      dependencies: [],
    };
    return { probe: toolProbe, customPath: null, profiles: store.profiles ?? [], profileModelSummaries: {}, common: store.common ?? null, binding: null, effectiveContextId: null, nativeContextError: null, snapshots: Object.keys(currentFiles).map((role) => ({ role, text: currentFiles[role], fingerprint: 'remote', error: null })), recoveryNeeded: [] };
  }
  const reload = useCallback(async (nextTool: string, nextScope: Scope, nextProject: string, fresh = false) => {
    if (remoteTargetId !== 'local') {
      if (!nativeAvailable || !nextTool) { setLoading(false); setWorkspace(null); return null; }
      const request = ++loadSequence.current;
      setLoading(true); setError('');
      try {
        const [probe, store] = await Promise.all([native.probeRemoteCli(remoteTargetId, nextTool), native.getRemoteToolStore(remoteTargetId, nextTool, nextScope, nextScope === 'project' ? nextProject : null)]);
        if (!alive.current || request !== loadSequence.current) return null;
        const value = makeRemoteWorkspace(probe, store, nextScope);
        setWorkspace(value);
        setScopedContext({ key: JSON.stringify([nextTool, nextScope, nextProject]), value: { effectiveContextId: null, nativeContextError: null } });
        setCustomPath('');
        return value;
      } catch (failure) {
        if (alive.current && request === loadSequence.current) { setWorkspace(null); setError(errorText(failure)); }
        return null;
      } finally { if (alive.current && request === loadSequence.current) setLoading(false); }
    }
    if (nextScope === 'project' && !nextProject) {
      // A previous CLI read may still be in flight. Retire it before publishing
      // the choose-project prompt, or its completion overwrites this context.
      ++loadSequence.current;
      setLoading(false);
      setWorkspace(null);
      setScopedContext({ key: JSON.stringify([nextTool, nextScope, nextProject]), value: { effectiveContextId: null, nativeContextError: null } });
      return null;
    }
    if (!nativeAvailable || !nextTool) { setLoading(false); setWorkspace(null); return null; }
    const request = ++loadSequence.current; setLoading(true); setError('');
    const key = JSON.stringify([nextTool, nextScope, nextProject]);
    let completed = false;
    // Resource pages need the binding, not CLI version processes. A full
    // workspace result remains authoritative if it finishes first.
    void native.getRegisteredToolContext(nextTool, nextScope, nextProject, fresh).then(value => {
      if (value && !completed && alive.current && request === loadSequence.current) {
        setScopedContext({ key, value });
        const cached = !fresh ? workspaceSnapshots.get(key) : undefined;
        if (cached && !value.nativeContextError && cached.effectiveContextId === value.effectiveContextId) {
          setWorkspace(cached);
          setCustomPath(cached.customPath ?? '');
        }
      }
    }).catch(() => { /* The workspace read supplies the final error/retry state. */ });
    try {
      const value = await native.getRegisteredToolWorkspace(nextTool, nextScope, nextProject, false, fresh);
      if (!alive.current || request !== loadSequence.current) return null;
      rememberWorkspace(key, value);
      setWorkspace(value); setScopedContext({ key, value: { effectiveContextId: value.effectiveContextId, nativeContextError: value.nativeContextError ?? null } }); setCustomPath(value.customPath ?? ''); return value;
    } catch (failure) { if (alive.current && request === loadSequence.current) setError(errorText(failure)); return null; }
    finally { completed = true; if (alive.current && request === loadSequence.current) setLoading(false); }
  }, [remoteTargetId, descriptor, toolId]);
  useEffect(() => { setWorkspace(null); setFrame(null); setDirty(false); setComparison(null); setFilter(''); setNotice(''); epoch.current++; if (active) void reload(toolId, scope, projectPath); }, [toolId, scope, projectPath, reload]);
  useEffect(() => { if (active && !workspace) void reload(toolId, scope, projectPath); }, [active]);
  useEffect(() => {
    if (!nativeAvailable || !active) return;
    if (isRemote) {
      void native.listRemoteProjects(remoteTargetId).then(items => {
        if (!alive.current) return;
        setProjects(items.map(item => ({
          id: `remote:${item.id}`,
          name: item.name,
          path: item.path,
          available: true,
          preferredTool: item.preferredTool ?? null,
          lastOpened: item.updatedAt,
          modelOverrides: {},
          selectedProfiles: {},
          appliedProfiles: {},
          reapplyProfiles: {},
        })));
      }).catch(value => { if (alive.current) setError(errorText(value)); });
      return;
    }
    void native.listProjects().then(value => { if (alive.current) setProjects(value); }).catch(value => { if (alive.current) setError(errorText(value)); });
  }, [active, isRemote, remoteTargetId]);
  useEffect(() => {
    if (!active || !nativeAvailable) return;
    const refresh = () => { if (!currentDirty.current && !currentFrame.current) void reload(toolId, scope, projectPath); };
    window.addEventListener('focus', refresh); let stop: (() => void) | undefined; let live = true;
    void listen('cliora:bindings-changed', refresh).then(value => { if (live) stop = value; else value(); }).catch(() => {});
    return () => { live = false; stop?.(); window.removeEventListener('focus', refresh); };
  }, [toolId, scope, projectPath, active, reload]);
  async function mayLeave(message = t('tools.workspace.discardMessage')) {
    if (!currentDirty.current) return true;
    const identity = currentContext.current; const revision = epoch.current;
    return confirmAction(message, () => alive.current && currentContext.current === identity && epoch.current === revision, { title: t('common.app.leaveDirtyTitle'), confirmLabel: t('common.app.leaveDirtyConfirm') });
  }
  function discard() { setFrame(null); setDirty(false); setResourceDirty({ mcp: false, skills: false, agents: false, memory: false }); setResourceEpoch(value => value + 1); epoch.current++; }
  async function closeFrame() { if (await mayLeave()) { discard(); } }
  async function openFrame(subject: ConfigurationSubject, profile: RegisteredProfile | null = null, confirmed = false, title?: string) {
    if (!confirmed && !await mayLeave()) return;
    discard(); setError(''); setNotice('');
    setFrame({ key: crypto.randomUUID(), subject, profile, title: title ?? (subject === 'current' ? t('tools.workspace.frameCurrent') : subject === 'common' ? t('tools.workspace.frameCommon') : profile?.id ? t('tools.workspace.frameProfile', { name: profile.name }) : t('tools.workspace.frameNew')) });
  }
  async function launch() {
    if (!nativeAvailable || launching) return;
    if (isRemote) {
      // Reuse the last remote project exactly like the local launch button.
      // The workbench opens the directory picker only when no remote project
      // exists for this host.
      window.dispatchEvent(new CustomEvent('cliora:open-remote-session-request', { detail: { toolId, targetId: remoteTargetId, quickLaunch: true } }));
      return;
    }
    const desktop = descriptor?.launchForm === 'desktop';
    let directory: string | null = null;
    setLaunching(true);
    try {
      const settings = await native.getLaunchSettings();
      if (!desktop) {
        const picked = await open({ directory: true, multiple: false, title: t('tools.workspace.launchPickTitle', { name: descriptor?.name ?? toolId }) });
        if (typeof picked !== 'string') return;
        directory = picked;
      }
      const request = { toolId, projectId: null, sessionId: null, mode: preferredLaunchMode(settings, 'cli', descriptor?.yoloAvailable ?? false), directory };
      const result = await native.launchCli(request);
      const opened = workbenchSessionId(result);
      if (opened) { onWorkbenchSession?.(opened); return; }
      setNotice(desktop ? t('tools.workspace.launchedDesktop', { name: descriptor?.name ?? toolId }) : t('tools.workspace.launched', { name: descriptor?.name ?? toolId }));
    } catch (failure) {
      if (await failedInWorkbench(desktop)) {
        const settings = await native.getLaunchSettings().catch(() => null);
        onWorkbenchFailure?.({ detail: errorText(failure), retry: { kind: 'launch', request: { toolId, projectId: null, sessionId: null, mode: preferredLaunchMode(settings, 'cli', descriptor?.yoloAvailable ?? false), directory } } });
        return;
      }
      setError(errorText(failure));
    } finally {
      setLaunching(false);
    }
  }
  async function createProfile() {
    let name = t('tools.workspace.newProfile'); let suffix = 1;
    while (workspace?.profiles.some(profile => profile.name === name)) name = t('tools.workspace.newProfileN', { suffix: ++suffix });
    await openFrame('profile', { id: '', tool: toolId, name, version: 0, inheritCommon: false, files: {}, suppressed: {}, connection: null, nativeCredentials: {} });
  }
  async function switchScope(next: Scope, path = '') { if (next === scope && (next === 'global' || path === projectPath)) return; if (!await mayLeave()) return; discard(); setScope(next); setProjectPath(path); }
  async function switchResource(next: ResourceView) { if (next === resource || !await mayLeave()) return; discard(); setResource(next); }
  async function openResourceItem(next: 'agents' | 'skills' | 'plugins', key: string) {
    if (!supported[next]) return;
    if (next !== resource) { if (!await mayLeave()) return; discard(); setResource(next); }
    setResourceFocus({ resource: next, key, token: ++focusToken.current });
  }
  const focusFor = (view: ResourceView) => resourceFocus?.resource === view ? { path: resourceFocus.key, token: resourceFocus.token } : null;
  const pluginTabs = (['agents', 'skills'] as const).filter(view => supported[view]);
  async function pickProject() { const started = currentContext.current; try { const value = await open({ directory: true, multiple: false, title: t('tools.workspace.pickProjectTitle') }); if (typeof value === 'string' && alive.current && started === currentContext.current) await switchScope('project', value); } catch (failure) { setError(errorText(failure)); } }
  const openTarget = async (profileId: string, target?: AccountImpactScope) => {
    if (!await mayLeave()) return;
    if (target && (target.toolId !== toolId || !target.scope || target.scope === 'project' && !target.projectPath)) { setError(t('tools.workspace.scopeChanged')); return; }
    const nextScope = target?.scope ?? scope; const nextPath = target?.projectPath ?? projectPath; const original = currentContext.current; const navigation = epoch.current;
    const value = isRemote
      ? await native.getRemoteToolStore(remoteTargetId, toolId, scope, scope === 'project' ? projectPath : null).then(store => makeRemoteWorkspace({ targetId: remoteTargetId, toolId, executable: '', installed: true, version: null, detail: null }, store, scope)).catch(failure => { setError(errorText(failure)); return null; })
      : await native.getRegisteredToolWorkspace(toolId, nextScope, nextPath, false, true).catch(failure => { setError(errorText(failure)); return null; });
    if (!alive.current || original !== currentContext.current || navigation !== epoch.current || !value) return;
    const profile = value.profiles.find(item => item.id === profileId);
    if (!profile) { setError(t('tools.workspace.profileGone')); return; }
    discard(); setScope(nextScope); setProjectPath(nextScope === 'global' ? '' : nextPath); setResource('config');
    // Scope effects load the target first; open after that identity settles.
    const targetContext = JSON.stringify([toolId, nextScope, nextScope === 'global' ? '' : nextPath]);
    setTimeout(() => { if (alive.current && currentContext.current === targetContext) void openFrame('profile', profile, true); }, 0);
  };
  useEffect(() => {
    if (!repair || repair.page !== 'connections' || !repair.toolId || appliedRepair.current === repair.sequence) return;
    appliedRepair.current = repair.sequence;
    void (async () => { if (!await mayLeave()) return; discard(); setTool(repair.toolId!); setScope(repair.scope ?? 'global'); setProjectPath(repair.projectPath ?? ''); setResource(repair.resourceView ?? 'config'); if (repair.profileId && !isRemote) { const value = await native.getRegisteredToolWorkspace(repair.toolId!, repair.scope ?? 'global', repair.projectPath ?? '', false, true).catch(() => null); const profile = value?.profiles.find(item => item.id === repair.profileId); if (alive.current && profile) setTimeout(() => void openFrame('profile', profile, true), 0); } })();
  }, [repair]);
  useEffect(() => {
    if (!openSequence || appliedOpen.current === openSequence) return; appliedOpen.current = openSequence;
    void (async () => {
      if (!await mayLeave()) return;
      discard();
      const nextTool = initialTool ?? toolId;
      const stored = readStoredContexts()[nextTool];
      const nextScope = stored ? stored.scope ?? 'global' : scope;
      const nextPath = stored ? stored.projectPath ?? '' : projectPath;
      setResource(openIntent?.resource ?? stored?.resource ?? 'config');
      setScope(nextScope); setProjectPath(nextPath);
      if (initialTool) setTool(initialTool);
      if (!openIntent?.create) return;
      if (JSON.stringify([nextTool, nextScope, nextPath]) === context) await createProfile();
      else pendingCreate.current = true;
    })();
  }, [openSequence]);
  useEffect(() => {
    if (!pendingCreate.current || !workspace) return;
    pendingCreate.current = false;
    void createProfile();
  }, [workspace]);
  useEffect(() => {
    if (!toolId) return;
    try {
      const all = readStoredContexts();
      all[toolId] = { resource, scope, projectPath };
      localStorage.setItem(contextStoreKey, JSON.stringify(all));
    } catch { /* 布局与功能不依赖本地存储。 */ }
  }, [toolId, resource, scope, projectPath]);
  const supportedRef = useRef(supported); supportedRef.current = supported;
  const switchResourceRef = useRef(switchResource); switchResourceRef.current = switchResource;
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const index = Number(event.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= resourceViews.length) return;
      const next = resourceViews[index];
      if (!supportedRef.current[next] || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      void switchResourceRef.current(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
  useEffect(() => {
    if (!discardSignal || appliedDiscard.current === discardSignal) return;
    appliedDiscard.current = discardSignal;
    discard();
  }, [discardSignal]);
  async function apply(profile: RegisteredProfile) {
    if (!await mayLeave()) return;
    const identity = currentContext.current; setApplying(profile.id); setError(''); setNotice('');
    try {
      if (isRemote) {
        const store = await native.getRemoteToolStore(remoteTargetId, toolId, scope, scope === 'project' ? projectPath : null);
        await native.saveRemoteToolStore(remoteTargetId, toolId, { ...store, currentFiles: profile.files, profiles: store.profiles.map(item => item.id === profile.id ? profile : item) }, scope, scope === 'project' ? projectPath : null);
      } else await native.applyRegisteredNativeProfile(toolId, profile.id, scope, projectPath || undefined, false);
      if (identity !== currentContext.current || !alive.current) return; await reload(toolId, scope, projectPath, true); setNotice(t('tools.workspace.applied')); }
    catch (failure) { if (identity !== currentContext.current || !alive.current) return; setError(errorText(failure)); try { const value = await native.compareRegisteredApplication(profile.id, scope, projectPath); if (identity === currentContext.current) { setCompareError(''); setComparison(value); } } catch {} }
    finally { if (identity === currentContext.current) setApplying(null); }
  }
  function closeComparison() { setComparison(null); setCompareError(''); }
  async function compareUse() {
    if (!comparison) return; const value = comparison; const identity = currentContext.current; setBusy(true); setError(''); setCompareError('');
    try {
      if (isRemote) { closeComparison(); return; }
      await native.applyComparedApplication(value, scope, projectPath); if (identity === currentContext.current && alive.current) { closeComparison(); await reload(toolId, scope, projectPath, true); setNotice(t('tools.workspace.appliedShort')); }
    }
    catch (failure) {
      if (identity !== currentContext.current || !alive.current) return;
      setCompareError(errorText(failure));
      // The comparison is usually stale (the file, profile or account changed after it was
      // taken). Refresh it so the dialog shows the current difference and a retry uses it.
      try { const fresh = await native.compareRegisteredApplication(value.profile.id, scope, projectPath); if (identity === currentContext.current && alive.current) setComparison(fresh); } catch { /* keep the error and the old view */ }
    }
    finally { if (identity === currentContext.current) setBusy(false); }
  }
  async function duplicate(profile: RegisteredProfile) { if (!await mayLeave()) return; const copy = structuredClone(profile); copy.id = ''; copy.version = 0; delete copy.revision; copy.name += t('tools.workspace.copySuffix'); await openFrame('profile', copy, true, t('tools.workspace.frameCopy', { name: profile.name })); }
  async function remove(profile: RegisteredProfile) { const identity = currentContext.current; if (!await confirmAction(t('tools.workspace.confirmDelete', { name: profile.name }), () => alive.current && identity === currentContext.current, { title: t('tools.workspace.deleteTitle'), confirmLabel: t('tools.agents.delete'), destructive: true })) return; setBusy(true); try { if (isRemote) await native.deleteRemoteToolProfile(remoteTargetId, toolId, profile.id); else await native.deleteNativeProfile(profile.id, profile.version, profile.revision ?? ''); if (identity === currentContext.current) await reload(toolId, scope, projectPath, true); } catch (failure) { setError(errorText(failure)); } finally { if (identity === currentContext.current) setBusy(false); } }
  function stored(result: ConfigurationSaveResult) { if (result.profile) setWorkspace(value => value ? { ...value, profiles: [...value.profiles.filter(profile => profile.id !== result.profile!.id), result.profile!] } : value); if (result.common) setWorkspace(value => value ? { ...value, common: result.common } : value); }
  function changed(_draft: ConfigurationDraft) { epoch.current++; }
  function cancelMaintenance() {
    if (!maintenance?.running || maintenance.cancelling) return;
    setMaintenance({ ...maintenance, cancelling: true });
    void native.cancelCliMaintenance(maintenance.tool).catch(failure => setMaintenance(previous => previous ? { ...previous, cancelling: false, error: errorText(failure) } : previous));
  }
  async function maintain(action: MaintenanceAction, source?: string, retry = false, lineVersion?: string, target?: string) {
    if (busy) return;
    if (!retry && (!await mayLeave() || !await confirmAction(action === 'upgrade_major' ? t('tools.workspace.maintainMajorConfirm') : t('tools.workspace.maintainConfirm'), () => alive.current, { title: action === 'uninstall_npm' ? t('tools.workspace.maintainUninstallTitle') : action === 'install' || action === 'install_native' ? t('tools.workspace.maintainInstallTitle') : action === 'upgrade_major' ? t('tools.workspace.maintainMajorTitle') : t('tools.workspace.maintainUpgradeTitle'), confirmLabel: action === 'uninstall_npm' ? t('tools.plugins.action.uninstall') : action === 'install' || action === 'install_native' ? t('tools.plugins.action.install') : action === 'upgrade_major' ? t('tools.workspace.maintainMajorAction') : t('tools.plugins.action.update') }))) return;
    const startedContext = currentContext.current;
    setBusy(true);
    const installed = workspace?.probe.installations.find(item => item.status === 'available' && item.path === workspace.probe.selectedPath) ?? workspace?.probe.installations.find(item => item.status === 'available');
    setMaintenance({ tool: toolId, name: descriptor.name, running: true, action, source, lineVersion, target, from: action.startsWith('install') ? null : installed?.version?.trim() || null, output: '', error: '', startedAt: Date.now() });
    let stop: (() => void) | undefined;
    try {
      stop = await listen<MaintenanceProgress>('cliora:maintenance-progress', event => {
        if (alive.current && event.payload.toolId === toolId) setMaintenance(previous => previous ? { ...previous, output: event.payload.output } : previous);
      }).catch(() => undefined);
      const result = isRemote
        ? await native.maintainRemoteCli(remoteTargetId, toolId, action, source, lineVersion)
        : await native.maintainRegisteredCli(toolId, action, source, lineVersion);
      if (alive.current) setMaintenance(previous => previous ? { ...previous, running: false, cancelling: false, output: result.output, version: result.version, finishedAt: Date.now() } : previous);
    } catch (failure) {
      if (alive.current) setMaintenance(previous => previous ? { ...previous, running: false, cancelling: false, error: errorText(failure), finishedAt: Date.now() } : previous);
    } finally {
      stop?.();
      if (alive.current) {
        setBusy(false);
        if (currentContext.current === startedContext) {
          await reload(toolId, scope, projectPath, true);
        }
      }
    }
  }
  async function savePath() { if (isRemote) return; if (!await mayLeave()) return; setBusy(true); try { await native.setRegisteredCustomCliPath(toolId, customPath.trim() || null); await reload(toolId, scope, projectPath, true); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); } }
  async function usePath(path: string) { if (isRemote) return; if (!await mayLeave()) return; setBusy(true); try { await native.setRegisteredCustomCliPath(toolId, path); await reload(toolId, scope, projectPath, true); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); } }
  async function openAccountQuota(queryId: string) { if (!await mayLeave()) return; const query = quota.queries.find(item => item.id === queryId); if (!query) { void quota.reload(); setError(t('tools.workspace.quotaChanged')); return; } setAccountUsageQuery(query); }
  const quotaIds = new Set(quota.queries.map(query => query.config.identity.profileId));
  const currentFile = workspace?.snapshots.some(snapshot => snapshot.fingerprint && !workspace.probe.nativeFiles.find(file => file.role === snapshot.role)?.sensitive);
  const modelOf = (profile: RegisteredProfile) => workspace?.profileModelSummaries ? workspace.profileModelSummaries[profile.id]?.model : profile.connection?.model;
  const query = filter.trim().toLocaleLowerCase();
  const matches = (profile: RegisteredProfile) => !query || [profile.name, modelOf(profile), host(profile.connection?.baseUrl)].some(value => value?.toLocaleLowerCase().includes(query));
  const profileGroups = (workspace ? [{ id: 'subscription', label: t('tools.workspace.groupSubscription'), profiles: workspace.profiles.filter(profile => quotaIds.has(profile.id) || profile.authentication?.kind === 'oauth') }, { id: 'other', label: t('tools.workspace.groupOther'), profiles: workspace.profiles.filter(profile => !quotaIds.has(profile.id) && profile.authentication?.kind !== 'oauth') }] : [])
    .map(group => ({ ...group, visible: group.profiles.filter(matches) })).filter(group => group.visible.length);
  function row(profile: RegisteredProfile) {
    const binding = workspace?.binding;
    const { same, commonPending, trusted, applied } = configurationApplicationState(profile, binding, workspace?.common);
    const model = modelOf(profile);
    const state = same ? applied ? 'active' : 'pending' : 'saved';
    const frozen = same && trusted ? binding?.appliedSummary : null;
    const frozenSource = frozen?.authentication.kind === 'oauth' ? t('tools.workspace.sourceManaged') : frozen?.authentication.kind === 'api_key' ? t('tools.workspace.sourceApiKey') : t('tools.workspace.sourceCli');
    const authentication = profile.authentication;
    const credential = authentication?.kind === 'oauth' ? t('tools.workspace.credentialAccount', { label: accounts.accounts.find(account => account.id === authentication.accountId)?.label ?? authentication.accountId }) : profile.authentication?.kind === 'api_key' ? t('tools.workspace.sourceApiKey') : profile.authentication?.kind === 'rebind_required' ? t('tools.workspace.credentialRebind') : t('tools.workspace.sourceCli');
    const versionNote = same && (binding!.profileVersion !== profile.version || commonPending) ? `${t('tools.workspace.versions', { used: binding!.profileVersion, saved: profile.version })}${commonPending ? t('tools.workspace.commonPending') : ''}` : '';
    const usedSummary = frozen ? [frozenSource, frozen.providerId, host(frozen.baseUrl ?? undefined), frozen.model].filter(Boolean).join(' · ') : '';
    const usedNote = usedSummary ? t('tools.workspace.lastUsed', { summary: usedSummary }) : '';
    return <div className={styles.profileRow} role="listitem" data-profile-id={profile.id} data-active={applied || undefined} key={profile.id}>
      <div className={styles.profileHead}>
        <span className={styles.profileMain}>
          <span className={styles.profileTitle}><button className={styles.profileName} title={profile.name} onClick={() => void openFrame('profile', profile)}>{profile.name}</button><StatusBadge className={styles.profileState} domain="profile" state={state} dot={applied} /></span>
          <span className={styles.profileMeta}>{model && <Badge className={styles.profileModel} title={model}>{model}</Badge>}<span data-tone={authentication?.kind === 'rebind_required' ? 'warn' : undefined}>{t('tools.workspace.savedAs', { credential })}{host(profile.connection?.baseUrl) && ` · ${host(profile.connection?.baseUrl)}`}</span></span>
          {(versionNote || usedNote) && <span className={styles.profileHistory}>{versionNote && <span title={versionNote}>{versionNote}</span>}{usedNote && <span title={usedNote}>{usedNote}</span>}</span>}
        </span>
        <span className={styles.profileActions}>{!applied && <Button size="sm" disabled={busy || !!applying || workspace?.probe.nativeWrites.state !== 'supported'} onClick={() => void apply(profile)}>{applying === profile.id ? t('tools.workspace.applying') : same ? t('tools.workspace.useNew') : t('tools.workspace.use')}</Button>}<Button variant="ghost" size="sm" onClick={() => void openFrame('profile', profile)}>{t('tools.workspace.edit')}</Button><RowMenu label={t('tools.workspace.rowMenu', { name: profile.name })}><button role="menuitem" onClick={() => void duplicate(profile)}>{t('tools.workspace.duplicateConfig')}</button><button role="menuitem" onClick={() => setQuotaAddFor(profile.id)}>{t('tools.workspace.addQuota')}</button><button role="menuitem" data-danger="true" onClick={() => void remove(profile)}>{t('tools.workspace.deleteConfig')}</button></RowMenu></span>
      </div>
      {!isRemote && <ProfileQuota profileId={profile.id} profileVersion={profile.version} toolId={toolId} profileAccountId={profile.authentication?.kind === 'oauth' ? profile.authentication.accountId : undefined} state={quota} addRequested={quotaAddFor === profile.id} onAddHandled={() => setQuotaAddFor(null)} />}
    </div>;
  }
  const linkedAuthentication = workspace?.profiles.find(profile => profile.id === accountUsageQuery?.config.identity.profileId)?.authentication;
  const queryAccount = linkedAuthentication?.kind === 'oauth' ? linkedAuthentication.accountId : accountUsageQuery?.config.identity.profileId ? undefined : accountUsageQuery?.config.identity.accountId ?? undefined;
  const resourceContext = scopedContext?.key === context ? scopedContext.value : null;
  const memoryProjects = useMemo(() => projects.flatMap(project => project.available && project.path ? [{ name: project.name, path: project.path }] : []), [projects]);
  const resourcesReady = resourceContext !== null && !resourceContext.nativeContextError;
  useFillHeight(configBoard, 'minHeight', !!workspace && resource === 'config');
  if (!descriptor) return <p>{t('tools.workspace.noTools')}</p>;
  // The page header is the CLI switcher; picking routes through the app's open sequence so the
  // unsaved-changes prompt stays the single confirmation.
  const toolHeading = <h2 className={styles.chromeTitle}>{managedTools.length > 1 && onPickTool
    ? <FilterSelect className={styles.toolPicker} variant="title" label={t('tools.workspace.switchTool', { name: descriptor.name })} searchLabel={t('tools.workspace.searchTool')} value={toolId} options={managedTools.map(item => ({ value: item.id, label: item.name, icon: <ToolIcon toolId={item.id} size={item.id === toolId ? 22 : 18} /> }))} onChange={id => { if (id !== toolId) onPickTool(id); }} />
    : <><ToolIcon toolId={toolId} size={22} /><strong>{descriptor.name}</strong></>}</h2>;
  return <section className={styles.workspace} aria-label={t('common.nav.connections')} data-host-target={remoteTargetId}><ToastScope toasts={toasts}>
    <div className={styles.main}>
    <div className={styles.chrome} data-workspace-chrome>
    <div className={styles.chromeHead}>
      {toolHeading}
      {workspace && <div className={styles.chromeInstall}><InstallPanel toolName={descriptor.name} heading={false} collapsed={resource !== 'config'} probe={workspace.probe} customPath={customPath} busy={busy} loading={loading} onCustomPath={setCustomPath} onSavePath={() => void savePath()} onMaintain={(action, source, lineVersion, target) => void maintain(action, source, false, lineVersion, target)} onUsePath={path => void usePath(path)} /></div>}
    </div>
    <div className={styles.taskBar}><div className={styles.views} role="tablist" aria-label={t('tools.workspace.tasksAria')} onKeyDown={navigateChoices}>{resourceViews.filter((id) => supported[id]).map((id) => { const label = t(`tools.workspace.view.${id}`); const shortcutIndex = resourceViews.findIndex((view) => view === id) + 1; return <button role="tab" key={id} aria-selected={resource === id} aria-keyshortcuts={`Alt+${shortcutIndex}`} tabIndex={resource === id ? 0 : -1} title={t('tools.workspace.viewTitle', { label, index: shortcutIndex })} className={resource === id ? styles.selected : ''} onClick={() => void switchResource(id)}>{label}</button>; })}</div><div className={styles.scopeBar} hidden={resource === 'memory'}><FilterSelect className={styles.projectSelect} label={t('tools.workspace.scopeLabel')} value={scope === 'global' ? '__global__' : projectPath} forceSearch searchLabel={t('home.launcher.searchLabel')} options={[{ value: '__global__', label: t('tools.workspace.scopeGlobal') }, ...projects.map(project => ({ value: project.path ?? project.id, label: project.name, detail: project.path ? shortPath(project.path) : undefined, disabled: !project.available || !project.path })), ...(projectPath && !projects.some(project => project.path === projectPath) ? [{ value: projectPath, label: projectPath.split(/[\\/]/).at(-1) ?? projectPath }] : [])]} onChange={value => void switchScope(value === '__global__' ? 'global' : 'project', value === '__global__' ? '' : value)} onPickFolder={() => void pickProject()} pickFolderLabel={t('common.filterSelect.pickFolder')} /></div></div>
    </div>
    <div hidden={resource !== 'config'}>
      {workspace?.nativeContextError && <div className={styles.feedback}><StatusBanner tone="error">{workspace.nativeContextError}</StatusBanner></div>}
      {workspace?.recoveryNeeded.length ? <div className={styles.feedback}><StatusBanner tone="error" action={<Button size="sm" onClick={() => { void native.recoverNativeTransactions().then(() => reload(toolId, scope, projectPath, true)).catch(failure => setError(errorText(failure))); }}>{t('tools.workspace.retryRecovery')}</Button>}>{t('tools.workspace.recoveryNeeded', { count: workspace.recoveryNeeded.length })}</StatusBanner></div> : null}
      {!workspace ? (loading && nativeAvailable
        ? <div className={styles.loadingList} role="status" aria-label={t('tools.workspace.loading')}><span className="skeleton-block short" /><span className="skeleton-block" /><span className="skeleton-block" /></div>
        : <div className={styles.taskEmpty} data-tone={nativeAvailable ? 'error' : undefined}><Icon name={nativeAvailable ? 'alert' : 'monitor'} size={24} /><div><strong>{nativeAvailable ? t('tools.workspace.loadFailed') : t('tools.workspace.needDesktop')}</strong><p>{nativeAvailable ? t('tools.workspace.loadFailedHint') : t('tools.workspace.previewHint')}</p></div>{nativeAvailable && <Button variant="primary" onClick={() => void reload(toolId, scope, projectPath)}>{t('tools.workspace.retryLoad')}</Button>}</div>)
      : <div ref={configBoard} className={styles.profileList} aria-label={t('tools.workspace.listAria')}>
        <Toolbar className={styles.listHeading} title={t('tools.workspace.profilesTitle')} titleAs="h3" count={workspace.profiles.length > 0 ? workspace.profiles.length : undefined} actions={<><Button variant="ghost" size="sm" icon={<Icon name="play" size={14} />} title={descriptor.launchForm === 'desktop' ? t('tools.workspace.launchTitleDesktop', { name: descriptor.name }) : t('tools.workspace.launchTitle', { name: descriptor.name })} disabled={launching || !workspace} onClick={() => void launch()} onContextMenu={(event) => { event.preventDefault(); void launch(); }}>{launching ? t('tools.workspace.launching') : t('home.tools.launch')}</Button><Button variant="ghost" size="sm" icon={<Icon name="settings" size={14} />} title={t('tools.workspace.commonTitle')} onClick={() => void openFrame('common')}>{t('tools.workspace.common')}</Button></>} primary={<Button variant="primary" size="sm" icon={<Icon name="plus" size={14} />} onClick={() => void createProfile()}>{t('tools.workspace.frameNew')}</Button>} />
        <div className={styles.boardBody}>
        {currentFile && <div className={styles.profileRow} data-kind="native"><span><button className={styles.profileName} onClick={() => void openFrame('current')}>{t('tools.workspace.currentFile')}</button><small>{t('tools.workspace.currentFileHint')}</small></span><Button variant="ghost" size="sm" onClick={() => void openFrame('current')}>{t('tools.workspace.edit')}</Button></div>}
        {workspace.profiles.length > 6 && <label className={styles.profileFilter}><SearchField type="search" label={t('home.tools.searchProfile')} pageSearch title={searchShortcutHint()} placeholder={t('tools.workspace.searchPlaceholder')} value={filter} onChange={setFilter} />{query && <span>{profileGroups.reduce((total, group) => total + group.visible.length, 0)} / {workspace.profiles.length}</span>}</label>}
        {!workspace.profiles.length && <div className={styles.profileEmpty}><strong>{t('tools.workspace.emptyTitle')}</strong><span>{t('tools.workspace.emptyDetail')}{currentFile ? t('tools.workspace.emptyCurrent') : ''}</span><Button size="sm" icon={<Icon name="plus" size={14} />} onClick={() => void createProfile()}>{t('tools.workspace.emptyCreate')}</Button></div>}
        {query && !profileGroups.length && <div className={styles.profileEmpty}><span>{t('tools.workspace.noMatch', { query: filter.trim() })}</span><Button variant="ghost" size="sm" onClick={() => setFilter('')}>{t('tools.workspace.clearSearch')}</Button></div>}
        <div role="list" aria-label={t('tools.workspace.itemsAria')} className={`${styles.profileCards}${workspace.profiles.length > 6 ? ` ${styles.profileScroll}` : ''}`}>{profileGroups.map(group => <div key={group.id} className={styles.profileGroup} data-group={group.id}>{profileGroups.length > 1 && <div className={styles.groupLabel}><strong>{group.label}</strong><Badge>{query ? `${group.visible.length}/${group.profiles.length}` : group.profiles.length}</Badge></div>}{group.visible.map(row)}</div>)}</div>
        </div>
      </div>}
      <GuideDialog wide suspended={!active} open={!!frame} title={frame?.title ?? t('tools.workspace.frameFallback')} hint={t(frame?.subject === 'current' ? 'tools.workspace.frameCurrentHint' : 'tools.workspace.frameHint', { tool: descriptor.name, scope: scope === 'global' ? t('tools.apply.global') : projectPath })} onClose={() => void closeFrame()} onBack={() => void closeFrame()}>{frame && !workspace && <p role="status">{t('tools.workspace.frameLoading')}</p>}{frame && workspace && <Suspense fallback={<PageSkeleton />}><ConfigurationWorkspaceEditor key={frame.key} toolId={toolId} subject={frame.subject} profile={frame.profile} scope={scope} projectPath={projectPath} remoteTargetId={isRemote ? remoteTargetId : null} workspace={workspace} accounts={accounts} onClose={() => void closeFrame()} onDirtyChange={value => { if (value) epoch.current++; setDirty(value); }} onDraftChange={changed} onStored={stored} onDone={(result, used) => { setFrame(null); setDirty(false); setNotice(result.application ? t('tools.workspace.doneUpdated') : used ? t('tools.workspace.doneSavedUsed') : t('tools.workspace.doneSaved')); void reload(toolId, scope, projectPath, true); }} /></Suspense>}</GuideDialog>
      <GuideDialog wide open={!!comparison} title={t('home.conflict.title')} onClose={closeComparison}>{comparison && <div>{comparison.files.map((file, index) => <ConflictCompare key={file.role} title={file.role} banner={index === 0 ? t('tools.workspace.compareBanner') : undefined} actions={false} currentContent={file.current} nextContent={file.proposedText} format={file.format} onUseNext={() => void compareUse()} onKeepCurrent={closeComparison} />)}{compareError && <div className={styles.feedback}><StatusBanner tone="error">{t('tools.workspace.compareFailed', { error: compareError })}</StatusBanner></div>}<div className="dialog-footer"><Button onClick={closeComparison}>{t('common.conflict.keepCurrent')}</Button><span className="dialog-footer-gap" /><Button variant="primary" disabled={busy} onClick={() => void compareUse()}>{busy ? t('tools.workspace.applying') : t('common.conflict.useNext')}</Button></div></div>}</GuideDialog>
    </div>
    <Suspense fallback={<PageSkeleton />}>
    {resource === 'accounts' && supported.accounts && <AccountsPanel key={toolId} toolId={toolId} state={accounts} onOpenProfile={(id, target) => void openTarget(id, target)} onOpenUsage={id => void openAccountQuota(id)} />}
    {resource === 'accounts' && accountUsageQuery && <QuotaEditor key={accountUsageQuery.id} query={accountUsageQuery} profileId={accountUsageQuery.config.identity.profileId ?? ''} profileAccountId={queryAccount} toolId={toolId} presets={quota.presets} onClose={() => setAccountUsageQuery(null)} onSaved={() => { setAccountUsageQuery(null); void quota.reload(); }} />}
    {!['config', 'accounts', 'memory'].includes(resource) && !resourcesReady && <div role="status" className={styles.contextState}><p>{resourceContext?.nativeContextError ?? (loading ? t('tools.workspace.contextLoading') : workspace?.nativeContextError ?? t('tools.workspace.contextFailed'))}</p>{!loading && <Button size="sm" onClick={() => void reload(toolId, scope, projectPath, true)}>{t('tools.workspace.contextRetry')}</Button>}</div>}
    {resourcesReady && resource === 'mcp' && supported.mcp && <McpWorkspace key={`${context}:${resourceEpoch}:${resourceContext?.effectiveContextId}`} toolId={toolId} scope={scope} projectPath={projectPath} contextId={resourceContext?.effectiveContextId ?? null} remoteTargetId={isRemote ? remoteTargetId : null} onDirtyChange={mcpDirty} onOpenLibrary={onOpenMcpLibrary} />}
    {resourcesReady && resource === 'skills' && supported.skills && <SkillsWorkspace key={`${context}:${resourceEpoch}:${resourceContext?.effectiveContextId}`} toolId={toolId} scope={scope} projectPath={projectPath} contextId={resourceContext?.effectiveContextId ?? null} remoteTargetId={isRemote ? remoteTargetId : null} onDirtyChange={skillsDirty} focusPath={focusFor('skills')} />}
    {resourcesReady && resource === 'agents' && supported.agents && <AgentsWorkspace key={`${context}:${resourceEpoch}:${resourceContext?.effectiveContextId}`} toolId={toolId} scope={scope} projectPath={projectPath} contextId={resourceContext?.effectiveContextId ?? null} remoteTargetId={isRemote ? remoteTargetId : null} onDirtyChange={agentsDirty} focusPath={focusFor('agents')} onOpenPlugin={supported.plugins ? id => void openResourceItem('plugins', id) : undefined} />}
    {resourcesReady && resource === 'plugins' && supported.plugins && <PluginsWorkspace key={`${context}:${resourceEpoch}:${resourceContext?.effectiveContextId}`} toolId={toolId} scope={scope} projectPath={projectPath} contextId={resourceContext?.effectiveContextId ?? null} remoteTargetId={isRemote ? remoteTargetId : null} focusPlugin={resourceFocus?.resource === 'plugins' ? { id: resourceFocus.key, token: resourceFocus.token } : null} onOpenItem={(tab, path) => void openResourceItem(tab, path)} openTabs={pluginTabs} />}
    {resource === 'memory' && supported.memory && (management?.memory
      ? <MemoryWorkspace key={toolId} toolId={toolId} toolName={descriptor.name} memory={management.memory} active={active} remoteTargetId={isRemote ? remoteTargetId : null} suggestedProjectPath={scope === 'project' && projectPath ? projectPath : readStoredContexts()[toolId]?.projectPath ?? null} projects={memoryProjects} onDirtyChange={memoryDirty} />
      : management?.memoryReason && <div className={styles.taskEmpty}><Icon name="alert" size={24} /><div><strong>{t('tools.workspace.memoryUnavailable')}</strong><p>{management.memoryReason}</p></div></div>)}
    </Suspense>
    <MaintenanceDialog state={maintenance} busy={busy} canRetry={maintenance?.tool === toolId} onCancel={cancelMaintenance} onRetry={() => { if (maintenance) void maintain(maintenance.action, maintenance.source, true, maintenance.lineVersion, maintenance.target); }} onClose={() => setMaintenance(null)} onMinimize={() => setMaintenance(previous => previous ? { ...previous, minimized: true } : previous)} onRestore={() => setMaintenance(previous => previous ? { ...previous, minimized: false } : previous)} />
    </div>
  </ToastScope></section>;
}
