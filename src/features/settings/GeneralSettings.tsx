import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getVersion } from '@tauri-apps/api/app';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { Icon } from '../../components/Icon';
import type { IconName } from '../../components/Icon';
import { ToolIcon } from '../../components/ToolIcon';
import { ToastStack } from '../../components/Toast';
import { ToolIconSettings } from './ToolIconSettings';
import { TerminalSettings } from './TerminalSettings';
import { native, nativeAvailable } from '../../lib/native';
import { useToasts } from '../../lib/toast';
import { setUpdateOffer, useUpdateOffer, type UpdateOffer } from '../../lib/appUpdate';
import brandIcon from '../../../src-tauri/icons/128x128@2x.png';
import { setLanguage, supportedLanguages, type AppLanguage } from '../../i18n';
import type { Theme } from '../../types/domain';
import type { RemoteTarget } from '../../types/remote';
import styles from './GeneralSettings.module.css';

type ToolItem = { id: string; name: string };

const MANAGED_PREVIEW = 8;

function orderedManagedTools(tools: ToolItem[], managed: string[]) {
  return [
    ...tools.filter((item) => managed.includes(item.id)),
    ...tools.filter((item) => !managed.includes(item.id)),
  ];
}

const themeGlyphs: Record<Theme, IconName> = { system: 'monitor', light: 'sun', dark: 'moon' };
const themeOrder: Theme[] = ['system', 'light', 'dark'];

function formatMb(bytes: number): string {
  return (bytes / 1048576).toFixed(1);
}

const ReleaseNotes = lazy(() => import('../records/MessageMarkdown'));

type UpdateStage = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'installed' | 'failed';

