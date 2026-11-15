import { useRemoteReads } from '../../lib/remoteReads';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native, nativeAvailable } from '../../lib/native';
import { uiAdapterFor } from '../../adapters';
import { confirmAction } from '../../lib/confirm';
import { EmptyState } from '../../components/EmptyState';
import type { AccountCapability, AccountImpact, AccountImpactContextKind, AccountImpactScope, AuthAccount, NativeLoginSnapshot } from '../../types/accounts';
import { useFillHeight } from '../../lib/fillHeight';
import styles from './ManagementPanel.module.css';
import accountStyles from './AccountsPanel.module.css';
import i18n from '../../i18n';
import { statusTable, statusTone, type StatusState, type Tone } from '../../lib/statusTone';
import { Badge, Button } from '../../components/ui';
import { Icon } from '../../components/Icon';

function NativeLoginSkeleton() {
  return <div className="skeleton-page" aria-busy="true">{[0, 1].map((index) => <div className={accountStyles.nativeSkeleton} key={index}><span className="skeleton-block" /><span className="skeleton-block" /><span className="skeleton-block" /></div>)}</div>;
}

function AccountListSkeleton() {
  return <div className={`${accountStyles.accountListLoading} skeleton-page`} aria-busy="true">{[0, 1].map((index) => <div className={accountStyles.accountSkeleton} key={index}><span className="skeleton-block" /><span className="skeleton-block" /><span className="skeleton-block" /></div>)}</div>;
}

