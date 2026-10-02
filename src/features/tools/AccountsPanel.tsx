import { useEffect, useRef, useState } from 'react';
import { native, nativeAvailable } from '../../lib/native';
import type { AccountCapability, AuthAccount } from '../../types/accounts';
import styles from './AccountsPanel.module.css';
export const accountStates = { signed_out: '已退出', pending: '等待原生登录完成', signed_in: '已登录', expired: '认证失效', error: '认证异常', unknown: '待核验' };
export function useAccounts(tool: string, active = true) {
  const currentTool = useRef(tool); currentTool.current = tool;
  const [accounts, setAccounts] = useState<AuthAccount[]>([]);
  const [capability, setCapability] = useState<AccountCapability | null>(null);
  const [error, setError] = useState('');
  const refresh = async () => { const [all, caps] = await Promise.all([native.listAccounts(), native.accountCapabilities()]); if (currentTool.current === tool) { setAccounts(all.filter(account => account.toolId === tool)); setCapability(caps.find(cap => cap.toolId === tool) ?? null); } };
  useEffect(() => {
    if (!nativeAvailable || !active) return;
    let live = true;
    const read = () => Promise.all([native.listAccounts(), native.accountCapabilities()]).then(([all, caps]) => { if (live) { setAccounts(all.filter(account => account.toolId === tool)); setCapability(caps.find(cap => cap.toolId === tool) ?? null); setError(''); } }).catch(value => { if (live) setError(value.message ?? '账号读取失败'); });
    void read(); const timer = window.setInterval(() => void read(), 2500);
    return () => { live = false; window.clearInterval(timer); };
  }, [tool, active]);
  return { accounts, capability, error, refresh };
}
export function AccountsPanel({ toolId, state }: { toolId: string; state: ReturnType<typeof useAccounts> }) {
  const live = useRef(true); useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [label, setLabel] = useState('');
  const [method, setMethod] = useState<'browser' | 'device'>('browser');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [renamed, setRenamed] = useState('');
  async function run(work: () => Promise<unknown>, notice: string) { setBusy(true); setError(''); try { await work(); if (!live.current) return; await state.refresh(); if (live.current) setMessage(notice); } catch (value) { if (!live.current) return; setError(value && typeof value === 'object' && 'message' in value ? String(value.message) : '账号操作失败'); } finally { if (live.current) setBusy(false); } }
  return <section className={styles.panel} aria-label="OAuth 账号管理">
    <h2>OAuth 账号</h2><p>为命名配置绑定账号，应用后仅对后续启动生效。已有终端继续使用原来的账号。</p>
    {!nativeAvailable && <p role="alert">请在桌面应用中管理账号。</p>}
    <p>{state.capability?.reason}</p>
    <div className={styles.create}><label>账号名称<input value={label} onChange={event => setLabel(event.target.value)} placeholder="例如：工作账号" /></label>
      <label>登录方式<select value={method} onChange={event => setMethod(event.target.value as 'browser' | 'device')}><option value="browser">浏览器 / 原生交互</option>{state.capability?.methods.includes('device') && <option value="device">设备码</option>}</select></label>
      <button disabled={busy || !nativeAvailable || !label.trim() || !state.capability?.managedLogin} onClick={() => void run(async () => { const account = await native.createAccount(toolId, label); await native.startAccountLogin(account.id, account.version, method); setLabel(''); }, '已请求打开原生登录终端；完成身份核验后才会显示已登录。')}>添加并登录</button>
      {state.capability?.importNative && <button disabled={busy || !label.trim()} onClick={() => void run(() => native.adoptNativeCodexAccount(label), '已将现有原生账号纳入管理；继续使用原目录，未复制令牌。')}>纳入现有原生账号</button>}
    </div>
    {(error || state.error) && <p role="alert">{error || state.error}</p>}{message && <p role="status">{message}</p>}
    {state.accounts.length === 0 && <p>还没有受管账号。</p>}
    <ul className={styles.list}>{state.accounts.map(account => <li key={account.id}>
      <div><strong>{account.label}</strong><span>{accountStates[account.state]}</span></div>
      <p>{account.identity?.email ?? account.identity?.subject ?? '尚无已核验身份'}{account.identity?.plan ? ` · ${account.identity.plan}` : ''}</p>
      {account.detail && <p>{account.detail}</p>}
      {editing === account.id && <label>新名称<input value={renamed} onChange={event => setRenamed(event.target.value)} /><button disabled={busy || !renamed.trim()} onClick={() => void run(async () => { await native.renameAccount(account.id, account.version, renamed); setEditing(null); }, '名称已更新。')}>保存名称</button></label>}
      <div className={styles.actions}>
        <button disabled={busy} onClick={() => void run(() => native.checkAccount(account.id), '已核验原生状态。')}>检查状态</button>
        <button disabled={busy} onClick={() => { setEditing(account.id); setRenamed(account.label); }}>重命名</button>
        {!account.pendingLogin && <><button disabled={busy || !state.capability?.managedLogin} onClick={() => void run(() => native.startAccountLogin(account.id, account.version, method), '已请求重新认证；完成后请重新应用绑定的配置。')}>{account.state === 'signed_in' ? '重新认证' : '登录'}</button><button disabled={busy || account.state === 'signed_out'} onClick={() => void run(() => native.logoutAccount(account.id, account.version), '已请求原生退出。该账号绑定的配置不能再启动；其他账号不受影响。')}>退出此账号</button></>}
        {account.pendingLogin && <button disabled={busy} onClick={() => void run(() => native.cancelAccountLogin(account.id, account.pendingLogin!.id), '已取消此尝试；外部登录终端需自行关闭，其迟到结果不会激活账号。')}>取消登录</button>}
      </div>
    </li>)}</ul>
  </section>;
}