function UpdateSettings({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const shared = useUpdateOffer();
  const [version, setVersion] = useState('');
  const [stage, setStage] = useState<UpdateStage>(shared ? 'available' : 'idle');
  const [offer, setOffer] = useState<(UpdateOffer & { update: Update | null }) | null>(shared ? { ...shared, update: null } : null);
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null }>({ downloaded: 0, total: null });
  const [failure, setFailure] = useState('');
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const installing = useRef(false);

  useEffect(() => { void getVersion().then((value) => setVersion(typeof value === 'string' ? value : ''), () => setVersion('')); }, []);
  useEffect(() => {
    if (!shared) return;
    setOffer((current) => current?.update ? current : { ...shared, update: null });
    setStage((current) => current === 'idle' || current === 'latest' || current === 'failed' ? 'available' : current);
  }, [shared]);

  async function handleCheck() {
    if (installing.current) return;
    setFailure('');
    setStage('checking');
    try {
      const update = await check();
      setCheckedAt(new Date());
      if (update) {
        setOffer({ version: update.version, notes: update.body ?? null, update });
        setUpdateOffer({ version: update.version, notes: update.body ?? null });
        setStage('available');
      } else {
        setOffer(null);
        setUpdateOffer(null);
        setStage('latest');
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setStage('failed');
    }
  }

  async function handleInstall() {
    if (installing.current) return;
    installing.current = true;
    setFailure('');
    try {
      let update = offer?.update ?? null;
      if (!update) {
        // 自动检查只带回版本信息，安装前重新取回更新句柄。
        setStage('checking');
        update = await check();
        if (!update) {
          setOffer(null);
          setUpdateOffer(null);
          setStage('latest');
          return;
        }
        setOffer({ version: update.version, notes: update.body ?? null, update });
      }
      setProgress({ downloaded: 0, total: null });
      setStage('downloading');
      // 插件在写入前强制验签；验签/下载/安装失败都会抛错，当前版本保持可用（ADR-4）。
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          setProgress({ downloaded: 0, total: event.data.contentLength ?? null });
        } else if (event.event === 'Progress') {
          setProgress((current) => ({ ...current, downloaded: current.downloaded + event.data.chunkLength }));
        }
      });
      setStage('installed');
      try {
        await relaunch();
      } catch { /* 重启失败时保留“已安装”提示，用户手动重新打开即可。 */ }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setStage('failed');
    } finally {
      installing.current = false;
    }
  }

  const percent = progress.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : null;
  const tone = stage === 'available' || stage === 'downloading' ? 'new' : stage === 'failed' ? 'error' : stage === 'latest' || stage === 'installed' ? 'ok' : undefined;
  const statusText = stage === 'checking' ? t('settings.update.checking')
    : stage === 'latest' ? t('settings.update.latest')
    : stage === 'available' && offer ? t('settings.update.available', { version: offer.version })
    : stage === 'downloading' ? t('settings.update.downloading')
    : stage === 'installed' ? t('settings.update.installed')
    : stage === 'failed' ? `${t('settings.update.failed')}${failure}`
    : t('settings.update.description');
  return <section className="settings-group" id="app-update">
    <div className={styles.update} data-tone={tone}>
      <span className={styles.updateMark}><img src={brandIcon} alt="" />{tone && <span className={styles.updateBadge} aria-hidden="true"><Icon name={tone === 'new' ? 'download' : tone === 'error' ? 'alert' : 'check'} size={11} strokeWidth={2.8} /></span>}</span>
      <span className={styles.updateText}>
        <h2>{t('settings.update.title')}{version && <span className={styles.updateVersion} title={t('settings.update.current')}>{t('settings.update.currentShort', { version })}</span>}</h2>
        <small role={stage === 'failed' ? 'alert' : 'status'} className={stage === 'failed' ? styles.updateError : undefined}>{statusText}</small>
        {checkedAt && stage === 'latest' && <small className={styles.updateMeta}>{t('settings.update.checkedAt', { time: checkedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}</small>}
      </span>
      <span className={styles.updateActions}>
        {stage === 'available' && offer
          ? <button className="button primary" type="button" disabled={busy} onClick={handleInstall}><Icon name="download" size={14} />{t('settings.update.install')}</button>
          : <button className="button" type="button" disabled={busy || stage === 'checking' || stage === 'downloading' || stage === 'installed'} onClick={handleCheck}>{stage === 'checking' ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" size={14} />}{stage === 'checking' ? t('settings.update.checking') : t('settings.update.check')}</button>}
      </span>
    </div>
    {stage === 'downloading' && <div className={styles.updateProgressRow}>
      <div className={styles.updateProgress} role="progressbar" aria-label={t('settings.update.downloading')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}><div className={percent === null ? styles.indeterminate : ''} style={percent === null ? undefined : { width: `${percent}%` }} /></div>
      <small>{progress.total ? t('settings.update.progress', { downloaded: formatMb(progress.downloaded), total: formatMb(progress.total) }) : t('settings.update.progressUnknown', { downloaded: formatMb(progress.downloaded) })}{percent !== null && <strong>{percent}%</strong>}</small>
    </div>}
    {(stage === 'available' || stage === 'downloading') && offer && <div className={styles.releaseNotes}>
      <div className={styles.releaseNotesHead}><Icon name="sparkle" size={14} /><strong>{t('settings.update.notesTitle', { version: offer.version })}</strong></div>
      {offer.notes?.trim()
        ? <div className={styles.releaseNotesBody}><Suspense fallback={<p>{offer.notes}</p>}><ReleaseNotes text={offer.notes} /></Suspense></div>
        : <p className={styles.releaseNotesEmpty}>{t('settings.update.confirmHint')}</p>}
      {offer.notes?.trim() && <p className={styles.releaseNotesEmpty}>{t('settings.update.confirmHint')}</p>}
    </div>}
  </section>;
}

function ThemeChoice({ value, disabled, onChange }: { value: Theme; disabled: boolean; onChange: (theme: Theme) => void }) {
  const { t } = useTranslation();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function move(from: number, step: number) {
    const next = (from + step + themeOrder.length) % themeOrder.length;
    refs.current[next]?.focus();
    onChange(themeOrder[next]);
  }
  return <div className="theme-choice" role="radiogroup" aria-label={t('settings.theme.label')}>{themeOrder.map((id, index) => <button key={id} ref={(element) => { refs.current[index] = element; }} type="button" role="radio" aria-checked={value === id} tabIndex={value === id ? 0 : -1} disabled={disabled} onClick={() => onChange(id)} onKeyDown={(event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); move(index, 1); }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); move(index, -1); }
  }}><Icon name={themeGlyphs[id]} size={16} />{t(`settings.theme.${id}`)}</button>)}</div>;
}

