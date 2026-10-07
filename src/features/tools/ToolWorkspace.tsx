import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import { configurationApplicationState } from '../../lib/configurationDraft';
import { confirmAction } from '../../lib/confirm';
import { searchShortcutHint } from '../../lib/shortcut';
import type { AdapterDescriptor, RegisteredProfile, RegisteredToolWorkspace, Scope, ApplyComparison } from '../../types/native';
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
import styles from './ToolWorkspace.module.css';

const errorText = (value: unknown) => value && typeof value === 'object' && 'message' in value ? String(value.message) : '操作失败，请重试。';
function host(address?: string) { try { return address ? new URL(address).host : ''; } catch { return '地址待核验'; } }
function RowMenu({ label, children }: { label: string; children: ReactNode }) {
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
    <button ref={trigger} type="button" className={styles.rowMenuButton} aria-label={label} title="更多操作" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true); } }}><svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg></button>
    {open && createPortal(<div ref={panel} className={styles.rowMenuList} role="menu" aria-label={label} style={box ? { top: box.top, left: box.left } : { top: 0, left: -10000 }} onKeyDown={keyNavigate} onClick={() => dismiss(true)}>{children}</div>, document.body)}
  </div>;
}


type ResourceView = 'config' | 'accounts' | 'mcp' | 'skills' | 'plugins' | 'agents';
type EditFrame = { key: string; subject: ConfigurationSubject; profile: RegisteredProfile | null; title: string };
export type WorkspaceOpenIntent = { resource?: ResourceView; create?: boolean };

