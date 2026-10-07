import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { uiAdapterFor } from '../../adapters';
import { native, nativeAvailable } from '../../lib/native';
import type { AuthAccount } from '../../types/accounts';
import { accountStateLabel, useAccounts } from './AccountsPanel';
import i18n from '../../i18n';
import styles from './AccountPicker.module.css';

export type AccountPickerProps = {
  toolId: string;
  selectedAccountId?: string;
  onSelect: (account: AuthAccount) => void;
  onBack: () => void;
};

function errorText(value: unknown) {
  return value && typeof value === 'object' && 'message' in value ? String(value.message) : i18n.t('tools.accounts.operationFailed');
}

/** Owns navigation/login attempts, never the calling editor's draft or apply action. */
export function AccountPicker({ toolId, selectedAccountId, onSelect, onBack }: AccountPickerProps) {
  const { t } = useTranslation();
  const state = useAccounts(toolId);
  const metadata = uiAdapterFor(toolId).accounts;
  const [label, setLabel] = useState(metadata?.defaultLabel ?? t('tools.accounts.newAccount'));
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
    setLabel(metadata?.defaultLabel ?? t('tools.accounts.newAccount')); setMethod('browser');
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
      if (isCurrent(request)) setNotice(t('tools.accounts.opened'));
    } catch (value) { if (isCurrent(request)) setError(errorText(value)); }
    finally { if (isCurrent(request)) setBusy(false); }
  }

  // Polling can complete an owned attempt. A cancelled account remains excluded
  // until an explicit retry, even if a stale response later claims signed_in.
  useEffect(() => {
    if (loginAccount && !loginAccount.pendingLogin && ownedAttempt.current?.accountId === loginAccount.id && loginAccount.version >= ownedAttempt.current.version) {
      ownedAttempt.current = null;
      if (loginAccount.state === 'signed_in' && loginAccount.identity && loginAccount.context) setNotice(t('tools.accounts.verified'));
      else setNotice(t('tools.accounts.incomplete'));
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
      setNotice(t('tools.accounts.cancelled'));
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
        throw new Error(t('tools.accounts.notVerified'));
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

  return <section className={styles.picker} aria-label={t('tools.accounts.pickerLabel')} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void cancel(true); } }}>
    <header><div><h3>{t('tools.accounts.pickerTitle')}</h3><p>{metadata?.description ?? t('tools.accounts.pickerDefaultDescription')}</p></div><button onClick={() => void cancel(true)}>{t('tools.accounts.back')}</button></header>
    <p>{t('tools.accounts.note')}</p>
    {!nativeAvailable && <p role="alert">{t('tools.accounts.pickerNativeOnly')}</p>}
    {(error || state.error) && <p role="alert">{error || state.error}</p>}
    {notice && <p role="status">{notice}</p>}
    {state.loading && <p role="status">{t('tools.accounts.loading')}</p>}
    {!state.loading && !state.accounts.length && <p>{t('tools.accounts.pickerEmpty')}</p>}
    <ul>{state.accounts.map(account => {
      const selectable = account.state === 'signed_in' && !!account.identity && !!account.context && !account.pendingLogin && !cancelledAccounts.current.has(account.id);
      return <li key={account.id} aria-label={account.label}>
        <div><strong>{account.label}</strong><span>{cancelledAccounts.current.has(account.id) ? t('tools.accounts.statusCancelled') : account.state === 'signed_in' && !account.identity ? t('tools.accounts.statusPendingIdentity') : accountStateLabel(account.state)}{account.id === selectedAccountId ? t('tools.accounts.draftSelected') : ''}</span></div>
        <p>{account.identity?.email ?? account.identity?.subject ?? t('tools.accounts.noIdentity')}</p>
        <div className={styles.actions}><button className={styles.primary} disabled={busy || waiting || !selectable} onClick={() => void select(account)}>{t('tools.accounts.selectAndBack')}</button>
          {account.pendingLogin && account.id === loginAccountId && <button disabled={busy} onClick={() => void cancel()}>{t('tools.accounts.cancelLogin')}</button>}
          {account.pendingLogin?.operation === 'login' && account.id === loginAccountId && state.capability?.browserLink && <button disabled={busy} onClick={() => {
            const request = ++sequence.current; setBusy(true); setError('');
            void native.openAccountLoginLink(account.id, account.pendingLogin!.id).catch(value => { if (isCurrent(request)) setError(errorText(value)); }).finally(() => { if (isCurrent(request)) setBusy(false); });
          }}>{t('tools.accounts.openAuthPage')}</button>}
          {!account.pendingLogin && !selectable && <><button disabled={busy || waiting} onClick={() => void check(account)}>{t('tools.accounts.checkStatus')}</button>{state.capability?.managedLogin && <button disabled={busy || waiting} onClick={() => void login(account)}>{t('tools.accounts.retryLogin')}</button>}</>}
        </div>
        {account.pendingLogin && <p role="status">{t('tools.accounts.waiting')}</p>}
        {account.detail && <details><summary>{t('tools.accounts.detail')}</summary><p>{account.detail}</p></details>}
      </li>;
    })}</ul>
    {state.capability?.managedLogin && <><button disabled={busy || waiting} onClick={() => setCreating(value => !value)}>{creating ? t('tools.accounts.collapseCreate') : t('tools.accounts.createLogin')}</button>
      {creating && <div className={styles.create}><label>{t('tools.accounts.accountName')}<input value={label} onChange={event => setLabel(event.target.value)} /></label>
        {methods.length > 1 && <label>{t('tools.accounts.loginMethod')}<select value={selectedMethod} onChange={event => setMethod(event.target.value as 'browser' | 'device')}>{methods.map(value => <option key={value} value={value}>{metadata?.methods?.[value] ?? (value === 'device' ? t('tools.accounts.methodDevice') : t('tools.accounts.methodBrowser'))}</option>)}</select></label>}
        <p>{metadata?.managedDescription}</p><button className={styles.primary} disabled={busy || waiting || !label.trim() || !selectedMethod} onClick={() => void login()}>{t('tools.accounts.addAndLogin')}</button></div>}
    </>}
    {state.capability && <details><summary>{t('tools.accounts.capabilitySummary')}</summary><p>{state.capability.reason}</p></details>}
  </section>;
}
