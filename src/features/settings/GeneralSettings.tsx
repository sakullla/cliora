import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, Segmented } from '../../components/ui';
import { getVersion } from '@tauri-apps/api/app';
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
import { setUpdateOffer, useUpdateOffer, type UpdateOffer } from '../../lib/appUpdate';
import brandIcon from '../../../src-tauri/icons/128x128@2x.png';
import { setLanguage, supportedLanguages, type AppLanguage } from '../../i18n';
import type { Theme } from '../../types/domain';
import { RemoteHosts } from './RemoteHosts';
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
  return <section className="settings-group" id={showHosts ? undefined : 'remote-ssh-settings'}>
    <div className="setting-intro"><h2>{t('settings.remoteSsh.title')}</h2><p>{t('settings.remoteSsh.description')}</p></div>
    {showToggle && <label className="setting-row"><span><strong>{t('settings.remoteSsh.enable')}</strong><small>{t('settings.remoteSsh.enableHint')}</small></span><input type="checkbox" role="switch" checked={enabled} disabled={busy} onChange={(event) => onChange(event.target.checked)} /></label>}
    {enabled && !showHosts && <div className="setting-row"><span><strong>{t('settings.remoteSsh.manageHosts')}</strong><small>{t('settings.remoteSsh.manageHostsHint')}</small></span><Button icon={<Icon name="server" size={14} />} onClick={onOpenHosts}>{t('settings.remoteSsh.openHosts')}</Button></div>}
    {enabled && showHosts && <div className="setting-row-block"><RemoteHosts /></div>}
  </section>;
}

export function GeneralSettings({ tools, managed, preservedUnknown, icons, busy, theme, onThemeChange, onManagedChange, onIconChange, onIconError, onOpenMigration, onOpenShortcutHelp, onReopenOnboarding, onOpenHosts, remoteSshEnabled, onRemoteSshChange }: {
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
  onOpenHosts: () => void;
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
  return <div className={styles.general}>
    <SectionAnchors items={[
      { id: 'settings-managed', label: t('settings.managed.title') },
      { id: 'settings-interface', label: t('settings.interface.title') },
      ...(nativeAvailable ? [
        { id: 'app-update', label: t('settings.update.title') },
        { id: 'settings-terminal', label: t('settings.terminal.title') },
        { id: 'remote-ssh-settings', label: t('settings.remoteSsh.title') },
      ] : []),
      { id: 'settings-other', label: t('settings.sections.other') },
    ]} />
    <div className={styles.sections}>
    <section className="settings-group" id="settings-managed">
      <div className="setting-intro"><h2>{t('settings.managed.title')}</h2><p>{t('settings.managed.description')}</p></div>
      <div className="managed-checks">{managedShown.map((item) => <label key={item.id}><ToolIcon toolId={item.id} size={22} /><span title={item.name}>{item.name}</span><input type="checkbox" checked={managed.includes(item.id)} disabled={!nativeAvailable || busy} onChange={(event) => onManagedChange(item.id, event.target.checked)} /></label>)}</div>
      {tools.length > MANAGED_PREVIEW && <div className="managed-more"><button type="button" aria-expanded={managedExpanded} onClick={() => setManagedExpanded((value) => !value)}>{managedExpanded ? t('settings.managed.less') : t('settings.managed.more', { count: managedHidden })}<Icon name="arrowDown" size={14} /></button></div>}
      <ToolIconSettings tools={tools} icons={icons} busy={busy} onChange={handleIconChange} onError={onIconError} />
      {preservedUnknown.map((item) => <div className="setting-row" key={item.id}><span><strong>{item.id}</strong><small>{t('settings.managed.preservedUnknown', { count: item.profileCount })}</small></span></div>)}
    </section>
    <section className="settings-group" id="settings-interface">
      <div className="setting-intro"><h2>{t('settings.interface.title')}</h2><p>{t('settings.interface.description')}</p></div>
      <div className="setting-row"><span><strong>{t('settings.theme.label')}</strong><small>{t('settings.theme.hint')}</small></span><ThemeChoice value={theme} disabled={busy} onChange={(next) => { if (next !== theme) onThemeChange(next); }} /></div>
      <div className="setting-row"><span><strong>{t('settings.language.label')}</strong><small>{t('settings.language.hint')}</small></span><LanguageChoice value={language} disabled={busy} /></div>
    </section>
    {nativeAvailable && <UpdateSettings busy={busy} />}
    {nativeAvailable && <TerminalSettings />}
    {nativeAvailable && <RemoteSshSettings enabled={remoteSshEnabled} busy={busy} onChange={onRemoteSshChange} showHosts={false} onOpenHosts={onOpenHosts} />}
    <section className="settings-group" id="settings-other">
      <div className="setting-intro"><h2>{t('settings.sections.other')}</h2></div>
      <div className="setting-row"><span><strong>{t('settings.shortcuts.label')}</strong><small>{t('settings.shortcuts.hint')}</small></span><Button aria-label={t('settings.shortcuts.label')} onClick={onOpenShortcutHelp}>{t('settings.shortcuts.action')}</Button></div>
      <div className="setting-row"><span><strong>{t('settings.migrationEntry.label')}</strong><small>{t('settings.migrationEntry.hint')}</small></span><Button onClick={onOpenMigration}>{t('settings.migrationEntry.action')}</Button></div>
      <div className="setting-row"><span><strong>{t('settings.onboarding.label')}</strong><small>{t('settings.onboarding.hint')}</small></span><Button onClick={onReopenOnboarding}>{t('settings.onboarding.action')}</Button></div>
    </section>
    </div>
    <ToastStack status={toasts.notice} alert={toasts.error} onDismiss={toasts.dismiss} />
  </div>;
}

/** The General tab's table of contents: one link per settings group, shown beside them from 900px. */
function SectionAnchors({ items }: { items: { id: string; label: string }[] }) {
  const { t } = useTranslation();
  const [active, setActive] = useState(items[0]?.id ?? '');
  // A chosen link stays current until the reader scrolls on their own; the last sections may never reach the top.
  const pinned = useRef(false);
  const key = items.map((item) => item.id).join(' ');
  useEffect(() => {
    const release = () => { pinned.current = false; };
    window.addEventListener('wheel', release, { passive: true });
    window.addEventListener('touchstart', release, { passive: true });
    window.addEventListener('keydown', release);
    return () => {
      window.removeEventListener('wheel', release);
      window.removeEventListener('touchstart', release);
      window.removeEventListener('keydown', release);
    };
  }, []);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const visible = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id); else visible.delete(entry.target.id);
      }
      const first = items.find((item) => visible.has(item.id));
      if (first && !pinned.current) setActive(first.id);
    }, { rootMargin: '0px 0px -55% 0px' });
    for (const item of items) {
      const element = document.getElementById(item.id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [key]);
  function jump(event: MouseEvent<HTMLAnchorElement>, id: string) {
    const target = document.getElementById(id);
    if (!target) return;
    event.preventDefault();
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    pinned.current = true;
    setActive(id);
  }
  return <nav className={styles.anchors} aria-label={t('settings.sections.label')}>
    <p className={styles.anchorsTitle} aria-hidden="true">{t('settings.sections.label')}</p>
    <ul>{items.map((item) => <li key={item.id}><a href={`#${item.id}`} aria-current={active === item.id ? 'true' : undefined} onClick={(event) => jump(event, item.id)}>{item.label}</a></li>)}</ul>
  </nav>;
}
