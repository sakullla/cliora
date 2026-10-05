import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import type { AdapterDescriptor, RegisteredProfile, RegisteredToolWorkspace, Scope, ApplyComparison } from '../../types/native';
import type { ConfigurationDraft, ConfigurationSaveResult, ConfigurationSubject } from '../../types/configuration';
import type { AccountImpactScope } from '../../types/accounts';
import type { Project, TrayRepairTarget } from '../../types/launch';
import type { UsageQuery } from '../../types/usage';
import { AccountsPanel, useAccounts } from './AccountsPanel';
import { ProfileQuota, QuotaEditor, useUsageQuota } from './UsageQuota';
import { InstallPanel } from './InstallPanel';
import { ConfigurationWorkspaceEditor } from './configuration/ConfigurationWorkspaceEditor';
import { McpWorkspace, SkillsWorkspace } from './ResourceWorkspace';
import { PluginsWorkspace } from './PluginsWorkspace';
import { AgentsWorkspace } from './AgentsWorkspace';
import { ToolIcon } from '../../components/ToolIcon';
import { FilterSelect } from '../../components/FilterSelect';
import { GuideDialog } from '../../components/GuideDialog';
import { CodeEditor } from '../../components/CodeEditor';
import { shortPath } from '../../lib/paths';
import { navigateChoices } from '../../lib/choiceNavigation';
import styles from './ToolWorkspace.module.css';

const errorText = (value: unknown) => value && typeof value === 'object' && 'message' in value ? String(value.message) : '操作失败，请重试。';
function host(address?: string) { try { return address ? new URL(address).host : ''; } catch { return '地址待核验'; } }
function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
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
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, [open]);
  return <div className={styles.rowMenu} ref={ref}>
    <button type="button" className={styles.rowMenuButton} aria-label={label} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(value => !value)}>···</button>
    {open && createPortal(<div ref={panel} className={styles.rowMenuList} role="menu" style={box ? { top: box.top, left: box.left } : { top: 0, left: 0, visibility: 'hidden' }} onClick={() => setOpen(false)}>{children}</div>, document.body)}
  </div>;
}


