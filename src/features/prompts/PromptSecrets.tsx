import { useEffect, useMemo, useRef, useState } from 'react';
import type { InputHTMLAttributes, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { formatFailure } from '../../lib/feedback';
import { writeClipboard } from '../../lib/clipboard';
import { reveal } from '../../lib/reveal';
import { preferredInstallation, promptSecretTokens } from '../../lib/secretCommands';
import { SecretScriptAccess } from './SecretScriptAccess';
import { RowMenu } from '../../components/RowMenu';
import { Icon } from '../../components/Icon';
import { Badge, Button, IconButton } from '../../components/ui';
import type { Tone } from '../../lib/statusTone';
import type {
  NewSecretExecutor,
  PromptSecret,
  PromptSecretReference,
  PromptSecretStatus,
  SecretAuditEntry,
  SecretBrokerStatus,
  SecretCliContext,
  SecretExecutor,
  SecretGrant,
  SecretInstallation,
  SecretInstallationKind,
} from '../../types/secrets';
import styles from './PromptSecrets.module.css';

const statusTone: Record<PromptSecretStatus, Tone> = { available: 'success', missing: 'danger', unknown: 'neutral', unreadable: 'warning' };
const compactId = (id: string) => id.replace(/^urn:uuid:/, '').replaceAll('-', '').toLowerCase();

function relativeTime(seconds: number, locale: string) {
  if (!Number.isFinite(seconds) || seconds < 1e9) return '';
  const diff = seconds - Date.now() / 1000;
  const abs = Math.abs(diff);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < 60) return format.format(Math.round(diff), 'second');
  if (abs < 3600) return format.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return format.format(Math.round(diff / 3600), 'hour');
  return format.format(Math.round(diff / 86400), 'day');
}

/** Insert one canonical reference without duplicating an existing one. */
export function insertReference(body: string, reference: string): string {
  if (body.includes(reference)) return body;
  const trimmed = body.replace(/[ \t]+$/, '');
  if (!trimmed) return reference;
  if (reference.includes('\n')) return `${trimmed.trimEnd()}\n\n${reference}`;
  return `${trimmed}${trimmed.endsWith('\n') ? '' : ' '}${reference}`;
}

/**
 * Remove every spelling of one reference (with or without urn prefix or dashes) together
 * with one separating space, so the surrounding text closes up. Nothing else changes.
 */
export function removeReference(body: string, id: string): string {
  const wanted = compactId(id);
  let out = '';
  let last = 0;
  for (const match of body.matchAll(/\{\{cliora-secret:(?:urn:uuid:)?([0-9a-fA-F-]{32,36})\}\}/g)) {
    if (compactId(match[1]) !== wanted) continue;
    let start = match.index ?? 0;
    let end = start + match[0].length;
    if (start > last && /[ \t]/.test(body[start - 1])) start -= 1;
    else if (/[ \t]/.test(body[end] ?? '')) end += 1;
    out += body.slice(last, start);
    last = end;
  }
  return out + body.slice(last);
}

/**
 * The value field. Typing is masked by default; the eye only shows what is being typed here,
 * so a pasted token can be checked. A stored value is never read back into it.
 */
