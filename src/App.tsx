import { Fragment, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Icon } from './components/Icon';
import type { IconName } from './components/Icon';
import brandIcon from '../src-tauri/icons/128x128@2x.png';
import { useUpdateOffer } from './lib/appUpdate';
import { ConfirmationHost } from './components/ConfirmationHost';
import { EmptyState } from './components/EmptyState';
import { PageSkeleton } from './components/Skeleton';
import { PageHeader } from './components/PageHeader';
import { Tabs } from './components/Tabs';
import { ShortcutHelp } from './components/ShortcutHelp';
import { CommandPalette, type CommandItem } from './components/CommandPalette';
import { ToolIcon, ToolIconsContext } from './components/ToolIcon';
import { HostSwitcher } from './components/HostSwitcher';
import { GeneralSettings, RemoteSshSettings } from './features/settings/GeneralSettings';
import { ManagedTools } from './features/home/ManagedTools';
import { ProjectLauncher } from './features/home/ProjectLauncher';
import { OnboardingCard } from './features/home/OnboardingCard';
import { ONBOARDING_LAUNCHED_EVENT, completeOnboarding, readOnboardingComplete, readOnboardingLaunched, reopenOnboarding } from './lib/onboarding';
const LibraryPage = lazy(() => import('./features/library/LibraryPage').then((module) => ({ default: module.LibraryPage })));
const RecordsPage = lazy(() => import('./features/records/RecordsPage').then((module) => ({ default: module.RecordsPage })));
const MigrationSettings = lazy(() => import('./features/settings/MigrationSettings').then((module) => ({ default: module.MigrationSettings })));
const ToolWorkspacePage = lazy(() => import('./features/tools/ToolWorkspace').then((module) => ({ default: module.ToolWorkspacePage })));
import type { WorkspaceOpenIntent } from './features/tools/ToolWorkspace';
import type { LibraryMcpSpotlight } from './features/library/LibraryPage';
import { SessionWorkbench, failedInWorkbench, workbenchSessionId, type WorkbenchFailure } from './features/sessions/SessionWorkbench';
import sessionStyles from './features/sessions/SessionWorkbench.module.css';
import { applyStoredLanguage, readStoredLanguage } from './i18n';
import { native, nativeAvailable } from './lib/native';
import { formatFailure, launchFailureDetail } from './lib/feedback';
import { confirmAction } from './lib/confirm';
import { isEditableTarget, modAria, modLabel, withMod } from './lib/shortcut';
import { navigateList } from './lib/choiceNavigation';
import { browserBootstrap } from './types/domain';
import type { ApiError, Bootstrap, Theme } from './types/domain';
import type { HistorySession } from './types/history';
import type { Project, TrayRepairTarget } from './types/launch';
import type { LibraryItem, LibraryKind } from './types/library';
import type { AdapterCatalog } from './types/native';
import type { RemoteTarget } from './types/remote';

type Page = 'home' | 'sessions' | 'connections' | 'library' | 'records' | 'settings';
type SettingsTab = 'general' | 'hosts' | 'migration';
/** Cross-page locate requests; `target` keeps one spotlight pipeline for every destination. */
type Spotlight =
  | { target: 'project'; id: string; token: number }
  | { target: 'library'; kind: LibraryKind; id: string; token: number }
  | ({ target: 'mcp' } & LibraryMcpSpotlight);

const pages: { id: Page; glyph: IconName }[] = [
  { id: 'home', glyph: 'home' },
  { id: 'sessions', glyph: 'terminal' },
  { id: 'connections', glyph: 'connections' },
  { id: 'library', glyph: 'library' },
  { id: 'records', glyph: 'records' },
  { id: 'settings', glyph: 'settings' },
];

const navGroups: { label: string; pages: Page[] }[] = [
  { label: 'workspace', pages: ['home', 'sessions'] },
  { label: 'tools', pages: ['connections', 'library', 'records'] },
  { label: 'settingsGroup', pages: ['settings'] },
];

const themes: { id: Theme; glyph: IconName }[] = [
  { id: 'system', glyph: 'monitor' },
  { id: 'light', glyph: 'sun' },
  { id: 'dark', glyph: 'moon' },
];

/** Managed CLIs listed under 工具与连接 before the rest folds into “更多”. */
const sidebarToolLimit = 8;
const sidebarToolsExpandedKey = 'cliora:sidebar-tools-expanded';