type ResourceView = 'config' | 'accounts' | 'mcp' | 'skills' | 'plugins' | 'agents';
type EditFrame = { key: string; subject: ConfigurationSubject; profile: RegisteredProfile | null; title: string };
export function ToolWorkspacePage({ managedTools, initialTool, openSequence = 0, active = true, repair, onDirtyChange }: { active?: boolean; managedTools: AdapterDescriptor[]; initialTool?: string; openSequence?: number; repair?: TrayRepairTarget | null; onDirtyChange?: (dirty: boolean) => void }) {
  const [tool, setTool] = useState(repair?.toolId ?? initialTool ?? managedTools[0]?.id ?? '');
  const descriptor = managedTools.find(item => item.id === tool) ?? managedTools[0];
  const toolId = descriptor?.id ?? '';
  const [scope, setScope] = useState<Scope>(repair?.scope ?? 'global');
  const [projectPath, setProjectPath] = useState(repair?.projectPath ?? '');
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspace, setWorkspace] = useState<RegisteredToolWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const [resource, setResource] = useState<ResourceView>(repair?.resourceView ?? 'config');
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
  async function openFrame(subject: ConfigurationSubject, profile: RegisteredProfile | null = null, confirmed = false) {
    if (!confirmed && !await mayLeave()) return;
    discard(); setError(''); setNotice('');
    setFrame({ key: crypto.randomUUID(), subject, profile, title: subject === 'current' ? '修改正在使用的文件' : subject === 'common' ? '修改通用配置' : profile?.id ? '修改配置' : '新建配置' });
  }
  async function createProfile() {
    let name = '新配置'; let suffix = 1;
    while (workspace?.profiles.some(profile => profile.name === name)) name = `新配置 ${++suffix}`;
    await openFrame('profile', { id: '', tool: toolId, name, version: 0, inheritCommon: false, files: {}, suppressed: {}, connection: null, nativeCredentials: {} });
  }
  async function switchScope(next: Scope, path = '') { if (next === scope && (next === 'global' || path === projectPath)) return; if (!await mayLeave()) return; discard(); setScope(next); setProjectPath(path); setResource('config'); }
  async function switchTool(id: string) { if (id === toolId || !await mayLeave()) return; discard(); setTool(id); }
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
    void (async () => { if (!await mayLeave()) return; discard(); setResource('config'); if (initialTool) setTool(initialTool); })();
  }, [openSequence]);
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
  async function duplicate(profile: RegisteredProfile) { if (!await mayLeave()) return; const copy = structuredClone(profile); copy.id = ''; copy.version = 0; delete copy.revision; copy.name += ' 副本'; await openFrame('profile', copy, true); }
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
  function row(profile: RegisteredProfile) {
    const binding = workspace?.binding; const same = binding?.profileId === profile.id;
    const commonPending = same && profile.inheritCommon && !!workspace?.common && (binding?.commonVersion !== workspace.common.version || binding?.commonRevision !== workspace.common.revision);
    const applied = same && binding?.profileVersion === profile.version && !commonPending;
    const state = same ? applied ? '正在使用' : '已保存，待使用' : '已保存';
    const frozen = same ? binding?.appliedSummary : null;
    const frozenSource = frozen?.authentication.kind === 'oauth' ? '已管理账号' : frozen?.authentication.kind === 'api_key' ? 'API 密钥' : 'CLI 当前凭据';
    const authentication = profile.authentication;
    const credential = authentication?.kind === 'oauth' ? `账号 ${accounts.accounts.find(account => account.id === authentication.accountId)?.label ?? authentication.accountId}` : profile.authentication?.kind === 'api_key' ? 'API 密钥' : profile.authentication?.kind === 'rebind_required' ? '需重新选择来源' : 'CLI 当前凭据';
    return <div className={styles.profileRow} role="listitem" data-profile-id={profile.id} data-active={applied || undefined} key={profile.id}>
      <span><button className={styles.profileName} onClick={() => void openFrame('profile', profile)}>{profile.name}</button><span className={styles.profileMeta}><span className={styles.badge} data-tone={applied ? 'ok' : same ? 'warn' : undefined}>{state}</span>{profile.connection?.model && <span>{profile.connection.model}</span>}<span>保存设置：{credential}{host(profile.connection?.baseUrl) && ` · ${host(profile.connection?.baseUrl)}`}</span>{same && <span>最后使用版本 {binding!.profileVersion} · 保存版本 {profile.version}{commonPending && ' · 通用配置待应用'}</span>}{same && <span>上次已使用：{frozen ? `${frozenSource}${frozen.providerId ? ' · '+frozen.providerId : ''}${host(frozen.baseUrl ?? undefined) ? ' · '+host(frozen.baseUrl ?? undefined) : ''}${frozen.model ? ' · '+frozen.model : ''}` : '来源快照未提供，以最后使用版本为准'}</span>}</span></span>
      <span className={styles.profileActions}>{!applied && <button className={styles.primary} disabled={busy || !!applying || workspace?.probe.nativeWrites.state !== 'supported'} onClick={() => void apply(profile)}>{applying === profile.id ? '使用中' : same ? '使用新版本' : '使用'}</button>}<button onClick={() => void openFrame('profile', profile)}>修改</button><RowMenu label={`${profile.name} 更多操作`}><button role="menuitem" onClick={() => void openFrame('profile', profile)}>修改配置</button><button role="menuitem" onClick={() => void duplicate(profile)}>复制配置</button><button role="menuitem" onClick={() => setQuotaAddFor(profile.id)}>添加额度查询</button><button role="menuitem" data-danger="true" onClick={() => void remove(profile)}>删除配置</button></RowMenu></span>
      <ProfileQuota profileId={profile.id} profileVersion={profile.version} toolId={toolId} profileAccountId={profile.authentication?.kind === 'oauth' ? profile.authentication.accountId : undefined} state={quota} addRequested={quotaAddFor === profile.id} onAddHandled={() => setQuotaAddFor(null)} />
    </div>;
  }
  const linkedAuthentication = workspace?.profiles.find(profile => profile.id === accountUsageQuery?.config.identity.profileId)?.authentication;
  const queryAccount = linkedAuthentication?.kind === 'oauth' ? linkedAuthentication.accountId : accountUsageQuery?.config.identity.profileId ? undefined : accountUsageQuery?.config.identity.accountId ?? undefined;
  if (!descriptor) return <p>还没有管理中的 CLI，请在设置中选择工具。</p>;
  return <section className={styles.workspace} aria-label="工具与连接">
    <div className={styles.toolbar}><div className={styles.toolSwitcher} role="tablist" aria-label="CLI" onKeyDown={navigateChoices}>{managedTools.map(item => <button key={item.id} role="tab" aria-selected={item.id === toolId} tabIndex={item.id === toolId ? 0 : -1} className={item.id === toolId ? styles.selected : ''} onClick={() => void switchTool(item.id)}><ToolIcon toolId={item.id} size={23} />{item.name}</button>)}</div></div>
    <div className={styles.taskBar}><div className={styles.views} role="tablist" aria-label="当前任务" onKeyDown={navigateChoices}>{Object.entries({ config: '配置', accounts: '账号', mcp: 'MCP', skills: 'Skill', agents: 'Agents', plugins: '插件' }).filter(([id]) => supported[id as ResourceView]).map(([id, label]) => <button role="tab" key={id} aria-selected={resource === id} tabIndex={resource === id ? 0 : -1} className={resource === id ? styles.selected : ''} onClick={() => void switchResource(id as ResourceView)}>{label}</button>)}</div><div className={styles.scopeBar}><FilterSelect className={styles.projectSelect} label="配置范围" value={scope === 'global' ? '__global__' : projectPath} forceSearch searchLabel="搜索项目" options={[{ value: '__global__', label: '全局配置' }, ...projects.map(project => ({ value: project.path ?? project.id, label: project.name, detail: project.path ? shortPath(project.path) : undefined, disabled: !project.available || !project.path })), ...(projectPath && !projects.some(project => project.path === projectPath) ? [{ value: projectPath, label: projectPath.split(/[\\/]/).at(-1) ?? projectPath }] : [])]} onChange={value => void switchScope(value === '__global__' ? 'global' : 'project', value === '__global__' ? '' : value)} onPickFolder={() => void pickProject()} pickFolderLabel="选择文件夹…" /></div></div>
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
    <div hidden={resource !== 'config'}>
      {workspace && <InstallPanel toolName={descriptor.name} probe={workspace.probe} customPath={customPath} busy={busy} loading={loading} onCustomPath={setCustomPath} onSavePath={() => void savePath()} onMaintain={(action, source) => void maintain(action, source)} onUsePath={path => void usePath(path)} />}
      {workspace?.recoveryNeeded.length ? <p role="alert">有 {workspace.recoveryNeeded.length} 项文件事务需要恢复。<button onClick={() => { void native.recoverNativeTransactions().then(() => reload(toolId, scope, projectPath)).catch(failure => setError(errorText(failure))); }}>重试恢复</button></p> : null}
      {!workspace ? <div className={styles.taskEmpty}>{loading ? <p role="status">正在读取配置…</p> : <><p>配置读取失败，已有记录未被删除。</p><button onClick={() => void reload(toolId, scope, projectPath)}>重试读取配置</button></>}</div> : <div className={styles.profileList} aria-label="配置列表"><div className={styles.listHeading}><strong>配置</strong><span className={styles.listActions}><button onClick={() => void openFrame('common')}>通用配置</button><button className={styles.primary} onClick={() => void createProfile()}>新建配置</button></span></div>{currentFile && <div className={styles.profileRow} data-kind="native"><span><button className={styles.profileName} onClick={() => void openFrame('current')}>正在使用的文件</button><small>直接编辑当前范围的原生文件</small></span><button onClick={() => void openFrame('current')}>修改</button></div>}{workspace.profiles.length > 6 && <label className={styles.profileFilter}><input aria-label="搜索配置" placeholder="搜索配置" value={filter} onChange={event => setFilter(event.target.value)} /></label>}{!workspace.profiles.length && <p className={styles.profileEmpty}>还没有命名配置。可新建配置或编辑已有当前文件。</p>}<div role="list" aria-label="配置项" className={workspace.profiles.length > 6 ? styles.profileScroll : undefined}>{[{ id: 'subscription', label: '订阅套餐', profiles: workspace.profiles.filter(profile => quotaIds.has(profile.id) || profile.authentication?.kind === 'oauth') }, { id: 'other', label: '其他配置', profiles: workspace.profiles.filter(profile => !quotaIds.has(profile.id) && profile.authentication?.kind !== 'oauth') }].filter(group => group.profiles.length).map(group => <div key={group.id} className={styles.profileGroup} data-group={group.id}><div className={styles.groupLabel}><strong>{group.label}</strong><span>{group.profiles.length}</span></div>{group.profiles.filter(profile => profile.name.toLowerCase().includes(filter.toLowerCase())).map(row)}</div>)}</div></div>}
      <GuideDialog wide suspended={!active} open={!!frame} title={frame?.title ?? '配置'} hint={`${descriptor.name} · ${scope === 'global' ? '全局' : projectPath}。保存配置只入库，使用是独立操作。`} onClose={() => void closeFrame()}>{frame && !workspace && <p role="status">正在读取目标范围的配置…</p>}{frame && workspace && <ConfigurationWorkspaceEditor key={frame.key} toolId={toolId} subject={frame.subject} profile={frame.profile} scope={scope} projectPath={projectPath} workspace={workspace} accounts={accounts} onClose={() => void closeFrame()} onDirtyChange={value => { if (value) epoch.current++; setDirty(value); }} onDraftChange={changed} onStored={stored} onDone={(result, used) => { setFrame(null); setDirty(false); setNotice(result.application ? '当前文件已更新；下次会话读取。' : used ? '配置已保存并使用；下次会话读取。' : '配置已保存；正在使用的文件保持原版本。'); void reload(toolId, scope, projectPath); }} />}</GuideDialog>
      <GuideDialog wide open={!!comparison} title="比较当前文件与本次配置" hint="当前文件和保存配置不同。先比较，再明确使用。" onClose={() => setComparison(null)}>{comparison && <div>{comparison.files.map(file => <section key={file.role}><strong>{file.role}</strong><CodeEditor label={`${file.role} 当前内容`} format={file.format} value={file.current} readOnly /><CodeEditor label={`${file.role} 本次内容`} format={file.format} value={file.proposedText} readOnly /></section>)}<button disabled={busy} onClick={() => void compareUse()}>使用本次内容</button><button onClick={() => setComparison(null)}>保留当前文件</button></div>}</GuideDialog>
    </div>
    {resource === 'accounts' && supported.accounts && <AccountsPanel toolId={toolId} state={accounts} onOpenProfile={(id, target) => void openTarget(id, target)} onOpenUsage={id => void openAccountQuota(id)} />}
    {resource === 'accounts' && accountUsageQuery && <QuotaEditor key={accountUsageQuery.id} query={accountUsageQuery} profileId={accountUsageQuery.config.identity.profileId ?? ''} profileAccountId={queryAccount} toolId={toolId} presets={quota.presets} onClose={() => setAccountUsageQuery(null)} onSaved={() => { setAccountUsageQuery(null); void quota.reload(); }} />}
    {resource === 'mcp' && supported.mcp && <McpWorkspace key={`${context}:${resourceEpoch}:${workspace?.effectiveContextId}`} toolId={toolId} scope={scope} projectPath={projectPath} contextId={workspace?.effectiveContextId ?? null} onDirtyChange={mcpDirty} />}
    {resource === 'skills' && supported.skills && <SkillsWorkspace key={`${context}:${resourceEpoch}:${workspace?.effectiveContextId}`} toolId={toolId} scope={scope} projectPath={projectPath} contextId={workspace?.effectiveContextId ?? null} onDirtyChange={skillsDirty} />}
    {resource === 'agents' && supported.agents && <AgentsWorkspace key={`${context}:${resourceEpoch}:${workspace?.effectiveContextId}`} toolId={toolId} scope={scope} projectPath={projectPath} contextId={workspace?.effectiveContextId ?? null} onDirtyChange={agentsDirty} />}
    {resource === 'plugins' && supported.plugins && <PluginsWorkspace key={`${context}:${resourceEpoch}:${workspace?.effectiveContextId}`} toolId={toolId} scope={scope} projectPath={projectPath} contextId={workspace?.effectiveContextId ?? null} />}
  </section>;
}
