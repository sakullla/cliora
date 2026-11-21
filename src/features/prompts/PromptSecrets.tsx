import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { formatFailure } from '../../lib/feedback';
import { buildSecretUsageInstructions } from '../../lib/secretCommands';
import { Icon } from '../../components/Icon';
import { Badge, Button } from '../../components/ui';
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
import styles from './Prompts.module.css';

const statusTone: Record<PromptSecretStatus, Tone> = { available: 'success', missing: 'danger', unknown: 'neutral', unreadable: 'warning' };

/** Insert one canonical reference without duplicating an existing one. */
export function insertReference(body: string, reference: string): string {
  if (body.includes(reference)) return body;
  const trimmed = body.replace(/[ \t]+$/, '');
  if (!trimmed) return reference;
  return `${trimmed}${trimmed.endsWith('\n') ? '' : ' '}${reference}`;
}

const emptyExecutor: NewSecretExecutor = { label: '', description: '', executable: '', args: [], cwd: null, channel: 'env', envName: '' };
const emptyBroker: SecretBrokerStatus = { running: false, transport: '', error: null };

/**
 * Local secret management for the prompt editor. The panel only ever handles aliases and
 * reference text: the value leaves the password field straight into the native credential
 * store and is never read back, echoed, copied or sent with a prompt.
 *
 * The broker section manages the metadata that lets a local CLI use a secret without
 * seeing it: fixed executors, installation identities and the grants between them. Every
 * raw read still needs a fresh confirmation, and the inserted usage text is built from
 * this metadata so a reader never guesses a command.
 */
