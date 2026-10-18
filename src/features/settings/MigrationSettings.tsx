import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { open, save } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import type { PortableItem } from '../../types/portable';
import { GuideDialog } from '../../components/GuideDialog';
import { Icon } from '../../components/Icon';
import { formatFailure } from '../../lib/feedback';
import styles from './Sync.module.css';
import { MIN_PASSPHRASE, Notice, PassphraseField, useKindLabel } from './syncParts';
import { WebdavSettings } from './WebdavSettings';

function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

export function MigrationSettings({ active, onImported }: { active: boolean; onImported?: () => void }) {
  const { t } = useTranslation();
  const kindLabel = useKindLabel();
  const exportDescription = useId();
  const importDescription = useId();
  const [operation, setOperation] = useState<'export' | 'import' | 'webdav' | null>(null);
  const [items, setItems] = useState<PortableItem[]>([]);
  const [listReady, setListReady] = useState(false);
  const [listError, setListError] = useState('');
  const [exportPassword, setExportPassword] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [importFile, setImportFile] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [syncRevision, setSyncRevision] = useState(0);
  const bundleOpen = useRef(false);

  async function loadItems() {
    try {
      const listed = await native.listPortableItems();
      setItems(listed);
      setListError('');
      setListReady(true);
    } catch (reason) {
      setListReady(false);
      setListError(formatFailure(reason, t('settings.migration.listFailed'), t('settings.migration.listFailedNext')));
    }
  }

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
    setError('');
    setImportFile('');
    setOperation(next);
  }

  function closeBundle() {
    bundleOpen.current = false;
    setOperation(null);
    setError('');
    void native.cancelPortablePreview().catch(() => {});
  }

  async function exportBundle() {
    if (busy || exportPassword.length < MIN_PASSPHRASE || !items.length) return;
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
    } catch (reason) {
      if (bundleOpen.current) setError(formatFailure(reason, t('settings.migration.exportFailed'), t('settings.migration.exportFailedNext')));
    } finally { setBusy(false); }
  }

  async function pickFile() {
    const source = await open({ title: t('settings.migration.openTitle'), multiple: false,
      filters: [{ name: t('settings.migration.bundleName'), extensions: ['cliora'] }] });
    if (typeof source !== 'string' || !bundleOpen.current) return '';
    setImportFile(source);
    setError('');
    return source;
  }

  async function importBundle() {
    if (busy || !importPassword) return;
    const source = importFile || await pickFile();
    if (!source || !bundleOpen.current) return;
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
      setImportFile('');
      bundleOpen.current = false;
      setOperation(null);
      setMessage(conflicts
        ? t('settings.migration.restoredConflicts', { count: report.imported })
        : t('settings.migration.restored', { count: report.imported }));
      setSyncRevision((value) => value + 1);
      onImported?.();
      await loadItems();
    } catch (reason) {
      if (bundleOpen.current) setError(formatFailure(reason, t('settings.migration.importFailed'), t('settings.migration.importFailedNext')));
      await native.cancelPortablePreview().catch(() => {});
    } finally { setBusy(false); }
  }

  const dialogOpen = operation === 'export' || operation === 'import';
  const exportReady = exportPassword.length >= MIN_PASSPHRASE && items.length > 0;
  const kinds = Object.entries(items.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.kind]: (acc[item.kind] ?? 0) + 1 }), {}));
  const inventory = <ul className={styles.chips}>{kinds.map(([kind, count]) => <li key={kind}>{kindLabel(kind, 'migration')}<span>{count}</span></li>)}</ul>;
  const dialogError = error || (operation === 'export' ? listError : '');

  return <div className={styles.page}>
    {message && <Notice tone="success" onDismiss={() => setMessage('')}>{message}</Notice>}
    <div className={styles.layout}>
      <WebdavSettings active={active} editing={operation === 'webdav'} onEdit={setWebdavEditing} revision={syncRevision} />
      <aside className={styles.aside}>
        <section className={styles.card} data-variant="backup" aria-label={t('settings.migration.cardTitle')}>
          <header className={styles.backupHead}>
            <span className={styles.backupGlyph} aria-hidden="true"><Icon name="archive" size={22} /></span>
            <div><h2>{t('settings.migration.cardTitle')}</h2><p>{t('settings.migration.cardDetail')}</p></div>
          </header>
          {listReady && items.length > 0 && <div className={styles.inventory}>
            <small>{t('settings.migration.inventory', { count: items.length })}</small>
            {inventory}
          </div>}
          {!dialogOpen && listError && <p className={styles.inlineError} role="alert">{listError}</p>}
          <div className={styles.tiles}>
            <button type="button" className={styles.tile} aria-label={t('settings.migration.export')} aria-describedby={exportDescription} onClick={() => openBundle('export')}>
              <span className={styles.tileIcon} data-tone="accent" aria-hidden="true"><Icon name="download" size={18} /></span>
              <span className={styles.tileBody}><strong>{t('settings.migration.export')}</strong><small id={exportDescription}>{t('settings.migration.exportTile')}</small></span>
              <Icon name="chevronRight" size={16} />
            </button>
            <button type="button" className={styles.tile} aria-label={t('settings.migration.import')} aria-describedby={importDescription} onClick={() => openBundle('import')}>
              <span className={styles.tileIcon} data-tone="info" aria-hidden="true"><Icon name="upload" size={18} /></span>
              <span className={styles.tileBody}><strong>{t('settings.migration.import')}</strong><small id={importDescription}>{t('settings.migration.importTile')}</small></span>
              <Icon name="chevronRight" size={16} />
            </button>
          </div>
          <ul className={styles.facts}>
            <li><Icon name="lock" size={14} />{t('settings.migration.cardNote')}</li>
            <li><Icon name="info" size={14} />{t('settings.migration.cardLocal')}</li>
          </ul>
        </section>
      </aside>
    </div>
    <GuideDialog open={dialogOpen} title={operation === 'import' ? t('settings.migration.import') : t('settings.migration.export')} hint={operation === 'import' ? t('settings.migration.importHint') : t('settings.migration.exportHint')} onClose={closeBundle}>
      {operation === 'export' && <div className={`sync-dialog ${styles.dialogBody}`}>
        {dialogError && <Notice tone="error">{dialogError}</Notice>}
        {listReady && !listError && !items.length && <div className={styles.emptyBox}><span aria-hidden="true"><Icon name="package" size={22} /></span><p>{t('settings.migration.exportEmpty')}</p></div>}
        {!!items.length && <>
          <div className={styles.summaryBox}>
            <span className={styles.tileIcon} data-tone="accent" aria-hidden="true"><Icon name="package" size={18} /></span>
            <div><strong>{t('settings.migration.exportAll', { count: items.length })}</strong>{inventory}</div>
          </div>
          <PassphraseField label={t('settings.migration.password')} value={exportPassword} autoComplete="new-password" placeholder={t('settings.migration.passwordPlaceholder')} meter autoFocus
            hint={exportPassword.length >= MIN_PASSPHRASE ? t('settings.migration.hintOk') : t('settings.migration.hintMore', { count: MIN_PASSPHRASE - exportPassword.length })}
            onChange={setExportPassword} onEnter={() => void exportBundle()} />
          <div className={styles.callout} data-tone="warning"><Icon name="alert" size={16} /><span>{t('settings.migration.exportKeep')}</span></div>
          <div className={styles.dialogFoot}>
            <button type="button" className="button" onClick={closeBundle}>{t('common.dialog.cancel')}</button>
            <button type="button" className="button primary" data-dialog-save disabled={!nativeAvailable || busy || !exportReady} onClick={() => void exportBundle()}><Icon name="download" size={14} />{t('settings.migration.exportBundle')}</button>
          </div>
        </>}
      </div>}
      {operation === 'import' && <div className={`sync-dialog ${styles.dialogBody}`}>
        {dialogError && <Notice tone="error">{dialogError}</Notice>}
        <div className={styles.callout} data-tone="info"><Icon name="info" size={16} /><span>{t('settings.migration.importNote')}</span></div>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t('settings.migration.file')}</span>
          <button type="button" className={styles.filePick} data-chosen={importFile ? '' : undefined} disabled={busy} onClick={() => void pickFile()}>
            <span className={styles.tileIcon} data-tone={importFile ? 'accent' : undefined} aria-hidden="true"><Icon name={importFile ? 'check' : 'archive'} size={18} /></span>
            <span className={styles.tileBody}><strong>{importFile ? fileName(importFile) : t('settings.migration.chooseFile')}</strong><small>{importFile ? t('settings.migration.changeFile') : t('settings.migration.fileHint')}</small></span>
          </button>
        </div>
        <PassphraseField label={t('settings.migration.password')} value={importPassword} autoComplete="current-password" placeholder={t('settings.migration.importPasswordPlaceholder')} autoFocus
          onChange={setImportPassword} onEnter={() => void importBundle()} />
        <div className={styles.dialogFoot}>
          <button type="button" className="button" onClick={closeBundle}>{t('common.dialog.cancel')}</button>
          <button type="button" className="button primary" data-dialog-save disabled={!nativeAvailable || busy || !importPassword} onClick={() => void importBundle()}><Icon name="lock" size={14} />{busy ? t('settings.migration.restoring') : t('settings.migration.unlockRestore')}</button>
        </div>
      </div>}
    </GuideDialog>
  </div>;
}