const resourceViews: Array<[ResourceView, string]> = [['config', '配置'], ['accounts', '账号'], ['mcp', 'MCP'], ['skills', 'Skill'], ['agents', 'Agents'], ['plugins', '插件']];
const contextStoreKey = 'cliora:workspace-context';
type StoredContext = { resource?: ResourceView; scope?: Scope; projectPath?: string };
function readStoredContexts(): Record<string, StoredContext> {
  try { return JSON.parse(localStorage.getItem(contextStoreKey) ?? '{}') as Record<string, StoredContext>; } catch { return {}; }
}
export function ToolWorkspacePage({ managedTools, initialTool, openSequence = 0, openIntent = null, active = true, repair, onDirtyChange, discardSignal = 0 }: { active?: boolean; managedTools: AdapterDescriptor[]; initialTool?: string; openSequence?: number; openIntent?: WorkspaceOpenIntent | null; repair?: TrayRepairTarget | null; onDirtyChange?: (dirty: boolean) => void; discardSignal?: number }) {
  const [tool, setTool] = useState(repair?.toolId ?? initialTool ?? managedTools[0]?.id ?? '');
  const descriptor = managedTools.find(item => item.id === tool) ?? managedTools[0];
  const toolId = descriptor?.id ?? '';
  const [scope, setScope] = useState<Scope>(repair?.scope ?? readStoredContexts()[tool]?.scope ?? 'global');
  const [projectPath, setProjectPath] = useState(repair?.projectPath ?? readStoredContexts()[tool]?.projectPath ?? '');
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspace, setWorkspace] = useState<RegisteredToolWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
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
  const reload = useCallback(async (nextTool: string, nextScope: Scope, nextProject: string) => {
    if (!nativeAvailable || !nextTool || nextScope === 'project' && !nextProject) { setLoading(false); setWorkspace(null); return null; }
    const request = ++loadSequence.current; setLoading(true); setError('');
    try {
      const value = await native.getRegisteredToolWorkspace(nextTool, nextScope, nextProject, false, true);
      if (!alive.current || request !== loadSequence.current) return null;
      setWorkspace(value); setCustomPath(value.customPath ?? ''); return value;
    } catch (failure) { if (alive.current && request === loadSequence.current) setError(errorText(failure)); return null; }
    finally { if (alive.current && request === loadSequence.current) setLoading(false); }
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
  async function mayLeave(message = '当前草稿尚未保存，继续会丢失这些修改。是否放弃修改？') {
    if (!currentDirty.current) return true;
    const identity = currentContext.current; const revision = epoch.current;
    return confirmAction(message, () => alive.current && currentContext.current === identity && epoch.current === revision, { title: '放弃未保存修改？', confirmLabel: '放弃修改' });
  }
  function discard() { setFrame(null); setDirty(false); setResourceDirty({ mcp: false, skills: false, agents: false }); setResourceEpoch(value => value + 1); epoch.current++; }
  async function closeFrame() { if (await mayLeave()) { discard(); } }
  async function openFrame(subject: ConfigurationSubject, profile: RegisteredProfile | null = null, confirmed = false, title?: string) {
    if (!confirmed && !await mayLeave()) return;
    discard(); setError(''); setNotice('');
    setFrame({ key: crypto.randomUUID(), subject, profile, title: title ?? (subject === 'current' ? '修改正在使用的文件' : subject === 'common' ? '修改通用配置' : profile?.id ? `修改配置 · ${profile.name}` : '新建配置') });
  }
  async function launch() {
    if (!nativeAvailable || launching) return;
    setLaunching(true);
    try {
      const settings = await native.getLaunchSettings();
      const directory = await open({ directory: true, multiple: false, title: `选择 ${descriptor?.name ?? toolId} 启动工作目录` });
      if (typeof directory !== 'string') return;
      await native.launchCli({ toolId, projectId: null, sessionId: null, mode: preferredLaunchMode(settings, 'cli', descriptor?.yoloAvailable ?? false), directory });
      setNotice(`${descriptor?.name ?? toolId} 已向外部终端发出启动请求。`);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setLaunching(false);
    }
  }
  async function createProfile() {    let name = '新配置'; let suffix = 1;
    while (workspace?.profiles.some(profile => profile.name === name)) name = `新配置 ${++suffix}`;
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
  async function pickProject() { const started = currentContext.current; try { const value = await open({ directory: true, multiple: false, title: '选择配置项目文件夹' }); if (typeof value === 'string' && alive.current && started === currentContext.current) await switchScope('project', value); } catch (failure) { setError(errorText(failure)); } }
  const openTarget = async (profileId: string, target?: AccountImpactScope) => {
    if (!await mayLeave()) return;
    if (target && (target.toolId !== toolId || !target.scope || target.scope === 'project' && !target.projectPath)) { setError('范围关联已变化，请刷新账号关联。'); return; }
    const nextScope = target?.scope ?? scope; const nextPath = target?.projectPath ?? projectPath; const original = currentContext.current; const navigation = epoch.current;
    const value = await native.getRegisteredToolWorkspace(toolId, nextScope, nextPath, false, true).catch(failure => { setError(errorText(failure)); return null; });
    if (!alive.current || original !== currentContext.current || navigation !== epoch.current || !value) return;
    const profile = value.profiles.find(item => item.id === profileId);
    if (!profile) { setError('关联配置已不存在，请刷新。'); return; }
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
      const next = resourceViews[index][0];
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
    try { await native.applyRegisteredNativeProfile(toolId, profile.id, scope, projectPath || undefined, false); if (identity !== currentContext.current || !alive.current) return; await reload(toolId, scope, projectPath); setNotice('已使用保存的配置；下次会话读取新内容。'); }
    catch (failure) { if (identity !== currentContext.current || !alive.current) return; setError(errorText(failure)); try { const value = await native.compareRegisteredApplication(profile.id, scope, projectPath); if (identity === currentContext.current) setComparison(value); } catch {} }
    finally { if (identity === currentContext.current) setApplying(null); }
  }
  async function compareUse() {
    if (!comparison) return; const value = comparison; const identity = currentContext.current; setBusy(true); setError('');
    try { await native.applyComparedApplication(value, scope, projectPath); if (identity === currentContext.current && alive.current) { setComparison(null); await reload(toolId, scope, projectPath); setNotice('已使用保存的配置；下次会话读取。'); } }
    catch (failure) { if (identity === currentContext.current) setError(errorText(failure)); }
    finally { if (identity === currentContext.current) setBusy(false); }
  }
  async function duplicate(profile: RegisteredProfile) { if (!await mayLeave()) return; const copy = structuredClone(profile); copy.id = ''; copy.version = 0; delete copy.revision; copy.name += ' 副本'; await openFrame('profile', copy, true, `复制配置 · 来自 ${profile.name}`); }
  async function remove(profile: RegisteredProfile) { const identity = currentContext.current; if (!await confirmAction(`删除“${profile.name}”的管理记录？当前原生文件保留。`, () => alive.current && identity === currentContext.current, { title: '删除配置', confirmLabel: '删除', destructive: true })) return; setBusy(true); try { await native.deleteNativeProfile(profile.id, profile.version, profile.revision ?? ''); if (identity === currentContext.current) await reload(toolId, scope, projectPath); } catch (failure) { setError(errorText(failure)); } finally { if (identity === currentContext.current) setBusy(false); } }
  function stored(result: ConfigurationSaveResult) { if (result.profile) setWorkspace(value => value ? { ...value, profiles: [...value.profiles.filter(profile => profile.id !== result.profile!.id), result.profile!] } : value); if (result.common) setWorkspace(value => value ? { ...value, common: result.common } : value); }
  function changed(_draft: ConfigurationDraft) { epoch.current++; }
  async function maintain(action: 'install' | 'upgrade' | 'install_native' | 'uninstall_npm', source?: string) {
    if (!await mayLeave() || !await confirmAction('将更新本机 CLI 安装。继续吗？', () => alive.current, { title: action === 'uninstall_npm' ? '卸载 npm 版' : action === 'install' || action === 'install_native' ? '安装 CLI' : '更新 CLI', confirmLabel: action === 'uninstall_npm' ? '卸载' : action === 'install' || action === 'install_native' ? '安装' : '更新' })) return;
    setBusy(true); try { await native.maintainRegisteredCli(toolId, action, source); await reload(toolId, scope, projectPath); } catch (failure) { setError(errorText(failure)); } finally { if (alive.current) setBusy(false); }
  }
  async function savePath() { if (!await mayLeave()) return; setBusy(true); try { await native.setRegisteredCustomCliPath(toolId, customPath.trim() || null); await reload(toolId, scope, projectPath); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); } }
  async function usePath(path: string) { if (!await mayLeave()) return; setBusy(true); try { await native.setRegisteredCustomCliPath(toolId, path); await reload(toolId, scope, projectPath); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); } }
  async function openAccountQuota(queryId: string) { if (!await mayLeave()) return; const query = quota.queries.find(item => item.id === queryId); if (!query) { void quota.reload(); setError('额度引用已变化，请刷新后重试。'); return; } setAccountUsageQuery(query); }
  const quotaIds = new Set(quota.queries.map(query => query.config.identity.profileId));
  const currentFile = workspace?.snapshots.some(snapshot => snapshot.fingerprint && !workspace.probe.nativeFiles.find(file => file.role === snapshot.role)?.sensitive);
  const modelOf = (profile: RegisteredProfile) => workspace?.profileModelSummaries ? workspace.profileModelSummaries[profile.id]?.model : profile.connection?.model;
  const query = filter.trim().toLocaleLowerCase();
  const matches = (profile: RegisteredProfile) => !query || [profile.name, modelOf(profile), host(profile.connection?.baseUrl)].some(value => value?.toLocaleLowerCase().includes(query));
  const profileGroups = (workspace ? [{ id: 'subscription', label: '订阅套餐', profiles: workspace.profiles.filter(profile => quotaIds.has(profile.id) || profile.authentication?.kind === 'oauth') }, { id: 'other', label: '其他配置', profiles: workspace.profiles.filter(profile => !quotaIds.has(profile.id) && profile.authentication?.kind !== 'oauth') }] : [])
    .map(group => ({ ...group, visible: group.profiles.filter(matches) })).filter(group => group.visible.length);
  function row(profile: RegisteredProfile) {
    const binding = workspace?.binding;
    const { same, commonPending, trusted, applied } = configurationApplicationState(profile, binding, workspace?.common);
    const model = modelOf(profile);
    const state = same ? applied ? '正在使用' : '已保存，待使用' : '已保存';
    const frozen = same && trusted ? binding?.appliedSummary : null;
    const frozenSource = frozen?.authentication.kind === 'oauth' ? '已管理账号' : frozen?.authentication.kind === 'api_key' ? 'API 密钥' : 'CLI 当前凭据';
    const authentication = profile.authentication;
    const credential = authentication?.kind === 'oauth' ? `账号 ${accounts.accounts.find(account => account.id === authentication.accountId)?.label ?? authentication.accountId}` : profile.authentication?.kind === 'api_key' ? 'API 密钥' : profile.authentication?.kind === 'rebind_required' ? '需重新选择来源' : 'CLI 当前凭据';
    return <div className={styles.profileRow} role="listitem" data-profile-id={profile.id} data-active={applied || undefined} key={profile.id}>
      <span className={styles.profileMain}>
        <span className={styles.profileTitle}><button className={styles.profileName} title={profile.name} onClick={() => void openFrame('profile', profile)}>{profile.name}</button><span className={styles.badge} data-tone={applied ? 'ok' : same ? 'warn' : undefined}>{state}</span></span>
        <span className={styles.profileMeta}>{model && <span className={styles.profileModel} title={model}>{model}</span>}<span data-tone={authentication?.kind === 'rebind_required' ? 'warn' : undefined}>保存设置：{credential}{host(profile.connection?.baseUrl) && ` · ${host(profile.connection?.baseUrl)}`}</span></span>
        {same && <span className={styles.profileHistory}><span>最后使用版本 {binding!.profileVersion} · 保存版本 {profile.version}{commonPending && ' · 通用配置待应用'}</span><span>上次已使用：{frozen ? `${frozenSource}${frozen.providerId ? ' · '+frozen.providerId : ''}${host(frozen.baseUrl ?? undefined) ? ' · '+host(frozen.baseUrl ?? undefined) : ''}${frozen.model ? ' · '+frozen.model : ''}` : '来源快照未提供，以最后使用版本为准'}</span></span>}
      </span>
      <span className={styles.profileActions}>{!applied && <button className={styles.primary} disabled={busy || !!applying || workspace?.probe.nativeWrites.state !== 'supported'} onClick={() => void apply(profile)}>{applying === profile.id ? '使用中' : same ? '使用新版本' : '使用'}</button>}<button onClick={() => void openFrame('profile', profile)}>修改</button><RowMenu label={`${profile.name} 更多操作`}><button role="menuitem" onClick={() => void openFrame('profile', profile)}>修改配置</button><button role="menuitem" onClick={() => void duplicate(profile)}>复制配置</button><button role="menuitem" onClick={() => setQuotaAddFor(profile.id)}>添加额度查询</button><button role="menuitem" data-danger="true" onClick={() => void remove(profile)}>删除配置</button></RowMenu></span>
      <ProfileQuota profileId={profile.id} profileVersion={profile.version} toolId={toolId} profileAccountId={profile.authentication?.kind === 'oauth' ? profile.authentication.accountId : undefined} state={quota} addRequested={quotaAddFor === profile.id} onAddHandled={() => setQuotaAddFor(null)} />
    </div>;
  }
  const linkedAuthentication = workspace?.profiles.find(profile => profile.id === accountUsageQuery?.config.identity.profileId)?.authentication;
  const queryAccount = linkedAuthentication?.kind === 'oauth' ? linkedAuthentication.accountId : accountUsageQuery?.config.identity.profileId ? undefined : accountUsageQuery?.config.identity.accountId ?? undefined;
  if (!descriptor) return <p>还没有管理中的 CLI，请在设置中选择工具。</p>;
  return <section className={styles.workspace} aria-label="工具与连接">
    <div className={styles.chrome}>
    <div className={styles.toolbar}><div className={styles.toolSwitcher} role="tablist" aria-label="CLI" onKeyDown={navigateChoices}>{managedTools.map(item => <button key={item.id} role="tab" aria-selected={item.id === toolId} tabIndex={item.id === toolId ? 0 : -1} className={item.id === toolId ? styles.selected : ''} onClick={() => void switchTool(item.id)}><ToolIcon toolId={item.id} size={23} />{item.name}</button>)}</div></div>
    <div className={styles.taskBar}><div className={styles.views} role="tablist" aria-label="当前任务" onKeyDown={navigateChoices}>{resourceViews.filter(([id]) => supported[id]).map(([id, label]) => { const shortcutIndex = resourceViews.findIndex(([view]) => view === id) + 1; return <button role="tab" key={id} aria-selected={resource === id} aria-keyshortcuts={`Alt+${shortcutIndex}`} tabIndex={resource === id ? 0 : -1} title={`${label}（Alt+${shortcutIndex}）`} className={resource === id ? styles.selected : ''} onClick={() => void switchResource(id)}>{label}</button>; })}</div><div className={styles.scopeBar}><FilterSelect className={styles.projectSelect} label="配置范围" value={scope === 'global' ? '__global__' : projectPath} forceSearch searchLabel="搜索项目" options={[{ value: '__global__', label: '全局配置' }, ...projects.map(project => ({ value: project.path ?? project.id, label: project.name, detail: project.path ? shortPath(project.path) : undefined, disabled: !project.available || !project.path })), ...(projectPath && !projects.some(project => project.path === projectPath) ? [{ value: projectPath, label: projectPath.split(/[\\/]/).at(-1) ?? projectPath }] : [])]} onChange={value => void switchScope(value === '__global__' ? 'global' : 'project', value === '__global__' ? '' : value)} onPickFolder={() => void pickProject()} pickFolderLabel="选择文件夹…" /></div></div>
    </div>
    {(error || notice) && <div className={styles.feedback}>{error && <StatusBanner tone="error" onDismiss={() => setError('')}>{error}</StatusBanner>}{notice && <StatusBanner tone="success" autoDismissMs={8000} onDismiss={() => setNotice('')}>{notice}</StatusBanner>}</div>}
    <div hidden={resource !== 'config'}>
      {workspace && <InstallPanel toolName={descriptor.name} probe={workspace.probe} customPath={customPath} busy={busy} loading={loading} onCustomPath={setCustomPath} onSavePath={() => void savePath()} onMaintain={(action, source) => void maintain(action, source)} onUsePath={path => void usePath(path)} />}
      {workspace?.nativeContextError && <div className={styles.feedback}><StatusBanner tone="error">{workspace.nativeContextError}</StatusBanner></div>}
      {workspace?.recoveryNeeded.length ? <div className={styles.feedback}><StatusBanner tone="error" action={<button type="button" onClick={() => { void native.recoverNativeTransactions().then(() => reload(toolId, scope, projectPath)).catch(failure => setError(errorText(failure))); }}>重试恢复</button>}>有 {workspace.recoveryNeeded.length} 项文件事务需要恢复。</StatusBanner></div> : null}
      {!workspace ? (loading && nativeAvailable
        ? <div className={styles.loadingList} role="status" aria-label="正在读取配置"><span className="skeleton-block short" /><span className="skeleton-block" /><span className="skeleton-block" /></div>
        : <div className={styles.taskEmpty} data-tone={nativeAvailable ? 'error' : undefined}><Icon name={nativeAvailable ? 'alert' : 'monitor'} size={22} strokeWidth={1.5} /><div><strong>{nativeAvailable ? '配置读取失败' : '需要桌面应用'}</strong><p>{nativeAvailable ? '已有记录未被删除，可以重新读取。' : '浏览器预览无法读取本机 CLI 的原生配置。'}</p></div>{nativeAvailable && <button className={styles.primary} onClick={() => void reload(toolId, scope, projectPath)}>重试读取配置</button>}</div>)
      : <div className={styles.profileList} aria-label="配置列表">
        <div className={styles.listHeading}><strong>配置{workspace.profiles.length > 0 && <span className="count-chip">{workspace.profiles.length}</span>}</strong><span className={styles.listActions}><button title={`在外部终端启动 ${descriptor.name}`} disabled={launching || !workspace} onClick={() => void launch()}><Icon name="play" size={13} strokeWidth={2} />{launching ? '正在启动…' : '启动'}</button><button title="所有命名配置可继承的共享设置" onClick={() => void openFrame('common')}><Icon name="settings" size={14} />通用配置</button><button className={styles.primary} onClick={() => void createProfile()}><Icon name="plus" size={14} strokeWidth={2.2} />新建配置</button></span></div>
        {currentFile && <div className={styles.profileRow} data-kind="native"><span><button className={styles.profileName} onClick={() => void openFrame('current')}>正在使用的文件</button><small>直接编辑当前范围的原生文件</small></span><button onClick={() => void openFrame('current')}>修改</button></div>}
        {workspace.profiles.length > 6 && <label className={styles.profileFilter}><SearchField type="search" label="搜索配置" pageSearch title={searchShortcutHint} placeholder="按名称、模型或地址搜索配置" value={filter} onChange={setFilter} />{query && <span>{profileGroups.reduce((total, group) => total + group.visible.length, 0)} / {workspace.profiles.length}</span>}</label>}
        {!workspace.profiles.length && <div className={styles.profileEmpty}><strong>还没有命名配置</strong><span>命名配置可保存不同的供应商、模型和凭据，随时切换使用。{currentFile ? '也可以直接修改正在使用的文件。' : ''}</span><button className={styles.primary} onClick={() => void createProfile()}><Icon name="plus" size={14} strokeWidth={2.2} />新建第一个配置</button></div>}
        {query && !profileGroups.length && <div className={styles.profileEmpty}><span>没有匹配“{filter.trim()}”的配置。</span><button onClick={() => setFilter('')}>清除搜索</button></div>}
        <div role="list" aria-label="配置项" className={workspace.profiles.length > 6 ? styles.profileScroll : undefined}>{profileGroups.map(group => <div key={group.id} className={styles.profileGroup} data-group={group.id}><div className={styles.groupLabel}><strong>{group.label}</strong><span>{query ? `${group.visible.length}/${group.profiles.length}` : group.profiles.length}</span></div>{group.visible.map(row)}</div>)}</div>
      </div>}
      <GuideDialog wide suspended={!active} open={!!frame} title={frame?.title ?? '配置'} hint={`${descriptor.name} · ${scope === 'global' ? '全局' : projectPath}。保存配置只入库，使用是独立操作。`} onClose={() => void closeFrame()} onBack={() => void closeFrame()}>{frame && !workspace && <p role="status">正在读取目标范围的配置…</p>}{frame && workspace && <ConfigurationWorkspaceEditor key={frame.key} toolId={toolId} subject={frame.subject} profile={frame.profile} scope={scope} projectPath={projectPath} workspace={workspace} accounts={accounts} onClose={() => void closeFrame()} onDirtyChange={value => { if (value) epoch.current++; setDirty(value); }} onDraftChange={changed} onStored={stored} onDone={(result, used) => { setFrame(null); setDirty(false); setNotice(result.application ? '当前文件已更新；下次会话读取。' : used ? '配置已保存并使用；下次会话读取。' : '配置已保存；正在使用的文件保持原版本。'); void reload(toolId, scope, projectPath); }} />}</GuideDialog>
      <GuideDialog wide open={!!comparison} title="比较当前文件与本次配置" onClose={() => setComparison(null)}>{comparison && <div>{comparison.files.map((file, index) => <ConflictCompare key={file.role} title={file.role} banner={index === 0 ? '当前文件和保存配置不同。先比较，再明确使用。' : undefined} actions={false} currentContent={file.current} nextContent={file.proposedText} format={file.format} onUseNext={() => void compareUse()} onKeepCurrent={() => setComparison(null)} />)}<div className="dialog-footer"><button onClick={() => setComparison(null)}>保留当前文件</button><span className="dialog-footer-gap" /><button className={styles.primary} disabled={busy} onClick={() => void compareUse()}>使用本次内容</button></div></div>}</GuideDialog>
    </div>
    {resource === 'accounts' && supported.accounts && <AccountsPanel key={toolId} toolId={toolId} state={accounts} onOpenProfile={(id, target) => void openTarget(id, target)} onOpenUsage={id => void openAccountQuota(id)} />}
    {resource === 'accounts' && accountUsageQuery && <QuotaEditor key={accountUsageQuery.id} query={accountUsageQuery} profileId={accountUsageQuery.config.identity.profileId ?? ''} profileAccountId={queryAccount} toolId={toolId} presets={quota.presets} onClose={() => setAccountUsageQuery(null)} onSaved={() => { setAccountUsageQuery(null); void quota.reload(); }} />}
    {resource === 'mcp' && supported.mcp && <McpWorkspace key={`${context}:${resourceEpoch}:${workspace?.effectiveContextId}`} toolId={toolId} scope={scope} projectPath={projectPath} contextId={workspace?.effectiveContextId ?? null} onDirtyChange={mcpDirty} />}
    {resource === 'skills' && supported.skills && <SkillsWorkspace key={`${context}:${resourceEpoch}:${workspace?.effectiveContextId}`} toolId={toolId} scope={scope} projectPath={projectPath} contextId={workspace?.effectiveContextId ?? null} onDirtyChange={skillsDirty} />}
    {resource === 'agents' && supported.agents && <AgentsWorkspace key={`${context}:${resourceEpoch}:${workspace?.effectiveContextId}`} toolId={toolId} scope={scope} projectPath={projectPath} contextId={workspace?.effectiveContextId ?? null} onDirtyChange={agentsDirty} />}
    {resource === 'plugins' && supported.plugins && <PluginsWorkspace key={`${context}:${resourceEpoch}:${workspace?.effectiveContextId}`} toolId={toolId} scope={scope} projectPath={projectPath} contextId={workspace?.effectiveContextId ?? null} />}
  </section>;
}