export function PromptSecrets({ local, body, disabled, onInsert }: { local: boolean; body: string; disabled?: boolean; onInsert: (reference: string) => void }) {
  const { t, i18n } = useTranslation();
  const [secrets, setSecrets] = useState<PromptSecret[]>([]);
  const [references, setReferences] = useState<PromptSecretReference[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState<{ kind: 'create' } | { kind: 'rename'; id: string } | { kind: 'value'; id: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const [alias, setAlias] = useState('');
  const [value, setValue] = useState('');
  // Broker metadata. None of it is a value; it is what a controlled use is defined by.
  const [brokerOpen, setBrokerOpen] = useState(false);
  const [broker, setBroker] = useState<SecretBrokerStatus>(emptyBroker);
  const [executors, setExecutors] = useState<SecretExecutor[]>([]);
  const [installations, setInstallations] = useState<SecretInstallation[]>([]);
  const [grants, setGrants] = useState<SecretGrant[]>([]);
  const [audit, setAudit] = useState<SecretAuditEntry[]>([]);
  const [cli, setCli] = useState<SecretCliContext | null>(null);
  const [executorDraft, setExecutorDraft] = useState<NewSecretExecutor>(emptyExecutor);
  const [installationLabel, setInstallationLabel] = useState('');
  const [installationKind, setInstallationKind] = useState<SecretInstallationKind>('cli');
  const [grantForm, setGrantForm] = useState<{ secretId: string; installationId: string; executorId: string } | null>(null);
  const mounted = useRef(true);
  const loaded = useRef(false);
  const brokerLoaded = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function announce(text: string) {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = text ? setTimeout(() => { noticeTimer.current = null; if (mounted.current) setNotice(''); }, 4000) : null;
  }
  const showError = (failure: unknown) => setError(formatFailure(failure, t('library.secrets.readFailed'), t('library.secrets.retry')));

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (noticeTimer.current) clearTimeout(noticeTimer.current); };
  }, []);
  // A remote library context never reads or mints a local secret.
  useEffect(() => {
    if (!local) { loaded.current = false; setSecrets([]); return; }
    if (loaded.current) return;
    loaded.current = true;
    void reload();
  }, [local]);
  // Resolve the editor body so a stale, missing or unreadable reference is visible before saving.
  useEffect(() => {
    if (!local || !body.includes('{{cliora-secret:')) { setReferences([]); return; }
    const timer = setTimeout(() => {
      void native.resolvePromptSecretReferences(body).then(rows => {
        if (mounted.current) setReferences(Array.isArray(rows) ? rows : []);
      }).catch(() => { if (mounted.current) setReferences([]); });
    }, 300);
    return () => clearTimeout(timer);
  }, [local, body, revision]);
  // The broker section loads on first open so the prompt page stays cheap.
  useEffect(() => {
    if (!local || !brokerOpen || brokerLoaded.current) return;
    brokerLoaded.current = true;
    void reloadBroker();
  }, [local, brokerOpen]);

  async function reload() {
    setLoading(true);
    try {
      const rows = await native.listPromptSecrets();
      if (mounted.current) { setSecrets(Array.isArray(rows) ? rows : []); setError(''); }
    } catch (failure) { if (mounted.current) showError(failure); }
    finally { if (mounted.current) setLoading(false); }
  }
  async function reloadBroker() {
    try {
      const [status, executorRows, installationRows, grantRows, auditRows, context] = await Promise.all([
        native.secretBrokerStatus(),
        native.listSecretExecutors(),
        native.listSecretInstallations(),
        native.listSecretGrants(),
        native.listSecretAudit(20),
        native.secretCliContext(),
      ]);
      if (!mounted.current) return;
      setBroker(status ?? emptyBroker);
      setExecutors(Array.isArray(executorRows) ? executorRows : []);
      setInstallations(Array.isArray(installationRows) ? installationRows : []);
      setGrants(Array.isArray(grantRows) ? grantRows : []);
      setAudit(Array.isArray(auditRows) ? auditRows : []);
      setCli(context ?? null);
    } catch (failure) { if (mounted.current) showError(failure); }
  }
  function closeForm() { setForm(null); setAlias(''); setValue(''); }
  function openCreate() { setError(''); setAlias(''); setValue(''); setForm({ kind: 'create' }); }
  function openRename(secret: PromptSecret) { setError(''); setAlias(secret.alias); setValue(''); setForm({ kind: 'rename', id: secret.id }); }
  function openValue(secret: PromptSecret) { setError(''); setValue(''); setForm({ kind: 'value', id: secret.id }); }

  async function create() {
    if (busy || !alias.trim() || !value) return;
    setBusy(true); setError('');
    try {
      const created = await native.createPromptSecret(alias, value);
      if (!mounted.current) return;
      closeForm();
      setSecrets(previous => [...previous.filter(item => item.id !== created.id), created].sort((left, right) => left.alias.localeCompare(right.alias)));
      announce(t('library.secrets.created', { name: created.alias }));
      setRevision(value => value + 1);
      onInsert(created.reference);
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
      // A deleted secret takes its grants with it; the panel reloads instead of guessing.
      if (brokerLoaded.current) void reloadBroker();
      setRevision(value => value + 1);
      announce(t('library.secrets.removed'));
    } catch (failure) { if (mounted.current) setError(formatFailure(failure, t('library.secrets.saveFailed'), t('library.secrets.retry'))); }
    finally { if (mounted.current) setBusy(false); }
  }

  async function saveExecutor() {
    if (busy || !executorDraft.label.trim() || !executorDraft.executable.trim()) return;
    if (executorDraft.channel === 'env' && !executorDraft.envName?.trim()) return;
    setBusy(true); setError('');
    try {
      await native.saveSecretExecutor({
        ...executorDraft,
        label: executorDraft.label.trim(),
        executable: executorDraft.executable.trim(),
        envName: executorDraft.channel === 'env' ? (executorDraft.envName ?? '').trim() : null,
        cwd: executorDraft.cwd?.trim() ? executorDraft.cwd.trim() : null,
      });
      if (!mounted.current) return;
      setExecutorDraft(emptyExecutor);
      await reloadBroker();
      announce(t('library.secrets.broker.executorSaved'));
    } catch (failure) { if (mounted.current) setError(formatFailure(failure, t('library.secrets.broker.saveFailed'), t('library.secrets.retry'))); }
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
      setInstallationLabel('');
      await reloadBroker();
      announce(t('library.secrets.broker.installationCreated'));
    } catch (failure) { if (mounted.current) setError(formatFailure(failure, t('library.secrets.broker.saveFailed'), t('library.secrets.retry'))); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function revokeInstallation(installation: SecretInstallation) {
    if (busy) return;
    if (!await confirmAction(t('library.secrets.broker.confirmRevokeInstallation', { name: installation.label }), () => mounted.current, { destructive: true, title: t('library.secrets.broker.revokeInstallation'), confirmLabel: t('library.secrets.broker.revokeInstallation') })) return;
    setBusy(true); setError('');
    try {
      await native.revokeSecretInstallation(installation.id);
      if (!mounted.current) return;
      await reloadBroker();
      announce(t('library.secrets.broker.revokedInstallation'));
    } catch (failure) { if (mounted.current) setError(formatFailure(failure, t('library.secrets.broker.saveFailed'), t('library.secrets.retry'))); }
    finally { if (mounted.current) setBusy(false); }
  }
  function openGrant(secret: PromptSecret) {
    setError('');
    setGrantForm({ secretId: secret.id, installationId: installations.find(item => !item.revoked)?.id ?? '', executorId: executors[0]?.id ?? '' });
  }
  async function saveGrant() {
    if (busy || !grantForm || !grantForm.installationId || !grantForm.executorId) return;
    setBusy(true); setError('');
    try {
      await native.grantSecretUsage(grantForm.installationId, grantForm.secretId, grantForm.executorId);
      if (!mounted.current) return;
      setGrantForm(null);
      await reloadBroker();
      announce(t('library.secrets.broker.grantSaved'));
    } catch (failure) { if (mounted.current) setError(formatFailure(failure, t('library.secrets.broker.saveFailed'), t('library.secrets.retry'))); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function revokeGrant(grant: SecretGrant) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await native.revokeSecretUsage(grant.installationId, grant.secretId, grant.executorId);
      if (!mounted.current) return;
      await reloadBroker();
      announce(t('library.secrets.broker.grantRevoked'));
    } catch (failure) { if (mounted.current) setError(formatFailure(failure, t('library.secrets.broker.saveFailed'), t('library.secrets.retry'))); }
    finally { if (mounted.current) setBusy(false); }
  }
  /** Inserts complete, copied-from-metadata instructions; nothing is guessed. */
  async function insertInstructions() {
    setError('');
    try {
      const context = cli ?? await native.secretCliContext();
      if (!mounted.current) return;
      // Prefer a live installation that already carries a grant, so the inserted text
      // holds real use/read commands; otherwise fall back to the first live one.
      const installation = installations.find(item => !item.revoked && grants.some(grant => grant.installationId === item.id))
        ?? installations.find(item => !item.revoked);
      if (!installation) {
        setError(t('library.secrets.broker.needInstallation'));
        return;
      }
      setCli(context);
      const text = buildSecretUsageInstructions({
        executable: context.executable,
        entry: context.entry,
        installationId: installation.id,
        installationLabel: installation.label,
        kind: installation.kind,
        locale: i18n.language?.startsWith('en') ? 'en' : 'zh',
        secrets: secrets.map(secret => ({ id: secret.id, alias: secret.alias })),
        executors: executors.map(executor => ({ id: executor.id, label: executor.label })),
        grants: grants.filter(grant => grant.installationId === installation.id).map(grant => ({ secretId: grant.secretId, executorId: grant.executorId })),
      });
      onInsert(text);
      announce(t('library.secrets.broker.instructionsInserted'));
    } catch (failure) { if (mounted.current) setError(formatFailure(failure, t('library.secrets.broker.instructionsFailed'), t('library.secrets.retry'))); }
  }

  if (!local) {
    return <section className={styles.secrets} data-prompt-secrets data-secret-local="false">
      <div className={styles.secretHead}><Icon name="lock" size={13} /><strong>{t('library.secrets.title')}</strong></div>
      <p className={styles.hint} data-secret-local-only>{t('library.secrets.localOnly')}</p>
    </section>;
  }
  return <section className={styles.secrets} data-prompt-secrets data-secret-local="true">
    <div className={styles.secretHead}>
      <Icon name="lock" size={13} />
      <strong>{t('library.secrets.title')}</strong>
      <span className={styles.secretGap} />
      <Button size="sm" variant="ghost" data-secret-create disabled={disabled || busy} icon={<Icon name="plus" size={12} />} onClick={openCreate}>{t('library.secrets.create')}</Button>
    </div>
    <p className={styles.hint}>{t('library.secrets.hint')}</p>
    {error && <p className={styles.error} role="alert" data-secret-error>{error}{!secrets.length && <Button size="sm" variant="ghost" onClick={() => { setError(''); void reload(); }}>{t('library.secrets.retry')}</Button>}</p>}
    {notice && <p className={styles.notice} role="status" data-secret-notice>{notice}</p>}
    {form?.kind === 'create' && <div className={styles.secretForm}>
      <label>{t('library.secrets.alias')}<input autoFocus data-secret-alias maxLength={80} value={alias} disabled={busy} placeholder={t('library.secrets.aliasPlaceholder')} onChange={event => setAlias(event.target.value)} /></label>
      <label>{t('library.secrets.value')}<input type="password" data-secret-value autoComplete="new-password" value={value} disabled={busy} placeholder={t('library.secrets.valuePlaceholder')} onChange={event => setValue(event.target.value)} /></label>
      <div className={styles.secretActions}>
        <Button size="sm" variant="primary" data-secret-submit loading={busy} disabled={!alias.trim() || !value} onClick={() => void create()}>{t('library.secrets.save')}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={closeForm}>{t('library.secrets.cancel')}</Button>
      </div>
    </div>}
    {loading && !secrets.length && <p className={styles.hint} role="status">{t('library.secrets.loading')}</p>}
    {!loading && !error && !secrets.length && <p className={styles.hint} data-secret-empty>{t('library.secrets.empty')}</p>}
    <ul className={styles.secretList}>
      {secrets.map(secret => <li className={styles.secretRow} key={secret.id} data-secret-id={secret.id} data-secret-status={secret.status}>
        <span className={styles.secretAlias}>{secret.alias}</span>
        <Badge tone={statusTone[secret.status]}>{t(`library.secrets.status.${secret.status}`)}</Badge>
        <span className={styles.secretGap} />
        {form?.kind === 'rename' && form.id === secret.id ? <>
          <input autoFocus aria-label={t('library.secrets.alias')} data-secret-rename-value maxLength={80} value={alias} disabled={busy} onChange={event => setAlias(event.target.value)} />
          <Button size="sm" variant="primary" data-secret-rename-save loading={busy} disabled={!alias.trim()} onClick={() => void rename(secret)}>{t('library.secrets.renameSave')}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={closeForm}>{t('library.secrets.cancel')}</Button>
        </> : form?.kind === 'value' && form.id === secret.id ? <>
          <input autoFocus type="password" aria-label={t('library.secrets.value')} data-secret-update-value autoComplete="new-password" value={value} disabled={busy} placeholder={t('library.secrets.valuePlaceholder')} onChange={event => setValue(event.target.value)} />
          <Button size="sm" variant="primary" data-secret-update-save loading={busy} disabled={!value} onClick={() => void updateValue(secret)}>{t('library.secrets.updateSave')}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={closeForm}>{t('library.secrets.cancel')}</Button>
        </> : <>
          <Button size="sm" variant="ghost" data-secret-insert disabled={disabled || busy || secret.status !== 'available'} onClick={() => { setError(''); onInsert(secret.reference); announce(t('library.secrets.inserted', { name: secret.alias })); }}>{t('library.secrets.insert')}</Button>
          <Button size="sm" variant="ghost" data-secret-grant disabled={disabled || busy || !installations.some(item => !item.revoked)} onClick={() => openGrant(secret)}>{t('library.secrets.broker.grant')}</Button>
          <Button size="sm" variant="ghost" data-secret-rename disabled={disabled || busy} onClick={() => openRename(secret)}>{t('library.secrets.rename')}</Button>
          <Button size="sm" variant="ghost" data-secret-update disabled={disabled || busy} onClick={() => openValue(secret)}>{t('library.secrets.updateValue')}</Button>
          <Button size="sm" variant="ghost" data-secret-remove disabled={disabled || busy} onClick={() => void remove(secret)}>{t('library.secrets.remove')}</Button>
        </>}
        {grantForm?.secretId === secret.id && <div className={styles.secretForm} data-secret-grant-form>
          <label>{t('library.secrets.broker.selectInstallation')}
            <select data-secret-grant-installation value={grantForm.installationId} disabled={busy} onChange={event => setGrantForm({ ...grantForm, installationId: event.target.value })}>
              <option value="">{t('library.secrets.broker.selectInstallation')}</option>
              {installations.filter(item => !item.revoked).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <label>{t('library.secrets.broker.selectExecutor')}
            <select data-secret-grant-executor value={grantForm.executorId} disabled={busy} onChange={event => setGrantForm({ ...grantForm, executorId: event.target.value })}>
              <option value="">{t('library.secrets.broker.selectExecutor')}</option>
              {executors.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <div className={styles.secretActions}>
            <Button size="sm" variant="primary" data-secret-grant-save loading={busy} disabled={!grantForm.installationId || !grantForm.executorId} onClick={() => void saveGrant()}>{t('library.secrets.broker.grantSave')}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setGrantForm(null)}>{t('library.secrets.cancel')}</Button>
          </div>
        </div>}
      </li>)}
    </ul>
    {references.length > 0 && <div className={styles.secretRefs} data-secret-references>
      <span className={styles.hint}>{t('library.secrets.references')}</span>
      {references.map(item => <span className={styles.secretRef} key={item.id} data-secret-reference={item.reference} data-secret-reference-status={item.status}>
        <span>{item.alias ?? t('library.secrets.referenceUnnamed')}</span>
        <Badge tone={statusTone[item.status]}>{t(`library.secrets.referenceStatus.${item.status}`)}</Badge>
      </span>)}
    </div>}
    <div className={styles.secretBroker} data-secret-broker data-secret-broker-running={broker.running ? 'true' : 'false'}>
      <div className={styles.secretHead}>
        <Button size="sm" variant="ghost" data-secret-broker-toggle aria-expanded={brokerOpen} icon={<Icon name={brokerOpen ? 'arrowDown' : 'chevronRight'} size={12} />} onClick={() => setBrokerOpen(open => !open)}>{t('library.secrets.broker.title')}</Button>
        <span className={styles.secretGap} />
        {brokerOpen && <Badge tone={broker.running ? 'success' : 'danger'}>{broker.running ? t('library.secrets.broker.running') : t('library.secrets.broker.offline')}</Badge>}
      </div>
      {brokerOpen && <>
        <p className={styles.hint} data-secret-broker-status>{broker.error ? `${broker.transport} · ${broker.error}` : broker.transport}</p>
        <p className={styles.hint}>{t('library.secrets.broker.hint')}</p>
        <div className={styles.secretActions}>
          <Button size="sm" variant="primary" data-secret-broker-instructions disabled={disabled || busy} onClick={() => void insertInstructions()}>{t('library.secrets.broker.insertInstructions')}</Button>
          <Button size="sm" variant="ghost" data-secret-broker-refresh disabled={busy} onClick={() => void reloadBroker()}>{t('library.secrets.refresh')}</Button>
        </div>
        <div className={styles.secretHead}><strong>{t('library.secrets.broker.installations')}</strong></div>
        {!installations.length && <p className={styles.hint} data-secret-installations-empty>{t('library.secrets.broker.installationsEmpty')}</p>}
        <ul className={styles.secretList}>
          {installations.map(item => <li className={styles.secretRow} key={item.id} data-secret-installation={item.id} data-secret-installation-revoked={item.revoked ? 'true' : 'false'}>
            <span className={styles.secretAlias}>{item.label}</span>
            <Badge tone={item.revoked ? 'danger' : 'success'}>{item.revoked ? t('library.secrets.broker.revoked') : t(`library.secrets.broker.kind.${item.kind}`)}</Badge>
            <code className={styles.secretId}>{item.id}</code>
            <span className={styles.secretGap} />
            {!item.revoked && <Button size="sm" variant="ghost" data-secret-installation-revoke disabled={busy} onClick={() => void revokeInstallation(item)}>{t('library.secrets.broker.revokeInstallation')}</Button>}
          </li>)}
        </ul>
        <div className={styles.secretForm}>
          <label>{t('library.secrets.broker.installationLabel')}<input data-secret-installation-label maxLength={80} value={installationLabel} disabled={busy} placeholder={t('library.secrets.broker.installationLabelPlaceholder')} onChange={event => setInstallationLabel(event.target.value)} /></label>
          <label>{t('library.secrets.broker.installationKind')}
            <select data-secret-installation-kind value={installationKind} disabled={busy} onChange={event => setInstallationKind(event.target.value === 'mcp' ? 'mcp' : 'cli')}>
              <option value="cli">{t('library.secrets.broker.kind.cli')}</option>
              <option value="mcp">{t('library.secrets.broker.kind.mcp')}</option>
            </select>
          </label>
          <div className={styles.secretActions}>
            <Button size="sm" variant="primary" data-secret-installation-create loading={busy} disabled={!installationLabel.trim()} onClick={() => void createInstallation()}>{t('library.secrets.broker.createInstallation')}</Button>
          </div>
        </div>
        <div className={styles.secretHead}><strong>{t('library.secrets.broker.executors')}</strong></div>
        {!executors.length && <p className={styles.hint} data-secret-executors-empty>{t('library.secrets.broker.executorsEmpty')}</p>}
        <ul className={styles.secretList}>
          {executors.map(item => <li className={styles.secretRow} key={item.id} data-secret-executor={item.id} data-secret-executor-channel={item.channel}>
            <span className={styles.secretAlias}>{item.label}</span>
            <Badge tone="neutral">{t(`library.secrets.broker.channel.${item.channel}`)}</Badge>
            <code className={styles.secretId}>{item.executable} {item.args.join(' ')}</code>
            <span className={styles.secretGap} />
            <Button size="sm" variant="ghost" data-secret-executor-remove disabled={busy} onClick={() => void removeExecutor(item)}>{t('library.secrets.broker.removeExecutor')}</Button>
          </li>)}
        </ul>
        <div className={styles.secretForm}>
          <label>{t('library.secrets.broker.executorLabel')}<input data-secret-executor-label maxLength={80} value={executorDraft.label} disabled={busy} placeholder={t('library.secrets.broker.executorLabelPlaceholder')} onChange={event => setExecutorDraft({ ...executorDraft, label: event.target.value })} /></label>
          <label>{t('library.secrets.broker.executable')}<input data-secret-executor-executable value={executorDraft.executable} disabled={busy} placeholder={t('library.secrets.broker.executablePlaceholder')} onChange={event => setExecutorDraft({ ...executorDraft, executable: event.target.value })} /></label>
          <label>{t('library.secrets.broker.args')}<textarea data-secret-executor-args rows={2} value={executorDraft.args.join('\n')} disabled={busy} onChange={event => setExecutorDraft({ ...executorDraft, args: event.target.value.split('\n').map(line => line.trim()).filter(Boolean) })} /></label>
          <label>{t('library.secrets.broker.channelLabel')}
            <select data-secret-executor-channel value={executorDraft.channel} disabled={busy} onChange={event => setExecutorDraft({ ...executorDraft, channel: event.target.value === 'stdin' ? 'stdin' : 'env', envName: event.target.value === 'stdin' ? null : (executorDraft.envName ?? '') })}>
              <option value="env">{t('library.secrets.broker.channel.env')}</option>
              <option value="stdin">{t('library.secrets.broker.channel.stdin')}</option>
            </select>
          </label>
          {executorDraft.channel === 'env' && <label>{t('library.secrets.broker.envName')}<input data-secret-executor-env value={executorDraft.envName ?? ''} disabled={busy} placeholder={t('library.secrets.broker.envNamePlaceholder')} onChange={event => setExecutorDraft({ ...executorDraft, envName: event.target.value })} /></label>}
          <label>{t('library.secrets.broker.cwd')}<input data-secret-executor-cwd value={executorDraft.cwd ?? ''} disabled={busy} onChange={event => setExecutorDraft({ ...executorDraft, cwd: event.target.value })} /></label>
          <div className={styles.secretActions}>
            <Button size="sm" variant="primary" data-secret-executor-save loading={busy} disabled={!executorDraft.label.trim() || !executorDraft.executable.trim() || (executorDraft.channel === 'env' && !executorDraft.envName?.trim())} onClick={() => void saveExecutor()}>{t('library.secrets.broker.saveExecutor')}</Button>
          </div>
        </div>
        <div className={styles.secretHead}><strong>{t('library.secrets.broker.grants')}</strong></div>
        {!grants.length && <p className={styles.hint} data-secret-grants-empty>{t('library.secrets.broker.grantsEmpty')}</p>}
        <ul className={styles.secretList}>
          {grants.map(grant => <li className={styles.secretRow} key={`${grant.installationId}:${grant.secretId}:${grant.executorId}`} data-secret-grant-row={`${grant.secretId}:${grant.executorId}`}>
            <span className={styles.secretAlias}>{grant.alias}</span>
            <Badge tone="neutral">{grant.executorLabel}</Badge>
            <code className={styles.secretId}>{grant.installationId}</code>
            <span className={styles.secretGap} />
            <Button size="sm" variant="ghost" data-secret-grant-revoke disabled={busy} onClick={() => void revokeGrant(grant)}>{t('library.secrets.broker.revokeGrant')}</Button>
          </li>)}
        </ul>
        <div className={styles.secretHead}><strong>{t('library.secrets.broker.audit')}</strong></div>
        {!audit.length && <p className={styles.hint} data-secret-audit-empty>{t('library.secrets.broker.auditEmpty')}</p>}
        <ul className={styles.secretList}>
          {audit.map(entry => <li className={styles.secretRow} key={entry.id} data-secret-audit={entry.id} data-secret-audit-code={entry.code}>
            <span className={styles.secretAlias}>{t(`library.secrets.broker.operation.${entry.operation}`)}</span>
            <Badge tone={entry.decision === 'allowed' ? 'success' : 'danger'}>{t(`library.secrets.broker.decision.${entry.decision}`)}</Badge>
            <code className={styles.secretId}>{entry.code}</code>
          </li>)}
        </ul>
      </>}
    </div>
  </section>;
}
