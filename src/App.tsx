import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Icon } from './components/Icon';
import type { IconName } from './components/Icon';
import brandIcon from '../src-tauri/icons/128x128@2x.png';
import { ConfirmationHost } from './components/ConfirmationHost';
import { EmptyState } from './components/EmptyState';
import { PageSkeleton } from './components/Skeleton';
import { PageHeader } from './components/PageHeader';
import { Tabs } from './components/Tabs';
import { ShortcutHelp } from './components/ShortcutHelp';
import { CommandPalette, type CommandItem } from './components/CommandPalette';
import { ToolIcon, ToolIconsContext } from './components/ToolIcon';
import { GeneralSettings } from './features/settings/GeneralSettings';
import { ManagedTools } from './features/home/ManagedTools';
import { ProjectLauncher } from './features/home/ProjectLauncher';
const LibraryPage = lazy(() => import('./features/library/LibraryPage').then((module) => ({ default: module.LibraryPage })));
const RecordsPage = lazy(() => import('./features/records/RecordsPage').then((module) => ({ default: module.RecordsPage })));
const MigrationSettings = lazy(() => import('./features/settings/MigrationSettings').then((module) => ({ default: module.MigrationSettings })));
const ToolWorkspacePage = lazy(() => import('./features/tools/ToolWorkspace').then((module) => ({ default: module.ToolWorkspacePage })));
import type { WorkspaceOpenIntent } from './features/tools/ToolWorkspace';
import { native, nativeAvailable } from './lib/native';
import { confirmAction } from './lib/confirm';
import { isEditableTarget, modAria, modLabel, withMod } from './lib/shortcut';
import { navigateChoices } from './lib/choiceNavigation';
import { browserBootstrap } from './types/domain';
import type { ApiError, Bootstrap, Theme } from './types/domain';
import type { Project, TrayRepairTarget } from './types/launch';
import type { AdapterCatalog } from './types/native';

type Page = 'home' | 'connections' | 'library' | 'records' | 'settings';
type SettingsTab = 'general' | 'migration';

const pages: { id: Page; glyph: IconName }[] = [
  { id: 'home', glyph: 'home' },
  { id: 'connections', glyph: 'connections' },
  { id: 'library', glyph: 'library' },
  { id: 'records', glyph: 'records' },
  { id: 'settings', glyph: 'settings' },
];

const themes: { id: Theme; glyph: IconName }[] = [
  { id: 'system', glyph: 'monitor' },
  { id: 'light', glyph: 'sun' },
  { id: 'dark', glyph: 'moon' },
];

