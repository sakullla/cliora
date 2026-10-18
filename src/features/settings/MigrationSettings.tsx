import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { open, save } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import type { PortableItem } from '../../types/portable';
import { GuideDialog } from '../../components/GuideDialog';
import { formatFailure } from '../../lib/feedback';
import styles from './MigrationSettings.module.css';
import { WebdavSettings } from './WebdavSettings';

export function MigrationSettings({ active, onImported }: { active: boolean; onImported?: () => void }) {
  const { t } = useTranslation();
  const [operation, setOperation] = useState<'export' | 'import' | 'webdav' | null>(null);
  const [items, setItems] = useState<PortableItem[]>([]);
  const [listReady, setListReady] = useState(false);
  const [listError, setListError] = useState('');
  const [exportPassword, setExportPassword] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [revealPassword, setRevealPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [syncRevision, setSyncRevision] = useState(0);
  const bundleOpen = useRef(false);

  useEffect(() => {
    if (!active || !nativeAvailable) return;
    let alive = true;
    void native.listPortableItems().then((next) => {
      if (!alive) return;
      setItems(next);
      setListError('');
      setListReady(true);
    }).catch((reason) => {
      if (!alive) return;
      setListReady(false);
      setListError(formatFailure(reason, t('settings.migration.listFailed'), t('settings.migration.listFailedNext')));
    });
    return () => { alive = false; };
  }, [active]);

  function setWebdavEditing(editing: boolean) {
    setOperation((current) => editing ? 'webdav' : current === 'webdav' ? null : current);
  }

  function openBundle(next: 'export' | 'import') {
    bundleOpen.current = true;
    setRevealPassword(false);
    setOperation(next);
  }

  function closeBundle() {
    bundleOpen.current = false;
    setOperation(null);
    setRevealPassword(false);
    void native.cancelPortablePreview().catch(() => {});
  }

  async function exportBundle() {
    if (busy || exportPassword.length < 12 || !items.length) return;
    const destination = await save({ title: t('settings.migration.saveTitle'),
      defaultPath: `cliora-${new Date().toISOString().slice(0, 10)}.cliora`,
      filters: [{ name: t('settings.migration.bundleName'), extensions: ['cliora'] }] });
    if (!destination || !bundleOpen.current) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const count = await native.exportPortableBundle(destination, exportPassword);
      if (!bundleOpen.current) return;
      setMessage(t('settings.migration.exported', { count }));
      setExportPassword('');
      bundleOpen.current = false;
      setOperation(null);
      setRevealPassword(false);
    } catch (reason) {
      if (bundleOpen.current) setError(formatFailure(reason, t('settings.migration.exportFailed'), t('settings.migration.exportFailedNext')));
    } finally { setBusy(false); }
  }

  async function importBundle() {
    if (busy || !importPassword) return;
    const source = await open({ title: t('settings.migration.openTitle'), multiple: false,
      filters: [{ name: t('settings.migration.bundleName'), extensions: ['cliora'] }] });
    if (typeof source !== 'string' || !bundleOpen.current) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await native.previewPortableBundle(source, importPassword);
      if (!bundleOpen.current) {
        await native.cancelPortablePreview().catch(() => {});
        return;
      }
      const conflicts = next.items.filter((item) => item.status === 'conflict').length;
      const report = await native.applyPortableBundle(next.previewId);
      setImportPassword('');
      setRevealPassword(false);
      bundleOpen.current = false;
      setOperation(null);
      setMessage(conflicts
        ? t('settings.migration.restoredConflicts', { count: report.imported })
        : t('settings.migration.restored', { count: report.imported }));
      setSyncRevision((value) => value + 1);
      onImported?.();
      try {
        const listed = await native.listPortableItems();
        setItems(listed);
        setListError('');
        setListReady(true);
      } catch (reason) {
        setListReady(false);
        setListError(formatFailure(reason, t('settings.migration.listFailed'), t('settings.migration.listFailedNext')));
      }
    } catch (reason) {
      if (bundleOpen.current) setError(formatFailure(reason, t('settings.migration.importFailed'), t('settings.migration.importFailedNext')));
      await native.cancelPortablePreview().catch(() => {});
    } finally { setBusy(false); }
  }

  const dialogOpen = operation === 'export' || operation === 'import';
  const revealButton = <button type="button" aria-label={revealPassword ? t('settings.migration.hidePassword') : t('settings.migration.showPassword')} aria-pressed={revealPassword} onClick={() => setRevealPassword((value) => !value)}>{revealPassword ? t('settings.migration.hide') : t('settings.migration.show')}</button>;
  const bannerError = error || listError;
  const exportReady = exportPassword.length >= 12 && items.length > 0;
  return <div className={styles.page}>
    {!dialogOpen && bannerError && <div className={styles.error} role="alert">{bannerError}</div>}
    {!dialogOpen && message && <div className={styles.message} role="status">{message}</div>}
    <section className="migration-card" aria-label={t('settings.migration.cardTitle')}><h2>{t('settings.migration.cardTitle')}</h2><p>{t('settings.migration.cardDetail')}</p><div className="migration-actions"><button className="button primary" type="button" onClick={() => openBundle('export')}>{t('settings.migration.export')}</button><button className="button" type="button" onClick={() => openBundle('import')}>{t('settings.migration.import')}</button></div><small>{t('settings.migration.cardNote')}</small></section>
    <GuideDialog open={dialogOpen} title={operation === 'import' ? t('settings.migration.import') : t('settings.migration.export')} hint={operation === 'import' ? t('settings.migration.importHint') : t('settings.migration.exportHint')} onClose={closeBundle}>
    {bannerError && <div className={styles.error} role="alert">{bannerError}</div>}
    {message && <div className={styles.message} role="status">{message}</div>}
    {operation === 'export' && <section className="settings-group">
      {listReady && !listError && !items.length && <p className={styles.empty}>{t('settings.migration.exportEmpty')}</p>}
      {!!items.length && <div className={styles.action}><p className={styles.hint}>{t('settings.migration.exportAll', { count: items.length })}</p>
        <label>{t('settings.migration.password')}<span className={styles.secret}><input aria-label={t('settings.migration.password')} type={revealPassword ? 'text' : 'password'} value={exportPassword} autoComplete="new-password" placeholder={t('settings.migration.passwordPlaceholder')} onChange={(event) => setExportPassword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void exportBundle(); } }} />{revealButton}</span></label>
        <button type="button" className="button primary" disabled={!nativeAvailable || busy || !exportReady} onClick={() => void exportBundle()}>{t('settings.migration.exportBundle')}</button>
        <small className={styles.passwordHint} data-ok={exportReady || undefined}>{exportPassword.length >= 12 ? t('settings.migration.hintOk') : t('settings.migration.hintMore', { count: 12 - exportPassword.length })}</small></div>}
    </section>}
    {operation === 'import' && <section className="settings-group">
      <div className={styles.action}><label>{t('settings.migration.password')}<span className={styles.secret}><input aria-label={t('settings.migration.password')} type={revealPassword ? 'text' : 'password'} value={importPassword} autoComplete="current-password" placeholder={t('settings.migration.importPasswordPlaceholder')} onChange={(event) => setImportPassword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void importBundle(); } }} />{revealButton}</span></label>
        <button type="button" className="button primary" disabled={!nativeAvailable || busy || !importPassword} onClick={() => void importBundle()}>{t('settings.migration.unlockRestore')}</button></div>
    </section>}
    </GuideDialog>
    <WebdavSettings active={active} editing={operation === 'webdav'} onEdit={setWebdavEditing} revision={syncRevision} />
  </div>;
}
