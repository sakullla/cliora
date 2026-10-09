import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import { configurationApplicationState } from '../../lib/configurationDraft';
import { confirmAction } from '../../lib/confirm';
import { searchShortcutHint } from '../../lib/shortcut';
import type { AdapterDescriptor, RegisteredProfile, RegisteredToolWorkspace, RegisteredToolContext, Scope, ApplyComparison, MaintenanceProgress } from '../../types/native';
import type { ConfigurationDraft, ConfigurationSaveResult, ConfigurationSubject } from '../../types/configuration';
import type { AccountImpactScope } from '../../types/accounts';
import type { Project, TrayRepairTarget } from '../../types/launch';
import { preferredLaunchMode } from '../../types/launch';
import type { UsageQuery } from '../../types/usage';
import { AccountsPanel, useAccounts } from './AccountsPanel';
import { ProfileQuota, QuotaEditor, useUsageQuota } from './UsageQuota';
import { InstallPanel } from './InstallPanel';
import { ConfigurationWorkspaceEditor } from './configuration/ConfigurationWorkspaceEditor';
import { McpWorkspace, SkillsWorkspace } from './ResourceWorkspace';
import { PluginsWorkspace } from './PluginsWorkspace';
import { AgentsWorkspace } from './AgentsWorkspace';
import { ToolIcon } from '../../components/ToolIcon';
import { Icon } from '../../components/Icon';
import { StatusBanner } from '../../components/StatusBanner';
import { FilterSelect } from '../../components/FilterSelect';
import { SearchField } from '../../components/SearchField';
import { GuideDialog } from '../../components/GuideDialog';
import { ConflictCompare } from '../../components/configuration/ConflictCompare';
import { shortPath } from '../../lib/paths';
import { navigateChoices } from '../../lib/choiceNavigation';
import i18n from '../../i18n';
import styles from './ToolWorkspace.module.css';

const errorText = (value: unknown) => value && typeof value === 'object' && 'message' in value ? String(value.message) : i18n.t('tools.workspace.operationFailed');
function host(address?: string) { try { return address ? new URL(address).host : ''; } catch { return i18n.t('tools.workspace.hostUnknown'); } }
function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const items = () => [...panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []];
  const dismiss = (restoreFocus: boolean) => { setOpen(false); if (restoreFocus) trigger.current?.focus(); };
  // Keyboard users land on the first action once the menu has been placed.
  useEffect(() => { if (open && box) items()[0]?.focus({ preventScroll: true }); }, [open, box !== null]);
  useEffect(() => { if (!open) setBox(null); }, [open]);
  function keyNavigate(event: ReactKeyboardEvent<HTMLDivElement>) {
    const list = items(); if (!list.length) return;
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Tab') { event.preventDefault(); dismiss(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
    list[next].focus();
  }
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = ref.current?.getBoundingClientRect();
      const menu = panel.current;
      if (!trigger || !menu) return;
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const left = Math.max(8, Math.min(trigger.right - width, window.innerWidth - width - 8));
      const spaceBelow = window.innerHeight - trigger.bottom - 8;
      const top = spaceBelow >= height || trigger.top < height + 8
        ? Math.min(trigger.bottom + 4, Math.max(8, window.innerHeight - height - 8))
        : trigger.top - height - 4;
      setBox({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); dismiss(true); } };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, [open]);
  return <div className={styles.rowMenu} ref={ref}>
    <button ref={trigger} type="button" className={styles.rowMenuButton} aria-label={label} title={t('tools.workspace.moreActions')} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); } }}><svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg></button>
    {open && createPortal(<div ref={panel} className={styles.rowMenuList} role="menu" aria-label={label} style={box ? { top: box.top, left: box.left } : { top: 0, left: -10000 }} onKeyDown={keyNavigate} onClick={() => dismiss(true)}>{children}</div>, document.body)}
  </div>;
}


type ResourceView = 'config' | 'accounts' | 'mcp' | 'skills' | 'plugins' | 'agents';
type EditFrame = { key: string; subject: ConfigurationSubject; profile: RegisteredProfile | null; title: string };
export type WorkspaceOpenIntent = { resource?: ResourceView; create?: boolean };

