import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native, nativeAvailable } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { GuideDialog } from '../../components/GuideDialog';
import type { ConflictPreview, SyncStatus, WebdavSetup } from '../../types/portable';
import styles from './MigrationSettings.module.css';

export function WebdavSettings({ active, editing, onEdit }: { active: boolean; editing: boolean; onEdit: (editing: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [setup, setSetup] = useState<WebdavSetup>({ endpoint: '', username: '', authPassword: '', encryptionPassword: '', previousEncryptionPassword: '', enabled: true });
  const [busy, setBusy] = useState(false);
  const [previews, setPreviews] = useState<Record<string, ConflictPreview>>({});
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const latest = useRef(''); latest.current = JSON.stringify([status, previews, active]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!active || !nativeAvailable) return;
    let alive = true;
    void native.getWebdavStatus().then((next) => {
      if (!alive) return;
      setStatus(next);
      if (next.endpoint) setSetup((old) => ({ ...old, endpoint: next.endpoint ?? '', enabled: next.enabled }));
    }).catch((reason: { message?: string }) => { if (alive) setError(reason.message ?? t('settings.webdav.statusFailed')); });
    return () => { alive = false; };
  }, [active]);

  async function configure() {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await native.configureWebdav(setup);
      setStatus(next); onEdit(false);
      setSetup({ endpoint: next.endpoint ?? '', username: '', authPassword: '', encryptionPassword: '', previousEncryptionPassword: '', enabled: next.enabled });
      setMessage(t('settings.webdav.configured'));
      if (next.enabled) setStatus(await native.syncWebdavNow());
    } catch (reason) { setError((reason as { message?: string }).message ?? t('settings.webdav.configureFailed')); }
    finally { setBusy(false); }
  }

  async function toggleEnabled() {
    if (busy || !status) return;
    setBusy(true); setError('');
    try { setStatus(await native.setWebdavEnabled(!status.enabled)); }
    catch (reason) { setError((reason as { message?: string }).message ?? t('settings.webdav.toggleFailed')); }
    finally { setBusy(false); }
  }

  async function syncNow() {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await native.syncWebdavNow(); setStatus(next);
      setPreviews({});
      setMessage(t('settings.webdav.syncDone', { uploaded: next.uploaded, downloaded: next.downloaded, pending: next.conflicts.length ? t('settings.webdav.syncPending', { count: next.conflicts.length }) : '' }));
    } catch (reason) {
      setError((reason as { message?: string }).message ?? t('settings.webdav.syncFailed'));
      void native.getWebdavStatus().then(setStatus).catch(() => {});
    } finally { setBusy(false); }
  }

  async function resolve(key: string, versionId: string | null, deleted: boolean) {
    if (busy) return;
    const started = latest.current;
    if (versionId && !await confirmAction(deleted ? t('settings.webdav.confirmDelete') : t('settings.webdav.confirmReplace'), () => mounted.current && latest.current === started, { title: deleted ? t('settings.webdav.confirmDeleteTitle') : t('settings.webdav.confirmReplaceTitle'), confirmLabel: deleted ? t('settings.webdav.deleteLocal') : t('settings.webdav.replaceLocal'), destructive: deleted })) return;
    setBusy(true); setError(''); setMessage('');
    try { setStatus(await native.resolveWebdavConflict(key, versionId));
      setPreviews((old) => { const next = { ...old }; delete next[key]; return next; });
      setMessage(t('settings.webdav.resolved')); }
    catch (reason) { setError((reason as { message?: string }).message ?? t('settings.webdav.resolveFailed')); }
    finally { setBusy(false); }
  }

  async function previewConflict(key: string) {
    if (busy) return;
    setBusy(true); setError('');
    try { const next = await native.previewWebdavConflict(key); setPreviews((old) => ({ ...old, [key]: next })); }
    catch (reason) { setError((reason as { message?: string }).message ?? t('settings.webdav.previewFailed')); }
    finally { setBusy(false); }
  }

  return <section className="settings-group">
    <div className="setting-intro"><h2>{t('settings.webdav.title')}</h2><p>{t('settings.webdav.description')}</p></div>
    {error && <div className={styles.inlineError} role="alert">{error}</div>}
    {message && <div className={styles.inlineMessage} role="status">{message}</div>}
    {status?.configured ? <>
      <div className="setting-row"><span><strong>{status.endpoint}</strong><small>{status.lastSuccess ? t('settings.webdav.lastSuccess', { time: new Date(status.lastSuccess * 1000).toLocaleString(i18n.language === 'en' ? 'en-US' : 'zh-CN') }) : t('settings.webdav.neverSynced')}{status.pendingChanges ? t('settings.webdav.pendingSuffix', { count: status.pendingChanges }) : ''}{status.lastError ? t('settings.webdav.lastFailedSuffix', { error: status.lastError }) : ''}</small></span>
        <button className="button" type="button" disabled={busy} onClick={() => void toggleEnabled()}>{status.enabled ? t('settings.webdav.pause') : t('settings.webdav.enable')}</button></div>
      <div className={styles.action}><button className="button primary" type="button" disabled={busy} onClick={() => void syncNow()}>{busy ? t('settings.webdav.syncing') : t('settings.webdav.syncNow')}</button>
        <button className="button" type="button" disabled={busy} onClick={() => onEdit(true)}>{t('settings.webdav.editConnection')}</button></div>
    </> : <div className="setting-row"><span><strong>{t('settings.webdav.notConnected')}</strong><small>{t('settings.webdav.notConnectedHint')}</small></span><button className="button" type="button" onClick={() => onEdit(true)}>{t('settings.webdav.configure')}</button></div>}
    <GuideDialog open={editing} title={status?.configured ? t('settings.webdav.editTitle') : t('settings.webdav.configure')} hint={t('settings.webdav.dialogHint')} onClose={() => onEdit(false)}>
    <div className={styles.webdavForm}>
      <label>{t('settings.webdav.endpoint')}<input type="url" value={setup.endpoint} placeholder="https://dav.example.com/cliora/" onChange={(event) => setSetup({ ...setup, endpoint: event.target.value })} /></label>
      <label>{t('settings.webdav.username')}<input value={setup.username} autoComplete="username" onChange={(event) => setSetup({ ...setup, username: event.target.value })} /></label>
      <label>{t('settings.webdav.password')}<input type="password" value={setup.authPassword} autoComplete="new-password" placeholder={t('settings.webdav.passwordPlaceholder')} onChange={(event) => setSetup({ ...setup, authPassword: event.target.value })} /></label>
      <details className={styles.advanced}><summary>{t('settings.webdav.advancedSummary')}</summary><label>{t('settings.webdav.encryptionLabel')}<input type="password" value={setup.encryptionPassword} autoComplete="new-password" placeholder={t('settings.webdav.encryptionPlaceholder')} onChange={(event) => setSetup({ ...setup, encryptionPassword: event.target.value })} /></label><label>{t('settings.webdav.previousLabel')}<input type="password" value={setup.previousEncryptionPassword} autoComplete="off" placeholder={t('settings.webdav.previousPlaceholder')} onChange={(event) => setSetup({ ...setup, previousEncryptionPassword: event.target.value })} /></label></details>
      <small>{t('settings.webdav.securityNote')}</small>
      <div className={styles.action}><button type="button" className="button primary" disabled={!nativeAvailable || busy || !setup.endpoint || !setup.username || !setup.authPassword || (setup.authPassword.length < 12 && setup.encryptionPassword.length < 12)} onClick={() => void configure()}>{t('settings.webdav.save')}</button>
        <button type="button" className="button" disabled={busy} onClick={() => onEdit(false)}>{t('common.dialog.cancel')}</button></div>
    </div>
    </GuideDialog>
    {!!status?.conflicts.length && <div className={styles.conflicts}><h3>{t('settings.webdav.conflictsTitle')}</h3><p>{t('settings.webdav.conflictsHint')}</p>
      {status.conflicts.map((conflict) => <div className={styles.conflict} key={conflict.key}><strong>{conflict.label}</strong><small>{conflict.key} · {t('settings.webdav.remoteVersions', { count: conflict.remoteVersions })}</small>
        {!previews[conflict.key] ? <button className="button" type="button" disabled={busy} onClick={() => void previewConflict(conflict.key)}>{t('settings.webdav.preview')}</button> : <>
          <div className={styles.version}><strong>{t('settings.webdav.local')}</strong><p>{previews[conflict.key].localSummary}</p><button className="button" type="button" disabled={busy} onClick={() => void resolve(conflict.key, null, false)}>{t('settings.webdav.keepLocal')}</button></div>
          {previews[conflict.key].versions.map((version) => <div className={styles.version} key={version.id}><strong>{t('settings.webdav.remoteVersion', { id: version.id.slice(0, 8) })}</strong><p>{version.summary}</p>
            <button className="button" type="button" disabled={busy} onClick={() => void resolve(conflict.key, version.id, version.deleted)}>{version.deleted ? t('settings.webdav.acceptDelete') : t('settings.webdav.useRemote')}</button></div>)}
        </>}</div>)}
    </div>}
  </section>;
}
