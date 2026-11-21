import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { formatFailure } from '../../lib/feedback';
import { buildSecretUsageFromMetadata } from '../../lib/secretCommands';
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
 * The default view focuses on the two steps users actually need: store a secret locally
 * and insert its placeholder reference. Advanced broker settings (caller identities,
 * fixed script executors, grants and activity logs) stay collapsed until requested.
 */
export function PromptSecrets({ local, body, disabled, onInsert }: { local: boolean; body: string; disabled?: boolean; onInsert: (reference: string) => void }) {
  const { t, i18n } = useTranslation();
  const [secrets, setSecrets] = useState<PromptSecret[]>([]);
  const [references, setReferences] = useState<PromptSecretReference[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [guideOpen, setGuideOpen] = useState(false);
  const [form, setForm] = useState<{ kind: 'create' } | { kind: 'rename'; id: string } | { kind: 'value'; id: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const [alias, setAlias] = useState('');
  const [value, setValue] = useState('');
  // Broker metadata. None of it is a value; it is what a controlled use is defined by.
  const [brokerOpen, setBrokerOpen] = useState(false);
  const [executorFormOpen, setExecutorFormOpen] = useState(false);
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
      setExecutorFormOpen(false);
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
  /** Inserts complete, copied-from-metadata instructions; creates a default CLI identity if none exists yet. */
  async function insertInstructions() {
    setError('');
    setBusy(true);
    try {
      const context = cli ?? await native.secretCliContext();
      if (!mounted.current) return;
      setCli(context);
      let currentInstallations = installations;
      if (!currentInstallations.some(item => !item.revoked)) {
        const created = await native.createSecretInstallation(t('library.secrets.broker.defaultCliLabel'), 'cli', null);
        if (!mounted.current) return;
        currentInstallations = [created, ...currentInstallations];
        setInstallations(currentInstallations);
      }
      // The shared helper picks a live installation that already carries a grant
      // when one exists, so the inserted text holds real use/read commands.
      const text = buildSecretUsageFromMetadata({
        context,
        installations: currentInstallations.map(item => ({ id: item.id, label: item.label, kind: item.kind, revoked: item.revoked })),
        locale: i18n.language?.startsWith('en') ? 'en' : 'zh',
        secrets: secrets.map(secret => ({ id: secret.id, alias: secret.alias })),
        executors: executors.map(executor => ({ id: executor.id, label: executor.label })),
        grants: grants.map(grant => ({ installationId: grant.installationId, secretId: grant.secretId, executorId: grant.executorId })),
      });
      if (!text) {
        setError(t('library.secrets.broker.needInstallation'));
        return;
      }
      onInsert(text);
      announce(t('library.secrets.broker.instructionsInserted'));
    } catch (failure) { if (mounted.current) setError(formatFailure(failure, t('library.secrets.broker.instructionsFailed'), t('library.secrets.retry'))); }
    finally { if (mounted.current) setBusy(false); }
  }

  const liveInstallations = installations.filter(item => !item.revoked);
  const canGrant = liveInstallations.length > 0 && executors.length > 0;
  const transportLabel = broker.transport === 'unix_socket'
    ? t('library.secrets.broker.transportUnix')
    : broker.transport === 'named_pipe'
      ? t('library.secrets.broker.transportPipe')
      : broker.transport;
  const installationLabelOf = (id: string) => installations.find(item => item.id === id)?.label ?? id;

  if (!local) {
    return <section className={styles.secrets} data-prompt-secrets data-secret-local="false">
      <div className={styles.secretHead}><Icon name="lock" size={14} /><strong>{t('library.secrets.title')}</strong></div>
      <p className={styles.hint} data-secret-local-only>{t('library.secrets.localOnly')}</p>
    </section>;
  }
  return <section className={styles.secrets} data-prompt-secrets data-secret-local="true">
    <div className={styles.secretHead}>
      <span className={styles.secretTitleGroup}>
        <Icon name="shield" size={14} className={styles.secretShield} />
        <strong>{t('library.secrets.title')}</strong>
        {secrets.length > 0 && <span className={styles.secretCount}>{t('library.secrets.count', { count: secrets.length })}</span>}
      </span>
      <span className={styles.secretGap} />
      {secrets.length > 0 && <Button size="sm" variant="ghost" aria-expanded={guideOpen} icon={<Icon name="info" size={12} />} onClick={() => setGuideOpen(open => !open)}>{t('library.secrets.howItWorks')}</Button>}
      <Button size="sm" variant="primary" data-secret-create disabled={disabled || busy} icon={<Icon name="plus" size={12} />} onClick={openCreate}>{t('library.secrets.create')}</Button>
    </div>
    <p className={styles.hint}>{t('library.secrets.hint')}</p>
    {(guideOpen || (!loading && !secrets.length && form?.kind !== 'create')) && <ol className={styles.secretSteps}>
      <li>{t('library.secrets.step1')}</li>
      <li>{t('library.secrets.step2')}</li>
      <li>{t('library.secrets.step3')}</li>
    </ol>}
    {error && <p className={styles.error} role="alert" data-secret-error>{error}{!secrets.length && <Button size="sm" variant="ghost" onClick={() => { setError(''); void reload(); }}>{t('library.secrets.retry')}</Button>}</p>}
    {notice && <p className={styles.notice} role="status" data-secret-notice>{notice}</p>}
    {form?.kind === 'create' && <div className={styles.secretCardForm} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); closeForm(); }
      if (event.key === 'Enter' && alias.trim() && value) { event.preventDefault(); void create(); }
    }}>
      <div className={styles.secretFormGrid}>
        <label>{t('library.secrets.alias')}<input autoFocus data-secret-alias maxLength={80} value={alias} disabled={busy} placeholder={t('library.secrets.aliasPlaceholder')} onChange={event => setAlias(event.target.value)} /></label>
        <label>{t('library.secrets.value')}<input type="password" data-secret-value autoComplete="new-password" value={value} disabled={busy} placeholder={t('library.secrets.valuePlaceholder')} onChange={event => setValue(event.target.value)} /></label>
      </div>
      <div className={styles.secretFormFooter}>
        <span className={styles.hint}>{t('library.secrets.valueNote')}</span>
        <div className={styles.secretActions}>
          <Button size="sm" variant="ghost" disabled={busy} onClick={closeForm}>{t('library.secrets.cancel')}</Button>
          <Button size="sm" variant="primary" data-secret-submit loading={busy} disabled={!alias.trim() || !value} onClick={() => void create()}>{t('library.secrets.save')}</Button>
        </div>
      </div>
    </div>}
    {references.length > 0 && <div className={styles.secretRefs} data-secret-references>
      <span className={styles.secretRefsLabel}>{t('library.secrets.references')}</span>
      {references.map(item => <span className={styles.secretRef} key={item.id} data-secret-reference={item.reference} data-secret-reference-status={item.status}>
        <Icon name="lock" size={11} />
        <span>{item.alias ?? t('library.secrets.referenceUnnamed')}</span>
        <Badge tone={statusTone[item.status]} dot={item.status === 'available'}>{t(`library.secrets.referenceStatus.${item.status}`)}</Badge>
      </span>)}
    </div>}
    {loading && !secrets.length && <p className={styles.hint} role="status">{t('library.secrets.loading')}</p>}
    {!loading && !error && !secrets.length && form?.kind !== 'create' && <p className={styles.hint} data-secret-empty>{t('library.secrets.empty')}</p>}
    {secrets.length > 0 && <ul className={styles.secretList}>
      {secrets.map(secret => {
        const referenced = body.includes(secret.reference);
        return <li className={styles.secretRow} key={secret.id} data-secret-id={secret.id} data-secret-status={secret.status}>
          <div className={styles.secretRowMain}>
            <Icon name="lock" size={12} className={styles.secretRowIcon} />
            <span className={styles.secretAlias} title={secret.alias}>{secret.alias}</span>
            <Badge tone={statusTone[secret.status]} dot={secret.status === 'available'}>{t(`library.secrets.status.${secret.status}`)}</Badge>
            {referenced && <span className={styles.secretInBody}>{t('library.secrets.inBody')}</span>}
            <span className={styles.secretGap} />
            <div className={styles.secretRowControls}>
              <Button size="sm" variant={referenced ? 'ghost' : undefined} data-secret-insert disabled={disabled || busy || secret.status !== 'available'} icon={<Icon name="plus" size={12} />} onClick={() => { setError(''); onInsert(secret.reference); announce(t('library.secrets.inserted', { name: secret.alias })); }}>{t('library.secrets.insert')}</Button>
              {canGrant && <Button size="sm" variant="ghost" data-secret-grant disabled={disabled || busy} title={t('library.secrets.broker.grant')} aria-label={t('library.secrets.broker.grant')} icon={<Icon name="sliders" size={12} />} onClick={() => openGrant(secret)} />}
              <Button size="sm" variant="ghost" data-secret-rename disabled={disabled || busy} title={t('library.secrets.rename')} aria-label={t('library.secrets.rename')} icon={<Icon name="pencil" size={12} />} onClick={() => openRename(secret)} />
              <Button size="sm" variant="ghost" data-secret-update disabled={disabled || busy} title={t('library.secrets.updateValue')} aria-label={t('library.secrets.updateValue')} icon={<Icon name="lock" size={12} />} onClick={() => openValue(secret)} />
              <Button size="sm" variant="ghost" className={styles.secretDangerBtn} data-secret-remove disabled={disabled || busy} title={t('library.secrets.remove')} aria-label={t('library.secrets.remove')} icon={<Icon name="trash" size={12} />} onClick={() => void remove(secret)} />
            </div>
          </div>
          {form?.kind === 'rename' && form.id === secret.id && <div className={styles.secretInlineEdit} onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); closeForm(); }
            if (event.key === 'Enter' && alias.trim()) { event.preventDefault(); void rename(secret); }
          }}>
            <input autoFocus aria-label={t('library.secrets.alias')} data-secret-rename-value maxLength={80} value={alias} disabled={busy} onChange={event => setAlias(event.target.value)} />
            <Button size="sm" variant="primary" data-secret-rename-save loading={busy} disabled={!alias.trim()} onClick={() => void rename(secret)}>{t('library.secrets.renameSave')}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={closeForm}>{t('library.secrets.cancel')}</Button>
          </div>}
          {form?.kind === 'value' && form.id === secret.id && <div className={styles.secretInlineEdit} onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); closeForm(); }
            if (event.key === 'Enter' && value) { event.preventDefault(); void updateValue(secret); }
          }}>
            <input autoFocus type="password" aria-label={t('library.secrets.value')} data-secret-update-value autoComplete="new-password" value={value} disabled={busy} placeholder={t('library.secrets.valuePlaceholder')} onChange={event => setValue(event.target.value)} />
            <Button size="sm" variant="primary" data-secret-update-save loading={busy} disabled={!value} onClick={() => void updateValue(secret)}>{t('library.secrets.updateSave')}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={closeForm}>{t('library.secrets.cancel')}</Button>
          </div>}
          {grantForm?.secretId === secret.id && <div className={styles.secretInlineCard} data-secret-grant-form>
            <div className={styles.secretFormGrid}>
              <label>{t('library.secrets.broker.selectInstallation')}
                <select data-secret-grant-installation value={grantForm.installationId} disabled={busy} onChange={event => setGrantForm({ ...grantForm, installationId: event.target.value })}>
                  <option value="">{t('library.secrets.broker.selectInstallation')}</option>
                  {liveInstallations.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
              <label>{t('library.secrets.broker.selectExecutor')}
                <select data-secret-grant-executor value={grantForm.executorId} disabled={busy} onChange={event => setGrantForm({ ...grantForm, executorId: event.target.value })}>
                  <option value="">{t('library.secrets.broker.selectExecutor')}</option>
                  {executors.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
            </div>
            <div className={styles.secretActions}>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setGrantForm(null)}>{t('library.secrets.cancel')}</Button>
              <Button size="sm" variant="primary" data-secret-grant-save loading={busy} disabled={!grantForm.installationId || !grantForm.executorId} onClick={() => void saveGrant()}>{t('library.secrets.broker.grantSave')}</Button>
            </div>
          </div>}
        </li>;
      })}
    </ul>}
    <div className={styles.secretBroker} data-secret-broker data-secret-broker-running={broker.running ? 'true' : 'false'}>
      <button type="button" className={styles.secretBrokerToggle} data-secret-broker-toggle aria-expanded={brokerOpen} onClick={() => setBrokerOpen(open => !open)}>
        <Icon name={brokerOpen ? 'chevronDown' : 'chevronRight'} size={12} />
        <Icon name="terminal" size={12} />
        <span>{t('library.secrets.broker.title')}</span>
        <span className={styles.secretGap} />
        {brokerOpen && <Badge tone={broker.running ? 'success' : 'danger'} dot>{broker.running ? t('library.secrets.broker.running') : t('library.secrets.broker.offline')}</Badge>}
      </button>
      {brokerOpen && <div className={styles.secretBrokerBody}>
        <div className={styles.secretBrokerSummary}>
          <div className={styles.secretBrokerMeta}>
            <p className={styles.hint}>{t('library.secrets.broker.hint')}</p>
            <p className={styles.secretStatusLine} data-secret-broker-status>{broker.error ? `${transportLabel} · ${broker.error}` : transportLabel}</p>
            <p className={styles.hint} data-secret-broker-mcp-hint>{t('library.secrets.broker.mcpHint')}</p>
          </div>
          <div className={styles.secretActions}>
            <Button size="sm" variant="primary" data-secret-broker-instructions disabled={disabled || busy} icon={<Icon name="terminal" size={12} />} onClick={() => void insertInstructions()}>{t('library.secrets.broker.insertInstructions')}</Button>
            <Button size="sm" variant="ghost" data-secret-broker-refresh disabled={busy} icon={<Icon name="refresh" size={12} />} onClick={() => void reloadBroker()}>{t('library.secrets.refresh')}</Button>
          </div>
        </div>

        <div className={styles.secretSubSection}>
          <div className={styles.secretSubHead}>
            <strong>{t('library.secrets.broker.installations')}</strong>
            <span className={styles.hint}>{t('library.secrets.broker.installationsHint')}</span>
          </div>
          {!installations.length && <p className={styles.hint} data-secret-installations-empty>{t('library.secrets.broker.installationsEmpty')}</p>}
          {installations.length > 0 && <ul className={styles.secretList}>
            {installations.map(item => <li className={styles.secretCompactRow} key={item.id} data-secret-installation={item.id} data-secret-installation-revoked={item.revoked ? 'true' : 'false'}>
              <span className={styles.secretAlias}>{item.label}</span>
              <Badge tone={item.revoked ? 'danger' : 'success'}>{item.revoked ? t('library.secrets.broker.revoked') : t(`library.secrets.broker.kind.${item.kind}`)}</Badge>
              <code className={styles.secretId}>{item.id}</code>
              <span className={styles.secretGap} />
              {!item.revoked && <Button size="sm" variant="ghost" data-secret-installation-revoke disabled={busy} onClick={() => void revokeInstallation(item)}>{t('library.secrets.broker.revokeInstallation')}</Button>}
            </li>)}
          </ul>}
          <div className={styles.secretQuickAdd}>
            <input aria-label={t('library.secrets.broker.installationLabel')} data-secret-installation-label maxLength={80} value={installationLabel} disabled={busy} placeholder={t('library.secrets.broker.installationLabelPlaceholder')} onChange={event => setInstallationLabel(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && installationLabel.trim()) { event.preventDefault(); void createInstallation(); } }} />
            <select aria-label={t('library.secrets.broker.installationKind')} data-secret-installation-kind value={installationKind} disabled={busy} onChange={event => setInstallationKind(event.target.value === 'mcp' ? 'mcp' : 'cli')}>
              <option value="cli">{t('library.secrets.broker.kind.cli')}</option>
              <option value="mcp">{t('library.secrets.broker.kind.mcp')}</option>
            </select>
            <Button size="sm" data-secret-installation-create loading={busy} disabled={!installationLabel.trim()} icon={<Icon name="plus" size={12} />} onClick={() => void createInstallation()}>{t('library.secrets.broker.createInstallation')}</Button>
          </div>
        </div>

        <div className={styles.secretSubSection}>
          <div className={styles.secretSubHead}>
            <strong>{t('library.secrets.broker.executors')}</strong>
            <span className={styles.secretGap} />
            <Button size="sm" variant="ghost" icon={<Icon name={executorFormOpen ? 'close' : 'plus'} size={12} />} onClick={() => setExecutorFormOpen(open => !open)}>{executorFormOpen ? t('library.secrets.cancel') : t('library.secrets.broker.addExecutor')}</Button>
          </div>
          <p className={styles.hint}>{t('library.secrets.broker.executorsHint')}</p>
          {!executors.length && !executorFormOpen && <p className={styles.hint} data-secret-executors-empty>{t('library.secrets.broker.executorsEmpty')}</p>}
          {executors.length > 0 && <ul className={styles.secretList}>
            {executors.map(item => <li className={styles.secretCompactRow} key={item.id} data-secret-executor={item.id} data-secret-executor-channel={item.channel}>
              <span className={styles.secretAlias}>{item.label}</span>
              <Badge tone="neutral">{t(`library.secrets.broker.channel.${item.channel}`)}</Badge>
              <code className={styles.secretId}>{item.executable} {item.args.join(' ')}</code>
              <span className={styles.secretGap} />
              <Button size="sm" variant="ghost" data-secret-executor-remove disabled={busy} onClick={() => void removeExecutor(item)}>{t('library.secrets.broker.removeExecutor')}</Button>
            </li>)}
          </ul>}
          {executorFormOpen && <div className={styles.secretForm}>
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
          </div>}
        </div>

        {(grants.length > 0 || canGrant) && <div className={styles.secretSubSection}>
          <div className={styles.secretSubHead}>
            <strong>{t('library.secrets.broker.grants')}</strong>
            <span className={styles.hint}>{t('library.secrets.broker.grantsHint')}</span>
          </div>
          {!grants.length && <p className={styles.hint} data-secret-grants-empty>{t('library.secrets.broker.grantsEmpty')}</p>}
          {grants.length > 0 && <ul className={styles.secretList}>
            {grants.map(grant => <li className={styles.secretCompactRow} key={`${grant.installationId}:${grant.secretId}:${grant.executorId}`} data-secret-grant-row={`${grant.secretId}:${grant.executorId}`}>
              <span className={styles.secretAlias}>{grant.alias}</span>
              <Badge tone="neutral">{grant.executorLabel}</Badge>
              <span className={styles.secretId} title={grant.installationId}>{installationLabelOf(grant.installationId)}</span>
              <span className={styles.secretGap} />
              <Button size="sm" variant="ghost" data-secret-grant-revoke disabled={busy} onClick={() => void revokeGrant(grant)}>{t('library.secrets.broker.revokeGrant')}</Button>
            </li>)}
          </ul>}
        </div>}

        <div className={styles.secretSubSection}>
          <div className={styles.secretSubHead}>
            <strong>{t('library.secrets.broker.audit')}</strong>
            <span className={styles.hint}>{t('library.secrets.broker.auditHint')}</span>
          </div>
          {!audit.length && <p className={styles.hint} data-secret-audit-empty>{t('library.secrets.broker.auditEmpty')}</p>}
          {audit.length > 0 && <ul className={styles.secretList}>
            {audit.map(entry => <li className={styles.secretCompactRow} key={entry.id} data-secret-audit={entry.id} data-secret-audit-code={entry.code}>
              <span className={styles.secretAlias}>{t(`library.secrets.broker.operation.${entry.operation}`)}</span>
              <Badge tone={entry.decision === 'allowed' ? 'success' : 'danger'}>{t(`library.secrets.broker.decision.${entry.decision}`)}</Badge>
              <code className={styles.secretId}>{entry.code}</code>
            </li>)}
          </ul>}
        </div>
      </div>}
    </div>
  </section>;
}