/** Tone of an account or native login state; states outside the shared table read as neutral. */
function accountTone(state: string): Tone {
  return state in statusTable.account ? statusTone('account', state as StatusState<'account'>).tone : 'neutral';
}
export function accountStateLabel(state: string): string {
  return i18n.t(`tools.accounts.state.${state}`, { defaultValue: state });
}
/** Identity is optional only when the capability says so. A missing flag stays required. */
export function accountReadyForSelection(account: Pick<AuthAccount, 'state' | 'identity' | 'context' | 'pendingLogin'>, capability: AccountCapability | null | undefined) {
  const identityReady = !!account.identity || capability?.identityRequired === false;
  return account.state === 'signed_in' && identityReady && !!account.context && !account.pendingLogin;
}
function contextName(kind: AccountImpactContextKind): string {
  return i18n.t(`tools.accounts.context.${kind}`, { defaultValue: kind });
}
function scopeName(scope: AccountImpactScope): string {
  return scope.scope === 'global' ? i18n.t('tools.accounts.scopeGlobal') : scope.scope === 'project' ? scope.projectName ?? scope.projectPath ?? i18n.t('tools.accounts.scopeProject') : i18n.t('tools.accounts.scopeUnknown');
}
function impactSummary(impact: AccountImpact) {
  const none = i18n.t('tools.accounts.none');
  return i18n.t('tools.accounts.impactSummary', {
    profiles: impact.profiles.map(profile => profile.name).join('、') || none,
    scopes: impact.scopes.map(scope => i18n.t('tools.accounts.scopeEntry', { scope: scopeName(scope), state: scope.active ? i18n.t('tools.accounts.scopeActive') : i18n.t('tools.accounts.scopeHistory') })).join('、') || none,
    references: impact.usageReferences.map(query => query.label).join('、') || none,
  });
}
function errorText(value: unknown, fallback: string) {
  return value && typeof value === 'object' && 'message' in value ? String(value.message) : fallback;
}
const nativeDiscoveryRequests = new Map<string, Promise<NativeLoginSnapshot>>();
function readNativeLogins(toolId: string) {
  const pending = nativeDiscoveryRequests.get(toolId);
  if (pending) return pending;
  const request = native.discoverNativeLogins(toolId).finally(() => { if (nativeDiscoveryRequests.get(toolId) === request) nativeDiscoveryRequests.delete(toolId); });
  nativeDiscoveryRequests.set(toolId, request);
  return request;
}
export function useAccounts(tool: string, active = true, remoteTargetId: string | null = null) {
  const remoteReads = useRemoteReads(remoteTargetId, tool, active);
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
      const [all, rawCaps] = remoteTargetId
        ? await remoteReads.native.getRemoteResourceStore(remoteTargetId, tool, 'accounts').then(value => {
          const store = value as { accounts?: AuthAccount[]; capability?: AccountCapability | null };
          return [store.accounts ?? [], store.capability ?? null] as const;
        })
        : await Promise.all([native.listAccounts(), native.accountCapabilities()]);
      const caps = Array.isArray(rawCaps) ? rawCaps : rawCaps ? [rawCaps] : [];
      if (mounted.current && generation.current === scope && request.current === currentRequest && currentTool.current === tool) { const matching = all.filter(account => account.toolId === tool); setAccounts(matching); setCapability(caps.find(cap => cap.toolId === tool) ?? null); setError(''); return matching; }
      return null;
    } catch (value) {
      if (mounted.current && generation.current === scope && request.current === currentRequest && currentTool.current === tool) setError(errorText(value, i18n.t('tools.accounts.readFailed')));
      throw value;
    }
  };
  useEffect(() => {
    mounted.current = true; const scope = ++generation.current;
    if (!nativeAvailable || !active) { setLoading(false); return () => { mounted.current = false; generation.current++; }; }
    setLoading(true); setAccounts([]); setCapability(null); setError('');
    const read = () => refresh().catch(() => {}).finally(() => { if (mounted.current && generation.current === scope) setLoading(false); });
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await read();
      if (!disposed) timer = setTimeout(() => { void poll(); }, remoteTargetId ? 30_000 : 2_500);
    };
    void poll();
    return () => { disposed = true; mounted.current = false; generation.current++; clearTimeout(timer); };
  }, [tool, active, remoteTargetId]);
  return { accounts, capability, error, refresh, loading, remote: !!remoteTargetId };
}
type AccountNavigation = {
  onOpenProfile?: (profileId: string, target?: AccountImpactScope) => void;
  onOpenUsage?: (queryId: string) => void;
};
type AccountImpactController = {
  impact: AccountImpact | null;
  loading: boolean;
  busy: boolean;
  error: string;
  notice: string;
  refreshWithAccounts: () => Promise<void>;
  reapply: (scope: AccountImpactScope) => Promise<void>;
};
/** Reads the real references of one account while its management region is open. */
function useAccountImpact({ account, active, remote, refreshAccounts }: { account: AuthAccount; active: boolean; remote: boolean; refreshAccounts: () => Promise<AuthAccount[] | null> }): AccountImpactController {
  const { t } = useTranslation();
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
      if (remote) { setImpact(null); return; }
      const value = await native.accountImpact(account.id);
      if (sequence !== request.current || current.current.id !== account.id || current.current.version !== account.version) return;
      if (value.accountId !== account.id || value.toolId !== account.toolId || value.accountVersion !== account.version) throw new Error(t('tools.accounts.changedError'));
      setImpact(value);
    } catch (value) { if (sequence === request.current) setError(errorText(value, t('tools.accounts.impactFailed'))); }
    finally { if (sequence === request.current) setLoading(false); }
  }
  useEffect(() => {
    const success = successfulReapply.current;
    if (success && (success.accountId !== account.id || success.contextId !== account.context?.id || account.state !== 'signed_in')) successfulReapply.current = null;
    setImpact(null); setNotice(successfulReapply.current?.notice ?? ''); setBusy(false);
    if (active && nativeAvailable && !remote) void refresh();
    return () => { request.current++; };
  }, [active, account.id, account.version, refreshEpoch, remote]);
  async function refreshWithAccounts() {
    const sequence = request.current; setBusy(true); setError('');
    try {
      const updated = await refreshAccounts();
      if (request.current === sequence && updated?.some(item => item.id === account.id)) setRefreshEpoch(value => value + 1);
    } catch (value) { if (request.current === sequence) setError(errorText(value, t('tools.accounts.refreshFailed'))); }
    finally { if (request.current === sequence && current.current.id === account.id) setBusy(false); }
  }
  async function reapply(scope: AccountImpactScope) {
    const sequence = ++request.current; setBusy(true); setError(''); setNotice(''); successfulReapply.current = null;
    try {
      const fresh = await native.accountImpact(account.id);
      if (sequence !== request.current) return;
      const target = fresh.scopes.find(item => item.bindingId === scope.bindingId);
      if (fresh.accountVersion !== account.version || fresh.toolId !== account.toolId || !target?.active || !target.canReapply || !target.needsReapply || target.profileId !== scope.profileId || target.profileVersion !== scope.profileVersion || target.contextId !== scope.contextId || !target.reapplyRequest || JSON.stringify(target.reapplyRequest) !== JSON.stringify(scope.reapplyRequest)) throw new Error(t('tools.accounts.reapplyChanged'));
      await native.reapplyAccountProfile(scope.reapplyRequest!);
      if (sequence !== request.current) return;
      const successNotice = t('tools.accounts.reapplied', { profile: target.profileName ?? target.profileId, scope: scopeName(target) });
      successfulReapply.current = { accountId: account.id, contextId: scope.reapplyRequest!.expectedContextId, notice: successNotice }; setNotice(successNotice);
      // Shared apply checks the identity and can advance its version. Refresh the
      // parent first; the next render reads impacts against the accepted version.
      const updated = await refreshAccounts();
      if (request.current === sequence && updated?.some(item => item.id === account.id)) setRefreshEpoch(value => value + 1);
    } catch (value) { if (sequence === request.current) setError(errorText(value, t('tools.accounts.reapplyFailed'))); }
    finally { if (sequence === request.current && current.current.id === account.id) setBusy(false); }
  }
  return { impact, loading, busy, error, notice, refreshWithAccounts, reapply };
}
/** One continuous area: linked profiles, scopes, quota references and login contexts. */
function AccountImpactView({ account, controller, remote = false, onOpenProfile, onOpenUsage }: { account: AuthAccount; controller: AccountImpactController; remote?: boolean } & AccountNavigation) {
  const { t } = useTranslation();
  const { impact, loading, busy, error, notice, refreshWithAccounts, reapply } = controller;
  return <section className={accountStyles.impact} aria-label={t('tools.accounts.impactAria', { label: account.label })}>
    <div className={accountStyles.impactHeader}><strong>{t('tools.accounts.impactTitle')}</strong><Button variant="ghost" size="sm" disabled={loading || busy} onClick={() => void refreshWithAccounts()}>{t('tools.accounts.refreshImpact')}</Button></div>
    {remote && <p>{t('tools.accounts.remoteImpact')}</p>}
    {loading && !impact && !remote && <p role="status">{t('tools.accounts.loadingImpact')}</p>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {impact && <><h4>{t('tools.accounts.profilesTitle')}</h4><ul>{impact.profiles.map(profile => <li key={profile.id}><div className={styles.actions}><span>{profile.name}</span>{onOpenProfile && <button disabled={busy} onClick={() => onOpenProfile(profile.id)}>{t('tools.accounts.editProfile')}</button>}</div></li>)}</ul>{!impact.profiles.length && <p>{t('tools.accounts.noProfiles')}</p>}
      <h4>{t('tools.accounts.scopesTitle')}</h4><ul>{impact.scopes.map(scope => <li key={scope.bindingId}>
        <strong>{scope.profileName ?? t('tools.accounts.deletedProfile')} · {scopeName(scope)}</strong><p>{scope.active ? t('tools.accounts.scopeActive') : t('tools.accounts.scopeHistory')} · {contextName(scope.contextKind)}{scope.needsReapply ? t('tools.accounts.needsReapply') : ''}</p>
        {scope.reason && <p>{scope.reason}</p>}<div className={styles.actions}>{scope.active && scope.canReapply && scope.needsReapply && scope.reapplyRequest && <Button variant="primary" disabled={busy || loading} onClick={() => void reapply(scope)}>{t('tools.accounts.reapply')}</Button>}{scope.profileName && onOpenProfile && <button disabled={busy} onClick={() => onOpenProfile(scope.profileId, scope)}>{t('tools.accounts.openScope')}</button>}</div>
      </li>)}</ul>{!impact.scopes.length && <p>{t('tools.accounts.noScopes')}</p>}
      <h4>{t('tools.accounts.usageTitle')}</h4><ul>{impact.usageReferences.map(query => <li key={query.id}><div className={styles.actions}><span>{query.label}{query.needsRebind ? t('tools.accounts.needsRebind') : ''}</span>{onOpenUsage && <button disabled={busy} onClick={() => onOpenUsage(query.id)}>{t('tools.accounts.openUsage')}</button>}</div><p>{contextName(query.contextKind)} · {query.enabled ? t('tools.accounts.enabled') : t('tools.accounts.disabled')}</p></li>)}</ul>{!impact.usageReferences.length && <p>{t('tools.accounts.noUsage')}</p>}
      <h4>{t('tools.accounts.contextsTitle')}</h4>
      <p className={accountStyles.contextSummary}>{t('tools.accounts.contextSummary', { contexts: impact.contexts.map(context => contextName(context.kind)).join('、') || t('tools.accounts.noContexts') })}</p>
    </>}
  </section>;
}
type AccountRowActions = {
  run: (work: () => Promise<unknown>, notice: string) => Promise<void>;
  isCurrent: () => boolean;
  busy: boolean;
  capability: AccountCapability | null;
  method: 'browser' | 'device';
  remote: boolean;
  refreshAccounts: () => Promise<AuthAccount[] | null>;
};
/** One managed account: identity and state first, its current action next, management on demand. */
function AccountRow({ account, run, isCurrent, busy, capability, method, remote, refreshAccounts, onOpenProfile, onOpenUsage }: { account: AuthAccount } & AccountRowActions & AccountNavigation) {
  const { t } = useTranslation();
  const [managing, setManaging] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(account.label);
  const renameButton = useRef<HTMLButtonElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const manageButton = useRef<HTMLButtonElement>(null);
  const wasRenaming = useRef(false);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const impact = useAccountImpact({ account, active: managing, remote, refreshAccounts });
  const pending = account.pendingLogin;
  useEffect(() => { setRenaming(false); setManaging(false); }, [account.id]);
  useEffect(() => {
    // Busy disables the pressed control, so focus comes back only once the run settles.
    if (busy || !restoreFocus.current) return;
    const target = restoreFocus.current; restoreFocus.current = null;
    if (target.isConnected) target.focus({ preventScroll: true });
  }, [busy]);
  useEffect(() => {
    if (renaming) { renameInput.current?.focus(); renameInput.current?.select(); }
    else if (wasRenaming.current) requestAnimationFrame(() => renameButton.current?.focus());
    wasRenaming.current = renaming;
  }, [renaming]);
  const identity = account.identity?.email ?? account.identity?.subject ?? null;
  const identityText = identity ?? t('tools.accounts.noIdentity');
  const plan = account.identity?.plan ? ` · ${account.identity.plan}` : '';
  const signIn = !remote && !!capability?.managedLogin && !!capability.methods.length;
  const readOnlyCapability = !!capability && !capability.managedLogin;
  const managed = !remote && !readOnlyCapability;
  const canManage = managed || remote;
  const methods = capability?.methods ?? [];
  const loginMethod = methods.includes(method) ? method : methods[0];
  const manageId = `account-management-${account.id}`;
  const deleteHintId = `account-delete-hint-${account.id}`;
  function guard(fresh: AccountImpact) {
    if (fresh.accountId !== account.id || fresh.toolId !== account.toolId) throw new Error(t('tools.accounts.changedError'));
    if (fresh.accountVersion !== account.version) { void refreshAccounts().catch(() => {}); throw new Error(t('tools.accounts.changedError')); }
    return fresh;
  }
  return <li data-account-id={account.id} data-account-state={account.state}>
    <div className={accountStyles.accountHead}>
      <div className={accountStyles.accountIdentity}>
        <strong>{account.label}</strong>
        <p>{identityText}{plan}</p>
      </div>
      <div className={accountStyles.accountState}>
        {remote && <span className={accountStyles.readOnlyTag}>{t('tools.accounts.remoteReadOnly')}</span>}
        <Badge tone={accountTone(account.state)} dot={account.state === 'signed_in'} data-state={account.state}>{accountStateLabel(account.state)}</Badge>
      </div>
    </div>
    {canManage && renaming && <div className={accountStyles.renameForm}>
      <label>{t('tools.accounts.newName')}<input ref={renameInput} value={renameValue} onChange={event => setRenameValue(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing && !busy && renameValue.trim()) { event.preventDefault(); void run(async () => { await native.renameAccount(account.id, account.version, renameValue.trim()); if (isCurrent()) setRenaming(false); }, t('tools.accounts.renamed')); }
        else if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); setRenaming(false); }
      }} /></label>
      <Button size="sm" disabled={busy || !renameValue.trim()} onClick={() => void run(async () => { await native.renameAccount(account.id, account.version, renameValue.trim()); if (isCurrent()) setRenaming(false); }, t('tools.accounts.renamed'))}>{t('tools.accounts.saveName')}</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRenaming(false)}>{t('tools.accounts.cancelRename')}</Button>
    </div>}
    {pending && <div className={accountStyles.waiting} role="status">
      <span>{t('tools.accounts.pendingNote')}</span>
      {!remote && <div className={styles.actions}>
        <Button size="sm" disabled={busy} onClick={() => void run(() => native.cancelAccountLogin(account.id, pending.id), t('tools.accounts.cancelledNotice'))}>{t('tools.accounts.cancelLogin')}</Button>
        {pending.operation === 'login' && capability?.browserLink && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(() => native.openAccountLoginLink(account.id, pending.id), t('tools.accounts.browserRequested'))}>{t('tools.accounts.openAuthPage')}</Button>}
      </div>}
    </div>}
    <div className={accountStyles.rowActions}>
      {!pending && signIn && <Button size="sm" disabled={busy} onClick={() => void run(() => native.startAccountLogin(account.id, account.version, loginMethod!), account.state === 'signed_in' ? t('tools.accounts.reauthRequested') : t('tools.accounts.loginRequested'))}>{account.state === 'signed_in' ? t('tools.accounts.reauthenticate') : t('tools.accounts.login')}</Button>}
      {!pending && managed && <Button variant={signIn ? 'ghost' : 'secondary'} size="sm" disabled={busy} onClick={() => void run(() => native.checkAccount(account.id), t('tools.accounts.checkedNotice'))}>{t('tools.accounts.checkStatus')}</Button>}
      {!pending && managed && <Button ref={renameButton} variant="ghost" size="sm" disabled={busy} onClick={() => { setRenameValue(account.label); setRenaming(true); }}>{t('tools.accounts.rename')}</Button>}
      {account.retiredContexts.length > 0 && canManage && !managing && <Button variant="ghost" size="sm" onClick={() => setManaging(true)}>{t('tools.accounts.viewRetired')}</Button>}
      {canManage && <Button ref={manageButton} variant="ghost" size="sm" aria-expanded={managing} aria-controls={manageId} onClick={() => setManaging(value => !value)}>{t('tools.accounts.manageSummary')}</Button>}
    </div>
    {!managed && !remote && readOnlyCapability && account.detail && <p className={accountStyles.readOnlyDetail}>{account.detail}</p>}
    {canManage && managing && <div className={accountStyles.management} id={manageId} role="region" aria-label={t('tools.accounts.managementAria', { label: account.label })}>
      {account.detail && <p>{account.detail}</p>}
      <AccountImpactView account={account} controller={impact} remote={remote} onOpenProfile={onOpenProfile} onOpenUsage={onOpenUsage} />
      <section className={accountStyles.danger} aria-label={t('tools.accounts.dangerTitle')}>
        <h4>{t('tools.accounts.dangerTitle')}</h4>
        <p>{t('tools.accounts.dangerNote')}</p>
        {impact.impact && <p>{t('tools.accounts.dangerImpact', { profiles: impact.impact.profiles.length, scopes: impact.impact.scopes.length, usage: impact.impact.usageReferences.length })}</p>}
        {impact.error && <p>{t('tools.accounts.dangerImpactFailed')}</p>}
        {managed && <div className={accountStyles.dangerActions}>
          <Button size="sm" disabled={busy || !!pending || account.state === 'signed_out'} onClick={event => { const opener = event.currentTarget; void run(async () => {
            const fresh = guard(await native.accountImpact(account.id));
            if (!isCurrent()) return false;
            if (!await confirmAction(t('tools.accounts.logoutConfirm', { label: account.label, impact: impactSummary(fresh) }), isCurrent, { title: t('tools.accounts.logout'), confirmLabel: t('tools.accounts.logout'), destructive: true })) { restoreFocus.current = opener; return false; }
            await native.logoutAccount(account.id, account.version);
            restoreFocus.current = manageButton.current;
          }, t('tools.accounts.logoutRequested')); }}>{t('tools.accounts.logout')}</Button>
          <Button variant="danger" size="sm" disabled={busy || !!pending} aria-describedby={pending ? deleteHintId : undefined} title={pending ? t('tools.accounts.deleteDisabledTitle') : t('tools.accounts.deleteTitle')} onClick={event => { const opener = event.currentTarget; void run(async () => {
            const fresh = guard(await native.accountImpact(account.id));
            if (!isCurrent()) return false;
            if (!await confirmAction(t('tools.accounts.deleteConfirm', { label: account.label, impact: impactSummary(fresh) }), isCurrent, { title: t('tools.accounts.deleteAction'), confirmLabel: t('tools.accounts.deleteAction'), destructive: true })) { restoreFocus.current = opener; return false; }
            await native.deleteAccount(account.id, account.version);
            if (isCurrent()) setRenaming(false);
          }, t('tools.accounts.deleted')); }}>{t('tools.accounts.deleteAction')}</Button>
        </div>}
        {pending && <p id={deleteHintId} className={accountStyles.actionHint}>{t('tools.accounts.deleteDisabledHint')}</p>}
      </section>
    </div>}
  </li>;
}
export function AccountsPanel({ toolId, state, onOpenProfile, onOpenUsage }: { toolId: string; state: ReturnType<typeof useAccounts> } & AccountNavigation) {
  const { t } = useTranslation();
  const metadata = uiAdapterFor(toolId).accounts;
  const currentTool = useRef(toolId); currentTool.current = toolId;
  const live = useRef(true); useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [label, setLabel] = useState(metadata?.defaultLabel ?? t('tools.accounts.newAccount'));
  const [method, setMethod] = useState<'browser' | 'device'>('browser');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [nativeLogins, setNativeLogins] = useState<NativeLoginSnapshot | null>(null);
  const [nativeLoading, setNativeLoading] = useState(false);
  const [nativeError, setNativeError] = useState('');
  const discoverySequence = useRef(0);
  const remote = state.remote;
  async function discover() {
    const sequence = ++discoverySequence.current;
    setNativeLoading(true); setNativeError('');
    try { const value = await readNativeLogins(toolId); if (live.current && discoverySequence.current === sequence) setNativeLogins(value); }
    catch (value) { if (live.current && discoverySequence.current === sequence) setNativeError(errorText(value, t('tools.accounts.nativeReadFailed'))); }
    finally { if (live.current && discoverySequence.current === sequence) setNativeLoading(false); }
  }
  useEffect(() => {
    setNativeLogins(null); setNativeError(''); setMessage(''); setError(''); setCreating(false); setLabel(metadata?.defaultLabel ?? t('tools.accounts.newAccount')); setMethod('browser');
    if (nativeAvailable && !remote) void discover();
    return () => { discoverySequence.current++; };
  }, [toolId, remote]);
  const board = useRef<HTMLElement>(null);
  useFillHeight(board, 'minHeight');
  const isCurrent = () => live.current && currentTool.current === toolId;
  async function run(work: () => Promise<unknown>, notice: string) { setBusy(true); setError(''); setMessage(''); try { const outcome = await work(); if (outcome === false || !isCurrent()) return; await state.refresh(); if (isCurrent()) setMessage(notice); } catch (value) { if (!isCurrent()) return; setError(errorText(value, t('tools.accounts.actionFailed'))); } finally { if (isCurrent()) setBusy(false); } }
  return <section ref={board} className={styles.panel} aria-label={t('tools.accounts.label')}>
    <div className={styles.header}><div><h2>{t('tools.accounts.title')}</h2><p>{metadata?.description ?? t('tools.accounts.defaultDescription')}</p></div>{state.capability?.managedLogin && !remote && <Button variant={creating ? 'secondary' : 'primary'} icon={creating ? undefined : <Icon name="plus" size={14} />} aria-expanded={creating} onClick={() => setCreating(value => !value)}>{creating ? t('tools.accounts.collapseAdd') : t('tools.accounts.add')}</Button>}</div>
    <div className={styles.body}>
    {!nativeAvailable && <p role="alert">{t('tools.accounts.nativeOnly')}</p>}
    <section className={accountStyles.nativeLogin} aria-label={t('tools.accounts.nativeTitle')}><div className={styles.header}><div><h3>{t('tools.accounts.nativeTitle')}</h3><p>{metadata?.nativeDescription ?? t('tools.accounts.nativeDefaultDescription')}</p></div><div className={styles.actions}><span className={accountStyles.readOnlyTag}>{t('tools.accounts.nativeReadOnly')}</span><Button variant="ghost" size="sm" disabled={remote || nativeLoading || !nativeAvailable} onClick={() => void discover()}>{nativeLoading ? t('tools.accounts.nativeChecking') : t('tools.accounts.nativeCheck')}</Button></div></div>
      {nativeLoading && !nativeLogins && <div className={accountStyles.nativeLoading} role="status" aria-label={t('tools.accounts.nativeLoading')}><NativeLoginSkeleton /></div>}
      {nativeError && <p role="alert">{nativeError}</p>}
      {nativeLogins && !nativeLogins.logins.length && (!state.loading && !state.accounts.length
        ? <EmptyState icon="monitor" title={t('tools.accounts.nativeEmptyTitle')} detail={t('tools.accounts.nativeEmpty')} action={<Button variant="primary" disabled={remote || nativeLoading || !nativeAvailable} onClick={() => void discover()}>{t('tools.accounts.rediscover')}</Button>} />
        : <p>{t('tools.accounts.nativeEmpty')}</p>)}
      {nativeLogins?.logins.map((login, index) => <div className={accountStyles.nativeRow} data-native-login={login.provider} key={`${login.provider}:${login.authKind}:${login.identity?.subject ?? login.identity?.email ?? ''}:${index}`}><div className={accountStyles.nativeIdentity}><strong>{login.identity?.email ?? login.identity?.subject ?? login.provider}</strong><span>{login.identity ? `${login.provider} · ` : ''}{login.authKind === 'oauth' ? 'OAuth' : 'API Key'}{login.identity?.plan && ` · ${login.identity.plan}`}{!login.identity && login.authKind === 'oauth' && login.state === 'signed_in' ? t('tools.accounts.identityMissing') : ''}</span><p>{login.managedAccountId ? t('tools.accounts.managed', { label: state.accounts.find(account => account.id === login.managedAccountId)?.label ?? t('tools.accounts.existingAccount') }) : login.state === 'signed_in' ? t('tools.accounts.unmanagedNote') : login.detail}</p></div><Badge tone={accountTone(login.state)} dot={login.state === 'signed_in'} data-state={login.state}>{login.state === 'signed_in' ? login.authKind === 'api_key' ? t('tools.accounts.badgeConfigured') : t('tools.accounts.badgeSignedIn') : login.state === 'signed_out' ? t('tools.accounts.badgeSignedOut') : accountStateLabel(login.state)}</Badge>{login.state !== 'signed_out' && <details><summary>{t('tools.accounts.detail')}</summary><p>{login.detail}</p></details>}</div>)}
    </section>
    {creating && <div className={`${styles.create} ${accountStyles.addForm}`}><label>{t('tools.accounts.accountName')}<input value={label} onChange={event => setLabel(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && !busy && nativeAvailable && label.trim() && state.capability?.managedLogin && state.capability.methods.length) { event.preventDefault(); void run(async () => { const account = await native.createAccount(toolId, label.trim()); if (!isCurrent()) return; await native.startAccountLogin(account.id, account.version, state.capability!.methods.includes(method) ? method : state.capability!.methods[0]); }, t('tools.accounts.loginRequested')); } }} placeholder={t('tools.accounts.namePlaceholder')} /></label>
      <label>{t('tools.accounts.loginMethod')}<select value={state.capability?.methods.includes(method) ? method : state.capability?.methods[0] ?? ''} onChange={event => setMethod(event.target.value as 'browser' | 'device')}>{state.capability?.methods.map(value => <option key={value} value={value}>{metadata?.methods?.[value] ?? (value === 'device' ? t('tools.accounts.methodDevice') : t('tools.accounts.methodBrowser'))}</option>)}</select></label>
      <p>{metadata?.managedDescription}</p>
      <Button variant="primary" disabled={busy || !nativeAvailable || !label.trim() || !state.capability?.managedLogin || !state.capability.methods.length} onClick={() => void run(async () => { const account = await native.createAccount(toolId, label.trim()); if (!isCurrent()) return; await native.startAccountLogin(account.id, account.version, state.capability!.methods.includes(method) ? method : state.capability!.methods[0]); }, t('tools.accounts.loginRequested'))}>{t('tools.accounts.addAndLogin')}</Button>
      {state.capability?.importNative && <button disabled={busy || !nativeAvailable || !label.trim()} onClick={() => void run(() => native.adoptNativeAccount(toolId, label), t('tools.accounts.adopted'))}>{t('tools.accounts.adopt')}</button>}
    </div>}
    {(error || state.error) && <p role="alert">{error || state.error}</p>}{message && <p role="status">{message}</p>}
    <div className={styles.sectionTitle}><h3>{t('tools.accounts.managedTitle')}</h3><span>{t('tools.accounts.count', { count: state.accounts.length })}</span>{remote && <span className={accountStyles.readOnlyTag}>{t('tools.accounts.remoteReadOnly')}</span>}</div>
    {state.capability && !state.capability.managedLogin && state.capability.reason && <p className={styles.readonlyNote}>{state.capability.reason}</p>}
    {state.loading ? <AccountListSkeleton /> : state.accounts.length === 0 && <p className={styles.empty}>{state.capability?.managedLogin ? t('tools.accounts.emptyManaged') : t('tools.accounts.emptyReadonly')}</p>}
    <ul className={styles.list}>{state.accounts.map(account => <AccountRow key={account.id} account={account} run={run} isCurrent={isCurrent} busy={busy} capability={state.capability} method={method} remote={remote} refreshAccounts={state.refresh} onOpenProfile={onOpenProfile} onOpenUsage={onOpenUsage} />)}</ul>
    {state.capability && <details className={styles.compatibility}><summary>{t('tools.accounts.compatibility')}</summary><p>{state.capability.reason}</p></details>}
    </div>
  </section>;
}