function LanguageChoice({ value, disabled }: { value: AppLanguage; disabled: boolean }) {
  const { t } = useTranslation();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function choose(language: AppLanguage) {
    if (language !== value) setLanguage(language);
  }
  function move(from: number, step: number) {
    const next = (from + step + supportedLanguages.length) % supportedLanguages.length;
    refs.current[next]?.focus();
    choose(supportedLanguages[next]);
  }
  return <div className={styles.languageChoice} role="radiogroup" aria-label={t('settings.language.label')}>{supportedLanguages.map((id, index) => <button key={id} ref={(element) => { refs.current[index] = element; }} type="button" role="radio" aria-checked={value === id} tabIndex={value === id ? 0 : -1} disabled={disabled} onClick={() => choose(id)} onKeyDown={(event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); move(index, 1); }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); move(index, -1); }
  }}>{t(`common.language.${id}`)}</button>)}</div>;
}

function RemoteSshSettings({ enabled, busy, onChange }: { enabled: boolean; busy: boolean; onChange: (enabled: boolean) => void }) {
  const { t } = useTranslation();
  const [targets, setTargets] = useState<RemoteTarget[]>([]);
  const [draft, setDraft] = useState({ id: '', name: '', host: '', port: '22', user: 'root', sshConfig: '', defaultPath: '' });
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!enabled || !nativeAvailable) { setTargets([]); return; }
    void native.listRemoteTargets().then(setTargets).catch(() => setMessage(t('settings.remoteSsh.loadFailed')));
  }, [enabled, t]);
  async function save() {
    if (!draft.name.trim() || !draft.host.trim() || !draft.user.trim()) return;
    setMessage('');
    const target: RemoteTarget = {
      id: draft.id, name: draft.name.trim(), host: draft.host.trim(), port: Number(draft.port) || 22,
      user: draft.user.trim(), sshConfig: draft.sshConfig.trim() || null, defaultPath: draft.defaultPath.trim() || null,
      enabled: true, createdAt: 0, updatedAt: 0,
    };
    try {
      const saved = await native.saveRemoteTarget(target);
      setTargets((items) => [...items.filter((item) => item.id !== saved.id), saved]);
      setDraft({ id: '', name: '', host: '', port: '22', user: 'root', sshConfig: '', defaultPath: '' });
      setMessage(t('settings.remoteSsh.saved'));
    } catch (error) { setMessage((error as { message?: string }).message ?? t('settings.remoteSsh.saveFailed')); }
  }
  async function remove(id: string) {
    try { await native.deleteRemoteTarget(id); setTargets((items) => items.filter((item) => item.id !== id)); }
    catch (error) { setMessage((error as { message?: string }).message ?? t('settings.remoteSsh.saveFailed')); }
  }
  async function test(target: RemoteTarget) {
    try { const result = await native.testRemoteTarget(target); setMessage(`${result.identity ?? ''} ${result.system ?? ''}`.trim() || t('settings.remoteSsh.ready')); }
    catch (error) { setMessage((error as { message?: string }).message ?? t('settings.remoteSsh.testFailed')); }
  }
  return <section className="settings-group" id="remote-ssh-settings">
    <div className="setting-intro"><h2>{t('settings.remoteSsh.title')}</h2><p>{t('settings.remoteSsh.description')}</p></div>
    <label className="setting-row"><span><strong>{t('settings.remoteSsh.enable')}</strong><small>{t('settings.remoteSsh.enableHint')}</small></span><input type="checkbox" role="switch" checked={enabled} disabled={busy} onChange={(event) => onChange(event.target.checked)} /></label>
    {enabled && <>
      <div className="remote-target-form">
        <input aria-label={t('settings.remoteSsh.name')} placeholder={t('settings.remoteSsh.name')} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        <input aria-label={t('settings.remoteSsh.host')} placeholder={t('settings.remoteSsh.host')} value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })} />
        <input aria-label={t('settings.remoteSsh.port')} inputMode="numeric" placeholder="22" value={draft.port} onChange={(event) => setDraft({ ...draft, port: event.target.value })} />
        <input aria-label={t('settings.remoteSsh.user')} placeholder={t('settings.remoteSsh.user')} value={draft.user} onChange={(event) => setDraft({ ...draft, user: event.target.value })} />
        <input aria-label={t('settings.remoteSsh.path')} placeholder={t('settings.remoteSsh.path')} value={draft.defaultPath} onChange={(event) => setDraft({ ...draft, defaultPath: event.target.value })} />
        <input aria-label={t('settings.remoteSsh.config')} placeholder={t('settings.remoteSsh.config')} value={draft.sshConfig} onChange={(event) => setDraft({ ...draft, sshConfig: event.target.value })} />
        <button className="button" type="button" disabled={busy} onClick={() => void save()}>{draft.id ? t('settings.remoteSsh.update') : t('settings.remoteSsh.add')}</button>
      </div>
      {targets.map((target) => <div className="setting-row" key={target.id}><span><strong>{target.name}</strong><small>{target.user}@{target.host}:{target.port}{target.defaultPath ? ` · ${target.defaultPath}` : ''}</small></span><span className="setting-actions"><button className="button" type="button" onClick={() => void test(target)}>{t('settings.remoteSsh.test')}</button><button className="text-button" type="button" onClick={() => setDraft({ id: target.id, name: target.name, host: target.host, port: String(target.port), user: target.user, sshConfig: target.sshConfig ?? '', defaultPath: target.defaultPath ?? '' })}>{t('settings.remoteSsh.edit')}</button><button className="text-button" type="button" onClick={() => void remove(target.id)}>{t('settings.remoteSsh.delete')}</button></span></div>)}
      {message && <small role="status">{message}</small>}
    </>}
  </section>;
}

