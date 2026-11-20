import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { formatFailure } from '../../lib/feedback';
import { Icon } from '../../components/Icon';
import { Badge, Button } from '../../components/ui';
import type { Tone } from '../../lib/statusTone';
import type { PromptSecret, PromptSecretReference, PromptSecretStatus } from '../../types/secrets';
import styles from './Prompts.module.css';

const statusTone: Record<PromptSecretStatus, Tone> = { available: 'success', missing: 'danger', unknown: 'neutral', unreadable: 'warning' };

/** Insert one canonical reference without duplicating an existing one. */
export function insertReference(body: string, reference: string): string {
  if (body.includes(reference)) return body;
  const trimmed = body.replace(/[ \t]+$/, '');
  if (!trimmed) return reference;
  return `${trimmed}${trimmed.endsWith('\n') ? '' : ' '}${reference}`;
}

/**
 * Local secret management for the prompt editor. The panel only ever handles aliases and
 * reference text: the value leaves the password field straight into the native credential
 * store and is never read back, echoed, copied or sent with a prompt.
 */
export function PromptSecrets({ local, body, disabled, onInsert }: { local: boolean; body: string; disabled?: boolean; onInsert: (reference: string) => void }) {
  const { t } = useTranslation();
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
  const mounted = useRef(true);
  const loaded = useRef(false);
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

  async function reload() {
    setLoading(true);
    try {
      const rows = await native.listPromptSecrets();
      if (mounted.current) { setSecrets(Array.isArray(rows) ? rows : []); setError(''); }
    } catch (failure) { if (mounted.current) showError(failure); }
    finally { if (mounted.current) setLoading(false); }
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
      setRevision(value => value + 1);
      announce(t('library.secrets.removed'));
    } catch (failure) { if (mounted.current) setError(formatFailure(failure, t('library.secrets.saveFailed'), t('library.secrets.retry'))); }
    finally { if (mounted.current) setBusy(false); }
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
          <Button size="sm" variant="ghost" data-secret-rename disabled={disabled || busy} onClick={() => openRename(secret)}>{t('library.secrets.rename')}</Button>
          <Button size="sm" variant="ghost" data-secret-update disabled={disabled || busy} onClick={() => openValue(secret)}>{t('library.secrets.updateValue')}</Button>
          <Button size="sm" variant="ghost" data-secret-remove disabled={disabled || busy} onClick={() => void remove(secret)}>{t('library.secrets.remove')}</Button>
        </>}
      </li>)}
    </ul>
    {references.length > 0 && <div className={styles.secretRefs} data-secret-references>
      <span className={styles.hint}>{t('library.secrets.references')}</span>
      {references.map(item => <span className={styles.secretRef} key={item.id} data-secret-reference={item.reference} data-secret-reference-status={item.status}>
        <span>{item.alias ?? t('library.secrets.referenceUnnamed')}</span>
        <Badge tone={statusTone[item.status]}>{t(`library.secrets.referenceStatus.${item.status}`)}</Badge>
      </span>)}
    </div>}
  </section>;
}