const resourceViews: ResourceView[] = ['config', 'accounts', 'mcp', 'skills', 'agents', 'plugins'];
const contextStoreKey = 'cliora:workspace-context';
type StoredContext = { resource?: ResourceView; scope?: Scope; projectPath?: string };
function readStoredContexts(): Record<string, StoredContext> {
  try { return JSON.parse(localStorage.getItem(contextStoreKey) ?? '{}') as Record<string, StoredContext>; } catch { return {}; }
}
export function ToolWorkspacePage({ managedTools, initialTool, openSequence = 0, openIntent = null, active = true, repair, onDirtyChange, discardSignal = 0 }: { active?: boolean; managedTools: AdapterDescriptor[]; initialTool?: string; openSequence?: number; openIntent?: WorkspaceOpenIntent | null; repair?: TrayRepairTarget | null; onDirtyChange?: (dirty: boolean) => void; discardSignal?: number }) {
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
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [maintenance, setMaintenance] = useState<{ tool: string; name: string; running: boolean; action: 'install' | 'upgrade' | 'install_native' | 'uninstall_npm'; source?: string; cancelling?: boolean; output: string; error: string; version?: string | null } | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [resource, setResource] = useState<ResourceView>(repair?.resourceView ?? readStoredContexts()[tool]?.resource ?? 'config');
  const [frame, setFrame] = useState<EditFrame | null>(null);
  const [dirty, setDirty] = useState(false);
  const [resourceDirty, setResourceDirty] = useState({ mcp: false, skills: false, agents: false });
  const [resourceEpoch, setResourceEpoch] = useState(0);
  const mcpDirty = useCallback((value: boolean) => setResourceDirty(previous => previous.mcp === value ? previous : { ...previous, mcp: value }), []);
  const skillsDirty = useCallback((value: boolean) => setResourceDirty(previous => previous.skills === value ? previous : { ...previous, skills: value }), []);
  const agentsDirty = useCallback((value: boolean) => setResourceDirty(previous => previous.agents === value ? previous : { ...previous, agents: value }), []);
  const [comparison, setComparison] = useState<ApplyComparison | null>(null);
  const [filter, setFilter] = useState('');
  const [customPath, setCustomPath] = useState('');
  const [quotaAddFor, setQuotaAddFor] = useState<string | null>(null);
  const [accountUsageQuery, setAccountUsageQuery] = useState<UsageQuery | null>(null);
  const [launching, setLaunching] = useState(false);
  const quota = useUsageQuota(active);
  const accounts = useAccounts(toolId, active);
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
  const supported = { config: true, accounts: management?.accounts ?? true, mcp: management?.mcp ?? true, skills: management?.skills ?? true, agents: management?.agents ?? true, plugins: (management?.plugins ?? true) && (scope === 'global' || (management?.projectPlugins ?? true)) };
  useEffect(() => { alive.current = true; return () => { alive.current = false; loadSequence.current++; }; }, []);
  useLayoutEffect(() => { onDirtyChange?.(allDirty); }, [allDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => { if (!supported[resource]) setResource('config'); if (resource !== 'accounts') setAccountUsageQuery(null); }, [resource, supported.accounts, supported.mcp, supported.skills, supported.agents, supported.plugins]);
  const reload = useCallback(async (nextTool: string, nextScope: Scope, nextProject: string, fresh = false) => {
    if (!nativeAvailable || !nextTool || nextScope === 'project' && !nextProject) { setLoading(false); setWorkspace(null); return null; }
    const request = ++loadSequence.current; setLoading(true); setError('');
    const key = JSON.stringify([nextTool, nextScope, nextProject]);
    let completed = false;
    // Resource pages need the binding, not CLI version processes. A full
    // workspace result remains authoritative if it finishes first.
    void native.getRegisteredToolContext(nextTool, nextScope, nextProject, fresh).then(value => {
      if (value && !completed && alive.current && request === loadSequence.current) setScopedContext({ key, value });
    }).catch(() => { /* The workspace read supplies the final error/retry state. */ });
    try {
      const value = await native.getRegisteredToolWorkspace(nextTool, nextScope, nextProject, false, fresh);
      if (!alive.current || request !== loadSequence.current) return null;
      setWorkspace(value); setScopedContext({ key, value: { effectiveContextId: value.effectiveContextId, nativeContextError: value.nativeContextError ?? null } }); setCustomPath(value.customPath ?? ''); return value;
    } catch (failure) { if (alive.current && request === loadSequence.current) setError(errorText(failure)); return null; }
    finally { completed = true; if (alive.current && request === loadSequence.current) setLoading(false); }
  }, []);
  useEffect(() => { setWorkspace(null); setFrame(null); setDirty(false); setComparison(null); setFilter(''); setNotice(''); epoch.current++; if (active) void reload(toolId, scope, projectPath); }, [toolId, scope, projectPath, reload]);
  useEffect(() => { if (active && !workspace) void reload(toolId, scope, projectPath); }, [active]);
  useEffect(() => { if (nativeAvailable && active) void native.listProjects().then(value => { if (alive.current) setProjects(value); }).catch(failure => { if (alive.current) setError(errorText(failure)); }); }, [active]);
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
  function discard() { setFrame(null); setDirty(false); setResourceDirty({ mcp: false, skills: false, agents: false }); setResourceEpoch(value => value + 1); epoch.current++; }
  async function closeFrame() { if (await mayLeave()) { discard(); } }
  async function openFrame(subject: ConfigurationSubject, profile: RegisteredProfile | null = null, confirmed = false, title?: string) {
    if (!confirmed && !await mayLeave()) return;
    discard(); setError(''); setNotice('');
    setFrame({ key: crypto.randomUUID(), subject, profile, title: title ?? (subject === 'current' ? t('tools.workspace.frameCurrent') : subject === 'common' ? t('tools.workspace.frameCommon') : profile?.id ? t('tools.workspace.frameProfile', { name: profile.name }) : t('tools.workspace.frameNew')) });
  }
  async function launch() {
    if (!nativeAvailable || launching) return;
    setLaunching(true);
    try {
      const settings = await native.getLaunchSettings();
      const directory = await open({ directory: true, multiple: false, title: t('tools.workspace.launchPickTitle', { name: descriptor?.name ?? toolId }) });
      if (typeof directory !== 'string') return;
      await native.launchCli({ toolId, projectId: null, sessionId: null, mode: preferredLaunchMode(settings, 'cli', descriptor?.yoloAvailable ?? false), directory });
      setNotice(t('tools.workspace.launched', { name: descriptor?.name ?? toolId }));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setLaunching(false);
    }
  }
  async function createProfile() {    let name = t('tools.workspace.newProfile'); let suffix = 1;
    while (workspace?.profiles.some(profile => profile.name === name)) name = t('tools.workspace.newProfileN', { suffix: ++suffix });
    await openFrame('profile', { id: '', tool: toolId, name, version: 0, inheritCommon: false, files: {}, suppressed: {}, connection: null, nativeCredentials: {} });
  }
  async function switchScope(next: Scope, path = '') { if (next === scope && (next === 'global' || path === projectPath)) return; if (!await mayLeave()) return; discard(); setScope(next); setProjectPath(path); }
  function restoreContext(id: string, forcedResource?: ResourceView) {
    const stored = readStoredContexts()[id];
    if (!stored) { if (forcedResource) setResource(forcedResource); return; }
    setResource(forcedResource ?? stored.resource ?? 'config');
    setScope(stored.scope ?? 'global');
    setProjectPath(stored.projectPath ?? '');
  }
  async function switchTool(id: string) { if (id === toolId || !await mayLeave()) return; discard(); setTool(id); restoreContext(id); }
  async function switchResource(next: ResourceView) { if (next === resource || !await mayLeave()) return; discard(); setResource(next); }
  async function pickProject() { const started = currentContext.current; try { const value = await open({ directory: true, multiple: false, title: t('tools.workspace.pickProjectTitle') }); if (typeof value === 'string' && alive.current && started === currentContext.current) await switchScope('project', value); } catch (failure) { setError(errorText(failure)); } }
  const openTarget = async (profileId: string, target?: AccountImpactScope) => {
    if (!await mayLeave()) return;
    if (target && (target.toolId !== toolId || !target.scope || target.scope === 'project' && !target.projectPath)) { setError(t('tools.workspace.scopeChanged')); return; }
    const nextScope = target?.scope ?? scope; const nextPath = target?.projectPath ?? projectPath; const original = currentContext.current; const navigation = epoch.current;
    const value = await native.getRegisteredToolWorkspace(toolId, nextScope, nextPath, false, true).catch(failure => { setError(errorText(failure)); return null; });
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
    void (async () => { if (!await mayLeave()) return; discard(); setTool(repair.toolId!); setScope(repair.scope ?? 'global'); setProjectPath(repair.projectPath ?? ''); setResource(repair.resourceView ?? 'config'); if (repair.profileId) { const value = await native.getRegisteredToolWorkspace(repair.toolId!, repair.scope ?? 'global', repair.projectPath ?? '', false, true).catch(() => null); const profile = value?.profiles.find(item => item.id === repair.profileId); if (alive.current && profile) setTimeout(() => void openFrame('profile', profile, true), 0); } })();
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
    try { await native.applyRegisteredNativeProfile(toolId, profile.id, scope, projectPath || undefined, false); if (identity !== currentContext.current || !alive.current) return; await reload(toolId, scope, projectPath, true); setNotice(t('tools.workspace.applied')); }
    catch (failure) { if (identity !== currentContext.current || !alive.current) return; setError(errorText(failure)); try { const value = await native.compareRegisteredApplication(profile.id, scope, projectPath); if (identity === currentContext.current) setComparison(value); } catch {} }
    finally { if (identity === currentContext.current) setApplying(null); }
  }
  async function compareUse() {
    if (!comparison) return; const value = comparison; const identity = currentContext.current; setBusy(true); setError('');
    try { await native.applyComparedApplication(value, scope, projectPath); if (identity === currentContext.current && alive.current) { setComparison(null); await reload(toolId, scope, projectPath, true); setNotice(t('tools.workspace.appliedShort')); } }
    catch (failure) { if (identity === currentContext.current) setError(errorText(failure)); }
    finally { if (identity === currentContext.current) setBusy(false); }
  }
  async function duplicate(profile: RegisteredProfile) { if (!await mayLeave()) return; const copy = structuredClone(profile); copy.id = ''; copy.version = 0; delete copy.revision; copy.name += t('tools.workspace.copySuffix'); await openFrame('profile', copy, true, t('tools.workspace.frameCopy', { name: profile.name })); }
  async function remove(profile: RegisteredProfile) { const identity = currentContext.current; if (!await confirmAction(t('tools.workspace.confirmDelete', { name: profile.name }), () => alive.current && identity === currentContext.current, { title: t('tools.workspace.deleteTitle'), confirmLabel: t('tools.agents.delete'), destructive: true })) return; setBusy(true); try { await native.deleteNativeProfile(profile.id, profile.version, profile.revision ?? ''); if (identity === currentContext.current) await reload(toolId, scope, projectPath, true); } catch (failure) { setError(errorText(failure)); } finally { if (identity === currentContext.current) setBusy(false); } }
  function stored(result: ConfigurationSaveResult) { if (result.profile) setWorkspace(value => value ? { ...value, profiles: [...value.profiles.filter(profile => profile.id !== result.profile!.id), result.profile!] } : value); if (result.common) setWorkspace(value => value ? { ...value, common: result.common } : value); }
  function changed(_draft: ConfigurationDraft) { epoch.current++; }
  function cancelMaintenance() {
    if (!maintenance?.running || maintenance.cancelling) return;
    setMaintenance({ ...maintenance, cancelling: true });
    void native.cancelCliMaintenance(maintenance.tool).catch(failure => setMaintenance(previous => previous ? { ...previous, cancelling: false, error: errorText(failure) } : previous));
  }
  async function maintain(action: 'install' | 'upgrade' | 'install_native' | 'uninstall_npm', source?: string, retry = false) {
    if (busy) return;
    if (!retry && (!await mayLeave() || !await confirmAction(t('tools.workspace.maintainConfirm'), () => alive.current, { title: action === 'uninstall_npm' ? t('tools.workspace.maintainUninstallTitle') : action === 'install' || action === 'install_native' ? t('tools.workspace.maintainInstallTitle') : t('tools.workspace.maintainUpgradeTitle'), confirmLabel: action === 'uninstall_npm' ? t('tools.plugins.action.uninstall') : action === 'install' || action === 'install_native' ? t('tools.plugins.action.install') : t('tools.plugins.action.update') }))) return;
    const startedContext = currentContext.current;
    setBusy(true);
    setMaintenance({ tool: toolId, name: descriptor.name, running: true, action, source, output: '', error: '' });
    let stop: (() => void) | undefined;
    try {
      stop = await listen<MaintenanceProgress>('cliora:maintenance-progress', event => {
        if (alive.current && event.payload.toolId === toolId) setMaintenance(previous => previous ? { ...previous, output: event.payload.output } : previous);
      }).catch(() => undefined);
      const result = await native.maintainRegisteredCli(toolId, action, source);
      if (alive.current) setMaintenance(previous => previous ? { ...previous, running: false, output: result.output, version: result.version } : previous);
    } catch (failure) {
      if (alive.current) setMaintenance(previous => previous ? { ...previous, running: false, error: errorText(failure) } : previous);
    } finally {
      stop?.();
      if (alive.current) {
        setBusy(false);
        if (currentContext.current === startedContext) await reload(toolId, scope, projectPath, true);
      }
    }
  }
  async function savePath() { if (!await mayLeave()) return; setBusy(true); try { await native.setRegisteredCustomCliPath(toolId, customPath.trim() || null); await reload(toolId, scope, projectPath, true); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); } }
  async function usePath(path: string) { if (!await mayLeave()) return; setBusy(true); try { await native.setRegisteredCustomCliPath(toolId, path); await reload(toolId, scope, projectPath, true); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); } }
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
    const state = same ? applied ? t('tools.workspace.stateActive') : t('tools.workspace.statePending') : t('tools.workspace.stateSaved');
    const frozen = same && trusted ? binding?.appliedSummary : null;
    const frozenSource = frozen?.authentication.kind === 'oauth' ? t('tools.workspace.sourceManaged') : frozen?.authentication.kind === 'api_key' ? t('tools.workspace.sourceApiKey') : t('tools.workspace.sourceCli');
    const authentication = profile.authentication;
    const credential = authentication?.kind === 'oauth' ? t('tools.workspace.credentialAccount', { label: accounts.accounts.find(account => account.id === authentication.accountId)?.label ?? authentication.accountId }) : profile.authentication?.kind === 'api_key' ? t('tools.workspace.sourceApiKey') : profile.authentication?.kind === 'rebind_required' ? t('tools.workspace.credentialRebind') : t('tools.workspace.sourceCli');
    return <div className={styles.profileRow} role="listitem" data-profile-id={profile.id} data-active={applied || undefined} key={profile.id}>
      <span className={styles.profileMain}>
        <span className={styles.profileTitle}><button className={styles.profileName} title={profile.name} onClick={() => void openFrame('profile', profile)}>{profile.name}</button><span className={styles.badge} data-tone={applied ? 'ok' : same ? 'warn' : undefined}>{state}</span></span>
        <span className={styles.profileMeta}>{model && <span className={styles.profileModel} title={model}>{model}</span>}<span data-tone={authentication?.kind === 'rebind_required' ? 'warn' : undefined}>{t('tools.workspace.savedAs', { credential })}{host(profile.connection?.baseUrl) && ` · ${host(profile.connection?.baseUrl)}`}</span></span>
        {same && <span className={styles.profileHistory}><span>{t('tools.workspace.versions', { used: binding!.profileVersion, saved: profile.version })}{commonPending ? t('tools.workspace.commonPending') : ''}</span><span>{t('tools.workspace.lastUsed', { summary: frozen ? `${frozenSource}${frozen.providerId ? ' · '+frozen.providerId : ''}${host(frozen.baseUrl ?? undefined) ? ' · '+host(frozen.baseUrl ?? undefined) : ''}${frozen.model ? ' · '+frozen.model : ''}` : t('tools.workspace.noSnapshot') })}</span></span>}
      </span>
      <span className={styles.profileActions}>{!applied && <button className={styles.primary} disabled={busy || !!applying || workspace?.probe.nativeWrites.state !== 'supported'} onClick={() => void apply(profile)}>{applying === profile.id ? t('tools.workspace.applying') : same ? t('tools.workspace.useNew') : t('tools.workspace.use')}</button>}<button onClick={() => void openFrame('profile', profile)}>{t('tools.workspace.edit')}</button><RowMenu label={t('tools.workspace.rowMenu', { name: profile.name })}><button role="menuitem" onClick={() => void openFrame('profile', profile)}>{t('tools.workspace.editConfig')}</button><button role="menuitem" onClick={() => void duplicate(profile)}>{t('tools.workspace.duplicateConfig')}</button><button role="menuitem" onClick={() => setQuotaAddFor(profile.id)}>{t('tools.workspace.addQuota')}</button><button role="menuitem" data-danger="true" onClick={() => void remove(profile)}>{t('tools.workspace.deleteConfig')}</button></RowMenu></span>
      <ProfileQuota profileId={profile.id} profileVersion={profile.version} toolId={toolId} profileAccountId={profile.authentication?.kind === 'oauth' ? profile.authentication.accountId : undefined} state={quota} addRequested={quotaAddFor === profile.id} onAddHandled={() => setQuotaAddFor(null)} />
    </div>;
  }
  const linkedAuthentication = workspace?.profiles.find(profile => profile.id === accountUsageQuery?.config.identity.profileId)?.authentication;
  const queryAccount = linkedAuthentication?.kind === 'oauth' ? linkedAuthentication.accountId : accountUsageQuery?.config.identity.profileId ? undefined : accountUsageQuery?.config.identity.accountId ?? undefined;
  const resourceContext = scopedContext?.key === context ? scopedContext.value : null;
  const resourcesReady = resourceContext !== null && !resourceContext.nativeContextError;
  if (!descriptor) return <p>{t('tools.workspace.noTools')}</p>;
  return <section className={styles.workspace} aria-label={t('common.nav.connections')}>
    <div className={styles.chrome}>
    <div className={styles.toolbar}><div className={styles.toolSwitcher} role="tablist" aria-label="CLI" onKeyDown={navigateChoices}>{managedTools.map(item => <button key={item.id} role="tab" aria-selected={item.id === toolId} tabIndex={item.id === toolId ? 0 : -1} className={item.id === toolId ? styles.selected : ''} onClick={() => void switchTool(item.id)}><ToolIcon toolId={item.id} size={23} />{item.name}</button>)}</div></div>
    <div className={styles.taskBar}><div className={styles.views} role="tablist" aria-label={t('tools.workspace.tasksAria')} onKeyDown={navigateChoices}>{resourceViews.filter((id) => supported[id]).map((id) => { const label = t(`tools.workspace.view.${id}`); const shortcutIndex = resourceViews.findIndex((view) => view === id) + 1; return <button role="tab" key={id} aria-selected={resource === id} aria-keyshortcuts={`Alt+${shortcutIndex}`} tabIndex={resource === id ? 0 : -1} title={t('tools.workspace.viewTitle', { label, index: shortcutIndex })} className={resource === id ? styles.selected : ''} onClick={() => void switchResource(id)}>{label}</button>; })}</div><div className={styles.scopeBar}><FilterSelect className={styles.projectSelect} label={t('tools.workspace.scopeLabel')} value={scope === 'global' ? '__global__' : projectPath} forceSearch searchLabel={t('home.launcher.searchLabel')} options={[{ value: '__global__', label: t('tools.workspace.scopeGlobal') }, ...projects.map(project => ({ value: project.path ?? project.id, label: project.name, detail: project.path ? shortPath(project.path) : undefined, disabled: !project.available || !project.path })), ...(projectPath && !projects.some(project => project.path === projectPath) ? [{ value: projectPath, label: projectPath.split(/[\\/]/).at(-1) ?? projectPath }] : [])]} onChange={value => void switchScope(value === '__global__' ? 'global' : 'project', value === '__global__' ? '' : value)} onPickFolder={() => void pickProject()} pickFolderLabel={t('common.filterSelect.pickFolder')} /></div></div>
    </div>
    {(error || notice) && <div className={styles.feedback}>{error && <StatusBanner tone="error" onDismiss={() => setError('')}>{error}</StatusBanner>}{notice && <StatusBanner tone="success" autoDismissMs={8000} onDismiss={() => setNotice('')}>{notice}</StatusBanner>}</div>}
    <div hidden={resource !== 'config'}>
      {workspace && <InstallPanel toolName={descriptor.name} probe={workspace.probe} customPath={customPath} busy={busy} loading={loading} onCustomPath={setCustomPath} onSavePath={() => void savePath()} onMaintain={(action, source) => void maintain(action, source)} onUsePath={path => void usePath(path)} />}
      {workspace?.nativeContextError && <div className={styles.feedback}><StatusBanner tone="error">{workspace.nativeContextError}</StatusBanner></div>}
      {workspace?.recoveryNeeded.length ? <div className={styles.feedback}><StatusBanner tone="error" action={<button type="button" onClick={() => { void native.recoverNativeTransactions().then(() => reload(toolId, scope, projectPath, true)).catch(failure => setError(errorText(failure))); }}>{t('tools.workspace.retryRecovery')}</button>}>{t('tools.workspace.recoveryNeeded', { count: workspace.recoveryNeeded.length })}</StatusBanner></div> : null}
      {!workspace ? (loading && nativeAvailable
        ? <div className={styles.loadingList} role="status" aria-label={t('tools.workspace.loading')}><span className="skeleton-block short" /><span className="skeleton-block" /><span className="skeleton-block" /></div>
        : <div className={styles.taskEmpty} data-tone={nativeAvailable ? 'error' : undefined}><Icon name={nativeAvailable ? 'alert' : 'monitor'} size={22} strokeWidth={1.5} /><div><strong>{nativeAvailable ? t('tools.workspace.loadFailed') : t('tools.workspace.needDesktop')}</strong><p>{nativeAvailable ? t('tools.workspace.loadFailedHint') : t('tools.workspace.previewHint')}</p></div>{nativeAvailable && <button className={styles.primary} onClick={() => void reload(toolId, scope, projectPath)}>{t('tools.workspace.retryLoad')}</button>}</div>)
      : <div className={styles.profileList} aria-label={t('tools.workspace.listAria')}>
        <div className={styles.listHeading}><strong>{t('tools.workspace.profilesTitle')}{workspace.profiles.length > 0 && <span className="count-chip">{workspace.profiles.length}</span>}</strong><span className={styles.listActions}><button title={t('tools.workspace.launchTitle', { name: descriptor.name })} disabled={launching || !workspace} onClick={() => void launch()}><Icon name="play" size={13} strokeWidth={2} />{launching ? t('tools.workspace.launching') : t('home.tools.launch')}</button><button title={t('tools.workspace.commonTitle')} onClick={() => void openFrame('common')}><Icon name="settings" size={14} />{t('tools.workspace.common')}</button><button className={styles.primary} onClick={() => void createProfile()}><Icon name="plus" size={14} strokeWidth={2.2} />{t('tools.workspace.frameNew')}</button></span></div>
        {currentFile && <div className={styles.profileRow} data-kind="native"><span><button className={styles.profileName} onClick={() => void openFrame('current')}>{t('tools.workspace.currentFile')}</button><small>{t('tools.workspace.currentFileHint')}</small></span><button onClick={() => void openFrame('current')}>{t('tools.workspace.edit')}</button></div>}
        {workspace.profiles.length > 6 && <label className={styles.profileFilter}><SearchField type="search" label={t('home.tools.searchProfile')} pageSearch title={searchShortcutHint()} placeholder={t('tools.workspace.searchPlaceholder')} value={filter} onChange={setFilter} />{query && <span>{profileGroups.reduce((total, group) => total + group.visible.length, 0)} / {workspace.profiles.length}</span>}</label>}
        {!workspace.profiles.length && <div className={styles.profileEmpty}><strong>{t('tools.workspace.emptyTitle')}</strong><span>{t('tools.workspace.emptyDetail')}{currentFile ? t('tools.workspace.emptyCurrent') : ''}</span><button className={styles.primary} onClick={() => void createProfile()}><Icon name="plus" size={14} strokeWidth={2.2} />{t('tools.workspace.emptyCreate')}</button></div>}
        {query && !profileGroups.length && <div className={styles.profileEmpty}><span>{t('tools.workspace.noMatch', { query: filter.trim() })}</span><button onClick={() => setFilter('')}>{t('tools.workspace.clearSearch')}</button></div>}
        <div role="list" aria-label={t('tools.workspace.itemsAria')} className={workspace.profiles.length > 6 ? styles.profileScroll : undefined}>{profileGroups.map(group => <div key={group.id} className={styles.profileGroup} data-group={group.id}><div className={styles.groupLabel}><strong>{group.label}</strong><span>{query ? `${group.visible.length}/${group.profiles.length}` : group.profiles.length}</span></div>{group.visible.map(row)}</div>)}</div>
      </div>}
      <GuideDialog wide suspended={!active} open={!!frame} title={frame?.title ?? t('tools.workspace.frameFallback')} hint={t('tools.workspace.frameHint', { tool: descriptor.name, scope: scope === 'global' ? t('tools.apply.global') : projectPath })} onClose={() => void closeFrame()} onBack={() => void closeFrame()}>{frame && !workspace && <p role="status">{t('tools.workspace.frameLoading')}</p>}{frame && workspace && <ConfigurationWorkspaceEditor key={frame.key} toolId={toolId} subject={frame.subject} profile={frame.profile} scope={scope} projectPath={projectPath} workspace={workspace} accounts={accounts} onClose={() => void closeFrame()} onDirtyChange={value => { if (value) epoch.current++; setDirty(value); }} onDraftChange={changed} onStored={stored} onDone={(result, used) => { setFrame(null); setDirty(false); setNotice(result.application ? t('tools.workspace.doneUpdated') : used ? t('tools.workspace.doneSavedUsed') : t('tools.workspace.doneSaved')); void reload(toolId, scope, projectPath, true); }} />}</GuideDialog>
      <GuideDialog wide open={!!comparison} title={t('home.conflict.title')} onClose={() => setComparison(null)}>{comparison && <div>{comparison.files.map((file, index) => <ConflictCompare key={file.role} title={file.role} banner={index === 0 ? t('tools.workspace.compareBanner') : undefined} actions={false} currentContent={file.current} nextContent={file.proposedText} format={file.format} onUseNext={() => void compareUse()} onKeepCurrent={() => setComparison(null)} />)}<div className="dialog-footer"><button onClick={() => setComparison(null)}>{t('common.conflict.keepCurrent')}</button><span className="dialog-footer-gap" /><button className={styles.primary} disabled={busy} onClick={() => void compareUse()}>{t('common.conflict.useNext')}</button></div></div>}</GuideDialog>
    </div>
    {resource === 'accounts' && supported.accounts && <AccountsPanel key={toolId} toolId={toolId} state={accounts} onOpenProfile={(id, target) => void openTarget(id, target)} onOpenUsage={id => void openAccountQuota(id)} />}
    {resource === 'accounts' && accountUsageQuery && <QuotaEditor key={accountUsageQuery.id} query={accountUsageQuery} profileId={accountUsageQuery.config.identity.profileId ?? ''} profileAccountId={queryAccount} toolId={toolId} presets={quota.presets} onClose={() => setAccountUsageQuery(null)} onSaved={() => { setAccountUsageQuery(null); void quota.reload(); }} />}
    {!['config', 'accounts'].includes(resource) && !resourcesReady && <div role="status"><p>{resourceContext?.nativeContextError ?? (loading ? t('tools.workspace.contextLoading') : workspace?.nativeContextError ?? t('tools.workspace.contextFailed'))}</p>{!loading && <button onClick={() => void reload(toolId, scope, projectPath, true)}>{t('tools.workspace.contextRetry')}</button>}</div>}
    {resourcesReady && resource === 'mcp' && supported.mcp && <McpWorkspace key={`${context}:${resourceEpoch}:${resourceContext?.effectiveContextId}`} toolId={toolId} scope={scope} projectPath={projectPath} contextId={resourceContext?.effectiveContextId ?? null} onDirtyChange={mcpDirty} />}
    {resourcesReady && resource === 'skills' && supported.skills && <SkillsWorkspace key={`${context}:${resourceEpoch}:${resourceContext?.effectiveContextId}`} toolId={toolId} scope={scope} projectPath={projectPath} contextId={resourceContext?.effectiveContextId ?? null} onDirtyChange={skillsDirty} />}
    {resourcesReady && resource === 'agents' && supported.agents && <AgentsWorkspace key={`${context}:${resourceEpoch}:${resourceContext?.effectiveContextId}`} toolId={toolId} scope={scope} projectPath={projectPath} contextId={resourceContext?.effectiveContextId ?? null} onDirtyChange={agentsDirty} />}
    {resourcesReady && resource === 'plugins' && supported.plugins && <PluginsWorkspace key={`${context}:${resourceEpoch}:${resourceContext?.effectiveContextId}`} toolId={toolId} scope={scope} projectPath={projectPath} contextId={resourceContext?.effectiveContextId ?? null} />}
    <GuideDialog open={!!maintenance} title={t('tools.workspace.maintenanceTitle', { name: maintenance?.name })} onClose={() => { if (maintenance?.running) cancelMaintenance(); else setMaintenance(null); }}>
      {maintenance && <>
        <p role="status">{maintenance.running ? t('tools.workspace.maintenanceRunning') : maintenance.error || t('tools.workspace.maintenanceDone', { version: maintenance.version ?? '' })}</p>
        {maintenance.running && maintenance.error && <p role="alert">{maintenance.error}</p>}
        <pre className={styles.maintenanceLog} aria-label={t('tools.workspace.maintenanceLog')}>{maintenance.output || t('tools.workspace.maintenanceWaiting')}</pre>
        <div className="dialog-footer">{maintenance.running
          ? <button disabled={maintenance.cancelling} onClick={cancelMaintenance}>{t(maintenance.cancelling ? 'tools.workspace.maintenanceCancelling' : 'tools.workspace.maintenanceCancel')}</button>
          : <>{maintenance.error && maintenance.tool === toolId && <button disabled={busy} onClick={() => void maintain(maintenance.action, maintenance.source, true)}>{t('tools.workspace.maintenanceRetry')}</button>}<button onClick={() => setMaintenance(null)}>{t('tools.workspace.maintenanceClose')}</button></>}</div>
      </>}
    </GuideDialog>
  </section>;
}
