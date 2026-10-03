import { useEffect, useRef, useState } from 'react';
import { native, nativeAvailable } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import type { AccountCapability, AuthAccount, NativeLoginSnapshot } from '../../types/accounts';
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
  const [accounts, setAccounts] = useState<AuthAccount[]>([]);
  const [capability, setCapability] = useState<AccountCapability | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const refresh = async () => { const [all, caps] = await Promise.all([native.listAccounts(), native.accountCapabilities()]); if (currentTool.current === tool) { setAccounts(all.filter(account => account.toolId === tool)); setCapability(caps.find(cap => cap.toolId === tool) ?? null); } };
  useEffect(() => {
    if (!nativeAvailable || !active) { setLoading(false); return; }
    setLoading(true); setAccounts([]); setCapability(null);
    let live = true;
    const read = () => Promise.all([native.listAccounts(), native.accountCapabilities()]).then(([all, caps]) => { if (live) { setAccounts(all.filter(account => account.toolId === tool)); setCapability(caps.find(cap => cap.toolId === tool) ?? null); setError(''); } }).catch(value => { if (live) setError(value.message ?? '账号读取失败'); });
    void read().finally(() => { if (live) setLoading(false); }); const timer = window.setInterval(() => void read(), 2500);
    return () => { live = false; window.clearInterval(timer); };
  }, [tool, active]);
  return { accounts, capability, error, refresh, loading };
}
export function AccountsPanel({ toolId, state }: { toolId: string; state: ReturnType<typeof useAccounts> }) {
  const currentTool = useRef(toolId); currentTool.current = toolId;
  const live = useRef(true); useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [label, setLabel] = useState('');
  const [method, setMethod] = useState<'browser' | 'device'>('browser');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [renamed, setRenamed] = useState('');
  const [creating, setCreating] = useState(false);
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
    setNativeLogins(null);
    if (nativeAvailable) void discover();
    return () => { discoverySequence.current++; };
  }, [toolId]);
  async function run(work: () => Promise<unknown>, notice: string) { setBusy(true); setError(''); try { await work(); if (!live.current) return; await state.refresh(); if (live.current) setMessage(notice); } catch (value) { if (!live.current) return; setError(value && typeof value === 'object' && 'message' in value ? String(value.message) : '账号操作失败'); } finally { if (live.current) setBusy(false); } }
  return <section className={styles.panel} aria-label="OAuth 账号管理">
    <div className={styles.header}><div><h2>账号与登录</h2><p>查看 CLI 已有登录，或添加独立账号并绑定配置。</p></div><button className={styles.primary} disabled={!state.capability?.managedLogin} onClick={() => setCreating(value => !value)}>{creating ? '收起添加' : '添加账号'}</button></div>
    {!nativeAvailable && <p role="alert">请在桌面应用中管理账号。</p>}
    <section className={accountStyles.nativeLogin} aria-label="CLI 原生登录"><div className={styles.header}><div><h3>CLI 原生登录</h3><p>来自 CLI 默认登录目录</p></div><button disabled={nativeLoading || !nativeAvailable} onClick={() => void discover()}>{nativeLoading ? '检查中…' : '检查原生登录'}</button></div>
      {nativeLoading && !nativeLogins && <p role="status">正在读取 CLI 登录状态…</p>}
      {nativeError && <p role="alert">{nativeError}</p>}
      {nativeLogins?.logins.map(login => <div className={accountStyles.nativeRow} key={`${login.provider}:${login.authKind}`}><div className={accountStyles.nativeIdentity}><strong>{login.identity?.email ?? login.identity?.subject ?? login.provider}</strong><span>{login.identity ? `${login.provider} · ` : ''}{login.authKind === 'oauth' ? 'OAuth' : 'API Key'}{login.identity?.plan && ` · ${login.identity.plan}`}{!login.identity && login.authKind === 'oauth' && login.state === 'signed_in' && ' · 身份未提供'}</span><p>{login.managedAccountId ? `已纳入管理 · ${state.accounts.find(account => account.id === login.managedAccountId)?.label ?? '已有账号'}` : login.state === 'signed_in' ? '可在 CLI 默认配置中使用 · 未纳入独立账号管理' : login.detail}</p></div><span className={styles.badge} data-state={login.state}>{login.state === 'signed_in' ? login.authKind === 'api_key' ? 'CLI 已配置' : 'CLI 已登录' : login.state === 'signed_out' ? 'CLI 未登录' : accountStates[login.state]}</span>{login.state !== 'signed_out' && <details><summary>登录详情</summary><p>{login.detail}</p></details>}</div>)}
    </section>
    {creating && <div className={styles.create}><label>账号名称<input value={label} onChange={event => setLabel(event.target.value)} placeholder="例如：工作账号" /></label>
      <label>登录方式<select value={method} onChange={event => setMethod(event.target.value as 'browser' | 'device')}><option value="browser">浏览器 / 原生交互</option>{state.capability?.methods.includes('device') && <option value="device">设备码</option>}</select></label>
      <button className={styles.primary} disabled={busy || !nativeAvailable || !label.trim() || !state.capability?.managedLogin} onClick={() => void run(async () => { const account = await native.createAccount(toolId, label); await native.startAccountLogin(account.id, account.version, method); setLabel(''); }, '已请求打开原生登录终端；完成身份核验后才会显示已登录。')}>添加并登录</button>
      {state.capability?.importNative && <button disabled={busy || !nativeAvailable || !label.trim()} onClick={() => void run(() => native.adoptNativeAccount(toolId, label), '已将现有原生账号纳入管理；继续使用原目录，未复制令牌。')}>纳入现有原生账号</button>}
    </div>}
    {(error || state.error) && <p role="alert">{error || state.error}</p>}{message && <p role="status">{message}</p>}
    <div className={styles.sectionTitle}><h3>独立账号</h3><span>{state.accounts.length} 个</span></div>
    {state.loading ? <p role="status">正在读取账号…</p> : state.accounts.length === 0 && <p className={styles.empty}>还没有独立账号。需要多账号切换时，点击“添加账号”完成登录并绑定配置。</p>}
    <ul className={styles.list}>{state.accounts.map(account => <li key={account.id}>
      <div><strong>{account.label}</strong><span data-state={account.state}>{accountStates[account.state]}</span></div>
      <p>{account.identity?.email ?? account.identity?.subject ?? '尚无已核验身份'}{account.identity?.plan ? ` · ${account.identity.plan}` : ''}</p>
      {account.detail && <p>{account.detail}</p>}
      {editing === account.id && <label>新名称<input value={renamed} onChange={event => setRenamed(event.target.value)} /><button disabled={busy || !renamed.trim()} onClick={() => void run(async () => { await native.renameAccount(account.id, account.version, renamed); setEditing(null); }, '名称已更新。')}>保存名称</button><button disabled={busy} onClick={() => setEditing(null)}>取消重命名</button></label>}
      <div className={styles.actions}>
        <button disabled={busy} onClick={() => void run(() => native.checkAccount(account.id), '已核验原生状态。')}>检查状态</button>
        <button disabled={busy} onClick={() => { setEditing(account.id); setRenamed(account.label); }}>重命名</button>
        {!account.pendingLogin && <><button disabled={busy || !state.capability?.managedLogin} onClick={() => void run(() => native.startAccountLogin(account.id, account.version, method), '已请求重新认证；完成后请重新应用绑定的配置。')}>{account.state === 'signed_in' ? '重新认证' : '登录'}</button><button disabled={busy || account.state === 'signed_out'} onClick={() => void run(() => native.logoutAccount(account.id, account.version), '已请求原生退出。该账号绑定的配置不能再启动；其他账号不受影响。')}>退出此账号</button></>}
        {account.pendingLogin && <button disabled={busy} onClick={() => void run(() => native.cancelAccountLogin(account.id, account.pendingLogin!.id), '已取消此尝试；外部登录终端需自行关闭，其迟到结果不会激活账号。')}>取消登录</button>}
        {account.pendingLogin?.operation === 'login' && state.capability?.browserLink && <button className={styles.primary} disabled={busy} onClick={() => void run(() => native.openAccountLoginLink(account.id, account.pendingLogin!.id), '已请求打开系统浏览器；请在浏览器完成授权。')}>打开授权页面</button>}
        <button className={styles.destructive} disabled={busy || !!account.pendingLogin} title={account.pendingLogin ? '请先取消正在进行的账号操作' : '删除 Cliora 中的账号管理记录'} onClick={() => void (async () => {
          if (!await confirmAction(`删除“${account.label}”的管理记录？原生登录文件、插件和历史记录会保留，不会退出或撤销授权。绑定的配置及额度查询需先解除关联。`, () => live.current && currentTool.current === toolId, { title: '删除账号', confirmLabel: '删除账号', destructive: true })) return;
          await run(async () => { await native.deleteAccount(account.id, account.version); if (editing === account.id) setEditing(null); }, '账号管理记录已删除；原生登录文件与历史记录已保留。');
        })()}>删除账号</button>
      </div>
    </li>)}</ul>
    {state.capability && <details className={styles.compatibility}><summary>登录方式与兼容性</summary><p>{state.capability.reason}</p></details>}
  </section>;
}
