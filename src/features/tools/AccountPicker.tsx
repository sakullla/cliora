import { useEffect, useRef, useState } from 'react';
import { uiAdapterFor } from '../../adapters';
import { native, nativeAvailable } from '../../lib/native';
import type { AuthAccount } from '../../types/accounts';
import { accountStates, useAccounts } from './AccountsPanel';
import styles from './AccountPicker.module.css';

export type AccountPickerProps = {
  toolId: string;
  selectedAccountId?: string;
  onSelect: (account: AuthAccount) => void;
  onBack: () => void;
};

function errorText(value: unknown) {
  return value && typeof value === 'object' && 'message' in value ? String(value.message) : '账号操作失败，请重试。';
}

/** Owns navigation/login attempts, never the calling editor's draft or apply action. */
export function AccountPicker({ toolId, selectedAccountId, onSelect, onBack }: AccountPickerProps) {
  const state = useAccounts(toolId);
  const metadata = uiAdapterFor(toolId).accounts;
  const [label, setLabel] = useState(metadata?.defaultLabel ?? '新账号');
  const [method, setMethod] = useState<'browser' | 'device'>('browser');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loginAccountId, setLoginAccountId] = useState<string | null>(null);
  const currentTool = useRef(toolId); currentTool.current = toolId;
  const sequence = useRef(0);
  const alive = useRef(true);
  const ownedAttempt = useRef<{ accountId: string; attemptId: string; version: number } | null>(null);
  const cancelledAccounts = useRef(new Set<string>());
  const cancelling = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false; sequence.current++;
      const attempt = ownedAttempt.current; ownedAttempt.current = null;
      if (attempt) void native.cancelAccountLogin(attempt.accountId, attempt.attemptId).catch(() => {});
    };
  }, []);
  useEffect(() => {
    sequence.current++; setCreating(false); setLoginAccountId(null); setError(''); setNotice(''); setBusy(false);
    setLabel(metadata?.defaultLabel ?? '新账号'); setMethod('browser');
    const attempt = ownedAttempt.current; ownedAttempt.current = null;
    if (attempt) void native.cancelAccountLogin(attempt.accountId, attempt.attemptId).catch(() => {});
  }, [toolId]);
  const isCurrent = (request: number) => alive.current && sequence.current === request && currentTool.current === toolId;
  const loginAccount = state.accounts.find(account => account.id === loginAccountId);
  const waiting = !!loginAccount?.pendingLogin || !!ownedAttempt.current;
  const methods = state.capability?.methods ?? [];
  const selectedMethod = methods.includes(method) ? method : methods[0];

  async function login(existing?: AuthAccount) {
    if (!state.capability?.managedLogin || !selectedMethod) return;
    const request = ++sequence.current;
    setBusy(true); setError(''); setNotice('');
    let started: AuthAccount | undefined;
    try {
      const account = existing ?? await native.createAccount(toolId, label.trim());
      // Returning before creation finishes must not open a new login terminal.
      if (!isCurrent(request)) return;
      setLoginAccountId(account.id); cancelledAccounts.current.delete(account.id);
      started = await native.startAccountLogin(account.id, account.version, selectedMethod);
      if (!isCurrent(request)) {
        if (started.pendingLogin) await native.cancelAccountLogin(started.id, started.pendingLogin.id);
        return;
      }
      ownedAttempt.current = started.pendingLogin ? { accountId: started.id, attemptId: started.pendingLogin.id, version: started.version } : null;
      await state.refresh();
      if (isCurrent(request)) setNotice('已打开原生登录。完成身份核验后，请明确选择账号返回配置；配置草稿会保留。');
    } catch (value) { if (isCurrent(request)) setError(errorText(value)); }
    finally { if (isCurrent(request)) setBusy(false); }
  }

  // Polling can complete an owned attempt. A cancelled account remains excluded
  // until an explicit retry, even if a stale response later claims signed_in.
  useEffect(() => {
    if (loginAccount && !loginAccount.pendingLogin && ownedAttempt.current?.accountId === loginAccount.id && loginAccount.version >= ownedAttempt.current.version) {
      ownedAttempt.current = null;
      if (loginAccount.state === 'signed_in' && loginAccount.identity && loginAccount.context) setNotice('身份已核验。请明确选择账号返回配置；尚未应用配置。');
      else setNotice('登录尚未完成身份核验，请检查状态或重试登录。');
    }
  }, [loginAccount]);

  async function cancel(back = false) {
    if (cancelling.current) return;
    cancelling.current = true;
    const request = ++sequence.current;
    setBusy(true); setError('');
    const attempt = ownedAttempt.current ?? (loginAccount?.pendingLogin ? { accountId: loginAccount.id, attemptId: loginAccount.pendingLogin.id } : null);
    try {
      if (attempt) {
        await native.cancelAccountLogin(attempt.accountId, attempt.attemptId);
        cancelledAccounts.current.add(attempt.accountId); ownedAttempt.current = null;
        await state.refresh();
      }
      if (!isCurrent(request)) return;
      setNotice('已取消此尝试；外部终端由你关闭，迟到结果不会选中账号。');
      if (back) onBack();
    } catch (value) { if (isCurrent(request)) setError(errorText(value)); }
    finally { cancelling.current = false; if (isCurrent(request)) setBusy(false); }
  }

  async function select(account: AuthAccount) {
    const request = ++sequence.current;
    setBusy(true); setError('');
    try {
      const checked = await native.checkAccount(account.id);
      if (!isCurrent(request)) return;
      if (checked.toolId !== toolId || checked.id !== account.id || checked.state !== 'signed_in' || !checked.identity || !checked.context || checked.pendingLogin || cancelledAccounts.current.has(checked.id)) {
        await state.refresh();
        throw new Error('该账号尚未核验为可用身份，请检查或重新登录后再选择。');
      }
      onSelect(checked);
    } catch (value) { if (isCurrent(request)) setError(errorText(value)); }
    finally { if (isCurrent(request)) setBusy(false); }
  }

  async function check(account: AuthAccount) {
    const request = ++sequence.current; setBusy(true); setError('');
    try { await native.checkAccount(account.id); await state.refresh(); }
    catch (value) { if (isCurrent(request)) setError(errorText(value)); }
    finally { if (isCurrent(request)) setBusy(false); }
  }

  return <section className={styles.picker} aria-label="选择已管理账号" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void cancel(true); } }}>
    <header><div><h3>选择账号</h3><p>{metadata?.description ?? '选择已核验的独立账号，凭据由原生 CLI 维护。'}</p></div><button onClick={() => void cancel(true)}>返回配置</button></header>
    <p>只有明确选择才会更新配置的账号来源；选择不会应用配置。</p>
    {!nativeAvailable && <p role="alert">请在桌面应用中选择账号。</p>}
    {(error || state.error) && <p role="alert">{error || state.error}</p>}
    {notice && <p role="status">{notice}</p>}
    {state.loading && <p role="status">正在读取账号…</p>}
    {!state.loading && !state.accounts.length && <p>尚无已管理账号。CLI 当前登录保持只读，可返回配置使用当前原生来源。</p>}
    <ul>{state.accounts.map(account => {
      const selectable = account.state === 'signed_in' && !!account.identity && !!account.context && !account.pendingLogin && !cancelledAccounts.current.has(account.id);
      return <li key={account.id} aria-label={account.label}>
        <div><strong>{account.label}</strong><span>{cancelledAccounts.current.has(account.id) ? '已取消，需重新登录' : account.state === 'signed_in' && !account.identity ? '身份待核验' : accountStates[account.state]}{account.id === selectedAccountId && ' · 草稿已选'}</span></div>
        <p>{account.identity?.email ?? account.identity?.subject ?? '尚无已核验身份'}</p>
        <div className={styles.actions}><button className={styles.primary} disabled={busy || waiting || !selectable} onClick={() => void select(account)}>选择并返回</button>
          {account.pendingLogin && account.id === loginAccountId && <button disabled={busy} onClick={() => void cancel()}>取消登录</button>}
          {account.pendingLogin?.operation === 'login' && account.id === loginAccountId && state.capability?.browserLink && <button disabled={busy} onClick={() => {
            const request = ++sequence.current; setBusy(true); setError('');
            void native.openAccountLoginLink(account.id, account.pendingLogin!.id).catch(value => { if (isCurrent(request)) setError(errorText(value)); }).finally(() => { if (isCurrent(request)) setBusy(false); });
          }}>打开授权页面</button>}
          {!account.pendingLogin && !selectable && <><button disabled={busy || waiting} onClick={() => void check(account)}>检查状态</button>{state.capability?.managedLogin && <button disabled={busy || waiting} onClick={() => void login(account)}>重试登录</button>}</>}
        </div>
        {account.pendingLogin && <p role="status">等待原生身份核验。打开终端或浏览器不代表已登录；可以取消后返回草稿。</p>}
        {account.detail && <details><summary>登录详情</summary><p>{account.detail}</p></details>}
      </li>;
    })}</ul>
    {state.capability?.managedLogin && <><button disabled={busy || waiting} onClick={() => setCreating(value => !value)}>{creating ? '收起新增登录' : '登录新账号'}</button>
      {creating && <div className={styles.create}><label>账号名称<input value={label} onChange={event => setLabel(event.target.value)} /></label>
        {methods.length > 1 && <label>登录方式<select value={selectedMethod} onChange={event => setMethod(event.target.value as 'browser' | 'device')}>{methods.map(value => <option key={value} value={value}>{metadata?.methods?.[value] ?? (value === 'device' ? '设备码' : '原生交互登录')}</option>)}</select></label>}
        <p>{metadata?.managedDescription}</p><button className={styles.primary} disabled={busy || waiting || !label.trim() || !selectedMethod} onClick={() => void login()}>添加并登录</button></div>}
    </>}
    {state.capability && <details><summary>登录支持范围</summary><p>{state.capability.reason}</p></details>}
  </section>;
}
