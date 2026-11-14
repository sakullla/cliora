import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Segmented } from '../../components/ui';
import { getVersion } from '@tauri-apps/api/app';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { Icon } from '../../components/Icon';
import type { IconName } from '../../components/Icon';
import { SearchField } from '../../components/SearchField';
import { ToolIcon } from '../../components/ToolIcon';
import { ToastStack } from '../../components/Toast';
import { ToolIconSettings } from './ToolIconSettings';
import { TraySettings } from './TerminalSettings';
import { native, nativeAvailable } from '../../lib/native';
import { searchShortcutHint } from '../../lib/shortcut';
import { useToasts } from '../../lib/toast';
import { setUpdateOffer, useUpdateOffer, type UpdateOffer } from '../../lib/appUpdate';
import brandIcon from '../../../src-tauri/icons/128x128@2x.png';
import { setLanguage, supportedLanguages, type AppLanguage } from '../../i18n';
import type { Theme } from '../../types/domain';
import { RemoteHosts } from './RemoteHosts';
import styles from './GeneralSettings.module.css';

type ToolItem = { id: string; name: string };

/** The write a row started, so its result can be read from the preferences handed back. */
type PendingSave =
  | { kind: 'theme'; value: Theme; target: string; text: string }
  | { kind: 'managed'; id: string; value: boolean; target: string; text: string };

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
      setFailure(error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error));
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
      await update.download((event) => {
        if (event.event === 'Started') {
          setProgress({ downloaded: 0, total: event.data.contentLength ?? null });
        } else if (event.event === 'Progress') {
          setProgress((current) => ({ ...current, downloaded: current.downloaded + event.data.chunkLength }));
        }
      });
      // Windows installs exit the process directly, bypassing ExitRequested.
      // Checkpoint after the download, immediately before invoking the installer.
      await native.checkpointWorkbenchSessions();
      await update.install();
      setStage('installed');
      try {
        await relaunch();
      } catch { /* 重启失败时保留“已安装”提示，用户手动重新打开即可。 */ }
    } catch (error) {
      setFailure(error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error));
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
        <h2>{t('settings.update.title')}{version && <Badge className={styles.updateVersion} title={t('settings.update.current')}>{t('settings.update.currentShort', { version })}</Badge>}</h2>
        <small role={stage === 'failed' ? 'alert' : 'status'} className={stage === 'failed' ? styles.updateError : undefined}>{statusText}</small>
        {checkedAt && stage === 'latest' && <small className={styles.updateMeta}>{t('settings.update.checkedAt', { time: checkedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}</small>}
      </span>
      <span className={styles.updateActions}>
        {stage === 'available' && offer
          ? <Button variant="primary" disabled={busy} icon={<Icon name="download" size={14} />} onClick={handleInstall}>{t('settings.update.install')}</Button>
          : stage === 'checking'
            ? <Button loading>{t('settings.update.checking')}</Button>
            : <Button disabled={busy || stage === 'downloading' || stage === 'installed'} icon={<Icon name="refresh" size={14} />} onClick={handleCheck}>{t('settings.update.check')}</Button>}
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
  return <Segmented label={t('settings.theme.label')} value={value} onChange={onChange}
    options={themeOrder.map((id) => ({ value: id, disabled, label: <><Icon name={themeGlyphs[id]} size={16} />{t(`settings.theme.${id}`)}</> }))} />;
}

function LanguageChoice({ value, disabled }: { value: AppLanguage; disabled: boolean }) {
  const { t } = useTranslation();
  return <Segmented label={t('settings.language.label')} value={value} onChange={(language) => { if (language !== value) setLanguage(language); }}
    options={supportedLanguages.map((id) => ({ value: id, disabled, label: t(`common.language.${id}`) }))} />;
}

export function RemoteSshSettings({ enabled, busy, onChange, showHosts = true, showToggle = true, onOpenHosts }: { enabled: boolean; busy: boolean; onChange: (enabled: boolean) => void; showHosts?: boolean; showToggle?: boolean; onOpenHosts?: () => void }) {
  const { t } = useTranslation();
  // Host management on its own (settings tab, workbench dialog): just the host list.
  if (showHosts && !showToggle) return enabled ? <RemoteHosts /> : null;
  const toggle = <section className="settings-group" id={showHosts ? 'settings-remote' : 'remote-ssh-settings'}>
    <div className="setting-intro"><h2>{t('settings.remoteSsh.title')}</h2><p>{t('settings.remoteSsh.description')}</p></div>
    {showToggle && <label className="setting-row"><span><strong>{t('settings.remoteSsh.enable')}</strong><small>{t('settings.remoteSsh.enableHint')}</small></span><input type="checkbox" role="switch" checked={enabled} disabled={busy} onChange={(event) => onChange(event.target.checked)} /></label>}
    {enabled && !showHosts && <div className="setting-row"><span><strong>{t('settings.remoteSsh.manageHosts')}</strong><small>{t('settings.remoteSsh.manageHostsHint')}</small></span><Button icon={<Icon name="server" size={14} />} onClick={onOpenHosts}>{t('settings.remoteSsh.openHosts')}</Button></div>}
  </section>;
  // The host list is its own panel below the switch, never a card nested inside it.
  return showHosts ? <div className={styles.stack}>{toggle}{enabled && <RemoteHosts />}</div> : toggle;
}

/** Settings → General (appearance, updates, tray, help) or Settings → CLI tools, by `pane`. */
export function GeneralSettings({ pane, tools, managed, preservedUnknown, icons, busy, theme, onThemeChange, onManagedChange, onIconChange, onIconError, onOpenShortcutHelp, onReopenOnboarding }: {
  pane: 'general' | 'tools';
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
  onOpenShortcutHelp: () => void;
  onReopenOnboarding: () => void;
}) {
  const { t, i18n } = useTranslation();
  const toasts = useToasts();
  const language: AppLanguage = i18n.language === 'en' ? 'en' : 'zh';
  const catalogKey = tools.map((item) => item.id).join('\0');
  const managedKey = managed.join('\0');
  const [managedExpanded, setManagedExpanded] = useState(false);
  const [toolQuery, setToolQuery] = useState('');
  const [managedPreview, setManagedPreview] = useState(() => orderedManagedTools(tools, managed).slice(0, MANAGED_PREVIEW).map((item) => item.id));
  // Refresh the collapsed set when the catalog changes or the list is folded again, so a toggle does not move the chip just clicked.
  useEffect(() => {
    if (!managedExpanded) setManagedPreview(orderedManagedTools(tools, managed).slice(0, MANAGED_PREVIEW).map((item) => item.id));
  }, [catalogKey, managedExpanded]);
  const managedById = new Map(tools.map((item) => [item.id, item]));
  const toolNeedle = toolQuery.trim().toLowerCase();
  const managedShown = toolNeedle
    ? orderedManagedTools(tools, managed).filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(toolNeedle))
    : managedExpanded || tools.length <= MANAGED_PREVIEW
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
  // A write is confirmed only when the preference handed back by bootstrap matches
  // what was requested; a rejected write leaves the old value and the page error bar.
  const pendingSave = useRef<PendingSave | null>(null);
  const [saved, setSaved] = useState<{ target: string; text: string } | null>(null);
  useEffect(() => {
    const waiting = pendingSave.current;
    if (!waiting) return;
    const landed = waiting.kind === 'theme' ? theme === waiting.value : managed.includes(waiting.id) === waiting.value;
    if (landed) {
      pendingSave.current = null;
      setSaved({ target: waiting.target, text: waiting.text });
    } else if (!busy) {
      pendingSave.current = null;
    }
  }, [theme, catalogKey, managedKey, busy]);
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(null), 4000);
    return () => window.clearTimeout(timer);
  }, [saved]);
  function chooseTheme(next: Theme) {
    if (next === theme) return;
    // Browser preview has no native store; it may switch the view, never claim a write.
    if (!nativeAvailable) { setSaved(null); onThemeChange(next); return; }
    pendingSave.current = { kind: 'theme', value: next, target: 'settings-interface', text: t('settings.saved.theme') };
    setSaved(null);
    onThemeChange(next);
  }
  function chooseManaged(id: string, checked: boolean) {
    const item = tools.find((candidate) => candidate.id === id);
    pendingSave.current = { kind: 'managed', id, value: checked, target: 'settings-managed', text: t('settings.saved.managed', { name: item?.name ?? id }) };
    setSaved(null);
    onManagedChange(id, checked);
  }
  const ack = (target: string) => saved?.target === target
    ? <span className={styles.saved} role="status"><Icon name="check" size={13} />{saved.text}</span>
    : null;
  if (pane === 'tools') return <div className={styles.stack}>
    <section className="settings-group" id="settings-managed">
      <div className="setting-intro"><h2>{t('settings.managed.title')}{tools.length > 0 && <Badge className="heading-count">{t('settings.managed.enabledCount', { enabled: tools.filter((item) => managed.includes(item.id)).length, total: tools.length })}</Badge>}</h2><p>{t('settings.managed.description')}</p>{ack('settings-managed')}</div>
      {(tools.length > MANAGED_PREVIEW || !!toolNeedle) && <div className="managed-search"><SearchField type="search" pageSearch title={searchShortcutHint()} label={t('settings.managed.searchLabel')} placeholder={t('settings.managed.searchPlaceholder')} value={toolQuery} onChange={setToolQuery} /></div>}
      {managedShown.length > 0 ? <div className="managed-checks">{managedShown.map((item) => <label key={item.id}><ToolIcon toolId={item.id} size={22} /><span title={item.name}>{item.name}</span><input type="checkbox" checked={managed.includes(item.id)} disabled={!nativeAvailable || busy} onChange={(event) => chooseManaged(item.id, event.target.checked)} /></label>)}</div>
        : !!toolNeedle && <div className="managed-empty"><p>{t('settings.managed.noMatch', { query: toolQuery.trim() })}</p><Button size="sm" variant="ghost" onClick={() => setToolQuery('')}>{t('common.search.clear')}</Button></div>}
      {!toolNeedle && tools.length > MANAGED_PREVIEW && <div className="managed-more"><button type="button" aria-expanded={managedExpanded} onClick={() => setManagedExpanded((value) => !value)}>{managedExpanded ? t('settings.managed.less') : t('settings.managed.more', { count: managedHidden })}<Icon name="arrowDown" size={14} /></button></div>}
      <ToolIconSettings tools={tools} icons={icons} busy={busy} onChange={handleIconChange} onError={onIconError} />
      {preservedUnknown.map((item) => <div className="setting-row" key={item.id}><span><strong>{item.id}</strong><small>{t('settings.managed.preservedUnknown', { count: item.profileCount })}</small></span></div>)}
    </section>
    <ToastStack status={toasts.notice} alert={toasts.error} onDismiss={toasts.dismiss} />
  </div>;
  return <div className={styles.stack}>
    <section className="settings-group" id="settings-interface">
      <div className="setting-intro"><h2>{t('settings.interface.title')}</h2><p>{t('settings.interface.description')}</p>{ack('settings-interface')}</div>
      <div className="setting-row"><span><strong>{t('settings.theme.label')}</strong><small>{t('settings.theme.hint')}</small></span><ThemeChoice value={theme} disabled={busy} onChange={chooseTheme} /></div>
      <div className="setting-row"><span><strong>{t('settings.language.label')}</strong><small>{t('settings.language.hint')}</small></span><LanguageChoice value={language} disabled={busy} /></div>
    </section>
    {nativeAvailable && <UpdateSettings busy={busy} />}
    {nativeAvailable && <TraySettings />}
    <section className="settings-group" id="settings-other">
      <div className="setting-intro"><h2>{t('settings.sections.other')}</h2></div>
      <div className="setting-row"><span><strong>{t('settings.shortcuts.label')}</strong><small>{t('settings.shortcuts.hint')}</small></span><Button aria-label={t('settings.shortcuts.label')} onClick={onOpenShortcutHelp}>{t('settings.shortcuts.action')}</Button></div>
      <div className="setting-row"><span><strong>{t('settings.onboarding.label')}</strong><small>{t('settings.onboarding.hint')}</small></span><Button onClick={onReopenOnboarding}>{t('settings.onboarding.action')}</Button></div>
    </section>
    <ToastStack status={toasts.notice} alert={toasts.error} onDismiss={toasts.dismiss} />
  </div>;
}

