import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native, nativeAvailable } from '../../lib/native';
import { uiAdapterFor } from '../../adapters';
import { confirmAction } from '../../lib/confirm';
import { SkeletonRows } from '../../components/Skeleton';
import type { AccountCapability, AccountImpact, AccountImpactContextKind, AccountImpactScope, AuthAccount, NativeLoginSnapshot } from '../../types/accounts';
import styles from './ManagementPanel.module.css';
import accountStyles from './AccountsPanel.module.css';
import i18n from '../../i18n';

export function accountStateLabel(state: string): string {
  return i18n.t(`tools.accounts.state.${state}`, { defaultValue: state });
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
      if (mounted.current && generation.current === scope && request.current === currentRequest && currentTool.current === tool) setError(value && typeof value === 'object' && 'message' in value ? String(value.message) : i18n.t('tools.accounts.readFailed'));
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
function AccountImpactView({ account, active, refreshAccounts, onOpenProfile, onOpenUsage }: { account: AuthAccount; active: boolean; refreshAccounts: () => Promise<AuthAccount[] | null> } & AccountNavigation) {
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
      const value = await native.accountImpact(account.id);
      if (sequence !== request.current || current.current.id !== account.id || current.current.version !== account.version) return;
      if (value.accountId !== account.id || value.toolId !== account.toolId || value.accountVersion !== account.version) throw new Error(t('tools.accounts.changedError'));
      setImpact(value);
    } catch (value) { if (sequence === request.current) setError(value && typeof value === 'object' && 'message' in value ? String(value.message) : t('tools.accounts.impactFailed')); }
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
    } catch (value) { if (request.current === sequence) setError(value && typeof value === 'object' && 'message' in value ? String(value.message) : t('tools.accounts.refreshFailed')); }
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
    } catch (value) { if (sequence === request.current) setError(value && typeof value === 'object' && 'message' in value ? String(value.message) : t('tools.accounts.reapplyFailed')); }
    finally { if (request.current === sequence && current.current.id === account.id) setBusy(false); }
  }
  if (!active) return null;
  return <section className={accountStyles.impact} aria-label={t('tools.accounts.impactAria', { label: account.label })}>
    <div className={accountStyles.impactHeader}><strong>{t('tools.accounts.impactTitle')}</strong><button disabled={loading || busy} onClick={() => void refreshWithAccounts()}>{t('tools.accounts.refreshImpact')}</button></div>
    {loading && !impact && <p role="status">{t('tools.accounts.loadingImpact')}</p>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {impact && <><ul>{impact.profiles.map(profile => <li key={profile.id}><div className={styles.actions}><span>{profile.name}</span>{onOpenProfile && <button disabled={busy} onClick={() => onOpenProfile(profile.id)}>{t('tools.accounts.editProfile')}</button>}</div></li>)}</ul>{!impact.profiles.length && <p>{t('tools.accounts.noProfiles')}</p>}
      <h4>{t('tools.accounts.scopesTitle')}</h4><ul>{impact.scopes.map(scope => <li key={scope.bindingId}>
        <strong>{scope.profileName ?? t('tools.accounts.deletedProfile')} · {scopeName(scope)}</strong><p>{scope.active ? t('tools.accounts.scopeActive') : t('tools.accounts.scopeHistory')} · {contextName(scope.contextKind)}{scope.needsReapply ? t('tools.accounts.needsReapply') : ''}</p>
        {scope.reason && <p>{scope.reason}</p>}<div className={styles.actions}>{scope.active && scope.canReapply && scope.needsReapply && scope.reapplyRequest && <button className={styles.primary} disabled={busy || loading} onClick={() => void reapply(scope)}>{t('tools.accounts.reapply')}</button>}{scope.profileName && onOpenProfile && <button disabled={busy} onClick={() => onOpenProfile(scope.profileId, scope)}>{t('tools.accounts.openScope')}</button>}</div>
      </li>)}</ul>{!impact.scopes.length && <p>{t('tools.accounts.noScopes')}</p>}
      <h4>{t('tools.accounts.usageTitle')}</h4><ul>{impact.usageReferences.map(query => <li key={query.id}><div className={styles.actions}><span>{query.label}{query.needsRebind ? t('tools.accounts.needsRebind') : ''}</span>{onOpenUsage && <button disabled={busy} onClick={() => onOpenUsage(query.id)}>{t('tools.accounts.openUsage')}</button>}</div><p>{contextName(query.contextKind)} · {query.enabled ? t('tools.accounts.enabled') : t('tools.accounts.disabled')}</p></li>)}</ul>{!impact.usageReferences.length && <p>{t('tools.accounts.noUsage')}</p>}
      <p className={accountStyles.contextSummary}>{t('tools.accounts.contextSummary', { contexts: impact.contexts.map(context => contextName(context.kind)).join('、') || t('tools.accounts.noContexts') })}</p>
    </>}
  </section>;
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
    catch (value) { if (live.current && discoverySequence.current === sequence) setNativeError(value && typeof value === 'object' && 'message' in value ? String(value.message) : t('tools.accounts.nativeReadFailed')); }
    finally { if (live.current && discoverySequence.current === sequence) setNativeLoading(false); }
  }
  useEffect(() => {
    setNativeLogins(null); setNativeError(''); setMessage(''); setError(''); setEditing(null); setCreating(false); setExpanded(new Set()); setLabel(metadata?.defaultLabel ?? t('tools.accounts.newAccount')); setMethod('browser');
    if (nativeAvailable) void discover();
    return () => { discoverySequence.current++; };
  }, [toolId]);
  async function run(work: () => Promise<unknown>, notice: string) { setBusy(true); setError(''); setMessage(''); try { const outcome = await work(); if (outcome === false || !live.current || currentTool.current !== toolId) return; await state.refresh(); if (live.current && currentTool.current === toolId) setMessage(notice); } catch (value) { if (!live.current || currentTool.current !== toolId) return; setError(value && typeof value === 'object' && 'message' in value ? String(value.message) : t('tools.accounts.actionFailed')); } finally { if (live.current && currentTool.current === toolId) setBusy(false); } }
  return <section className={styles.panel} aria-label={t('tools.accounts.label')}>
    <div className={styles.header}><div><h2>{t('tools.accounts.title')}</h2><p>{metadata?.description ?? t('tools.accounts.defaultDescription')}</p></div>{state.capability?.managedLogin && <button className={styles.primary} onClick={() => setCreating(value => !value)}>{creating ? t('tools.accounts.collapseAdd') : t('tools.accounts.add')}</button>}</div>
    {!nativeAvailable && <p role="alert">{t('tools.accounts.nativeOnly')}</p>}
    <section className={accountStyles.nativeLogin} aria-label={t('tools.accounts.nativeTitle')}><div className={styles.header}><div><h3>{t('tools.accounts.nativeTitle')}</h3><p>{metadata?.nativeDescription ?? t('tools.accounts.nativeDefaultDescription')}</p></div><button disabled={nativeLoading || !nativeAvailable} onClick={() => void discover()}>{nativeLoading ? t('tools.accounts.nativeChecking') : t('tools.accounts.nativeCheck')}</button></div>
      {nativeLoading && !nativeLogins && <p role="status">{t('tools.accounts.nativeLoading')}</p>}
      {nativeError && <p role="alert">{nativeError}</p>}
      {nativeLogins && !nativeLogins.logins.length && <p>{t('tools.accounts.nativeEmpty')}</p>}
      {nativeLogins?.logins.map(login => <div className={accountStyles.nativeRow} key={`${login.provider}:${login.authKind}`}><div className={accountStyles.nativeIdentity}><strong>{login.identity?.email ?? login.identity?.subject ?? login.provider}</strong><span>{login.identity ? `${login.provider} · ` : ''}{login.authKind === 'oauth' ? 'OAuth' : 'API Key'}{login.identity?.plan && ` · ${login.identity.plan}`}{!login.identity && login.authKind === 'oauth' && login.state === 'signed_in' ? t('tools.accounts.identityMissing') : ''}</span><p>{login.managedAccountId ? t('tools.accounts.managed', { label: state.accounts.find(account => account.id === login.managedAccountId)?.label ?? t('tools.accounts.existingAccount') }) : login.state === 'signed_in' ? t('tools.accounts.unmanagedNote') : login.detail}</p></div><span className={styles.badge} data-state={login.state}>{login.state === 'signed_in' ? login.authKind === 'api_key' ? t('tools.accounts.badgeConfigured') : t('tools.accounts.badgeSignedIn') : login.state === 'signed_out' ? t('tools.accounts.badgeSignedOut') : accountStateLabel(login.state)}</span>{login.state !== 'signed_out' && <details><summary>{t('tools.accounts.detail')}</summary><p>{login.detail}</p></details>}</div>)}
    </section>
    {creating && <div className={styles.create}><label>{t('tools.accounts.accountName')}<input value={label} onChange={event => setLabel(event.target.value)} placeholder={t('tools.accounts.namePlaceholder')} /></label>
      <label>{t('tools.accounts.loginMethod')}<select value={state.capability?.methods.includes(method) ? method : state.capability?.methods[0] ?? ''} onChange={event => setMethod(event.target.value as 'browser' | 'device')}>{state.capability?.methods.map(value => <option key={value} value={value}>{metadata?.methods?.[value] ?? (value === 'device' ? t('tools.accounts.methodDevice') : t('tools.accounts.methodBrowser'))}</option>)}</select></label>
      <p>{metadata?.managedDescription}</p>
      <button className={styles.primary} disabled={busy || !nativeAvailable || !label.trim() || !state.capability?.managedLogin || !state.capability.methods.length} onClick={() => void run(async () => { const account = await native.createAccount(toolId, label.trim()); if (!live.current || currentTool.current !== toolId) return; await native.startAccountLogin(account.id, account.version, state.capability!.methods.includes(method) ? method : state.capability!.methods[0]); }, t('tools.accounts.loginRequested'))}>{t('tools.accounts.addAndLogin')}</button>
      {state.capability?.importNative && <button disabled={busy || !nativeAvailable || !label.trim()} onClick={() => void run(() => native.adoptNativeAccount(toolId, label), t('tools.accounts.adopted'))}>{t('tools.accounts.adopt')}</button>}
    </div>}
    {(error || state.error) && <p role="alert">{error || state.error}</p>}{message && <p role="status">{message}</p>}
    <div className={styles.sectionTitle}><h3>{t('tools.accounts.managedTitle')}</h3><span>{t('tools.accounts.count', { count: state.accounts.length })}</span></div>
    {state.loading ? <SkeletonRows count={2} /> : state.accounts.length === 0 && <p className={styles.empty}>{state.capability?.managedLogin ? t('tools.accounts.emptyManaged') : t('tools.accounts.emptyReadonly')}</p>}
    <ul className={styles.list}>{state.accounts.map(account => <li key={account.id}>
      <div><strong>{account.label}</strong><span data-state={account.state === 'signed_in' && !account.identity ? 'unknown' : account.state}>{account.state === 'signed_in' && !account.identity ? t('tools.accounts.statusPendingIdentity') : accountStateLabel(account.state)}</span></div>
      <p>{account.identity?.email ?? account.identity?.subject ?? t('tools.accounts.noIdentity')}{account.identity?.plan ? ` · ${account.identity.plan}` : ''}</p>
      {account.pendingLogin && <p>{t('tools.accounts.pendingNote')}</p>}
      {account.pendingLogin && <div className={styles.actions}><button disabled={busy} onClick={() => void run(() => native.cancelAccountLogin(account.id, account.pendingLogin!.id), t('tools.accounts.cancelledNotice'))}>{t('tools.accounts.cancelLogin')}</button>{account.pendingLogin.operation === 'login' && state.capability?.browserLink && <button disabled={busy} onClick={() => void run(() => native.openAccountLoginLink(account.id, account.pendingLogin!.id), t('tools.accounts.browserRequested'))}>{t('tools.accounts.openAuthPage')}</button>}</div>}
      {account.retiredContexts.length > 0 && <button onClick={() => setExpanded(previous => new Set(previous).add(account.id))}>{t('tools.accounts.viewRetired')}</button>}
      <details className={accountStyles.management} open={expanded.has(account.id)} onToggle={event => { const open = event.currentTarget.open; setExpanded(previous => { const next = new Set(previous); if (open) next.add(account.id); else next.delete(account.id); return next; }); }}><summary>{t('tools.accounts.manageSummary')}</summary>
      <div className={accountStyles.accountActions}>
        <div className={styles.actions}>
          <button disabled={busy} onClick={() => void run(() => native.checkAccount(account.id), t('tools.accounts.checkedNotice'))}>{t('tools.accounts.checkStatus')}</button>
          <button disabled={busy} onClick={() => { setEditing(account.id); setRenamed(account.label); }}>{t('tools.accounts.rename')}</button>
          {!account.pendingLogin && state.capability?.managedLogin && <button disabled={busy || !state.capability.methods.length} onClick={() => void run(() => native.startAccountLogin(account.id, account.version, state.capability!.methods.includes(method) ? method : state.capability!.methods[0]), t('tools.accounts.reauthRequested'))}>{account.state === 'signed_in' ? t('tools.accounts.reauthenticate') : t('tools.accounts.login')}</button>}
        </div>
        {editing === account.id && <label>{t('tools.accounts.newName')}<input value={renamed} onChange={event => setRenamed(event.target.value)} /><button disabled={busy || !renamed.trim()} onClick={() => void run(async () => { await native.renameAccount(account.id, account.version, renamed); setEditing(null); }, t('tools.accounts.renamed'))}>{t('tools.accounts.saveName')}</button><button disabled={busy} onClick={() => setEditing(null)}>{t('tools.accounts.cancelRename')}</button></label>}
        <details className={accountStyles.moreActions}><summary>{t('tools.accounts.moreActions')}</summary>
          <div className={styles.actions}>
            {!account.pendingLogin && <button disabled={busy || account.state === 'signed_out'} onClick={() => void run(async () => {
              const impact = await native.accountImpact(account.id);
              if (!live.current || currentTool.current !== toolId) return;
              if (!await confirmAction(t('tools.accounts.logoutConfirm', { label: account.label, impact: impactSummary(impact) }), () => live.current && currentTool.current === toolId, { title: t('tools.accounts.logout'), confirmLabel: t('tools.accounts.logout'), destructive: true })) return false;
              await native.logoutAccount(account.id, account.version);
            }, t('tools.accounts.logoutRequested'))}>{t('tools.accounts.logout')}</button>}
            <button className={styles.destructive} disabled={busy || !!account.pendingLogin} aria-describedby={account.pendingLogin ? `account-delete-hint-${account.id}` : undefined} title={account.pendingLogin ? t('tools.accounts.deleteDisabledTitle') : t('tools.accounts.deleteTitle')} onClick={() => void (async () => {
              await run(async () => {
                const impact = await native.accountImpact(account.id);
                if (!live.current || currentTool.current !== toolId) return;
                if (!await confirmAction(t('tools.accounts.deleteConfirm', { label: account.label, impact: impactSummary(impact) }), () => live.current && currentTool.current === toolId, { title: t('tools.accounts.deleteAction'), confirmLabel: t('tools.accounts.deleteAction'), destructive: true })) return false;
                await native.deleteAccount(account.id, account.version); if (editing === account.id) setEditing(null);
              }, t('tools.accounts.deleted'));
            })()}>{t('tools.accounts.deleteAction')}</button>
          </div>
        </details>
        {account.pendingLogin && <p id={`account-delete-hint-${account.id}`} className={accountStyles.actionHint}>{t('tools.accounts.deleteDisabledHint')}</p>}
      </div>
      <AccountImpactView account={account} active={expanded.has(account.id)} refreshAccounts={state.refresh} onOpenProfile={onOpenProfile} onOpenUsage={onOpenUsage} />
      {account.detail && <p>{account.detail}</p>}
      </details>
    </li>)}</ul>
    {state.capability && <details className={styles.compatibility}><summary>{t('tools.accounts.compatibility')}</summary><p>{state.capability.reason}</p></details>}
  </section>;
}
