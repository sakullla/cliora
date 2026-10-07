import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { Icon } from '../../components/Icon';
import type { IconName } from '../../components/Icon';
import { ToolIcon } from '../../components/ToolIcon';
import { ToastStack } from '../../components/Toast';
import { ToolIconSettings } from './ToolIconSettings';
import { TerminalSettings } from './TerminalSettings';
import { nativeAvailable } from '../../lib/native';
import { useToasts } from '../../lib/toast';
import { setLanguage, supportedLanguages, type AppLanguage } from '../../i18n';
import type { Theme } from '../../types/domain';
import styles from './GeneralSettings.module.css';

type ToolItem = { id: string; name: string };

const themeGlyphs: Record<Theme, IconName> = { system: 'monitor', light: 'sun', dark: 'moon' };
const themeOrder: Theme[] = ['system', 'light', 'dark'];

type UpdateOffer = { version: string; notes: string | null };

// ADR-4：Rust 端启动延迟自动检查的结果事件。模块级订阅（App 静态引入本模块）保证
// 任意页面都能收到，设置页挂载时读取最新结果；未收到即无待提示更新。
let autoCheckOffer: UpdateOffer | null = null;
if (nativeAvailable) {
  void listen<UpdateOffer>('cliora:update-available', (event) => { autoCheckOffer = event.payload; });
}

function formatMb(bytes: number): string {
  return (bytes / 1048576).toFixed(1);
}

type UpdateStage = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'installed' | 'failed';

function UpdateSettings({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const [version, setVersion] = useState('');
  const [stage, setStage] = useState<UpdateStage>(autoCheckOffer ? 'available' : 'idle');
  const [offer, setOffer] = useState<(UpdateOffer & { update: Update | null }) | null>(autoCheckOffer ? { ...autoCheckOffer, update: null } : null);
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null }>({ downloaded: 0, total: null });
  const [failure, setFailure] = useState('');
  const installing = useRef(false);

  useEffect(() => { void getVersion().then((value) => setVersion(typeof value === 'string' ? value : ''), () => setVersion('')); }, []);
  useEffect(() => {
    const unlisten = listen<UpdateOffer>('cliora:update-available', (event) => {
      setOffer((current) => current?.update ? current : { ...event.payload, update: null });
      setStage((current) => current === 'idle' || current === 'latest' || current === 'failed' ? 'available' : current);
    });
    return () => { void unlisten.then((off) => off()); };
  }, []);

  async function handleCheck() {
    if (installing.current) return;
    setFailure('');
    setStage('checking');
    try {
      const update = await check();
      if (update) {
        setOffer({ version: update.version, notes: update.body ?? null, update });
        setStage('available');
      } else {
        setOffer(null);
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

  return <section className="settings-group">
    <div className="setting-intro"><h2>{t('settings.update.title')}</h2><p>{t('settings.update.description')}</p></div>
    <div className="setting-row"><span><strong>{t('settings.update.current')}</strong><small>{version || '—'}</small></span><button className="button" type="button" disabled={busy || stage === 'checking' || stage === 'downloading'} onClick={handleCheck}>{stage === 'checking' ? t('settings.update.checking') : t('settings.update.check')}</button></div>
    {stage === 'latest' && <div className="setting-row"><span><small>{t('settings.update.latest')}</small></span></div>}
    {stage === 'available' && offer && <div className="setting-row"><span><strong>{t('settings.update.available', { version: offer.version })}</strong><small>{offer.notes || t('settings.update.confirmHint')}</small></span><button className="button" type="button" disabled={busy} onClick={handleInstall}>{t('settings.update.install')}</button></div>}
    {stage === 'downloading' && <div className="setting-row"><span><strong>{t('settings.update.downloading')}</strong><small>{progress.total ? t('settings.update.progress', { downloaded: formatMb(progress.downloaded), total: formatMb(progress.total) }) : t('settings.update.progressUnknown', { downloaded: formatMb(progress.downloaded) })}</small></span><div className={styles.updateProgress}><div className={progress.total ? '' : styles.indeterminate} style={progress.total ? { width: `${Math.min(100, Math.round((progress.downloaded / progress.total) * 100))}%` } : undefined} /></div></div>}
    {stage === 'installed' && <div className="setting-row"><span><small>{t('settings.update.installed')}</small></span></div>}
    {stage === 'failed' && <div className="setting-row"><span><small className={styles.updateError}>{t('settings.update.failed')}{failure}</small></span></div>}
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
  }}><Icon name={themeGlyphs[id]} size={15} />{t(`settings.theme.${id}`)}</button>)}</div>;
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