export function GeneralSettings({ tools, managed, preservedUnknown, icons, busy, theme, onThemeChange, onManagedChange, onIconChange, onIconError, onOpenMigration, onOpenShortcutHelp, onReopenOnboarding, remoteSshEnabled, onRemoteSshChange }: {
  tools: ToolItem[];
  managed: string[];
  preservedUnknown: { id: string; profileCount: number }[];
  icons: Record<string, string>;
  busy: boolean;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onManagedChange: (id: string, checked: boolean) => void;
  onIconChange: (toolId: string, dataUrl: string | null) => Promise<void>;
  onIconError: (message: string) => void;
  onOpenMigration: () => void;
  onOpenShortcutHelp: () => void;
  onReopenOnboarding: () => void;
  remoteSshEnabled: boolean;
  onRemoteSshChange: (enabled: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const toasts = useToasts();
  const language: AppLanguage = i18n.language === 'en' ? 'en' : 'zh';
  const catalogKey = tools.map((item) => item.id).join('\0');
  const [managedExpanded, setManagedExpanded] = useState(false);
  const [managedPreview, setManagedPreview] = useState(() => orderedManagedTools(tools, managed).slice(0, MANAGED_PREVIEW).map((item) => item.id));
  // Refresh the collapsed set when the catalog changes or the list is folded again, so a toggle does not move the chip just clicked.
  useEffect(() => {
    if (!managedExpanded) setManagedPreview(orderedManagedTools(tools, managed).slice(0, MANAGED_PREVIEW).map((item) => item.id));
  }, [catalogKey, managedExpanded]);
  const managedById = new Map(tools.map((item) => [item.id, item]));
  const managedShown = managedExpanded || tools.length <= MANAGED_PREVIEW
    ? orderedManagedTools(tools, managed)
    : managedPreview.flatMap((id) => {
      const item = managedById.get(id);
      return item ? [item] : [];
    });
  const managedHidden = tools.length - managedShown.length;
  async function handleIconChange(toolId: string, dataUrl: string | null) {
    try {
      await onIconChange(toolId, dataUrl);
      toasts.showNotice(dataUrl ? t('settings.icons.updated') : t('settings.icons.restored'));
    } catch { /* 失败原因由页面顶部错误条展示。 */ }
  }
  return <>
    <section className="settings-group">
      <div className="setting-intro"><h2>{t('settings.managed.title')}</h2><p>{t('settings.managed.description')}</p></div>
      <div className="managed-checks">{managedShown.map((item) => <label key={item.id}><ToolIcon toolId={item.id} size={22} /><span title={item.name}>{item.name}</span><input type="checkbox" checked={managed.includes(item.id)} disabled={!nativeAvailable || busy} onChange={(event) => onManagedChange(item.id, event.target.checked)} /></label>)}</div>
      {tools.length > MANAGED_PREVIEW && <div className="managed-more"><button type="button" aria-expanded={managedExpanded} onClick={() => setManagedExpanded((value) => !value)}>{managedExpanded ? t('settings.managed.less') : t('settings.managed.more', { count: managedHidden })}<Icon name="arrowDown" size={14} /></button></div>}
      <ToolIconSettings tools={tools} icons={icons} busy={busy} onChange={handleIconChange} onError={onIconError} />
      {preservedUnknown.map((item) => <div className="setting-row" key={item.id}><span><strong>{item.id}</strong><small>{t('settings.managed.preservedUnknown', { count: item.profileCount })}</small></span></div>)}
    </section>
    <section className="settings-group">
      <div className="setting-intro"><h2>{t('settings.interface.title')}</h2><p>{t('settings.interface.description')}</p></div>
      <div className="setting-row"><span><strong>{t('settings.theme.label')}</strong><small>{t('settings.theme.hint')}</small></span><ThemeChoice value={theme} disabled={busy} onChange={(next) => { if (next !== theme) onThemeChange(next); }} /></div>
      <div className="setting-row"><span><strong>{t('settings.language.label')}</strong><small>{t('settings.language.hint')}</small></span><LanguageChoice value={language} disabled={busy} /></div>
    </section>
    {nativeAvailable && <UpdateSettings busy={busy} />}
    {nativeAvailable && <TerminalSettings />}
    {nativeAvailable && <RemoteSshSettings enabled={remoteSshEnabled} busy={busy} onChange={onRemoteSshChange} />}
    <section className="settings-group">
      <div className="setting-row"><span><strong>{t('settings.shortcuts.label')}</strong><small>{t('settings.shortcuts.hint')}</small></span><button className="button" type="button" aria-label={t('settings.shortcuts.label')} onClick={onOpenShortcutHelp}>{t('settings.shortcuts.action')}</button></div>
      <div className="setting-row"><span><strong>{t('settings.migrationEntry.label')}</strong><small>{t('settings.migrationEntry.hint')}</small></span><button className="button" type="button" onClick={onOpenMigration}>{t('settings.migrationEntry.action')}</button></div>
      <div className="setting-row"><span><strong>{t('settings.onboarding.label')}</strong><small>{t('settings.onboarding.hint')}</small></span><button className="button" type="button" onClick={onReopenOnboarding}>{t('settings.onboarding.action')}</button></div>
    </section>
    <ToastStack status={toasts.notice} alert={toasts.error} onDismiss={toasts.dismiss} />
  </>;
}