export default function App() {
  const { t } = useTranslation();
  const [bootstrap, setBootstrap] = useState<Bootstrap>(() => browserBootstrap());
  const [catalog, setCatalog] = useState<AdapterCatalog | null>(null);
  const [loading, setLoading] = useState(nativeAvailable);
  const [loaded, setLoaded] = useState(!nativeAvailable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [page, setPage] = useState<Page>('home');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('cliora:sidebar-collapsed') === 'true'; } catch { return false; }
  });
  function toggleSidebar() {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    try { localStorage.setItem('cliora:sidebar-collapsed', String(next)); } catch { /* Layout remains usable without storage. */ }
  }
  const [visited, setVisited] = useState<Set<string>>(() => new Set(['home']));
  const [tool, setTool] = useState<string>('');
  const [toolOpenSequence, setToolOpenSequence] = useState(0);
  const [toolIntent, setToolIntent] = useState<WorkspaceOpenIntent | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteProjects, setPaletteProjects] = useState<Project[]>([]);
  const [spotlight, setSpotlight] = useState<{ id: string; token: number } | null>(null);
  const [trayRepair, setTrayRepair] = useState<TrayRepairTarget | null>(null);
  const activePage = useRef<Page>(page);
  activePage.current = page;
  const workspaceDirty = useRef(false);
  const pendingCatalog = useRef<AdapterCatalog | null>(null);
  const refreshSequence = useRef(0);
  const onWorkspaceDirtyChange = useCallback((dirty: boolean) => {
    workspaceDirty.current = dirty;
    if (!dirty && pendingCatalog.current) { setCatalog(pendingCatalog.current); pendingCatalog.current = null; }
  }, []);
  const [workspaceDiscard, setWorkspaceDiscard] = useState(0);
  const canLeave = useCallback(async (_next: Page) => {
    if (!workspaceDirty.current) return true;
    const accepted = await confirmAction(t('common.app.leaveDirtyMessage'), () => true, { title: t('common.app.leaveDirtyTitle'), confirmLabel: t('common.app.leaveDirtyConfirm') });
    if (accepted) setWorkspaceDiscard((value) => value + 1);
    return accepted;
  }, [t]);
  const section = page === 'settings' ? `${page}:${settingsTab}` : page;
  useEffect(() => { setVisited((old) => old.has(section) ? old : new Set([...old, section])); }, [section]);
  const hasVisited = (key: string) => section === key || visited.has(key);

  useEffect(() => {
    if (!nativeAvailable) return;
    void loadBootstrap();
  }, []);

  useEffect(() => {
    if (!paletteOpen || !nativeAvailable) return;
    let live = true;
    void native.listProjects().then((result) => { if (live && Array.isArray(result)) setPaletteProjects(result); }).catch(() => {});
    return () => { live = false; };
  }, [paletteOpen]);

  useEffect(() => {
    if (!nativeAvailable) return;
    let active = true;
    const stops: Array<() => void> = [];
    void listen<string>('cliora:tray-error', (event) => {
      if (active) setError({ code: 'tray_error', message: event.payload, action: t('common.app.trayErrorAction') });
    }).then((unlisten) => {
      if (active) stops.push(unlisten); else unlisten();
    }).catch(() => {});
    void listen('cliora:portable-changed', () => { if (active) void refreshAfterImport(); }).then((unlisten) => {
      if (active) stops.push(unlisten); else unlisten();
    }).catch(() => {});
    void listen<Omit<TrayRepairTarget, 'sequence'>>('cliora:tray-repair', (event) => {
      if (!active || !['home', 'connections', 'settings'].includes(event.payload.page)) return;
      void canLeave(event.payload.page).then((allowed) => {
        if (!active || !allowed) return;
        setTrayRepair((old) => ({ ...event.payload, sequence: (old?.sequence ?? 0) + 1 }));
        if (event.payload.page === 'settings') setSettingsTab('general');
        setPage(event.payload.page);
      });
    }).then((unlisten) => {
      if (active) stops.push(unlisten); else unlisten();
    }).catch(() => {});
    return () => { active = false; stops.forEach((stop) => stop()); };
  }, [canLeave]);

  async function loadBootstrap() {
    if (!nativeAvailable) return;
    setLoading(true);
    setError(null);
    try {
      const [loadedBootstrap, loadedCatalog] = await Promise.all([native.getBootstrap(), native.listCliAdapters()]);
      setBootstrap(loadedBootstrap);
      setCatalog(loadedCatalog);
      setLoaded(true);
    } catch (value) {
      setLoaded(false);
      setError(value as ApiError);
    } finally {
      setLoading(false);
    }
  }

  async function refreshAfterImport() {
    if (!nativeAvailable) return;
    const sequence = ++refreshSequence.current;
    try {
      const [nextBootstrap, nextCatalog] = await Promise.all([native.getBootstrap(), native.listCliAdapters()]);
      if (sequence !== refreshSequence.current) return;
      setBootstrap(nextBootstrap);
      if (workspaceDirty.current) {
        pendingCatalog.current = nextCatalog;
        setCatalog((current) => current ? { ...nextCatalog, managedIds: current.managedIds } : nextCatalog);
      } else { pendingCatalog.current = null; setCatalog(nextCatalog); }
    } catch (value) { setError(value as ApiError); }
  }

  useLayoutEffect(() => {
    const internals = (window as Window & { __TAURI_INTERNALS__?: { metadata?: unknown } }).__TAURI_INTERNALS__;
    if (!nativeAvailable || !internals?.metadata) return;
    if (/Mac/i.test(navigator.userAgent)) document.documentElement.dataset.native = 'macos';
  }, []);
  useEffect(() => {
    const mode = bootstrap.preferences.theme;
    const surface = { light: '#f6f5f2', dark: '#141615' } as const;
    const apply = () => {
      const resolved = mode === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode;
      document.documentElement.dataset.theme = resolved;
      if (!nativeAvailable) return;
      try {
        const appWindow = getCurrentWindow();
        void appWindow.setTheme(mode === 'system' ? null : mode).catch(() => {});
        void appWindow.setBackgroundColor(surface[resolved]).catch(() => {});
      } catch { void 0; }
    };
    apply();
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [bootstrap.preferences.theme]);

  const goRef = useRef<(next: Page) => void>(() => {});
  useEffect(() => {
    let pendingSearch = 0;
    const onKey = (event: KeyboardEvent) => {
      cancelAnimationFrame(pendingSearch);
      if (withMod(event) && event.key.toLowerCase() === 'k' && !event.repeat) {
        if (document.querySelector('dialog[open]')) return;
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (withMod(event) && event.key === '\\' && !event.repeat) {
        if (document.querySelector('dialog[open]') || isEditableTarget(event.target)) return;
        event.preventDefault();
        setSidebarCollapsed((value) => {
          const next = !value;
          try { localStorage.setItem('cliora:sidebar-collapsed', String(next)); } catch { /* Layout remains usable without storage. */ }
          return next;
        });
        return;
      }
      if (event.key === '?' && !withMod(event) && !event.altKey && !isEditableTarget(event.target)) {
        if (document.querySelector('dialog[open]')) return;
        event.preventDefault();
        setHelpOpen(true);
        return;
      }
      const findShortcut = withMod(event) && event.key.toLowerCase() === 'f';
      const slashShortcut = event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditableTarget(event.target);
      if (findShortcut || slashShortcut) {
        if (document.querySelector('dialog[open]')) return;
        const input = [...document.querySelectorAll<HTMLInputElement>('main input[data-page-search]')].find((item) => item.getClientRects().length);
        if (input) {
          event.preventDefault();
          input.focus();
          input.select();
        } else if (document.querySelector('main .skeleton-page') && ['library', 'records'].includes(activePage.current)) {
          event.preventDefault();
          const requestedPage = activePage.current;
          const deadline = performance.now() + 5000;
          const focusWhenLoaded = () => {
            if (activePage.current !== requestedPage || performance.now() > deadline || document.querySelector('dialog[open]') || isEditableTarget(document.activeElement)) return;
            const search = [...document.querySelectorAll<HTMLInputElement>('main input[data-page-search]')].find((item) => item.getClientRects().length);
            if (search) { search.focus(); search.select(); }
            else pendingSearch = requestAnimationFrame(focusWhenLoaded);
          };
          pendingSearch = requestAnimationFrame(focusWhenLoaded);
        }
        return;
      }
      if (!withMod(event)) return;
      const index = Number(event.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= pages.length || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      goRef.current(pages[index].id);
    };
    window.addEventListener('keydown', onKey);
    return () => { cancelAnimationFrame(pendingSearch); window.removeEventListener('keydown', onKey); };
  }, []);

  const managed: string[] = nativeAvailable ? catalog?.managedIds ?? [] : bootstrap.preferences.managed_tools;
  const visible = (nativeAvailable ? catalog?.registered ?? [] : bootstrap.tools).filter((item) => managed.includes(item.id));
  const visibleDescriptors = (catalog?.registered ?? []).filter((item) => managed.includes(item.id));
  const selectedTool = visible.some((item) => item.id === tool) ? tool : visible[0]?.id;
  const selectedToolName = visible.find((item) => item.id === selectedTool)?.name ?? selectedTool;
  const title: [string, string] = [t(`common.pages.${page}.title`), t(`common.pages.${page}.subtitle`)];

  async function go(next: Page) {
    if (!await canLeave(next)) return false;
    setPage(next);
    if (loaded) setError(null);
    document.querySelector('main')?.scrollTo({ top: 0 });
    requestAnimationFrame(() => document.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true }));
    return true;
  }
  goRef.current = go;

  async function revealProject(id: string) {
    if (await go('home')) setSpotlight({ id, token: Date.now() });
  }

  const commands: CommandItem[] = [
    ...pages.map((item, index) => ({ id: `page-${item.id}`, group: t('common.palette.groupPages'), label: t(`common.nav.${item.id}`), hint: `${modLabel}+${index + 1}`, keywords: item.id, icon: item.glyph, run: () => { void go(item.id); } })),
    ...visible.map((item) => ({ id: `tool-${item.id}`, group: t('common.palette.groupTools'), label: item.name, hint: t('common.palette.hintOpenConfig'), keywords: item.id, toolId: item.id, run: () => { setTool(item.id); setToolIntent(null); setToolOpenSequence((value) => value + 1); void go('connections'); } })),
    ...paletteProjects.map((project) => ({ id: `project-${project.id}`, group: t('common.palette.groupProjects'), label: project.name, hint: project.available ? t('common.palette.hintLocateProject') : t('common.palette.hintRebindProject'), keywords: project.path ?? '', icon: 'folder' as const, run: () => { void revealProject(project.id); } })),
    { id: 'sidebar', group: t('common.palette.groupActions'), label: sidebarCollapsed ? t('common.shell.sidebarExpand') : t('common.shell.sidebarCollapse'), hint: `${modLabel}+\\`, icon: sidebarCollapsed ? 'sidebarOpen' : 'sidebarClose', run: toggleSidebar },
    ...themes.map((item) => ({ id: `theme-${item.id}`, group: t('common.palette.groupActions'), label: t(`common.theme.${item.id}`), hint: bootstrap.preferences.theme === item.id ? t('common.theme.current') : t('common.theme.switch'), icon: item.glyph, run: () => { if (bootstrap.preferences.theme !== item.id) void updateTheme(item.id); } })),
    { id: 'help', group: t('common.palette.groupActions'), label: t('common.shortcuts.title'), hint: '?', icon: 'info', run: () => setHelpOpen(true) },
  ];

  async function updateManaged(id: string, checked: boolean) {
    if (!nativeAvailable || busy) return;
    const next = checked ? [...managed, id] : managed.filter((item) => item !== id);
    setBusy(true); setError(null);
    try { setCatalog(await native.setRegisteredManagedTools(next)); }
    catch (value) { setError(value as ApiError); }
    finally { setBusy(false); }
  }

  async function updateTheme(theme: Theme) {
    if (!nativeAvailable) { setBootstrap({ ...bootstrap, preferences: { ...bootstrap.preferences, theme } }); return; }
    if (busy) return;
    setBusy(true); setError(null);
    try { setBootstrap(await native.setTheme(theme)); }
    catch (value) { setError(value as ApiError); }
    finally { setBusy(false); }
  }

  async function updateIcon(toolId: string, dataUrl: string | null) {
    if (!nativeAvailable || busy) return;
    setBusy(true); setError(null);
    try { setBootstrap(await native.setToolIcon(toolId, dataUrl)); }
    catch (value) { setError(value as ApiError); throw value; }
    finally { setBusy(false); }
  }

  return <ToolIconsContext value={bootstrap.preferences.tool_icons ?? {}}><div className="titlebar-drag" data-tauri-drag-region /><div className="shell" data-sidebar-collapsed={sidebarCollapsed}>
    <aside className="sidebar" aria-label={t('common.nav.mainLabel')}>
      <div className="brand"><img className="brandmark" src={brandIcon} alt="" /><span className="brand-name"><strong>{t('common.shell.brand')}</strong><small>CLIORA</small></span><button type="button" className="sidebar-toggle" aria-label={sidebarCollapsed ? t('common.shell.sidebarExpand') : t('common.shell.sidebarCollapse')} title={sidebarCollapsed ? t('common.shell.sidebarExpand') : t('common.shell.sidebarCollapse')} aria-expanded={!sidebarCollapsed} aria-controls="main-navigation" onClick={toggleSidebar}><Icon name={sidebarCollapsed ? 'sidebarOpen' : 'sidebarClose'} size={17} /></button></div>
      <nav className="nav" id="main-navigation" aria-label={t('common.nav.label')}>
        {pages.map((item, index) => { const label = t(`common.nav.${item.id}`); return <button key={item.id} type="button" className={page === item.id ? 'active' : ''} aria-label={label} aria-current={page === item.id ? 'page' : undefined} aria-keyshortcuts={`${modAria}+${index + 1}`} title={t('common.nav.itemTitle', { label, shortcut: `${modLabel}+${index + 1}` })} onClick={() => go(item.id)}>
          <span className="nav-glyph" aria-hidden="true"><Icon name={item.glyph} /></span><span className="nav-text">{label}</span>
        </button>; })}
      </nav>
      <div className="sidebar-foot">
        <div className="theme-switch" role="group" aria-label={t('common.theme.switch')}>{themes.map((item) => { const label = t(`common.theme.${item.id}`); return <button key={item.id} type="button" aria-label={label} title={label} aria-pressed={bootstrap.preferences.theme === item.id} disabled={busy} onClick={() => { if (bootstrap.preferences.theme !== item.id) void updateTheme(item.id); }}><Icon name={item.glyph} size={14} /></button>; })}</div>
        <div className="sidebar-status" title={nativeAvailable ? t('common.shell.statusLocalTitle') : t('common.shell.statusPreviewTitle')}><span className="status-dot" data-tone={nativeAvailable ? undefined : 'preview'} /><span className="status-text" data-short={nativeAvailable ? t('common.shell.statusLocalShort') : t('common.shell.statusPreviewShort')}>{nativeAvailable ? t('common.shell.statusLocal') : t('common.shell.statusPreview')}</span></div>
      </div>
    </aside>
    <main className={`content${page === 'records' ? ' content-locked' : ''}`} id="main"><div className="content-inner">
      {!nativeAvailable && <div className="environment-banner" role="status"><span className="banner-icon"><Icon name="info" size={16} /></span><span>{t('common.shell.previewBanner')}</span></div>}
      {error && <div className="error-banner" role="alert"><span className="banner-icon"><Icon name="alert" size={16} /></span><div className="error-copy"><strong>{error.message}</strong><span>{error.action}</span>{error.data_directory && <code>{error.data_directory}</code>}</div>{loaded && <button type="button" onClick={() => setError(null)} aria-label={t('common.dismissError')}><Icon name="close" size={14} /></button>}</div>}
      <PageHeader title={title[0]} subtitle={title[1]} compact={page === 'records'} />
      {loading ? <PageSkeleton /> : !loaded ? <EmptyState icon="alert" title={t('common.shell.loadFailedTitle')} detail={t('common.shell.loadFailedDetail')} action={<button className="button primary" type="button" onClick={loadBootstrap}>{t('common.shell.loadFailedRetry')}</button>} /> : <>
        {page === 'home' && <div className="home-band">
          <section className="home-tools">
            <div className="section-heading"><h2>{t('home.managed.title')}<span className="count-chip" aria-hidden="true">{visible.length}</span></h2><button className="text-button" type="button" onClick={() => go('settings')}>{t('home.managed.adjust')} <span aria-hidden="true">→</span></button></div>
            {visible.length ? nativeAvailable ? <ManagedTools tools={visibleDescriptors} onOpenTool={(id, intent) => { setTool(id); setToolIntent(intent ?? null); setToolOpenSequence((value) => value + 1); void go('connections'); }} /> : <div className="tool-table"><div className="table-head"><span>{t('home.preview.tool')}</span><span>{t('home.preview.state')}</span><span>{t('home.preview.actions')}</span></div>{visible.map((item) => <div className="tool-row" key={item.id}><div className="tool-identity"><span className="tool-icon" aria-hidden="true"><ToolIcon toolId={item.id} /></span><strong>{item.name}</strong></div><div className="tool-state">{t('home.preview.unchecked')}</div><button className="button" type="button" onClick={() => { setTool(item.id); go('connections'); }}>{t('home.preview.open')} <span aria-hidden="true">→</span></button></div>)}</div> : <EmptyState title={t('home.empty.title')} detail={t('home.empty.detail')} action={<button className="button primary" type="button" onClick={() => go('settings')}>{t('common.goSettings')}</button>} />}
          </section>
          {nativeAvailable ? <ProjectLauncher tools={visibleDescriptors} repair={trayRepair?.page === 'home' ? trayRepair : null} spotlight={page === 'home' ? spotlight : null} /> : <section className="home-secondary"><div className="section-heading"><h2>{t('home.projects.title')}</h2></div><div className="subtle-panel"><span className="empty-symbol" aria-hidden="true"><Icon name="folder" size={20} /></span><strong>{t('home.projects.panelTitle')}</strong><p>{t('home.projects.panelDetail')}</p></div></section>}
        </div>}
        {(page === 'connections' || hasVisited('connections')) && <div hidden={page !== 'connections'}>
          {selectedTool ? nativeAvailable ? <Suspense fallback={<PageSkeleton />}><ToolWorkspacePage managedTools={visibleDescriptors} initialTool={selectedTool} openSequence={toolOpenSequence} openIntent={toolIntent} active={page === 'connections'} repair={trayRepair?.page === 'connections' ? trayRepair : null} onDirtyChange={onWorkspaceDirtyChange} discardSignal={workspaceDiscard} /></Suspense> : <><div className="tool-tabs" role="tablist" aria-label={t('tools.preview.tabsLabel')} onKeyDown={navigateChoices}>{visible.map((item) => <button key={item.id} type="button" role="tab" aria-selected={selectedTool === item.id} tabIndex={selectedTool === item.id ? 0 : -1} className={selectedTool === item.id ? 'active' : ''} onClick={() => setTool(item.id)}>{item.name}</button>)}</div><EmptyState title={t('tools.preview.configTitle', { name: selectedToolName })} detail={t('tools.preview.emptyDetail')} /></> : <EmptyState title={t('tools.empty.title')} detail={t('tools.empty.detail')} action={<button className="button primary" type="button" onClick={() => go('settings')}>{t('common.goSettings')}</button>} />}
        </div>}
        <div hidden={page !== 'library'}>{hasVisited('library') && <Suspense fallback={<PageSkeleton />}><LibraryPage managedTools={visibleDescriptors} active={page === 'library'} /></Suspense>}</div>
        <div className="records-shell" hidden={page !== 'records'}>{hasVisited('records') && <Suspense fallback={<PageSkeleton />}><RecordsPage active={page === 'records'} tools={visibleDescriptors} onOpenProjects={() => go('home')} /></Suspense>}</div>
        {page === 'settings' && <Tabs label={t('settings.tabs.label')} items={[['general', t('settings.tabs.general')], ['migration', t('settings.tabs.migration')]]} value={settingsTab} onChange={setSettingsTab} />}
        {page === 'settings' && settingsTab === 'general' && <GeneralSettings
          tools={nativeAvailable ? catalog?.registered ?? [] : bootstrap.tools}
          managed={managed}
          preservedUnknown={catalog?.preservedUnknown ?? []}
          icons={bootstrap.preferences.tool_icons ?? {}}
          busy={busy}
          theme={bootstrap.preferences.theme}
          onThemeChange={(next) => void updateTheme(next)}
          onManagedChange={(id, checked) => void updateManaged(id, checked)}
          onIconChange={updateIcon}
          onIconError={(message) => setError({ code: 'icon_error', message, action: t('settings.icons.repick') })}
          onOpenMigration={() => setSettingsTab('migration')}
          onOpenShortcutHelp={() => setHelpOpen(true)}
        />}
        <div hidden={page !== 'settings' || settingsTab !== 'migration'}>{hasVisited('settings:migration') && <Suspense fallback={<PageSkeleton />}><MigrationSettings active={page === 'settings' && settingsTab === 'migration'} onImported={() => void refreshAfterImport()} /></Suspense>}</div>
      </>}
    </div></main>
  </div><CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} /><ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} /><ConfirmationHost /></ToolIconsContext>;
}