export function GeneralSettings({ tools, managed, preservedUnknown, icons, busy, theme, onThemeChange, onManagedChange, onIconChange, onIconError, onOpenMigration, onOpenShortcutHelp }: {
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
}) {
  const { t, i18n } = useTranslation();
  const toasts = useToasts();
  const language: AppLanguage = i18n.language === 'en' ? 'en' : 'zh';
  async function handleIconChange(toolId: string, dataUrl: string | null) {
    try {
      await onIconChange(toolId, dataUrl);
      toasts.showNotice(dataUrl ? t('settings.icons.updated') : t('settings.icons.restored'));
    } catch { /* 失败原因由页面顶部错误条展示。 */ }
  }
  return <>
    <section className="settings-group">
      <div className="setting-intro"><h2>{t('settings.managed.title')}</h2><p>{t('settings.managed.description')}</p></div>
      <div className="managed-checks">{tools.map((item) => <label key={item.id}><input type="checkbox" checked={managed.includes(item.id)} disabled={!nativeAvailable || busy} onChange={(event) => onManagedChange(item.id, event.target.checked)} /><ToolIcon toolId={item.id} size={24} /><span>{item.name}</span></label>)}</div>
      <ToolIconSettings tools={tools} icons={icons} busy={busy} onChange={handleIconChange} onError={onIconError} />
      {preservedUnknown.map((item) => <div className="setting-row" key={item.id}><span><strong>{item.id}</strong><small>{t('settings.managed.preservedUnknown', { count: item.profileCount })}</small></span></div>)}
    </section>
    <section className="settings-group">
      <div className="setting-intro"><h2>{t('settings.appearance.title')}</h2><p>{t('settings.appearance.description')}</p></div>
      <div className="setting-row"><span><strong>{t('settings.theme.label')}</strong><small>{t('settings.theme.hint')}</small></span><ThemeChoice value={theme} disabled={busy} onChange={(next) => { if (next !== theme) onThemeChange(next); }} /></div>
    </section>
    <section className="settings-group">
      <div className="setting-intro"><h2>{t('settings.language.title')}</h2><p>{t('settings.language.description')}</p></div>
      <div className="setting-row"><span><strong>{t('settings.language.label')}</strong><small>{t('settings.language.hint')}</small></span><LanguageChoice value={language} disabled={busy} /></div>
    </section>
    {nativeAvailable && <UpdateSettings busy={busy} />}
    {nativeAvailable && <TerminalSettings />}
    <div className="setting-row"><span><strong>{t('settings.shortcuts.label')}</strong><small>{t('settings.shortcuts.hint')}</small></span><button className="button" type="button" aria-label={t('settings.shortcuts.label')} onClick={onOpenShortcutHelp}>{t('settings.shortcuts.action')}</button></div>
    <div className="setting-row migration-entry"><span><strong>{t('settings.migrationEntry.label')}</strong><small>{t('settings.migrationEntry.hint')}</small></span><button className="button" type="button" onClick={onOpenMigration}>{t('settings.migrationEntry.action')}</button></div>
    <ToastStack status={toasts.notice} alert={toasts.error} onDismiss={toasts.dismiss} />
  </>;
}
