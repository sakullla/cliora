import { useEffect, useRef, useState } from 'react';
import { native, nativeAvailable } from '../../lib/native';
import { uiAdapterFor } from '../../adapters';
import { confirmAction } from '../../lib/confirm';
import type { AccountCapability, AccountImpact, AccountImpactContextKind, AccountImpactScope, AuthAccount, NativeLoginSnapshot } from '../../types/accounts';
import styles from './ManagementPanel.module.css';
import accountStyles from './AccountsPanel.module.css';
export const accountStates = { signed_out: '已退出', pending: '等待原生登录完成', signed_in: '已登录', expired: '认证失效', error: '认证异常', unknown: '待核验' };
const nativeDiscoveryRequests = new Map<string, Promise<NativeLoginSnapshot>>();
function readNativeLogins(toolId: string) {
  const pending = nativeDiscoveryRequests.get(toolId);
  if (pending) return pending;
  const request = native.discoverNativeLogins(toolId).finally(() => { if (nativeDiscoveryRequests.get(toolId) === request) nativeDiscoveryRequests.delete(toolId); });
  nativeDiscoveryRequests.set(toolId, request);
  return request;
}
export function useAccounts(tool: string, active = true) {
  const currentTool = useRef(tool); currentTool.current = tool;
  const mounted = useRef(false);
  const generation = useRef(0);
  const request = useRef(0);
  const [accounts, setAccounts] = useState<AuthAccount[]>([]);
  const [capability, setCapability] = useState<AccountCapability | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    const scope = generation.current; const currentRequest = ++request.current;
    try {
      const [all, caps] = await Promise.all([native.listAccounts(), native.accountCapabilities()]);
      if (mounted.current && generation.current === scope && request.current === currentRequest && currentTool.current === tool) { const matching = all.filter(account => account.toolId === tool); setAccounts(matching); setCapability(caps.find(cap => cap.toolId === tool) ?? null); setError(''); return matching; }
      return null;
    } catch (value) {
      if (mounted.current && generation.current === scope && request.current === currentRequest && currentTool.current === tool) setError(value && typeof value === 'object' && 'message' in value ? String(value.message) : '账号读取失败');
      throw value;
    }
  };
  useEffect(() => {
    mounted.current = true; const scope = ++generation.current;
    if (!nativeAvailable || !active) { setLoading(false); return () => { mounted.current = false; generation.current++; }; }
    setLoading(true); setAccounts([]); setCapability(null); setError('');
    const read = () => refresh().catch(() => {}).finally(() => { if (mounted.current && generation.current === scope) setLoading(false); });
    void read(); const timer = window.setInterval(() => void read(), 2500);
    return () => { mounted.current = false; generation.current++; window.clearInterval(timer); };
  }, [tool, active]);
  return { accounts, capability, error, refresh, loading };
}
type AccountNavigation = {
  onOpenProfile?: (profileId: string, target?: AccountImpactScope) => void;
  onOpenUsage?: (queryId: string) => void;
};
const contextNames: Record<AccountImpactContextKind, string> = { current: '当前登录上下文', retained: '保留的旧登录上下文', pending: '等待核验的上下文', unknown: '上下文待确认', none: '未绑定上下文' };
const scopeName = (scope: AccountImpactScope) => scope.scope === 'global' ? '全局' : scope.scope === 'project' ? scope.projectName ?? scope.projectPath ?? '项目' : '范围待确认';
function impactSummary(impact: AccountImpact) {
  return `关联配置：${impact.profiles.map(profile => profile.name).join('、') || '无'}。使用范围：${impact.scopes.map(scope => `${scopeName(scope)}（${scope.active ? '正在使用' : '历史绑定'}）`).join('、') || '无'}。额度引用：${impact.usageReferences.map(query => query.label).join('、') || '无'}。`;
}
function AccountImpactView({ account, active, refreshAccounts, onOpenProfile, onOpenUsage }: { account: AuthAccount; active: boolean; refreshAccounts: () => Promise<AuthAccount[] | null> } & AccountNavigation) {
  const [impact, setImpact] = useState<AccountImpact | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const successfulReapply = useRef<{ accountId: string; contextId: string; notice: string } | null>(null);
  const request = useRef(0);
  const current = useRef(account); current.current = account;
  async function refresh() {
    const sequence = ++request.current; setLoading(true); setError('');
    try {
      const value = await native.accountImpact(account.id);
      if (sequence !== request.current || current.current.id !== account.id || current.current.version !== account.version) return;
      if (value.accountId !== account.id || value.toolId !== account.toolId || value.accountVersion !== account.version) throw new Error('账号已变化，请重新读取账号状态后查看关联。');
      setImpact(value);
    } catch (value) { if (sequence === request.current) setError(value && typeof value === 'object' && 'message' in value ? String(value.message) : '关联读取失败'); }
    finally { if (sequence === request.current) setLoading(false); }
  }
  useEffect(() => {
    const success = successfulReapply.current;
    if (success && (success.accountId !== account.id || success.contextId !== account.context?.id || account.state !== 'signed_in')) successfulReapply.current = null;
    setImpact(null); setNotice(successfulReapply.current?.notice ?? ''); setBusy(false);
    if (active && nativeAvailable) void refresh();
    return () => { request.current++; };
  }, [active, account.id, account.version, refreshEpoch]);
  async function refreshWithAccounts() {
    const sequence = request.current; setBusy(true); setError('');
    try {
      const updated = await refreshAccounts();
      if (request.current === sequence && updated?.some(item => item.id === account.id)) setRefreshEpoch(value => value + 1);
    } catch (value) { if (request.current === sequence) setError(value && typeof value === 'object' && 'message' in value ? String(value.message) : '账号状态读取失败，请重试。'); }
    finally { if (request.current === sequence && current.current.id === account.id) setBusy(false); }
  }
  async function reapply(scope: AccountImpactScope) {
    const sequence = ++request.current; setBusy(true); setError(''); setNotice(''); successfulReapply.current = null;
    try {
      const fresh = await native.accountImpact(account.id);
      if (sequence !== request.current) return;
      const target = fresh.scopes.find(item => item.bindingId === scope.bindingId);
      if (fresh.accountVersion !== account.version || fresh.toolId !== account.toolId || !target?.active || !target.canReapply || !target.needsReapply || target.profileId !== scope.profileId || target.profileVersion !== scope.profileVersion || target.contextId !== scope.contextId || !target.reapplyRequest || JSON.stringify(target.reapplyRequest) !== JSON.stringify(scope.reapplyRequest)) throw new Error('账号或范围关联已变化，请刷新后再重新应用。');
      await native.reapplyAccountProfile(scope.reapplyRequest!);
      if (sequence !== request.current) return;
      const successNotice = `已重新应用“${target.profileName ?? target.profileId}”到${scopeName(target)}；下次启动使用新的账号上下文。`;
      successfulReapply.current = { accountId: account.id, contextId: scope.reapplyRequest!.expectedContextId, notice: successNotice }; setNotice(successNotice);
      // Shared apply checks the identity and can advance its version. Refresh the
      // parent first; the next render reads impacts against the accepted version.
      const updated = await refreshAccounts();
      if (request.current === sequence && updated?.some(item => item.id === account.id)) setRefreshEpoch(value => value + 1);
    } catch (value) { if (sequence === request.current) setError(value && typeof value === 'object' && 'message' in value ? String(value.message) : '重新应用失败，请打开关联配置处理后重试。'); }
    finally { if (request.current === sequence && current.current.id === account.id) setBusy(false); }
  }
  if (!active) return null;
  return <section className={accountStyles.impact} aria-label={`${account.label}的关联`}>
    <div className={accountStyles.impactHeader}><strong>用于哪些配置</strong><button disabled={loading || busy} onClick={() => void refreshWithAccounts()}>刷新关联</button></div>
    {loading && !impact && <p role="status">正在读取真实引用…</p>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {impact && <><ul>{impact.profiles.map(profile => <li key={profile.id}><div className={styles.actions}><span>{profile.name}</span>{onOpenProfile && <button disabled={busy} onClick={() => onOpenProfile(profile.id)}>修改关联配置</button>}</div></li>)}</ul>{!impact.profiles.length && <p>没有命名配置引用此账号。</p>}
      <h4>使用范围与待应用项</h4><ul>{impact.scopes.map(scope => <li key={scope.bindingId}>
        <strong>{scope.profileName ?? '已删除的配置'} · {scopeName(scope)}</strong><p>{scope.active ? '正在使用' : '历史绑定'} · {contextNames[scope.contextKind]}{scope.needsReapply && ' · 待重新应用'}</p>
        {scope.reason && <p>{scope.reason}</p>}<div className={styles.actions}>{scope.active && scope.canReapply && scope.needsReapply && scope.reapplyRequest && <button className={styles.primary} disabled={busy || loading} onClick={() => void reapply(scope)}>重新应用此范围</button>}{scope.profileName && onOpenProfile && <button disabled={busy} onClick={() => onOpenProfile(scope.profileId, scope)}>打开此范围配置</button>}</div>
      </li>)}</ul>{!impact.scopes.length && <p>没有范围绑定此账号上下文。</p>}
      <h4>额度引用</h4><ul>{impact.usageReferences.map(query => <li key={query.id}><div className={styles.actions}><span>{query.label}{query.needsRebind ? ' · 需重新绑定' : ''}</span>{onOpenUsage && <button disabled={busy} onClick={() => onOpenUsage(query.id)}>打开额度设置</button>}</div><p>{contextNames[query.contextKind]} · {query.enabled ? '已启用' : '已停用'}</p></li>)}</ul>{!impact.usageReferences.length && <p>没有额度引用。</p>}
      <p className={accountStyles.contextSummary}>{impact.contexts.map(context => contextNames[context.kind]).join('、') || '尚无登录上下文'}。删除管理记录需先解除配置、范围和额度引用；此查询不代替操作时的引用检查。</p>
    </>}
  </section>;
}
export function AccountsPanel({ toolId, state, onOpenProfile, onOpenUsage }: { toolId: string; state: ReturnType<typeof useAccounts> } & AccountNavigation) {
  const metadata = uiAdapterFor(toolId).accounts;
  const currentTool = useRef(toolId); currentTool.current = toolId;
  const live = useRef(true); useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [label, setLabel] = useState(metadata?.defaultLabel ?? '新账号');
  const [method, setMethod] = useState<'browser' | 'device'>('browser');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [renamed, setRenamed] = useState('');
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [nativeLogins, setNativeLogins] = useState<NativeLoginSnapshot | null>(null);
  const [nativeLoading, setNativeLoading] = useState(false);
  const [nativeError, setNativeError] = useState('');
  const discoverySequence = useRef(0);
  async function discover() {
    const sequence = ++discoverySequence.current;
    setNativeLoading(true); setNativeError('');
    try { const value = await readNativeLogins(toolId); if (live.current && discoverySequence.current === sequence) setNativeLogins(value); }
    catch (value) { if (live.current && discoverySequence.current === sequence) setNativeError(value && typeof value === 'object' && 'message' in value ? String(value.message) : '原生登录读取失败'); }
    finally { if (live.current && discoverySequence.current === sequence) setNativeLoading(false); }
  }
  useEffect(() => {
    setNativeLogins(null); setNativeError(''); setMessage(''); setError(''); setEditing(null); setCreating(false); setExpanded(new Set()); setLabel(metadata?.defaultLabel ?? '新账号'); setMethod('browser');
    if (nativeAvailable) void discover();
    return () => { discoverySequence.current++; };
  }, [toolId]);
  async function run(work: () => Promise<unknown>, notice: string) { setBusy(true); setError(''); setMessage(''); try { const outcome = await work(); if (outcome === false || !live.current || currentTool.current !== toolId) return; await state.refresh(); if (live.current && currentTool.current === toolId) setMessage(notice); } catch (value) { if (!live.current || currentTool.current !== toolId) return; setError(value && typeof value === 'object' && 'message' in value ? String(value.message) : '账号操作失败'); } finally { if (live.current && currentTool.current === toolId) setBusy(false); } }
  return <section className={styles.panel} aria-label="OAuth 账号管理">
    <div className={styles.header}><div><h2>账号与登录</h2><p>{metadata?.description ?? '查看 CLI 已有登录，或添加独立账号并绑定配置。'}</p></div>{state.capability?.managedLogin && <button className={styles.primary} onClick={() => setCreating(value => !value)}>{creating ? '收起添加' : '添加账号'}</button>}</div>
    {!nativeAvailable && <p role="alert">请在桌面应用中管理账号。</p>}
    <section className={accountStyles.nativeLogin} aria-label="CLI 原生登录"><div className={styles.header}><div><h3>CLI 原生登录</h3><p>{metadata?.nativeDescription ?? '只读观察 CLI 当前凭据，不复制或纳入管理。'}</p></div><button disabled={nativeLoading || !nativeAvailable} onClick={() => void discover()}>{nativeLoading ? '检查中…' : '检查原生登录'}</button></div>
      {nativeLoading && !nativeLogins && <p role="status">正在读取 CLI 登录状态…</p>}
      {nativeError && <p role="alert">{nativeError}</p>}
      {nativeLogins && !nativeLogins.logins.length && <p>未发现当前 CLI 凭据；已有受管账号仍可单独选择。</p>}
      {nativeLogins?.logins.map(login => <div className={accountStyles.nativeRow} key={`${login.provider}:${login.authKind}`}><div className={accountStyles.nativeIdentity}><strong>{login.identity?.email ?? login.identity?.subject ?? login.provider}</strong><span>{login.identity ? `${login.provider} · ` : ''}{login.authKind === 'oauth' ? 'OAuth' : 'API Key'}{login.identity?.plan && ` · ${login.identity.plan}`}{!login.identity && login.authKind === 'oauth' && login.state === 'signed_in' && ' · 身份未提供'}</span><p>{login.managedAccountId ? `已纳入管理 · ${state.accounts.find(account => account.id === login.managedAccountId)?.label ?? '已有账号'}` : login.state === 'signed_in' ? '可在 CLI 默认配置中使用 · 未纳入独立账号管理' : login.detail}</p></div><span className={styles.badge} data-state={login.state}>{login.state === 'signed_in' ? login.authKind === 'api_key' ? 'CLI 已配置' : 'CLI 已登录' : login.state === 'signed_out' ? 'CLI 未登录' : accountStates[login.state]}</span>{login.state !== 'signed_out' && <details><summary>登录详情</summary><p>{login.detail}</p></details>}</div>)}
    </section>
    {creating && <div className={styles.create}><label>账号名称<input value={label} onChange={event => setLabel(event.target.value)} placeholder="例如：工作账号" /></label>
      <label>登录方式<select value={state.capability?.methods.includes(method) ? method : state.capability?.methods[0] ?? ''} onChange={event => setMethod(event.target.value as 'browser' | 'device')}>{state.capability?.methods.map(value => <option key={value} value={value}>{metadata?.methods?.[value] ?? (value === 'device' ? '设备码' : '原生交互登录')}</option>)}</select></label>
      <p>{metadata?.managedDescription}</p>
      <button className={styles.primary} disabled={busy || !nativeAvailable || !label.trim() || !state.capability?.managedLogin || !state.capability.methods.length} onClick={() => void run(async () => { const account = await native.createAccount(toolId, label.trim()); if (!live.current || currentTool.current !== toolId) return; await native.startAccountLogin(account.id, account.version, state.capability!.methods.includes(method) ? method : state.capability!.methods[0]); }, '已请求打开原生登录终端；完成身份核验后才会显示已登录。')}>添加并登录</button>
      {state.capability?.importNative && <button disabled={busy || !nativeAvailable || !label.trim()} onClick={() => void run(() => native.adoptNativeAccount(toolId, label), '已将现有原生账号纳入管理；继续使用原目录，未复制令牌。')}>纳入现有原生账号</button>}
    </div>}
    {(error || state.error) && <p role="alert">{error || state.error}</p>}{message && <p role="status">{message}</p>}
    <div className={styles.sectionTitle}><h3>独立账号</h3><span>{state.accounts.length} 个</span></div>
    {state.loading ? <p role="status">正在读取账号…</p> : state.accounts.length === 0 && <p className={styles.empty}>{state.capability?.managedLogin ? '还没有独立账号。需要多账号切换时，点击“添加账号”完成登录并绑定配置。' : '还没有独立账号。可在配置中沿用当前 CLI 凭据；本机受管登录的限制见下方兼容性说明。'}</p>}
    <ul className={styles.list}>{state.accounts.map(account => <li key={account.id}>
      <div><strong>{account.label}</strong><span data-state={account.state === 'signed_in' && !account.identity ? 'unknown' : account.state}>{account.state === 'signed_in' && !account.identity ? '身份待核验' : accountStates[account.state]}</span></div>
      <p>{account.identity?.email ?? account.identity?.subject ?? '尚无已核验身份'}{account.identity?.plan ? ` · ${account.identity.plan}` : ''}</p>
      {account.pendingLogin && <p>等待原生操作完成；打开终端不代表身份核验成功。</p>}
      {account.pendingLogin && <div className={styles.actions}><button disabled={busy} onClick={() => void run(() => native.cancelAccountLogin(account.id, account.pendingLogin!.id), '已取消此尝试；外部登录终端需自行关闭，其迟到结果不会激活账号。')}>取消登录</button>{account.pendingLogin.operation === 'login' && state.capability?.browserLink && <button disabled={busy} onClick={() => void run(() => native.openAccountLoginLink(account.id, account.pendingLogin!.id), '已请求打开系统浏览器；请在浏览器完成授权。')}>打开授权页面</button>}</div>}
      {account.retiredContexts.length > 0 && <button onClick={() => setExpanded(previous => new Set(previous).add(account.id))}>查看重新认证后的待应用项</button>}
      <details className={accountStyles.management} open={expanded.has(account.id)} onToggle={event => { const open = event.currentTarget.open; setExpanded(previous => { const next = new Set(previous); if (open) next.add(account.id); else next.delete(account.id); return next; }); }}><summary>管理与关联</summary>
      <div className={accountStyles.accountActions}>
        <div className={styles.actions}>
          <button disabled={busy} onClick={() => void run(() => native.checkAccount(account.id), '已核验原生状态。')}>检查状态</button>
          <button disabled={busy} onClick={() => { setEditing(account.id); setRenamed(account.label); }}>重命名</button>
          {!account.pendingLogin && state.capability?.managedLogin && <button disabled={busy || !state.capability.methods.length} onClick={() => void run(() => native.startAccountLogin(account.id, account.version, state.capability!.methods.includes(method) ? method : state.capability!.methods[0]), '已请求重新认证；完成后请重新应用绑定的配置。')}>{account.state === 'signed_in' ? '重新认证' : '登录'}</button>}
        </div>
        {editing === account.id && <label>新名称<input value={renamed} onChange={event => setRenamed(event.target.value)} /><button disabled={busy || !renamed.trim()} onClick={() => void run(async () => { await native.renameAccount(account.id, account.version, renamed); setEditing(null); }, '名称已更新。')}>保存名称</button><button disabled={busy} onClick={() => setEditing(null)}>取消重命名</button></label>}
        <details className={accountStyles.moreActions}><summary>更多账号操作</summary>
          <div className={styles.actions}>
            {!account.pendingLogin && <button disabled={busy || account.state === 'signed_out'} onClick={() => void run(async () => {
              const impact = await native.accountImpact(account.id);
              if (!live.current || currentTool.current !== toolId) return;
              if (!await confirmAction(`退出“${account.label}”的原生登录？关联配置可能无法启动，额度查询可能停止。${impactSummary(impact)}其他账号不受影响，管理记录仍保留。`, () => live.current && currentTool.current === toolId, { title: '退出此账号', confirmLabel: '退出此账号', destructive: true })) return false;
              await native.logoutAccount(account.id, account.version);
            }, '已请求原生退出。该账号绑定的配置不能再启动；其他账号不受影响。')}>退出此账号</button>}
            <button className={styles.destructive} disabled={busy || !!account.pendingLogin} aria-describedby={account.pendingLogin ? `account-delete-hint-${account.id}` : undefined} title={account.pendingLogin ? '请先取消正在进行的账号操作' : '删除 Cliora 中的账号管理记录'} onClick={() => void (async () => {
              await run(async () => {
                const impact = await native.accountImpact(account.id);
                if (!live.current || currentTool.current !== toolId) return;
                if (!await confirmAction(`删除“${account.label}”的管理记录？原生登录文件、插件和历史记录会保留，不会退出或撤销授权。绑定的配置及额度查询需先解除关联。${impactSummary(impact)}`, () => live.current && currentTool.current === toolId, { title: '删除账号', confirmLabel: '删除账号', destructive: true })) return false;
                await native.deleteAccount(account.id, account.version); if (editing === account.id) setEditing(null);
              }, '账号管理记录已删除；原生登录文件与历史记录已保留。');
            })()}>删除账号</button>
          </div>
        </details>
        {account.pendingLogin && <p id={`account-delete-hint-${account.id}`} className={accountStyles.actionHint}>删除已停用：登录进行中，请先取消当前操作。</p>}
      </div>
      <AccountImpactView account={account} active={expanded.has(account.id)} refreshAccounts={state.refresh} onOpenProfile={onOpenProfile} onOpenUsage={onOpenUsage} />
      {account.detail && <p>{account.detail}</p>}
      </details>
    </li>)}</ul>
    {state.capability && <details className={styles.compatibility}><summary>登录方式与兼容性</summary><p>{state.capability.reason}</p></details>}
  </section>;
}