/** Sidebar sub-navigation for the managed CLIs: one Tab stop, ↑/↓/Home/End move, Enter/Space open. */
function SidebarTools({ tools, current, active, onOpen }: { tools: Array<{ id: string; name: string }>; current?: string; active: boolean; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(() => { try { return localStorage.getItem(sidebarToolsExpandedKey) === 'true'; } catch { return false; } });
  if (!tools.length) return null;
  const overflow = tools.length > sidebarToolLimit;
  let shown = tools;
  if (overflow && !expanded) {
    shown = tools.slice(0, sidebarToolLimit);
    // The selected CLI always stays visible: it takes the last visible slot.
    const selected = tools.find((item) => item.id === current);
    if (selected && !shown.includes(selected)) shown = [...shown.slice(0, sidebarToolLimit - 1), selected];
  }
  const stop = shown.some((item) => item.id === current) ? current : shown[0]?.id;
  const toggle = () => setExpanded((old) => {
    try { localStorage.setItem(sidebarToolsExpandedKey, String(!old)); } catch { /* Folding works without storage. */ }
    return !old;
  });
  const moreLabel = expanded ? t('common.nav.toolsLess') : t('common.nav.toolsMore', { count: tools.length - sidebarToolLimit });
  return <div className="nav-tools" role="group" aria-label={t('common.nav.toolList')} onKeyDown={navigateList}>
    {shown.map((item) => {
      const selected = item.id === current;
      return <button type="button" key={item.id} className="nav-tool" data-selected={selected || undefined} aria-current={active && selected ? 'true' : undefined} tabIndex={item.id === stop ? 0 : -1} aria-label={item.name} title={item.name} onClick={() => onOpen(item.id)}><span className="nav-tool-icon" aria-hidden="true"><ToolIcon toolId={item.id} size={18} /></span><span className="nav-text">{item.name}</span></button>;
    })}
    {overflow && <button type="button" className="nav-tool nav-tool-more" tabIndex={-1} aria-expanded={expanded} aria-label={moreLabel} title={moreLabel} onClick={toggle}><span className="nav-tool-icon" aria-hidden="true"><Icon name={expanded ? 'arrowUp' : 'more'} size={14} /></span><span className="nav-text">{moreLabel}</span></button>}
  </div>;
}

export default function App() {
  const { t } = useTranslation();
  const [bootstrap, setBootstrap] = useState<Bootstrap>(() => browserBootstrap());
  const [catalog, setCatalog] = useState<AdapterCatalog | null>(null);
  const [loading, setLoading] = useState(nativeAvailable);
  const [loaded, setLoaded] = useState(!nativeAvailable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [page, setPage] = useState<Page>('home');
  // The workbench already has its own session rail, so the app navigation keeps a separate
  // collapsed state there (icon rail by default) and the full sidebar elsewhere.
  const [navCollapsed, setNavCollapsed] = useState(() => {
    const read = (key: string, fallback: boolean) => {
      try { const value = localStorage.getItem(key); return value === null ? fallback : value === 'true'; } catch { return fallback; }
    };
    return { pages: read('cliora:sidebar-collapsed', false), workbench: read('cliora:sidebar-collapsed-workbench', true) };
  });
  const navContext: 'workbench' | 'pages' = page === 'sessions' ? 'workbench' : 'pages';
  const sidebarCollapsed = navCollapsed[navContext];
  const navContextRef = useRef(navContext);
  navContextRef.current = navContext;
  function toggleSidebar() {
    const context = navContextRef.current;
    setNavCollapsed((old) => {
      const next = !old[context];
      try { localStorage.setItem(context === 'workbench' ? 'cliora:sidebar-collapsed-workbench' : 'cliora:sidebar-collapsed', String(next)); } catch { /* Layout remains usable without storage. */ }
      return { ...old, [context]: next };
    });
  }
  // First-run checklist (R5): visibility is decided once per launch from the truly-empty
  // state; step completion then follows live data until the card is closed or finished.
  const [onboardingComplete, setOnboardingComplete] = useState(readOnboardingComplete);
  const [onboardingVisible, setOnboardingVisible] = useState(false);
  const [onboardingHasConfig, setOnboardingHasConfig] = useState(false);
  const [onboardingLaunched, setOnboardingLaunched] = useState(readOnboardingLaunched);
  const onboardingEvaluated = useRef(false);
  const [visited, setVisited] = useState<Set<string>>(() => new Set(['home']));
  const [tool, setTool] = useState<string>('');
  // The CLI ToolWorkspace actually shows; a cancelled discard keeps it on the previous one.
  const [activeToolId, setActiveToolId] = useState<string | null>(null);
  const [toolOpenSequence, setToolOpenSequence] = useState(0);
  const [toolIntent, setToolIntent] = useState<WorkspaceOpenIntent | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteProjects, setPaletteProjects] = useState<Project[]>([]);
  const [paletteSessions, setPaletteSessions] = useState<HistorySession[]>([]);
  const [paletteLibrary, setPaletteLibrary] = useState<LibraryItem[]>([]);
  const [spotlight, setSpotlight] = useState<Spotlight | null>(null);
  const [trayRepair, setTrayRepair] = useState<TrayRepairTarget | null>(null);
  const [workbenchFocus, setWorkbenchFocus] = useState<string | null>(null);
  const [workbenchFailure, setWorkbenchFailure] = useState<WorkbenchFailure | null>(null);
  const [workbenchToken, setWorkbenchToken] = useState(0);
  const [remoteTargets, setRemoteTargets] = useState<RemoteTarget[]>([]);
  const [remoteTargetId, setRemoteTargetId] = useState(() => { try { return localStorage.getItem('cliora:remote-target') ?? 'local'; } catch { return 'local'; } });
  const activePage = useRef<Page>(page);
  activePage.current = page;
  const workspaceDirty = useRef(false);
  const mcpIntentToken = useRef(0);
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

  const [remoteTargetsRevision, setRemoteTargetsRevision] = useState(0);
  useEffect(() => {
    const refresh = () => setRemoteTargetsRevision((value) => value + 1);
    window.addEventListener('cliora:remote-targets-changed', refresh);
    return () => window.removeEventListener('cliora:remote-targets-changed', refresh);
  }, []);
  useEffect(() => {
    if (!nativeAvailable) return;
    // browserBootstrap starts with SSH off. Clearing the saved host before the real
    // preferences arrive makes the sidebar and the workbench disagree after startup.
    if (!bootstrap.preferences.remote_ssh_enabled) {
      if (loaded) { setRemoteTargets([]); setRemoteTargetId('local'); }
      return;
    }
    let live = true;
    void native.listRemoteTargets().then((targets) => {
      if (!live) return;
      const enabled = (Array.isArray(targets) ? targets : []).filter((target) => target.enabled);
      setRemoteTargets(enabled);
      setRemoteTargetId((current) => current !== 'local' && enabled.some((target) => target.id === current) ? current : 'local');
    }).catch(() => setRemoteTargets([]));
    return () => { live = false; };
  }, [bootstrap.preferences.remote_ssh_enabled, loaded, remoteTargetsRevision]);
  useEffect(() => {
    if (!bootstrap.preferences.remote_ssh_enabled && settingsTab === 'hosts') setSettingsTab('general');
  }, [bootstrap.preferences.remote_ssh_enabled, settingsTab]);

  function openHostManagement() {
    setSettingsTab('hosts');
    void go('settings');
  }

  function changeRemoteTarget(value: string) {
    if (value === '__manage') {
      openHostManagement();
      return;
    }
    setRemoteTargetId(value);
    try { localStorage.setItem('cliora:remote-target', value); } catch { /* optional preference */ }
    window.dispatchEvent(new CustomEvent('cliora:remote-target-changed', { detail: value }));
  }

  useEffect(() => {
    const onRemoteLaunch = (event: Event) => {
      const detail = (event as CustomEvent<{ toolId?: string; targetId?: string }>).detail;
      if (detail?.targetId) changeRemoteTarget(detail.targetId);
      void go('sessions').then(() => {
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('cliora:open-remote-session', { detail })), 0);
      });
    };
    window.addEventListener('cliora:open-remote-session-request', onRemoteLaunch);
    return () => window.removeEventListener('cliora:open-remote-session-request', onRemoteLaunch);
  }, []);

  useEffect(() => {
    if (!paletteOpen || !nativeAvailable) return;
    let live = true;
    void native.listProjects().then((result) => { if (live && Array.isArray(result)) setPaletteProjects(result); }).catch(() => {});
    // Palette data is read-only: sessions come straight from the indexed DB snapshot
    // (list_history_sessions never scans) and library items from the library tables.
    void native.listHistorySessions({ limit: 5 }).then((result) => {
      if (!live || !Array.isArray(result)) return;
      setPaletteSessions([...result].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 5));
    }).catch(() => {});
    void Promise.all([native.listLibraryItems('prompt', null, ''), native.listLibraryItems('rule', null, '')])
      .then((groups) => { if (live) setPaletteLibrary(groups.flatMap((entries) => entries.slice(0, 5))); })
      .catch(() => {});
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
    // Release builds load from tauri://localhost or http://tauri.localhost; the dev server has a port and keeps Inspect.
    if (location.port !== '') return;
    // The WebView menu (Back / Reload / Print) is not part of a desktop app. Keep it where it helps:
    // text fields (cut, copy, paste) and an active text selection (copy).
    const onContextMenu = (event: MouseEvent) => {
      if (isEditableTarget(event.target) || (window.getSelection()?.toString() ?? '') !== '') return;
      event.preventDefault();
    };
    window.addEventListener('contextmenu', onContextMenu);
    return () => window.removeEventListener('contextmenu', onContextMenu);
  }, []);
  useEffect(() => {
    const mode = bootstrap.preferences.theme;
    const apply = () => {
      const resolved = mode === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode;
      document.documentElement.dataset.theme = resolved;
      if (!nativeAvailable) return;
      try {
        const appWindow = getCurrentWindow();
        void appWindow.setTheme(mode === 'system' ? null : mode).catch(() => {});
        const background = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
        void appWindow.setBackgroundColor(background).catch(() => {});
      } catch { void 0; }
    };
    apply();
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [bootstrap.preferences.theme]);
  useEffect(() => {
    const saved = bootstrap.preferences.language;
    if (saved === 'zh' || saved === 'en') {
      applyStoredLanguage(saved);
      return;
    }
    if (!nativeAvailable) return;
    const local = readStoredLanguage();
    if (!local) return;
    let cancelled = false;
    void native.setLanguage(local).then((next) => {
      if (!cancelled) setBootstrap(next);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [bootstrap.preferences.language]);

  const updateOffer = useUpdateOffer();
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
        toggleSidebar();
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
  // Sidebar highlight follows the CLI the workspace reports, not the requested one.
  const sidebarTool = nativeAvailable && activeToolId && visible.some((item) => item.id === activeToolId) ? activeToolId : selectedTool;
  const selectedToolName = visible.find((item) => item.id === selectedTool)?.name ?? selectedTool;
  const title: [string, string] = [t(`common.pages.${page}.title`), page === 'records' && remoteTargetId !== 'local' ? t('records.page.remoteSubtitle') : t(`common.pages.${page}.subtitle`)];

  async function go(next: Page) {
    if (!await canLeave(next)) return false;
    setPage(next);
    if (loaded) setError(null);
    document.querySelector('main')?.scrollTo({ top: 0 });
    requestAnimationFrame(() => document.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true }));
    return true;
  }
  goRef.current = go;

  // Sidebar CLI items and palette tool items share one channel. On the tools page only the
  // open sequence moves, so ToolWorkspace's own discard prompt is the single confirmation.
  function openTool(id: string) {
    setTool(id);
    setToolIntent(null);
    setToolOpenSequence((value) => value + 1);
    if (activePage.current !== 'connections') void go('connections');
  }

  async function revealProject(id: string) {
    if (await go('home')) setSpotlight({ target: 'project', id, token: Date.now() });
  }

  async function revealLibraryItem(kind: LibraryKind, id: string) {
    if (await go('library')) setSpotlight({ target: 'library', kind, id, token: Date.now() });
  }

  async function openMcpLibrary(definitionId: string) {
    if (await go('library')) setSpotlight({ target: 'mcp', id: definitionId, token: ++mcpIntentToken.current, source: 'connections' });
  }

  // Same command and confirmation flow as the Records list, with Records' default mode.
  function openWorkbenchSession(sessionId: string) {
    setWorkbenchFailure(null);
    setWorkbenchFocus(sessionId);
    setWorkbenchToken((value) => value + 1);
    void go('sessions');
  }

  function openWorkbenchFailure(failure: WorkbenchFailure) {
    setWorkbenchFailure(failure);
    setWorkbenchToken((value) => value + 1);
    void go('sessions');
  }

  async function resumePaletteSession(id: string) {
    try {
      const result = await native.resumeHistorySession(id, 'normal');
      const opened = workbenchSessionId(result);
      if (opened) { openWorkbenchSession(opened); return; }
    } catch (value) {
      const toolId = paletteSessions.find((item) => item.id === id)?.toolId;
      const desktop = (catalog?.registered ?? []).find((item) => item.id === toolId)?.launchForm === 'desktop';
      if (await failedInWorkbench(desktop)) {
        openWorkbenchFailure({ detail: formatFailure(value, t('sessions.launchFailed'), t('sessions.failureHint')), retry: { kind: 'resume', id, mode: 'normal' } });
        return;
      }
      const detail = launchFailureDetail(value);
      setError(detail ? { code: 'terminal_command_too_long', message: detail, action: '', data_directory: null } : value as ApiError);
    }
  }

  // Decide checklist visibility once per launch: only a fully fresh state (no managed
  // tool, no named profile, no project, no completion marker) counts as a first run.
  useEffect(() => {
    if (!nativeAvailable || !loaded || onboardingComplete || onboardingEvaluated.current) return;
    onboardingEvaluated.current = true;
    let active = true;
    void (async () => {
      if (managed.length > 0) return;
      try {
        const projects = await native.listProjects();
        if (!active || !Array.isArray(projects) || projects.length > 0) return;
        const items = await native.listPortableItems();
        if (!active || !Array.isArray(items)) return;
        if (!items.some((item) => item.kind === 'profile')) setOnboardingVisible(true);
      } catch { /* Keep the checklist hidden when the fresh state cannot be confirmed. */ }
    })();
    return () => { active = false; };
  }, [loaded, onboardingComplete, managed.length]);

  // While the checklist is open, re-reading the named-profile list on every return to
  // Home keeps step 2 in sync with profiles created on the tools page.
  useEffect(() => {
    if (!nativeAvailable || !onboardingVisible || page !== 'home') return;
    let active = true;
    void native.listPortableItems()
      .then((items) => { if (active && Array.isArray(items)) setOnboardingHasConfig(items.some((item) => item.kind === 'profile')); })
      .catch(() => {});
    return () => { active = false; };
  }, [onboardingVisible, page]);

  // launchCli / resumeHistorySession successes are reported by the OnboardingCard module.
  useEffect(() => {
    const markLaunched = () => setOnboardingLaunched(true);
    window.addEventListener(ONBOARDING_LAUNCHED_EVENT, markLaunched);
    return () => window.removeEventListener(ONBOARDING_LAUNCHED_EVENT, markLaunched);
  }, []);

  // All three steps done: record completion and retire the card for this session as well.
  useEffect(() => {
    if (!onboardingVisible) return;
    if (managed.length > 0 && onboardingHasConfig && onboardingLaunched) {
      completeOnboarding();
      setOnboardingComplete(true);
      setOnboardingVisible(false);
    }
  }, [onboardingVisible, managed.length, onboardingHasConfig, onboardingLaunched]);

  function closeOnboarding() {
    completeOnboarding();
    setOnboardingComplete(true);
    setOnboardingVisible(false);
  }

  function reopenOnboardingGuide() {
    reopenOnboarding();
    setOnboardingComplete(false);
    setOnboardingVisible(true);
    void go('home');
  }

  // Checklist step entries: the managed-CLI checkboxes, profile creation, and the launch area.
  function openAppUpdate() {
    setSettingsTab('general');
    void go('settings').then(() => requestAnimationFrame(() => document.getElementById('app-update')?.scrollIntoView({ block: 'center', behavior: 'smooth' })));
  }

  function openOnboardingToolSetup() {
    setSettingsTab('general');
    void go('settings');
  }

  function openOnboardingConfigCreate() {
    // Without a managed CLI there is no configuration target yet; guide to step 1 instead
    // of landing on the empty tools page.
    if (!selectedTool) { openOnboardingToolSetup(); return; }
    setTool(selectedTool);
    setToolIntent({ create: true });
    setToolOpenSequence((value) => value + 1);
    void go('connections');
  }

  function revealOnboardingLaunchArea() {
    document.querySelector<HTMLElement>('.home-launcher')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  const libraryKindLabel = (kind: LibraryKind) => t(kind === 'prompt' ? 'library.page.prompt' : 'library.page.ruleShort');
  const commands: CommandItem[] = [
    ...pages.map((item) => {
      const shortcut = pages.findIndex((pageItem) => pageItem.id === item.id);
      return { id: `page-${item.id}`, group: t('common.palette.groupPages'), label: t(`common.nav.${item.id}`), hint: shortcut >= 0 ? `${modLabel}+${shortcut + 1}` : undefined, keywords: item.id, icon: item.glyph, run: () => { void go(item.id); } };
    }),
    ...paletteSessions.map((session) => ({ id: `session-${session.id}`, group: t('common.palette.groupSessions'), label: session.title.trim() || t('common.palette.untitledSession'), hint: t('common.palette.hintResumeSession'), keywords: session.toolId, toolId: session.toolId, run: () => { void resumePaletteSession(session.id); } })),
    ...paletteLibrary.map((item) => ({ id: `library-${item.id}`, group: t('common.palette.groupLibrary'), label: item.title, hint: t('common.palette.hintOpenItem'), keywords: libraryKindLabel(item.kind), icon: 'library' as const, run: () => { void revealLibraryItem(item.kind, item.id); } })),
    ...visible.map((item) => ({ id: `tool-${item.id}`, group: t('common.palette.groupTools'), label: item.name, hint: t('common.palette.hintOpenConfig'), keywords: item.id, toolId: item.id, run: () => openTool(item.id) })),
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

  async function updateRemoteSsh(enabled: boolean) {
    if (!nativeAvailable || busy) return;
    setBusy(true); setError(null);
    try { setBootstrap(await native.setRemoteSshEnabled(enabled)); }
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

  return <ToolIconsContext value={bootstrap.preferences.tool_icons ?? {}}><div className="titlebar-drag" data-tauri-drag-region /><div className="shell" data-sidebar-collapsed={sidebarCollapsed} data-page={page}>
    <a className="skip-link" href="#main" onClick={(event) => { event.preventDefault(); const main = document.getElementById('main'); main?.focus(); main?.scrollTo({ top: 0 }); }}>{t('common.shell.skipToContent')}</a>
    <aside className="sidebar" aria-label={t('common.nav.mainLabel')}>
      <div className="brand">
        <img className="brandmark" src={brandIcon} alt="" />
        <span className="brand-name"><strong>{t('common.shell.brand')}</strong><small>Cliora</small></span>
        <button type="button" className="sidebar-toggle" aria-label={sidebarCollapsed ? t('common.shell.sidebarExpand') : t('common.shell.sidebarCollapse')} title={`${sidebarCollapsed ? t('common.shell.sidebarExpand') : t('common.shell.sidebarCollapse')} (${modLabel}+\\)`} aria-expanded={!sidebarCollapsed} aria-controls="main-navigation" onClick={toggleSidebar}><img className="sidebar-toggle-brand" src={brandIcon} alt="" /><span className="sidebar-toggle-icon"><Icon name={sidebarCollapsed ? 'sidebarOpen' : 'sidebarClose'} size={18} /></span></button>
      </div>
      {bootstrap.preferences.remote_ssh_enabled && <div className="sidebar-host"><HostSwitcher targets={remoteTargets} value={remoteTargetId} onChange={changeRemoteTarget} onManage={openHostManagement} collapsed={sidebarCollapsed} /></div>}
      <button type="button" className="sidebar-command" aria-label={t('common.shell.commandTitle', { shortcut: `${modLabel}+K` })} title={t('common.shell.commandTitle', { shortcut: `${modLabel}+K` })} onClick={() => setPaletteOpen(true)}><Icon name="search" size={15} /><span>{t('common.palette.title')}</span><kbd>{modLabel} K</kbd></button>
      <nav className="nav" id="main-navigation" aria-label={t('common.nav.label')}>
        {navGroups.map((group) => <div className="nav-group" key={group.label} data-group={group.label}>{group.pages.map((pageId) => { const item = pages.find((candidate) => candidate.id === pageId)!; const label = t(`common.nav.${item.id}`); const shortcut = pages.findIndex((pageItem) => pageItem.id === item.id); const shortcutLabel = shortcut >= 0 ? `${modLabel}+${shortcut + 1}` : ''; return <Fragment key={item.id}><button type="button" className={page === item.id ? 'active' : ''} aria-label={label} aria-current={page === item.id ? 'page' : undefined} aria-keyshortcuts={shortcut >= 0 ? `${modAria}+${shortcut + 1}` : undefined} title={shortcutLabel ? t('common.nav.itemTitle', { label, shortcut: shortcutLabel }) : label} onClick={() => go(item.id)}><span className="nav-glyph" aria-hidden="true"><Icon name={item.glyph} /></span><span className="nav-text">{label}</span></button>{item.id === 'connections' && loaded && <SidebarTools tools={visible} current={sidebarTool} active={page === 'connections'} onOpen={openTool} />}</Fragment>; })}</div>)}
      </nav>
      <div className="sidebar-foot">
        {updateOffer && <button type="button" className="sidebar-update" title={t('common.shell.updateTitle', { version: updateOffer.version })} aria-label={t('common.shell.updateTitle', { version: updateOffer.version })} onClick={openAppUpdate}><span className="sidebar-update-glyph" aria-hidden="true"><Icon name="download" size={14} /></span><span className="sidebar-update-text">{t('common.shell.updateAvailable', { version: updateOffer.version })}</span><span className="sidebar-update-action" aria-hidden="true">{t('common.shell.updateAction')}</span></button>}
        {!bootstrap.preferences.remote_ssh_enabled && <div className="sidebar-status" title={nativeAvailable ? t('common.shell.statusLocalTitle') : t('common.shell.statusPreviewTitle')}><span className="status-dot" data-tone={nativeAvailable ? undefined : 'preview'} /><span className="status-text" data-short={nativeAvailable ? t('common.shell.statusLocalShort') : t('common.shell.statusPreviewShort')}>{nativeAvailable ? t('common.shell.statusLocal') : t('common.shell.statusPreview')}</span></div>}
        <div className="theme-switch" role="group" aria-label={t('common.theme.switch')}>{themes.map((item) => { const label = t(`common.theme.${item.id}`); return <button key={item.id} type="button" aria-label={label} title={label} aria-pressed={bootstrap.preferences.theme === item.id} disabled={busy} onClick={() => { if (bootstrap.preferences.theme !== item.id) void updateTheme(item.id); }}><Icon name={item.glyph} size={14} /></button>; })}</div>
      </div>
    </aside>
    <main className={`content${page === 'records' || page === 'sessions' ? ' content-locked' : ''}${page === 'sessions' ? ' content-workbench' : ''}`} id="main" tabIndex={-1}><div className="content-inner">
      {!nativeAvailable && <div className="environment-banner" role="status"><span className="banner-icon"><Icon name="info" size={16} /></span><span>{t('common.shell.previewBanner')}</span></div>}
      {error && <div className="error-banner" role="alert"><span className="banner-icon"><Icon name="alert" size={16} /></span><div className="error-copy"><strong>{error.message}</strong><span>{error.action}</span>{error.data_directory && <code>{error.data_directory}</code>}</div>{loaded && <button type="button" onClick={() => setError(null)} aria-label={t('common.dismissError')}><Icon name="close" size={14} /></button>}</div>}
      {page !== 'sessions' && <PageHeader title={title[0]} subtitle={title[1]} compact={page === 'records' || page === 'connections'} />}
      {loading ? <PageSkeleton /> : !loaded ? <EmptyState icon="alert" title={t('common.shell.loadFailedTitle')} detail={t('common.shell.loadFailedDetail')} action={<button className="button primary" type="button" onClick={loadBootstrap}>{t('common.shell.loadFailedRetry')}</button>} /> : <>
        {page === 'home' && onboardingVisible && <OnboardingCard
          doneTools={managed.length > 0}
          doneConfig={onboardingHasConfig}
          doneLaunch={onboardingLaunched}
          onManageTools={openOnboardingToolSetup}
          onCreateConfig={openOnboardingConfigCreate}
          onGoLaunch={revealOnboardingLaunchArea}
          onClose={closeOnboarding}
        />}
        {page === 'home' && <div className="home-band">
          <section className="home-tools">
            <div className="section-heading"><h2>{t('home.managed.title')}<span className="count-chip" aria-hidden="true">{visible.length}</span></h2><button className="text-button" type="button" onClick={() => go('settings')}>{t('home.managed.adjust')} <span aria-hidden="true">→</span></button></div>
            {visible.length ? nativeAvailable ? <ManagedTools tools={visibleDescriptors} remoteTargetId={remoteTargetId} onOpenTool={(id, intent) => { setTool(id); setToolIntent(intent ?? null); setToolOpenSequence((value) => value + 1); void go('connections'); }} onWorkbenchSession={openWorkbenchSession} onWorkbenchFailure={openWorkbenchFailure} /> : <div className="tool-table"><div className="table-head"><span>{t('home.preview.tool')}</span><span>{t('home.preview.state')}</span><span>{t('home.preview.actions')}</span></div>{visible.map((item) => <div className="tool-row" key={item.id}><div className="tool-identity"><span className="tool-icon" aria-hidden="true"><ToolIcon toolId={item.id} /></span><strong>{item.name}</strong></div><div className="tool-state">{t('home.preview.unchecked')}</div><button className="button" type="button" onClick={() => { setTool(item.id); go('connections'); }}>{t('home.preview.open')} <span aria-hidden="true">→</span></button></div>)}</div> : <EmptyState title={t('home.empty.title')} detail={t('home.empty.detail')} action={<button className="button primary" type="button" onClick={() => go('settings')}>{t('common.goSettings')}</button>} />}
          </section>
          {nativeAvailable ? <ProjectLauncher tools={visibleDescriptors} remoteSshEnabled={bootstrap.preferences.remote_ssh_enabled} remoteTargetId={remoteTargetId} repair={trayRepair?.page === 'home' ? trayRepair : null} spotlight={page === 'home' && spotlight?.target === 'project' ? spotlight : null} onWorkbenchSession={openWorkbenchSession} onWorkbenchFailure={openWorkbenchFailure} /> : <section className="home-secondary"><div className="section-heading"><h2>{t('home.projects.title')}</h2></div><div className="subtle-panel"><span className="empty-symbol" aria-hidden="true"><Icon name="folder" size={20} /></span><strong>{t('home.projects.panelTitle')}</strong><p>{t('home.projects.panelDetail')}</p></div></section>}
        </div>}
        {(page === 'connections' || hasVisited('connections')) && <div hidden={page !== 'connections'}>
          {selectedTool ? nativeAvailable ? <Suspense fallback={<PageSkeleton />}><ToolWorkspacePage managedTools={visibleDescriptors} remoteTargetId={remoteTargetId} initialTool={selectedTool} openSequence={toolOpenSequence} openIntent={toolIntent} active={page === 'connections'} repair={trayRepair?.page === 'connections' ? trayRepair : null} onDirtyChange={onWorkspaceDirtyChange} discardSignal={workspaceDiscard} onWorkbenchSession={openWorkbenchSession} onWorkbenchFailure={openWorkbenchFailure} onOpenMcpLibrary={definitionId => void openMcpLibrary(definitionId)} onToolChange={setActiveToolId} /></Suspense> : <EmptyState title={t('tools.preview.configTitle', { name: selectedToolName })} detail={t('tools.preview.emptyDetail')} /> : <EmptyState title={t('tools.empty.title')} detail={t('tools.empty.detail')} action={<button className="button primary" type="button" onClick={() => go('settings')}>{t('common.goSettings')}</button>} />}
        </div>}
        <div hidden={page !== 'library'}>{hasVisited('library') && <Suspense fallback={<PageSkeleton />}><LibraryPage managedTools={visibleDescriptors} remoteTargetId={remoteTargetId} active={page === 'library'} spotlight={page === 'library' && spotlight?.target === 'library' ? spotlight : null} mcpSpotlight={page === 'library' && spotlight?.target === 'mcp' ? spotlight : null} onOpenConnections={() => { setSpotlight(null); void go('connections'); }} onWorkbenchSession={openWorkbenchSession} onWorkbenchFailure={openWorkbenchFailure} /></Suspense>}</div>
        <div className="records-shell" hidden={page !== 'records'}>{hasVisited('records') && <Suspense fallback={<PageSkeleton />}><RecordsPage active={page === 'records'} remoteTargetId={remoteTargetId} tools={visibleDescriptors} onOpenProjects={() => go('home')} onWorkbenchSession={openWorkbenchSession} onWorkbenchFailure={openWorkbenchFailure} /></Suspense>}</div>
        <div className={sessionStyles.shell} hidden={page !== 'sessions'}>{(page === 'sessions' || hasVisited('sessions')) && <SessionWorkbench active={page === 'sessions'} tools={visibleDescriptors} remoteSshEnabled={bootstrap.preferences.remote_ssh_enabled} remoteTargetId={remoteTargetId} syncedRemoteTargets={remoteTargets} onRemoteTargetChange={changeRemoteTarget} focusSessionId={workbenchFocus} focusToken={workbenchToken} failure={workbenchFailure} onFailure={setWorkbenchFailure} onOpenHome={() => { void go('home'); }} />}</div>
        {page === 'settings' && <Tabs label={t('settings.tabs.label')} items={[['general', t('settings.tabs.general')], ...(bootstrap.preferences.remote_ssh_enabled ? [['hosts', t('settings.tabs.hosts')] as [SettingsTab, string]] : []), ['migration', t('settings.tabs.migration')]]} value={settingsTab} onChange={setSettingsTab} />}
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
          onReopenOnboarding={reopenOnboardingGuide}
          onOpenHosts={() => setSettingsTab('hosts')}
          remoteSshEnabled={bootstrap.preferences.remote_ssh_enabled}
          onRemoteSshChange={(enabled) => void updateRemoteSsh(enabled)}
        />}
        {page === 'settings' && settingsTab === 'hosts' && <RemoteSshSettings enabled={bootstrap.preferences.remote_ssh_enabled} busy={busy} onChange={(enabled) => void updateRemoteSsh(enabled)} showHosts showToggle={false} />}
        <div hidden={page !== 'settings' || settingsTab !== 'migration'}>{hasVisited('settings:migration') && <Suspense fallback={<PageSkeleton />}><MigrationSettings active={page === 'settings' && settingsTab === 'migration'} onImported={() => void refreshAfterImport()} /></Suspense>}</div>
      </>}
    </div></main>
  </div><CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} /><ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} /><ConfirmationHost /></ToolIconsContext>;
}
