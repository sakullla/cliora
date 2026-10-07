import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { open, save } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import type { PortableItem, PortablePreview } from '../../types/portable';
import type { Project } from '../../types/launch';
import { Icon } from '../../components/Icon';
import { GuideDialog } from '../../components/GuideDialog';
import { formatFailure } from '../../lib/feedback';
import styles from './MigrationSettings.module.css';
import { WebdavSettings } from './WebdavSettings';

export function MigrationSettings({ active, onImported }: { active: boolean; onImported?: () => void }) {
  const { t } = useTranslation();
  const kindLabel = (kind: string) => t(`settings.migration.kind.${kind}`, { defaultValue: kind });
  const [operation, setOperation] = useState<'export' | 'import' | 'webdav' | null>(null);
  const [items, setItems] = useState<PortableItem[]>([]);
  const [listReady, setListReady] = useState(false);
  const [listError, setListError] = useState('');
  const [exportSelected, setExportSelected] = useState<string[]>([]);
  const [exportPassword, setExportPassword] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [preview, setPreview] = useState<PortablePreview | null>(null);
  const [importSelected, setImportSelected] = useState<string[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectLinks, setProjectLinks] = useState<Record<string, string>>({});
  const [applyTargets, setApplyTargets] = useState<Record<string, string>>({});
  const [revealPassword, setRevealPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!active || !nativeAvailable) return;
    let alive = true;
    void native.listPortableItems().then((next) => {
      if (!alive) return;
      setItems(next);
      setExportSelected((old) => old.length ? old : next.map((item) => item.key));
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

  function toggle(key: string, values: string[], update: (next: string[]) => void) {
    update(values.includes(key) ? values.filter((value) => value !== key) : [...values, key]);
  }

  async function exportBundle() {
    if (busy || exportPassword.length < 12 || !exportSelected.length) return;
    const destination = await save({ title: t('settings.migration.saveTitle'),
      defaultPath: `cliora-${new Date().toISOString().slice(0, 10)}.cliora`,
      filters: [{ name: t('settings.migration.bundleName'), extensions: ['cliora'] }] });
    if (!destination) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const count = await native.exportPortableBundle(destination, exportPassword, exportSelected);
      setMessage(t('settings.migration.exported', { count }));
      setExportPassword(''); setOperation(null); setRevealPassword(false);
    } catch (reason) { setError(formatFailure(reason, t('settings.migration.exportFailed'), t('settings.migration.exportFailedNext'))); }
    finally { setBusy(false); }
  }

  async function importBundle() {
    if (busy || !importPassword) return;
    const source = await open({ title: t('settings.migration.openTitle'), multiple: false,
      filters: [{ name: t('settings.migration.bundleName'), extensions: ['cliora'] }] });
    if (typeof source !== 'string') return;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await native.previewPortableBundle(source, importPassword);
      setPreview(next);
      setImportSelected(next.items.filter((item) => item.status === 'new').map((item) => item.key));
      setProjects(await native.listProjects().catch(() => []));
      setProjectLinks({}); setApplyTargets({});
      setImportPassword('');
    } catch (reason) { setError(formatFailure(reason, t('settings.migration.previewFailed'), t('settings.migration.previewFailedNext'))); }
    finally { setBusy(false); }
  }

  async function cancelPreview() {
    await native.cancelPortablePreview().catch(() => {});
    setPreview(null); setImportSelected([]); setProjectLinks({}); setApplyTargets({});
  }

  async function pickProjectDirectory(projectId: string) {
    const path = await open({ title: t('settings.migration.pickProjectTitle'), directory: true, multiple: false });
    if (typeof path === 'string') setProjectLinks((old) => ({ ...old, [projectId]: path }));
  }

  async function applyPreview() {
    if (!preview || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const links = Object.entries(projectLinks).filter(([id]) => importSelected.includes(`project:${id}`)).map(([projectId, path]) => ({ projectId, path }));
      const targets = Object.entries(applyTargets).filter(([key, value]) => value && importSelected.includes(key)).map(([key, value]) => ({
        profileId: key.slice('profile:'.length), projectId: value === 'global' ? null : value,
      }));
      const report = await native.applyPortableBundle(preview.previewId, importSelected, links, targets);
      setPreview(null); setImportSelected([]);
      setProjectLinks({}); setApplyTargets({});
      setMessage(t('settings.migration.restored', { count: report.imported, detail: report.targets.map((target) => t('settings.migration.targetResult', { label: target.label, status: target.status === 'failed' ? t('settings.migration.targetFailed', { detail: target.detail }) : target.status === 'linked' ? t('settings.migration.targetLinked') : t('settings.migration.targetApplied') })).join(t('settings.migration.separator')) || t('settings.migration.noTargets') }));
      setOperation(null); setRevealPassword(false);
      onImported?.();
      try {
        const next = await native.listPortableItems();
        setItems(next); setExportSelected(next.map((item) => item.key));
        setListError(''); setListReady(true);
      } catch (reason) {
        setListReady(false);
        setListError(formatFailure(reason, t('settings.migration.listFailed'), t('settings.migration.listFailedNext')));
      }
    } catch (reason) { setError(formatFailure(reason, t('settings.migration.importFailed'), t('settings.migration.importFailedNext'))); }
    finally { setBusy(false); }
  }

  const projectChoices = [...new Map([
    ...projects.map((project) => [project.id, { id: project.id, name: project.name, path: project.path }] as const),
    ...(preview?.items.filter((item) => item.kind === 'project').map((item) => [item.key.slice('project:'.length), {
      id: item.key.slice('project:'.length), name: item.label, path: projectLinks[item.key.slice('project:'.length)] ?? projects.find((project) => `project:${project.id}` === item.key)?.path ?? null,
    }] as const) ?? []),
  ]).values()];

  const dialogOpen = operation === 'export' || operation === 'import';
  const allExportSelected = !!items.length && items.every((item) => exportSelected.includes(item.key));
  const revealButton = <button type="button" aria-label={revealPassword ? t('settings.migration.hidePassword') : t('settings.migration.showPassword')} aria-pressed={revealPassword} onClick={() => setRevealPassword((value) => !value)}>{revealPassword ? t('settings.migration.hide') : t('settings.migration.show')}</button>;
  const bannerError = error || listError;
  return <div className={styles.page}>
    {!dialogOpen && bannerError && <div className={styles.error} role="alert">{bannerError}</div>}
    {!dialogOpen && message && <div className={styles.message} role="status">{message}</div>}
    <section className="migration-card"><div className="migration-mark"><Icon name="migration" size={24} /></div><h2>{t('settings.migration.cardTitle')}</h2><p>{t('settings.migration.cardDetail')}</p><div className="migration-actions"><button className="button primary" type="button" onClick={() => setOperation('export')}>{t('settings.migration.export')}</button><button className="button" type="button" onClick={() => setOperation('import')}>{t('settings.migration.import')}</button></div><small>{t('settings.migration.cardNote')}</small></section>
    <GuideDialog open={dialogOpen} title={operation === 'import' ? t('settings.migration.import') : t('settings.migration.export')} hint={operation === 'import' ? t('settings.migration.importHint') : t('settings.migration.exportHint')} onClose={() => { setOperation(null); setRevealPassword(false); }}>
    {bannerError && <div className={styles.error} role="alert">{bannerError}</div>}
    {message && <div className={styles.message} role="status">{message}</div>}
    {operation === 'export' && <section className="settings-group">
      <div className={styles.listBar}><span><strong>{t('settings.migration.selectedCount', { selected: exportSelected.filter((key) => items.some((item) => item.key === key)).length, total: items.length })}</strong>{t('settings.migration.exportNote')}</span>
        {!!items.length && <button type="button" className="text-button" disabled={busy} onClick={() => setExportSelected(allExportSelected ? [] : items.map((item) => item.key))}>{allExportSelected ? t('settings.migration.deselectAll') : t('settings.migration.selectAll')}</button>}</div>
      <div className={styles.list} aria-label={t('settings.migration.exportListLabel')}>
        {items.map((item) => <label className={styles.item} key={item.key}><input type="checkbox" checked={exportSelected.includes(item.key)}
          onChange={() => toggle(item.key, exportSelected, setExportSelected)} disabled={busy} />
          <span><strong>{item.label}</strong><small>{kindLabel(item.kind)}{item.pendingFields.length ? t('settings.migration.pendingSuffix') : ''}</small></span></label>)}
        {listReady && !listError && !items.length && <p className={styles.empty}>{t('settings.migration.exportEmpty')}</p>}
      </div>
      <div className={styles.action}><label>{t('settings.migration.password')}<span className={styles.secret}><input aria-label={t('settings.migration.password')} type={revealPassword ? 'text' : 'password'} value={exportPassword} autoComplete="new-password" placeholder={t('settings.migration.passwordPlaceholder')} onChange={(event) => setExportPassword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void exportBundle(); } }} />{revealButton}</span></label>
        <button type="button" className="button primary" disabled={!nativeAvailable || busy || exportPassword.length < 12 || !exportSelected.length} onClick={() => void exportBundle()}>{t('settings.migration.exportBundle')}</button>
        <small className={styles.passwordHint} data-ok={(exportPassword.length >= 12 && exportSelected.length > 0) || undefined}>{!exportSelected.length ? t('settings.migration.hintSelect') : exportPassword.length >= 12 ? t('settings.migration.hintOk') : t('settings.migration.hintMore', { count: 12 - exportPassword.length })}</small></div>
    </section>}
    {operation === 'import' && <section className="settings-group">
      {!preview ? <div className={styles.action}><label>{t('settings.migration.password')}<span className={styles.secret}><input aria-label={t('settings.migration.password')} type={revealPassword ? 'text' : 'password'} value={importPassword} autoComplete="current-password" placeholder={t('settings.migration.importPasswordPlaceholder')} onChange={(event) => setImportPassword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void importBundle(); } }} />{revealButton}</span></label>
        <button type="button" className="button primary" disabled={!nativeAvailable || busy || !importPassword} onClick={() => void importBundle()}>{t('settings.migration.preview')}</button></div> : <>
        <div className={styles.listBar}><span><strong>{t('settings.migration.selectedCount', { selected: importSelected.length, total: preview.items.filter((item) => item.status !== 'same').length })}</strong>{t('settings.migration.importNote')}</span></div>
        <div className={`${styles.list} ${styles.previewList}`} aria-label={t('settings.migration.previewLabel')}>{preview.items.map((item) => <div className={styles.previewItem} key={item.key}>
          <label className={styles.item}><input type="checkbox" checked={importSelected.includes(item.key)} disabled={busy || item.status === 'same'} onChange={() => toggle(item.key, importSelected, setImportSelected)} />
            <span><strong>{item.label}</strong><small>{kindLabel(item.kind)} · {item.status === 'new' ? t('settings.migration.statusNew') : item.status === 'same' ? t('settings.migration.statusSame') : t('settings.migration.statusDifferent')}
              {item.pendingFields.length ? t('settings.migration.pendingFields', { fields: item.pendingFields.join('、') }) : ''}</small></span></label>
          {item.status !== 'same' && <details className={styles.previewDetails}><summary>{t('settings.migration.compareSummary')}</summary><div className={styles.compare}><div><strong>{t('settings.migration.local')}</strong><pre>{item.localPreview ?? t('settings.migration.localEmpty')}</pre></div><div><strong>{t('settings.migration.bundle')}</strong><pre>{item.incomingPreview ?? t('settings.migration.previewUnavailable')}</pre></div></div></details>}
          {item.kind === 'project' && importSelected.includes(item.key) && <div className={styles.targetChoice}><span>{t('settings.migration.localDir', { value: projectLinks[item.key.slice('project:'.length)] ?? t('settings.migration.pendingLink') })}</span><button className="button" type="button" disabled={busy} onClick={() => void pickProjectDirectory(item.key.slice('project:'.length))}>{t('settings.migration.chooseDir')}</button></div>}
          {item.kind === 'profile' && importSelected.includes(item.key) && <label className={styles.targetChoice}>{t('settings.migration.applyTarget', { tool: item.toolId ?? 'CLI' })}<select value={applyTargets[item.key] ?? ''} disabled={busy} onChange={(event) => setApplyTargets((old) => ({ ...old, [item.key]: event.target.value }))}>
            <option value="">{t('settings.migration.applyLater')}</option><option value="global">{t('settings.migration.applyGlobal')}</option>{projectChoices.map((project) => <option key={project.id} value={project.id}>{t('settings.migration.applyProject', { name: project.name })}{project.path ? '' : t('settings.migration.applyProjectNoDir')}</option>)}
          </select></label>}
        </div>)}</div>
        <div className={styles.action}><span className={styles.hint}>{preview.pendingProjects ? t('settings.migration.pendingProjects', { count: preview.pendingProjects }) : t('settings.migration.noAutoSwitch')}</span>
          <button type="button" className="button" disabled={busy} onClick={() => void cancelPreview()}>{t('common.dialog.cancel')}</button>
          <button type="button" className="button primary" disabled={busy || !importSelected.length} onClick={() => void applyPreview()}>{t('settings.migration.confirmRestore', { count: importSelected.length })}</button></div>
      </>}
    </section>}
    </GuideDialog>
    <WebdavSettings active={active} editing={operation === 'webdav'} onEdit={setWebdavEditing} />
  </div>;
}