function ValueInput({ shown, onToggle, ...input }: InputHTMLAttributes<HTMLInputElement> & { shown: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return <span className={styles.valueInput}>
    <input {...input} type={shown ? 'text' : 'password'} autoComplete="new-password" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
    <button type="button" className={styles.valueToggle} aria-pressed={shown} aria-label={t(shown ? 'library.secrets.hideValue' : 'library.secrets.showValue')} title={t(shown ? 'library.secrets.hideValue' : 'library.secrets.showValue')} disabled={input.disabled} onClick={onToggle}><Icon name={shown ? 'eyeOff' : 'eye'} size={14} /></button>
  </span>;
}

const pageSize = 30;
const emptyBroker: SecretBrokerStatus = { running: false, transport: '', error: null };
type Tab = 'secrets' | 'access';
type Form = { kind: 'create'; referenceId?: string } | { kind: 'rename'; id: string } | { kind: 'value'; id: string } | null;

/**
 * Local secret management for the prompt editor. The panel only ever handles aliases and
 * reference text: the value leaves the password field straight into the native credential
 * store and is never read back, echoed, copied or sent with a prompt.
 *
 * Two views keep the common path short. "Secrets" stores a value and inserts its
 * placeholder; "AI access" holds the broker metadata (connections, saved scripts and
 * activity) that a controlled use is defined by.
 */
export function PromptSecrets({ local, body, disabled, onInsert, onRemoveReference }: { local: boolean; body: string; disabled?: boolean; onInsert: (reference: string) => void; onRemoveReference?: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<Tab>('secrets');
  const [secrets, setSecrets] = useState<PromptSecret[]>([]);
  const [references, setReferences] = useState<PromptSecretReference[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pageError, setPageError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState<Form>(null);
  const [revision, setRevision] = useState(0);
  const [alias, setAlias] = useState('');
  const [value, setValue] = useState('');
  const [valueShown, setValueShown] = useState(false);
  // The row a reference chip points at flashes once so the eye lands on it.
  const [flashId, setFlashId] = useState('');
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const pendingLocate = useRef('');
  // Broker metadata. None of it is a value; it is what a controlled use is defined by.
  const [addingIdentity, setAddingIdentity] = useState(false);
  const [brokerLoading, setBrokerLoading] = useState(false);
  const [brokerError, setBrokerError] = useState('');
  const [broker, setBroker] = useState<SecretBrokerStatus>(emptyBroker);
  // The status is only read on the AI access tab; until then the dot stays neutral
  // instead of claiming the broker is offline.
  const [brokerChecked, setBrokerChecked] = useState(false);
  const [executors, setExecutors] = useState<SecretExecutor[]>([]);
  const [installations, setInstallations] = useState<SecretInstallation[]>([]);
  const [grants, setGrants] = useState<SecretGrant[]>([]);
  const [audit, setAudit] = useState<SecretAuditEntry[]>([]);
  const [cli, setCli] = useState<SecretCliContext | null>(null);
  const [installationLabel, setInstallationLabel] = useState('');
  const [installationKind, setInstallationKind] = useState<SecretInstallationKind>('cli');
  const [grantSecretId, setGrantSecretId] = useState('');
  const [preferredId, setPreferredId] = useState('');
  const mounted = useRef(true);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [pageInfo, setPageInfo] = useState({ total: 0, matched: 0, offset: 0 });
  const [grantCounts, setGrantCounts] = useState<Record<string, number>>({});
  const [directIds, setDirectIds] = useState<string[]>([]);
  const [programs, setPrograms] = useState<string[]>([]);
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditError, setAuditError] = useState('');
  const [auditRevision, setAuditRevision] = useState(0);
  const pageRequest = useRef(0);
  const brokerRequest = useRef(0);
  const tokens = useMemo(() => promptSecretTokens(body), [body]);
  const referenceText = tokens.join(' ');
  const referencedIds = useMemo(() => new Set(tokens.map(token => compactId(token.slice('{{cliora-secret:'.length, -2)))), [tokens]);

  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function announce(text: string) {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = text ? setTimeout(() => { noticeTimer.current = null; if (mounted.current) setNotice(''); }, 4000) : null;
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (noticeTimer.current) clearTimeout(noticeTimer.current); if (flashTimer.current) clearTimeout(flashTimer.current); };
  }, []);
  useEffect(() => {
    if (!local || tab !== 'secrets') return;
    const timer = window.setTimeout(() => void reload(), search ? 150 : 0);
    return () => { window.clearTimeout(timer); pageRequest.current++; };
  }, [local, tab, search, offset, referenceText, revision]);

  useEffect(() => {
    if (!local || !referenceText) { setReferences([]); return; }
    let current = true;
    void native.resolvePromptSecretReferences(referenceText).then(rows => {
      if (current) setReferences(Array.isArray(rows) ? rows : []);
    }).catch(() => { if (current) setReferences([]); });
    return () => { current = false; };
  }, [local, referenceText, revision]);

  useEffect(() => {
    if (!local || (tab !== 'access' && !grantSecretId)) return;
    void reloadBroker();
    return () => { brokerRequest.current++; };
  }, [local, tab, grantSecretId]);

  useEffect(() => {
    if (!local || tab !== 'access' || !auditOpen) return;
    let current = true;
    setAuditError('');
    void native.listSecretAudit(100).then(rows => { if (current) setAudit(rows); })
      .catch(failure => { if (current) setAuditError(formatFailure(failure, t('library.secrets.readFailed'), t('library.secrets.retry'))); });
    return () => { current = false; };
  }, [local, tab, auditOpen, auditRevision]);

  async function reload() {
    const request = ++pageRequest.current;
    setLoading(true);
    try {
      const page = await native.listPromptSecretPage(search, offset, referenceText);
      if (!mounted.current || pageRequest.current !== request) return;
      if (!Array.isArray(page?.items)) throw new Error(t('library.secrets.readFailed'));
      setSecrets(page.items); setPageInfo({ total: page.total, matched: page.matched, offset: page.offset });
      setGrantCounts(page.grantCounts); setDirectIds(page.directReadIds ?? []); setPageError('');
    } catch (failure) {
      if (mounted.current && pageRequest.current === request) setPageError(formatFailure(failure, t('library.secrets.readFailed'), t('library.secrets.retry')));
    }
    finally { if (mounted.current && pageRequest.current === request) setLoading(false); }
  }

  async function reloadBroker() {
    const request = ++brokerRequest.current;
    setBrokerLoading(true); setBrokerError('');
    try {
      const [options, status] = await Promise.all([
        native.secretAccessOptions(tab === 'access' ? undefined : grantSecretId),
        tab === 'access' ? native.secretBrokerStatus().catch(failure => ({ ...emptyBroker, error: formatFailure(failure, t('library.secrets.readFailed'), t('library.secrets.retry')) })) : null,
      ]);
      if (!mounted.current || request !== brokerRequest.current) return;
      if (status) { setBroker(status); setBrokerChecked(true); }
      setExecutors(options.executors); setInstallations(options.installations);
      setGrants(options.grants); setCli(options.cli); setPrograms(options.availablePrograms);
      if (grantSecretId && tab === 'secrets') setGrantCounts(current => ({ ...current, [grantSecretId]: options.grants.length }));
    } catch (failure) {
      if (mounted.current && request === brokerRequest.current) setBrokerError(formatFailure(failure, t('library.secrets.readFailed'), t('library.secrets.retry')));
    } finally { if (mounted.current && request === brokerRequest.current) setBrokerLoading(false); }
  }

  async function refreshGrants(secretId: string) {
    const request = brokerRequest.current;
    try {
      const rows = await native.listSecretGrants(secretId);
      if (!mounted.current || request !== brokerRequest.current) return;
      setGrants(rows);
      setGrantCounts(current => ({ ...current, [secretId]: rows.length }));
    } catch (failure) {
      if (mounted.current && request === brokerRequest.current) setBrokerError(formatFailure(failure, t('library.secrets.readFailed'), t('library.secrets.retry')));
    }
  }
  function closeForm() { setForm(null); setAlias(''); setValue(''); setValueShown(false); }
  /** Point at a secret's row: scroll it into view and flash it once. */
  function revealRow(id: string) {
    const row = sectionRef.current?.querySelector<HTMLElement>(`[data-secret-id="${CSS.escape(id)}"]`);
    if (!row) return false;
    reveal(row);
    if (!row.contains(document.activeElement)) row.focus({ preventScroll: true });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlashId(id);
    flashTimer.current = setTimeout(() => { flashTimer.current = null; if (mounted.current) setFlashId(''); }, 1200);
    return true;
  }
  useEffect(() => {
    if (pendingLocate.current && revealRow(pendingLocate.current)) pendingLocate.current = '';
  }, [secrets]);

  function changeSearch(query: string) {
    pendingLocate.current = '';
    setSearch(query); setOffset(0); setGrantSecretId('');
    if (form?.kind !== 'create') closeForm();
  }
  function locate(id: string) {
    if (revealRow(id)) return;
    changeSearch(id);
    pendingLocate.current = id;
  }
  async function copyReference(secret: PromptSecret) {
    const copied = await writeClipboard(secret.reference);
    if (!mounted.current) return;
    if (copied) announce(t('library.secrets.referenceCopied', { name: secret.alias }));
    else setError(t('library.secrets.copyFailed'));
  }
  async function setDirectUse(secret: PromptSecret, enabled: boolean) {
    if (busy || disabled) return;
    setBusy(true); setError('');
    try {
      await native.setSecretDirectRead(secret.id, enabled);
      if (!mounted.current) return;
      setDirectIds(ids => enabled ? [...new Set([...ids, secret.id])] : ids.filter(id => id !== secret.id));
      if (enabled && !referencedIds.has(compactId(secret.id))) onInsert(secret.reference);
      setRevision(n => n + 1);
      announce(t(enabled ? 'library.secrets.directReady' : 'library.secrets.directRevoked', { name: secret.alias }));
    } catch (failure) {
      if (mounted.current) setError(formatFailure(failure, t('library.secrets.saveFailed'), t('library.secrets.retry')));
    } finally { if (mounted.current) setBusy(false); }
  }
  function openCreate(referenceId?: string) { setError(''); setAlias(''); setValue(''); setValueShown(false); setGrantSecretId(''); setTab('secrets'); setForm({ kind: 'create', referenceId }); }
  function openRename(secret: PromptSecret) { setError(''); setAlias(secret.alias); setValue(''); setValueShown(false); setForm({ kind: 'rename', id: secret.id }); }
  function openValue(secret: Pick<PromptSecret, 'id'>) { setError(''); setValue(''); setValueShown(false); setForm({ kind: 'value', id: secret.id }); }

  async function create() {
    if (busy || !alias.trim() || !value) return;
    setBusy(true); setError('');
    try {
      const created = await native.createPromptSecret(alias, value, form?.kind === 'create' ? form.referenceId : undefined);
      if (!mounted.current) return;
      closeForm();
      setSearch(''); setOffset(0);
      announce(t('library.secrets.created', { name: created.alias }));
      setRevision(value => value + 1);
      if (form?.kind !== 'create' || !form.referenceId) onInsert(created.reference);
    } catch (failure) { if (mounted.current) setError(formatFailure(failure, t('library.secrets.createFailed'), t('library.secrets.retry'))); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function rename(secret: PromptSecret) {
    if (busy || !alias.trim()) return;
    setBusy(true); setError('');
    try {
      const saved = await native.renamePromptSecret(secret.id, secret.version, alias);
      if (!mounted.current) return;
      closeForm();
      setSecrets(previous => previous.map(item => item.id === saved.id ? saved : item));
      setReferences(previous => previous.map(item => item.id === saved.id ? { ...item, alias: saved.alias } : item));
      setRevision(value => value + 1);
      announce(t('library.secrets.renamed'));
    } catch (failure) { if (mounted.current) setError(formatFailure(failure, t('library.secrets.saveFailed'), t('library.secrets.retry'))); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function updateValue(secret: PromptSecret) {
    if (busy || !value) return;
    setBusy(true); setError('');
    try {
      const saved = await native.updatePromptSecretValue(secret.id, secret.version, value);
      if (!mounted.current) return;
      closeForm();
      setSecrets(previous => previous.map(item => item.id === saved.id ? saved : item));
      setRevision(value => value + 1);
      announce(t('library.secrets.updated'));
    } catch (failure) { if (mounted.current) setError(formatFailure(failure, t('library.secrets.saveFailed'), t('library.secrets.retry'))); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function remove(secret: PromptSecret) {
    if (busy) return;
    if (!await confirmAction(t('library.secrets.confirmRemove', { name: secret.alias }), () => mounted.current, { destructive: true, title: t('library.secrets.remove'), confirmLabel: t('library.secrets.remove') })) return;
    setBusy(true); setError('');
    try {
      await native.deletePromptSecret(secret.id, secret.version);
      if (!mounted.current) return;
      setSecrets(previous => previous.filter(item => item.id !== secret.id));
      if (grantSecretId === secret.id) setGrantSecretId('');
      setGrants(previous => previous.filter(grant => grant.secretId !== secret.id));
      setRevision(value => value + 1);
      announce(t('library.secrets.removed'));
    } catch (failure) { if (mounted.current) setError(formatFailure(failure, t('library.secrets.saveFailed'), t('library.secrets.retry'))); }
    finally { if (mounted.current) setBusy(false); }
  }

  async function removeExecutor(executor: SecretExecutor) {
    if (busy) return;
    if (!await confirmAction(t('library.secrets.broker.confirmRemoveExecutor', { name: executor.label }), () => mounted.current, { destructive: true, title: t('library.secrets.broker.removeExecutor'), confirmLabel: t('library.secrets.broker.removeExecutor') })) return;
    setBusy(true); setError('');
    try {
      await native.deleteSecretExecutor(executor.id);
      if (!mounted.current) return;
      await reloadBroker();
      announce(t('library.secrets.broker.executorRemoved'));
    } catch (failure) { if (mounted.current) setError(formatFailure(failure, t('library.secrets.broker.saveFailed'), t('library.secrets.retry'))); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function createInstallation() {
    if (busy || !installationLabel.trim()) return;
    setBusy(true); setError('');
    try {
      await native.createSecretInstallation(installationLabel.trim(), installationKind, null);
      if (!mounted.current) return;
      setInstallationLabel(''); setAddingIdentity(false);
      await reloadBroker();
      announce(t('library.secrets.broker.installationCreated'));
    } catch (failure) { if (mounted.current) setError(formatFailure(failure, t('library.secrets.broker.saveFailed'), t('library.secrets.retry'))); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function changeInstallation(item: SecretInstallation, action: 'revoke' | 'restore' | 'delete') {
    if (busy) return;
    const label = t(`library.secrets.broker.${action}Installation`);
    const message = {
      revoke: 'confirmRevokeInstallation', restore: 'confirmRestoreInstallation', delete: 'confirmDeleteInstallation',
    } as const;
    if (!await confirmAction(t(`library.secrets.broker.${message[action]}`, { name: item.label }), () => mounted.current, { destructive: action !== 'restore', title: label, confirmLabel: label })) return;
    setBusy(true); setError('');
    try {
      const change = { revoke: native.revokeSecretInstallation, restore: native.restoreCliInstallation, delete: native.deleteCliInstallation };
      await change[action](item.id);
      await reloadBroker();
    } catch (failure) { if (mounted.current) setError(formatFailure(failure, t('library.secrets.saveFailed'), t('library.secrets.retry'))); }
    finally { if (mounted.current) setBusy(false); }
  }

  async function createDefaultCli() {
    if (installations.some(item => item.kind === 'cli' && !item.targetId && item.revoked)) {
      throw new Error(t('library.secrets.broker.restoreFirst'));
    }
    const item = await native.createSecretInstallation(t('library.secrets.broker.defaultCliLabel'), 'cli', null);
    if (mounted.current) setInstallations(previous => [item, ...previous]);
    return item;
  }

  async function saveGrant(installationId: string, executor: string | NewSecretExecutor) {
    if (busy || !grantSecretId) return;
    setBusy(true); setError('');
    let executorId = typeof executor === 'string' ? executor : '';
    try {
      const id = installationId || (await createDefaultCli()).id;
      if (typeof executor !== 'string') {
        const existing = executors.find(item => item.executable === executor.executable && item.channel === executor.channel
          && item.envName === executor.envName && item.cwd === executor.cwd && JSON.stringify(item.args) === JSON.stringify(executor.args));
        const saved = existing ?? await native.saveSecretExecutor(executor);
        executorId = saved.id;
        if (!existing && mounted.current) setExecutors(previous => [...previous, saved]);
      }
      await native.grantSecretUsage(id, grantSecretId, executorId);
      if (mounted.current) {
        setPreferredId(id);
        await refreshGrants(grantSecretId);
        announce(t('library.secrets.broker.grantSaved'));
      }
      return { executorId, granted: true };
    } catch (failure) {
      if (mounted.current) setError(t('library.secrets.broker.retryGrant') + ' ' + formatFailure(failure, t('library.secrets.broker.saveFailed'), ''));
    } finally { if (mounted.current) setBusy(false); }
    return { executorId, granted: false };
  }
  async function revokeGrant(grant: SecretGrant) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await native.revokeSecretUsage(grant.installationId, grant.secretId, grant.executorId);
      if (!mounted.current) return;
      await refreshGrants(grant.secretId);
      announce(t('library.secrets.broker.grantRevoked'));
    } catch (failure) {
      if (mounted.current) setError(t('library.secrets.broker.retryRevoke', { name: grant.executorLabel }) + ' ' + formatFailure(failure, t('library.secrets.broker.saveFailed'), ''));
    }
    finally { if (mounted.current) setBusy(false); }
  }
  const referencedGrants = grants.filter(grant => referencedIds.has(compactId(grant.secretId)));
  const insertionTarget = preferredInstallation(installations.filter(item => item.kind === 'cli' && !item.targetId), referencedGrants, preferredId);
  const portableInstructions = [...new Set(referencedGrants.filter(grant => grant.installationId === insertionTarget?.id).map(grantInstruction))].filter(line => !body.includes(line));
  function grantInstruction(grant: SecretGrant) {
    return t('library.secrets.broker.grantedInstructions', {
      script: grant.executorLabel, secret: grant.alias, reference: '{{cliora-secret:' + grant.secretId + '}}',
    });
  }

  const brokerReady = !!cli && !brokerLoading && !brokerError;
  const brokerState = !brokerReady || !brokerChecked ? 'unknown' : broker.running ? 'running' : 'offline';
  const locale = i18n.language?.startsWith('en') ? 'en' : 'zh-CN';
  const problems = references.filter(item => item.status !== 'available').length;
  const formKeys = (submit: () => void, ready: boolean) => (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeForm(); }
    if (event.key === 'Enter' && ready) { event.preventDefault(); submit(); }
  };
  function tabKeys(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next: Tab = tab === 'secrets' ? 'access' : 'secrets';
    setGrantSecretId('');
    setTab(next);
    event.currentTarget.querySelector<HTMLElement>(`[data-secret-tab="${next}"]`)?.focus();
  }

  if (!local) {
    return <section className={styles.vault} data-prompt-secrets data-secret-local="false">
      <header className={styles.head}>
        <span className={styles.mark} aria-hidden="true"><Icon name="shield" size={16} /></span>
        <div className={styles.headText}><strong>{t('library.secrets.title')}</strong><span>{t('library.secrets.tagline')}</span></div>
      </header>
      <p className={styles.localOnly} data-secret-local-only><Icon name="globe" size={14} /><span>{t('library.secrets.localOnly')}</span></p>
    </section>;
  }

  return <section ref={sectionRef} className={styles.vault} data-prompt-secrets data-secret-local="true">
    <header className={styles.head}>
      <span className={styles.mark} aria-hidden="true"><Icon name="shield" size={16} /></span>
      <div className={styles.headText}><strong>{t('library.secrets.title')}</strong><span>{t('library.secrets.tagline')}</span></div>
      <div className={styles.headActions}>
        <div className={styles.tabs} role="tablist" aria-label={t('library.secrets.tabsLabel')} onKeyDown={tabKeys}>
          <button type="button" role="tab" disabled={busy} className={styles.tab} data-secret-tab="secrets" aria-selected={tab === 'secrets'} tabIndex={tab === 'secrets' ? 0 : -1} onClick={() => setTab('secrets')}>
            {t('library.secrets.tabs.secrets')}{pageInfo.total > 0 && <span className={styles.tabCount} title={t('library.secrets.count', { count: pageInfo.total })}>{pageInfo.total}</span>}
          </button>
          <button type="button" role="tab" disabled={busy} className={styles.tab} data-secret-tab="access" data-secret-broker-toggle aria-selected={tab === 'access'} tabIndex={tab === 'access' ? 0 : -1} onClick={() => { setGrantSecretId(''); setTab('access'); }}>
            {t('library.secrets.tabs.access')}<span className={styles.tabDot} data-state={brokerState} aria-hidden="true" />
          </button>
        </div>
        <Button size="sm" variant="primary" data-secret-create disabled={disabled || busy} icon={<Icon name="plus" size={12} />} onClick={() => openCreate()}>{t('library.secrets.create')}</Button>
      </div>
    </header>

    {error && <p className={styles.alert} role="alert" data-secret-error><Icon name="alert" size={14} /><span>{error}</span></p>}
    {brokerError && (tab === 'access' || !!grantSecretId) && <div className={styles.alert} role="alert"><Icon name="alert" size={14} /><span>{brokerError}</span><Button size="sm" variant="ghost" onClick={() => void reloadBroker()}>{t('library.secrets.retry')}</Button></div>}

    {tab === 'secrets' ? <div className={styles.panel} role="tabpanel" aria-label={t('library.secrets.tabs.secrets')}>
      {pageError && <div className={styles.alert} role="alert" data-secret-page-error><Icon name="alert" size={14} /><span>{pageError}</span><Button size="sm" variant="ghost" disabled={loading} onClick={() => void reload()}>{t('library.secrets.retry')}</Button></div>}
      {references.length > 0 && <div className={styles.refs} data-secret-references data-problem={problems > 0 || undefined}>
        <span className={styles.refsLabel}>{problems > 0 && <Icon name="alert" size={12} />}{problems > 0 ? t('library.secrets.referencesProblem', { count: problems }) : t('library.secrets.references')}</span>
        {references.map(item => {
          return <span className={styles.ref} key={item.id} title={item.reference} data-secret-reference={item.reference} data-secret-reference-status={item.status}>
            <span className={styles.dot} data-tone={statusTone[item.status]} aria-hidden="true" />
            {item.alias ? <button type="button" disabled={busy} className={styles.refName} title={t('library.secrets.locate', { name: item.alias })} onClick={() => locate(item.id)}>{item.alias}</button> : <span>{item.id.slice(0, 8)}</span>}
            {item.status !== 'available' && <span className={styles.refState}>{t(`library.secrets.referenceStatus.${item.status}`)}</span>}
            {item.status === 'unknown' && <Button size="sm" variant="ghost" disabled={disabled || busy} data-secret-bind={item.id} onClick={() => openCreate(item.id)}>{t('library.secrets.bindHere')}</Button>}
            {item.status === 'missing' && <Button size="sm" variant="ghost" disabled={disabled || busy} data-secret-refill={item.id} onClick={() => { locate(item.id); openValue(item); }}>{t('library.secrets.refillValue')}</Button>}
            {onRemoveReference && <IconButton size="sm" className={styles.refRemove} disabled={disabled || busy} data-secret-reference-remove={item.id} aria-label={t('library.secrets.removeReference', { name: item.alias ?? item.id.slice(0, 8) })} title={t('library.secrets.removeReference', { name: item.alias ?? item.id.slice(0, 8) })} icon={<Icon name="close" size={11} />} onClick={() => { onRemoveReference(item.id); announce(t('library.secrets.referenceRemoved')); }} />}
          </span>;
        })}
      </div>}

      {form?.kind === 'create' && <div ref={reveal} className={styles.create} onKeyDown={formKeys(() => void create(), !!alias.trim() && !!value)}>
        <div className={styles.createHead}><Icon name="lock" size={14} />{form.referenceId ? t('library.secrets.bindHere') : t('library.secrets.createTitle')}</div>
        <div className={styles.fields}>
          <label className={styles.field}>{t('library.secrets.alias')}<input autoFocus data-secret-alias maxLength={80} value={alias} disabled={busy} placeholder={t('library.secrets.aliasPlaceholder')} onChange={event => setAlias(event.target.value)} /></label>
          <label className={styles.field}>{t('library.secrets.value')}<ValueInput data-secret-value shown={valueShown} onToggle={() => setValueShown(shown => !shown)} value={value} disabled={busy} placeholder={t('library.secrets.valuePlaceholder')} onChange={event => setValue(event.target.value)} /></label>
        </div>
        <div className={styles.footer}>
          <span className={styles.footerNote}><Icon name="shield" size={12} />{t('library.secrets.valueNote')}</span>
          <div className={styles.footerActions}>
            <Button size="sm" variant="ghost" disabled={busy} onClick={closeForm}>{t('library.secrets.cancel')}</Button>
            <Button size="sm" variant="primary" data-secret-submit loading={busy} disabled={!alias.trim() || !value} icon={<Icon name="check" size={12} />} onClick={() => void create()}>{t('library.secrets.save')}</Button>
          </div>
        </div>
      </div>}

      {(pageInfo.total > 0 || search) && <span className={`search-field ${styles.search}`}>
        <input type="search" disabled={busy} data-secret-search aria-label={t('library.secrets.search')} placeholder={t('library.secrets.search')} value={search}
          onKeyDown={event => { if (event.key === 'Escape' && search) { event.preventDefault(); event.stopPropagation(); changeSearch(''); } }}
          onChange={event => changeSearch(event.target.value)} />
        {search && <button type="button" className="search-clear" aria-label={t('common.search.clear')} onClick={() => changeSearch('')}><Icon name="close" size={16} /></button>}
      </span>}
      {search && !pageError && !loading && !pageInfo.matched && <p className={styles.noMatch} role="status"><Icon name="search" size={14} />{t('library.secrets.noMatches')}<Button size="sm" variant="ghost" onClick={() => changeSearch('')}>{t('common.search.clear')}</Button></p>}
      {loading && !secrets.length && <div className={styles.list} role="status" aria-label={t('library.secrets.loading')}><div className={styles.skeleton} /><div className={styles.skeleton} /></div>}

      {!pageError && !loading && !search && !pageInfo.total && !form && <div className={styles.empty} data-secret-empty>
        <span className={styles.emptyMark} aria-hidden="true"><Icon name="lock" size={20} /></span>
        <div className={styles.emptyText}><strong>{t('library.secrets.empty.title')}</strong><span>{t('library.secrets.empty.detail')}</span></div>
      </div>}

      {secrets.length > 0 && <ul className={styles.list} data-scroll={secrets.length > 6 || undefined}>
        {secrets.map(secret => {
          const referenced = referencedIds.has(compactId(secret.id));
          const grantCount = grantCounts[secret.id] ?? 0;
          const direct = directIds.includes(secret.id);
          const open = grantSecretId === secret.id;
          return <li className={styles.item} key={secret.id} tabIndex={-1} data-open={open || undefined} data-flash={flashId === secret.id || undefined} data-secret-id={secret.id} data-secret-status={secret.status}>
            <div className={styles.itemMain}>
              <div className={styles.itemText}>
                <span className={styles.itemTitle}>
                  <span className={styles.alias} title={secret.alias + '\n' + secret.reference}>{secret.alias}</span>
                  {secret.status !== 'available' && <Badge tone={statusTone[secret.status]}>{t(`library.secrets.status.${secret.status}`)}</Badge>}
                </span>
              </div>
              <div className={styles.itemActions}>
                {direct && referenced
                  ? <span className={styles.inBody} title={t('library.secrets.directHint')}><Icon name="check" size={12} />{t('library.secrets.directActive')}</span>
                  : <Button size="sm" data-secret-direct title={t('library.secrets.directHint')} disabled={disabled || busy || secret.status !== 'available'} onClick={() => void setDirectUse(secret, true)}>{t('library.secrets.directUse')}</Button>}
                {referenced
                  ? !direct && <span className={styles.inBody}><Icon name="check" size={12} />{t('library.secrets.inBody')}</span>
                  : <Button size="sm" variant="ghost" data-secret-insert title={t('library.secrets.insertTitle', { name: secret.alias })} disabled={disabled || busy || secret.status !== 'available'} onClick={() => { setError(''); onInsert(secret.reference); announce(t('library.secrets.inserted', { name: secret.alias })); }}>{t('library.secrets.insert')}</Button>}
                {grantCount > 0 && <Button size="sm" variant="ghost" className={styles.grantPill} data-granted data-secret-grant aria-expanded={open} disabled={disabled || busy} icon={<Icon name="shield" size={12} />} onClick={() => setGrantSecretId(open ? '' : secret.id)}>{t('library.secrets.grantCount', { count: grantCount })}</Button>}
                <RowMenu label={t('library.secrets.manage', { name: secret.alias })}>
                  {!grantCount && <button role="menuitem" data-secret-grant disabled={disabled || busy} onClick={() => setGrantSecretId(secret.id)}>{t('library.secrets.broker.grant')}</button>}
                  {direct && <button role="menuitem" data-secret-direct-revoke disabled={disabled || busy} onClick={() => void setDirectUse(secret, false)}>{t('library.secrets.revokeDirect')}</button>}
                  <button role="menuitem" data-secret-copy-reference onClick={() => void copyReference(secret)}>{t('library.secrets.copyReference')}</button>
                  <button role="menuitem" data-secret-rename disabled={disabled || busy} onClick={() => openRename(secret)}>{t('library.secrets.rename')}</button>
                  <button role="menuitem" data-secret-update disabled={disabled || busy} onClick={() => openValue(secret)}>{t('library.secrets.updateValue')}</button>
                  <button role="menuitem" data-danger="true" data-secret-remove disabled={disabled || busy} onClick={() => void remove(secret)}>{t('library.secrets.remove')}</button>
                </RowMenu>
              </div>
            </div>
            {form?.kind === 'rename' && form.id === secret.id && <div ref={reveal} className={styles.inline} onKeyDown={formKeys(() => void rename(secret), !!alias.trim())}>
              <input autoFocus aria-label={t('library.secrets.alias')} data-secret-rename-value maxLength={80} value={alias} disabled={busy} onChange={event => setAlias(event.target.value)} />
              <Button size="sm" variant="ghost" disabled={busy} onClick={closeForm}>{t('library.secrets.cancel')}</Button>
              <Button size="sm" variant="primary" data-secret-rename-save loading={busy} disabled={!alias.trim()} onClick={() => void rename(secret)}>{t('library.secrets.renameSave')}</Button>
            </div>}
            {form?.kind === 'value' && form.id === secret.id && <div ref={reveal} className={styles.inline} onKeyDown={formKeys(() => void updateValue(secret), !!value)}>
              <ValueInput autoFocus aria-label={t('library.secrets.value')} data-secret-update-value shown={valueShown} onToggle={() => setValueShown(shown => !shown)} value={value} disabled={busy} placeholder={t('library.secrets.valuePlaceholder')} onChange={event => setValue(event.target.value)} />
              <Button size="sm" variant="ghost" disabled={busy} onClick={closeForm}>{t('library.secrets.cancel')}</Button>
              <Button size="sm" variant="primary" data-secret-update-save loading={busy} disabled={!value} onClick={() => void updateValue(secret)}>{t('library.secrets.updateSave')}</Button>
            </div>}
            {open && !cli && !brokerLoading && <p className={styles.alert} role="alert"><Icon name="alert" size={14} /><span>{brokerError || t('library.secrets.readFailed')}</span><Button size="sm" variant="ghost" onClick={() => void reloadBroker()}>{t('library.secrets.retry')}</Button></p>}
            {open && (brokerLoading && !cli ? <div className={styles.skeleton} role="status" aria-label={t('library.secrets.loading')} /> : cli && <SecretScriptAccess
              alias={secret.alias}
              availablePrograms={programs} installations={installations} executors={executors} grants={grants.filter(grant => grant.secretId === secret.id)} busy={busy || !brokerReady}
              onInsert={grant => {
                onInsert(grantInstruction(grant));
                announce(t('library.secrets.broker.instructionsInserted'));
              }}
              onGrant={saveGrant} onRevoke={grant => void revokeGrant(grant)} onClose={() => setGrantSecretId('')}
            />)}
          </li>;
        })}
      </ul>}
      {pageInfo.matched > pageSize && <div className={styles.pager} data-secret-pagination>
        <Button size="sm" variant="ghost" disabled={loading || busy || pageInfo.offset === 0} icon={<Icon name="chevronLeft" size={13} />} onClick={() => { setGrantSecretId(''); setOffset(pageInfo.offset - pageSize); }}>{t('prompts.previous')}</Button>
        <span className={styles.pagerRange}>{pageInfo.offset + 1}–{pageInfo.offset + secrets.length} / {pageInfo.matched}</span>
        <Button size="sm" variant="ghost" disabled={loading || busy || pageInfo.offset + pageSize >= pageInfo.matched} onClick={() => { setGrantSecretId(''); setOffset(pageInfo.offset + pageSize); }}>{t('prompts.next')}<Icon name="chevronRight" size={13} /></Button>
      </div>}
    </div> : <div className={styles.panel} role="tabpanel" aria-label={t('library.secrets.tabs.access')} data-secret-broker data-secret-broker-running={broker.running ? 'true' : 'false'}>
      <div className={styles.hero} data-state={brokerState}>
        <span className={styles.orb} aria-hidden="true" />
        <div className={styles.heroText}>
          <strong>{brokerReady ? (broker.running ? t('library.secrets.broker.running') : t('library.secrets.broker.offline')) : t('library.secrets.broker.checking')}</strong>
          <p>{t('library.secrets.broker.hint')}</p>
          {broker.error && <p className={styles.heroError} data-secret-broker-status>{broker.error}</p>}
        </div>
        <div className={styles.heroActions}>
          <IconButton size="sm" aria-label={t('library.secrets.retry')} data-secret-broker-refresh disabled={busy || brokerLoading} icon={<Icon name="refresh" size={13} />} onClick={() => { void reloadBroker(); setAuditRevision(n => n + 1); }} />
          <Button size="sm" variant="primary" data-secret-broker-instructions disabled={disabled || busy || !brokerReady || !portableInstructions.length} icon={<Icon name="plus" size={12} />} onClick={() => {
            onInsert(portableInstructions.join('\n'));
            announce(t('library.secrets.broker.instructionsInserted'));
          }}>{t('library.secrets.broker.insertInstructions')}</Button>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <div><strong>{t('library.secrets.broker.installations')}</strong><span>{t('library.secrets.broker.installationsHint')}</span></div>
          <Button size="sm" variant="ghost" disabled={!brokerReady || busy} data-secret-add-identity aria-expanded={addingIdentity} icon={addingIdentity ? undefined : <Icon name="plus" size={12} />} onClick={() => setAddingIdentity(open => !open)}>{t(addingIdentity ? 'library.secrets.cancel' : 'library.secrets.broker.createInstallation')}</Button>
        </div>
        <ul className={styles.rows}>
          {brokerReady && !installations.length && <li className={styles.rowsEmpty} data-secret-installations-empty>{t('library.secrets.broker.installationsEmpty')}</li>}
          {installations.map(item => <li className={styles.row} key={item.id} data-secret-installation={item.id} data-secret-installation-revoked={item.revoked ? 'true' : 'false'}>
            <span className={styles.rowIcon} aria-hidden="true"><Icon name={item.kind === 'mcp' ? 'plug' : 'terminal'} size={13} /></span>
            <span className={styles.rowText}>
              <span className={styles.rowTitle}>{item.label}</span>
              <Badge tone={item.revoked ? 'danger' : 'neutral'}>{item.revoked ? t('library.secrets.broker.revoked') : t(`library.secrets.broker.kind.${item.kind}`)}</Badge>
              <code className={styles.rowCode} title={item.id}>{item.id.slice(0, 8)}</code>
            </span>
            <span className={styles.rowActions}>
              {!item.revoked && <Button size="sm" variant="ghost" data-secret-installation-revoke disabled={busy} onClick={() => void changeInstallation(item, 'revoke')}>{t('library.secrets.broker.revokeInstallation')}</Button>}
              {item.revoked && item.kind === 'cli' && !item.targetId && <>
                <Button size="sm" data-secret-installation-restore disabled={busy} onClick={() => void changeInstallation(item, 'restore')}>{t('library.secrets.broker.restoreInstallation')}</Button>
                <Button size="sm" variant="ghost" data-secret-installation-delete disabled={busy} onClick={() => void changeInstallation(item, 'delete')}>{t('library.secrets.broker.deleteInstallation')}</Button>
              </>}
            </span>
          </li>)}
          {addingIdentity && <li className={styles.quickAdd}>
            <input autoFocus aria-label={t('library.secrets.broker.installationLabel')} data-secret-installation-label maxLength={80} value={installationLabel} disabled={busy} placeholder={t('library.secrets.broker.installationLabelPlaceholder')} onChange={event => setInstallationLabel(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && installationLabel.trim()) { event.preventDefault(); void createInstallation(); } }} />
            <select aria-label={t('library.secrets.broker.installationKind')} data-secret-installation-kind value={installationKind} disabled={busy} onChange={event => setInstallationKind(event.target.value === 'mcp' ? 'mcp' : 'cli')}>
              <option value="cli">{t('library.secrets.broker.kind.cli')}</option>
              <option value="mcp">{t('library.secrets.broker.kind.mcp')}</option>
            </select>
            <Button size="sm" variant="primary" data-secret-installation-create loading={busy} disabled={!installationLabel.trim()} onClick={() => void createInstallation()}>{t('library.secrets.broker.createInstallation')}</Button>
          </li>}
        </ul>
      </div>

      {executors.length > 0 && <details className={styles.details}>
        <summary><span>{t('library.secrets.broker.executors')}</span><span className={styles.count}>{executors.length}</span></summary>
        <ul className={styles.rows}>
          {executors.map(item => <li className={styles.row} key={item.id} data-secret-executor={item.id} data-secret-executor-channel={item.channel}>
            <span className={styles.rowIcon} aria-hidden="true"><Icon name="play" size={12} /></span>
            <span className={styles.rowText}>
              <span className={styles.rowTitle}>{item.label}</span>
              <Badge tone="neutral">{t(`library.secrets.broker.channel.${item.channel}`)}</Badge>
              <code className={styles.rowCode} title={[item.executable, ...item.args].join(' ')}>{[item.executable, ...item.args].join(' ')}</code>
            </span>
            <span className={styles.rowActions}>
              <Button size="sm" variant="ghost" data-secret-executor-remove disabled={busy} onClick={() => void removeExecutor(item)}>{t('library.secrets.broker.removeExecutor')}</Button>
            </span>
          </li>)}
        </ul>
      </details>}
      <details className={styles.details} open={auditOpen} onToggle={event => setAuditOpen(event.currentTarget.open)}>
        <summary><span>{t('library.secrets.broker.audit')}</span>{audit.length > 0 && <span className={styles.count}>{audit.length}</span>}</summary>
        {auditOpen && <p className={styles.muted}>{t('library.secrets.broker.retention')}</p>}
        {auditError && <p role="alert">{auditError} <Button size="sm" onClick={() => setAuditRevision(n => n + 1)}>{t('library.secrets.retry')}</Button></p>}
        {auditOpen && (!audit.length ? <p className={styles.muted} data-secret-audit-empty>{t('library.secrets.broker.auditEmpty')}</p> : <ul className={`${styles.rows} ${styles.auditRows}`}>
          {audit.map(entry => <li className={styles.row} key={entry.id} data-secret-audit={entry.id} data-secret-audit-code={entry.code}>
            <span className={styles.dot} data-tone={entry.code === 'ok' ? 'success' : 'danger'} aria-hidden="true" />
            <span className={styles.rowText}>
              <span className={styles.rowTitle}>{t(`library.secrets.broker.operation.${entry.operation}`)}</span>
              <span className={styles.rowTitle}>{grants.find(grant => grant.secretId === entry.secretId)?.alias ?? secrets.find(secret => secret.id === entry.secretId)?.alias}</span>
              {entry.code !== 'ok' && <Badge tone="danger">{t(`library.secrets.broker.result.${entry.code}`, { defaultValue: entry.code })}</Badge>}
            </span>
            <span className={styles.rowTime}>{relativeTime(entry.at, locale)}</span>
          </li>)}
        </ul>)}
      </details>
    </div>}

    {notice && <p className={styles.toast} role="status" data-secret-notice><Icon name="check" size={13} />{notice}</p>}
  </section>;
}
