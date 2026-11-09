import { RemoteWriteRecovery } from './features/remote/RemoteWriteRecovery';
import { requestWriteRecovery, useWriteRecoveryNeeded } from './features/remote/writeReceipts';
import { useRemoteIdentity } from './lib/remoteReads';
import { Fragment, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Icon } from './components/Icon';
import type { IconName } from './components/Icon';
import brandIcon from '../src-tauri/icons/128x128@2x.png';
import { useUpdateOffer } from './lib/appUpdate';
import { ConfirmationHost } from './components/ConfirmationHost';
import { EmptyState } from './components/EmptyState';
import { Badge, Button, IconButton } from './components/ui';
import { PageSkeleton } from './components/Skeleton';
import { PageHeader } from './components/PageHeader';
import { Tabs } from './components/Tabs';
import { ShortcutHelp } from './components/ShortcutHelp';
import { RowMenu } from './components/RowMenu';
import { CommandPalette, type CommandItem } from './components/CommandPalette';
import { ToolIcon, ToolIconsContext } from './components/ToolIcon';
import { HostSwitcher } from './components/HostSwitcher';
const GeneralSettings = lazy(() => import('./features/settings/GeneralSettings').then(module => ({ default: module.GeneralSettings })));
const RemoteSshSettings = lazy(() => import('./features/settings/GeneralSettings').then(module => ({ default: module.RemoteSshSettings })));
const SessionWorkbench = lazy(() => import('./features/sessions/SessionWorkbench').then(module => ({ default: module.SessionWorkbench })));
import type { RemoteWorkbenchIntent } from './features/sessions/workbenchLaunch';
import type { WorkbenchRailLayout } from './features/sessions/SessionWorkbench';
import { ManagedTools } from './features/home/ManagedTools';
import { ProjectLauncher } from './features/home/ProjectLauncher';
import { OnboardingCard } from './features/home/OnboardingCard';
import { RecentSessions } from './features/home/RecentSessions';
import { ONBOARDING_LAUNCHED_EVENT, completeOnboarding, readOnboardingComplete, readOnboardingLaunched, reopenOnboarding } from './lib/onboarding';
const LibraryPage = lazy(() => import('./features/library/LibraryPage').then((module) => ({ default: module.LibraryPage })));
const RecordsPage = lazy(() => import('./features/records/RecordsPage').then((module) => ({ default: module.RecordsPage })));
const MigrationSettings = lazy(() => import('./features/settings/MigrationSettings').then((module) => ({ default: module.MigrationSettings })));
const ToolWorkspacePage = lazy(() => import('./features/tools/ToolWorkspace').then((module) => ({ default: module.ToolWorkspacePage })));
import type { WorkspaceOpenIntent } from './features/tools/ToolWorkspace';
import type { LibraryMcpSpotlight } from './features/library/LibraryPage';
import { failedInWorkbench, workbenchSessionId, type WorkbenchFailure } from './features/sessions/workbenchLaunch';
import sessionStyles from './features/sessions/SessionWorkbench.module.css';
import { applyStoredLanguage, readStoredLanguage } from './i18n';
import { native, nativeAvailable } from './lib/native';
import { formatFailure, launchFailureDetail } from './lib/feedback';
import { confirmAction } from './lib/confirm';
import { isEditableTarget, modAria, modLabel, withMod } from './lib/shortcut';
import { usePageScroll } from './lib/uiNavigation';
import { browserBootstrap } from './types/domain';
import type { ApiError, Bootstrap, Theme } from './types/domain';
import type { HistorySession } from './types/history';
import type { Project, TrayRepairTarget, TwiglaneReviewSignal } from './types/launch';
import type { LibraryItem, LibraryKind } from './types/library';
import type { AdapterCatalog } from './types/native';
import type { RemoteTarget } from './types/remote';

type Page = 'home' | 'sessions' | 'connections' | 'library' | 'records' | 'settings';

/** Time-of-day greeting key for the home hero. */
function greetingPart(): 'morning' | 'afternoon' | 'evening' | 'night' {
  const hour = new Date().getHours();
  return hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : hour < 23 ? 'evening' : 'night';
}
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

/** On the workbench the sidebar is for switching sessions. The expanded sidebar shows every page icon
 *  that fits in its one row and folds only the overflow into a "more" menu; the folded icon rail keeps
 *  just the workspace pages. Mod+number shortcuts keep working either way. */
const workbenchNavPages: Page[] = ['home', 'sessions'];
/** Width of one page icon in the expanded workbench row (see shell.css). */
const WORKBENCH_NAV_SLOT = 32;

const themes: { id: Theme; glyph: IconName }[] = [
  { id: 'system', glyph: 'monitor' },
  { id: 'light', glyph: 'sun' },
  { id: 'dark', glyph: 'moon' },
];

export default function App() {
  const { t, i18n } = useTranslation();
  const [bootstrap, setBootstrap] = useState<Bootstrap>(() => browserBootstrap());
  const [catalog, setCatalog] = useState<AdapterCatalog | null>(null);
  const [loading, setLoading] = useState(nativeAvailable);
  const [loaded, setLoaded] = useState(!nativeAvailable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [page, setPage] = useState<Page>('home');
  // On the workbench the sidebar carries the session list, so it keeps its own collapsed state:
  // collapsed there means session icons only. It reuses the session rail's stored preference.
  const [navCollapsed, setNavCollapsed] = useState(() => {
    const read = (key: string, fallback: boolean) => {
      try { const value = localStorage.getItem(key); return value === null ? fallback : value === 'true'; } catch { return fallback; }
    };
    return { pages: read('cliora:sidebar-collapsed', false), workbench: read('cliora:workbench-rail-slim', false) };
  });
  const navContext: 'workbench' | 'pages' = page === 'sessions' ? 'workbench' : 'pages';
  const navContextRef = useRef(navContext);
  navContextRef.current = navContext;
  // Wide windows dock the session list in the sidebar; narrow ones keep the stacked top bar.
  const [wideShell, setWideShell] = useState(() => matchMedia('(min-width: 761px)').matches);
  useEffect(() => {
    const media = matchMedia('(min-width: 761px)');
    const update = () => setWideShell(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const [railHost, setRailHost] = useState<HTMLDivElement | null>(null);
  const [workbenchRail, setWorkbenchRail] = useState<WorkbenchRailLayout>({ docked: false, focus: false });
  const onRailLayout = useCallback((next: WorkbenchRailLayout) => setWorkbenchRail((old) => old.docked === next.docked && old.focus === next.focus ? old : next), []);
  const workbenchRailToggle = useRef<(() => void) | null>(null);
  const railDocked = page === 'sessions' && workbenchRail.docked;
  const navRef = useRef<HTMLElement>(null);
  const [navRoom, setNavRoom] = useState(pages.length);
  // Focus mode hides the sidebar entirely; the terminal takes the whole window.
  const focusLayout = page === 'sessions' && workbenchRail.focus;
  const sidebarCollapsed = navCollapsed[navContext] || focusLayout;
  // The expanded workbench row fills the space beside the search button; count how many icons fit.
  useLayoutEffect(() => {
    const node = navRef.current;
    if (!railDocked || sidebarCollapsed || !node) return;
    const measure = () => {
      const gap = parseFloat(getComputedStyle(node).columnGap) || 0;
      setNavRoom(Math.max(0, Math.floor((node.clientWidth + gap) / (WORKBENCH_NAV_SLOT + gap))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [railDocked, sidebarCollapsed]);
  const dockedNavPages: Page[] = sidebarCollapsed ? workbenchNavPages
    : navRoom >= pages.length ? pages.map((item) => item.id)
      : pages.slice(0, Math.max(workbenchNavPages.length, navRoom - 1)).map((item) => item.id);
  const overflowNavPages = pages.filter((item) => !dockedNavPages.includes(item.id));
  const toggleNavCollapsed = useCallback(() => {
    const context = navContextRef.current;
    setNavCollapsed((old) => {
      const next = !old[context];
      try { localStorage.setItem(context === 'workbench' ? 'cliora:workbench-rail-slim' : 'cliora:sidebar-collapsed', String(next)); } catch { /* Layout remains usable without storage. */ }
      return { ...old, [context]: next };
    });
  }, []);
  function toggleSidebar() {
    // The workbench leaves focus mode first, then folds the shared sidebar.
    if (navContextRef.current === 'workbench' && workbenchRailToggle.current) { workbenchRailToggle.current(); return; }
    toggleNavCollapsed();
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
  const [toolOpenSequence, setToolOpenSequence] = useState(0);
  const [toolIntent, setToolIntent] = useState<WorkspaceOpenIntent | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteProjects, setPaletteProjects] = useState<Project[]>([]);
  const [paletteSessions, setPaletteSessions] = useState<HistorySession[]>([]);
  const [paletteLibrary, setPaletteLibrary] = useState<LibraryItem[]>([]);
  const [paletteSourceFailed, setPaletteSourceFailed] = useState(false);
  const [paletteReload, setPaletteReload] = useState(0);
  const [spotlight, setSpotlight] = useState<Spotlight | null>(null);
  const [trayRepair, setTrayRepair] = useState<TrayRepairTarget | null>(null);
  const [remoteWorkbenchIntent, setRemoteWorkbenchIntent] = useState<RemoteWorkbenchIntent | null>(null);
  const [workbenchFocus, setWorkbenchFocus] = useState<string | null>(null);
  const [workbenchFailure, setWorkbenchFailure] = useState<WorkbenchFailure | null>(null);
  const [workbenchToken, setWorkbenchToken] = useState(0);
  const [reviewSignal, setReviewSignal] = useState<TwiglaneReviewSignal | null>(null);
  const [remoteTargets, setRemoteTargets] = useState<RemoteTarget[]>([]);
  const [remoteTargetId, setRemoteTargetId] = useState(() => { try { return localStorage.getItem('cliora:remote-target') ?? 'local'; } catch { return 'local'; } });
  const remoteIdentity = useRemoteIdentity(remoteTargetId);
  const [projectQueries, setProjectQueries] = useState<Record<string, string>>({});
  const activeHost = useRef(remoteTargetId);
  activeHost.current = remoteTargetId;
  const activeIdentity = useRef(remoteIdentity);
  activeIdentity.current = remoteIdentity;
  const availableHosts = useRef(remoteTargets);
  availableHosts.current = remoteTargets;
  const writeRecoveryNeeded = useWriteRecoveryNeeded(remoteTargetId);
  const writeRecoveryFallback = nativeAvailable && bootstrap.preferences.remote_ssh_enabled && page !== 'sessions' && writeRecoveryNeeded;
  const activePage = useRef<Page>(page);
  activePage.current = page;
  const workspaceDirty = useRef(false);
  const mcpIntentToken = useRef(0);
  const pendingCatalog = useRef<AdapterCatalog | null>(null);
  const refreshSequence = useRef(0);
  const preferenceEdits = useRef({ theme: 0, remote_ssh_enabled: 0, tool_icons: 0, language: 0 });
  const onWorkspaceDirtyChange = useCallback((dirty: boolean) => {
    workspaceDirty.current = dirty;
    if (!dirty && pendingCatalog.current) { setCatalog(pendingCatalog.current); pendingCatalog.current = null; }
  }, []);
  const [workspaceDiscard, setWorkspaceDiscard] = useState(0);
  const canLeave = useCallback(async (next: Page, valid: () => boolean = () => true, changingContext = false) => {
    if (!changingContext && next === activePage.current) return valid();
    if (!workspaceDirty.current) return true;
    const accepted = await confirmAction(t('common.app.leaveDirtyMessage'), valid, { title: t('common.app.leaveDirtyTitle'), confirmLabel: t('common.app.leaveDirtyConfirm') });
    if (!accepted || !valid()) return false;
    workspaceDirty.current = false;
    setWorkspaceDiscard((value) => value + 1);
    return true;
  }, [t]);
  const section = page === 'settings' ? `${page}:${settingsTab}` : page;
  const [scrollIntent, setScrollIntent] = useState(0);
  const pageScroll = usePageScroll(`${section}:${remoteIdentity}`, scrollIntent);
  const transitionPending = useRef(false);
  const transitionRef = useRef<(next: Page, host?: string) => Promise<boolean>>(async () => false);
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

  async function openHostManagement() {
    if (await go('settings')) setSettingsTab('hosts');
  }

  async function changeRemoteTarget(value: string) {
    if (value === '__manage') {
      await openHostManagement();
      return;
    }
    await transitionRef.current(activePage.current, value);
  }

  useEffect(() => {
    const onRemoteLaunch = (event: Event) => {
      const detail = (event as CustomEvent<Omit<RemoteWorkbenchIntent, 'token'>>).detail;
      if (!detail?.targetId) return;
      void transitionRef.current('sessions', detail.targetId).then(allowed => {
        if (allowed) setRemoteWorkbenchIntent(previous => ({ ...detail, token: (previous?.token ?? 0) + 1 }));
      });
    };
    window.addEventListener('cliora:open-remote-session-request', onRemoteLaunch);
    return () => window.removeEventListener('cliora:open-remote-session-request', onRemoteLaunch);
  }, []);

  useEffect(() => {
    if (!paletteOpen || !nativeAvailable) return;
    let live = true;
    setPaletteSourceFailed(false);
    const markFailed = () => { if (live) setPaletteSourceFailed(true); };
    void native.listProjects().then((result) => {
      if (live && Array.isArray(result)) {
        setPaletteProjects([...result].sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0)));
      }
    }).catch(markFailed);
    // Palette data is read-only: sessions come straight from the indexed DB snapshot
    // (list_history_sessions never scans) and library items from the library tables.
    void native.listHistorySessions({ limit: 5 }).then((result) => {
      if (!live || !Array.isArray(result)) return;
      setPaletteSessions([...result].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 5));
    }).catch(markFailed);
    void Promise.all([native.listLibraryItems('prompt', null, ''), native.listLibraryItems('rule', null, '')])
      .then((groups) => { if (live) setPaletteLibrary(groups.flatMap((entries) => entries.slice(0, 5))); })
      .catch(markFailed);
    return () => { live = false; };
  }, [paletteOpen, paletteReload]);

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
      void transitionRef.current(event.payload.page).then((allowed) => {
        if (!active || !allowed) return;
        pageScroll.cancel();
        setScrollIntent(value => value + 1);
        setTrayRepair((old) => ({ ...event.payload, sequence: (old?.sequence ?? 0) + 1 }));
        if (event.payload.page === 'settings') setSettingsTab('general');
      });
    }).then((unlisten) => {
      if (active) stops.push(unlisten); else unlisten();
    }).catch(() => {});
    return () => { active = false; stops.forEach((stop) => stop()); };
  }, [canLeave]);

  // cliora://review 的接收回执与返回事件走同一条路径：先交给 native 校验并更新内存态
  // 注册表，再决定定位会话还是让工作台重读。冷启动链接与运行中链接行为一致。
  useEffect(() => {
    if (!nativeAvailable) return;
    let active = true;
    let stop: (() => void) | null = null;
    const seen = new Set<string>();
    // 原审查关联失效时明确说明无法返回：不创建替代会话，不改动任何会话或仓库。
    const showReviewExpired = () => {
      setError({
        code: 'review_link_expired',
        message: t('sessions.reviewReturnExpired'),
        action: t('sessions.reviewReturnExpiredAction'),
      });
    };
    // 只有该 session 仍在工作台里且是本地会话时才跳转；否则停在当前页并说明原因。
    const sessionAvailable = async (sessionId: string) => native.listWorkbenchSessions()
      .then((list) => !Array.isArray(list)
        || list.some((item) => item.id === sessionId && !item.projectId?.startsWith('remote:')))
      // 读不到列表不是"会话已失效"的证据，保持原行为。
      .catch(() => true);
    const handle = (url: unknown) => {
      if (!active || typeof url !== 'string' || seen.has(url)) return;
      seen.add(url);
      void native.twiglaneReviewLink(url).then(async (outcome) => {
        if (!active) return;
        if (outcome.kind === 'ignored') {
          // unknown_review：注册表里从未有过这个 reviewId（重启或来源失效）；
          // superseded_review：同一会话已经发起了更新的审查，迟到事件不覆盖新结果。
          if (outcome.reason === 'unknown_review' || outcome.reason === 'superseded_review') showReviewExpired();
          return;
        }
        const sessionId = outcome.sessionId;
        if (!sessionId) return;
        if (outcome.kind === 'returned') {
          if (!await sessionAvailable(sessionId) || !active) {
            if (active) showReviewExpired();
            return;
          }
          openWorkbenchSession(sessionId);
          return;
        }
        setReviewSignal((current) => ({ sessionId, token: (current?.token ?? 0) + 1 }));
      }).catch(() => {});
    };
    // 浏览器 mock 或插件缺失时 unlisten 可能是拒绝的 promise；释放失败不打断任何事。
    const release = (fn: (() => void) | null) => {
      try {
        const pending = fn?.() as unknown;
        if (pending && typeof (pending as Promise<void>).catch === 'function') void (pending as Promise<void>).catch(() => {});
      } catch { /* the listener is gone either way */ }
    };
    void (async () => {
      try {
        const { getCurrent, onOpenUrl } = await import('@tauri-apps/plugin-deep-link');
        const current = await getCurrent().catch(() => null);
        for (const url of current ?? []) handle(url);
        const unlisten = await onOpenUrl((urls) => { for (const url of urls ?? []) handle(url); });
        if (active) stop = unlisten; else release(unlisten);
      } catch {
        // 没有 deep-link 运行环境时保持现有工作台行为。
      }
    })();
    return () => { active = false; release(stop); };
  }, []);

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
    const edits = { ...preferenceEdits.current };
    try {
      const [nextBootstrap, nextCatalog] = await Promise.all([native.getBootstrap(), native.listCliAdapters()]);
      if (sequence !== refreshSequence.current) return;
      // Preserve choices made after this read began, while still accepting the
      // imported catalog and unrelated settings from the same refresh.
      setBootstrap((current) => ({ ...nextBootstrap, preferences: {
        ...nextBootstrap.preferences,
        theme: edits.theme === preferenceEdits.current.theme ? nextBootstrap.preferences.theme : current.preferences.theme,
        remote_ssh_enabled: edits.remote_ssh_enabled === preferenceEdits.current.remote_ssh_enabled ? nextBootstrap.preferences.remote_ssh_enabled : current.preferences.remote_ssh_enabled,
        tool_icons: edits.tool_icons === preferenceEdits.current.tool_icons ? nextBootstrap.preferences.tool_icons : current.preferences.tool_icons,
        language: edits.language === preferenceEdits.current.language ? nextBootstrap.preferences.language : current.preferences.language,
      } }));
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
    ++preferenceEdits.current.language;
    void native.setLanguage(local).then((next) => {
      if (!cancelled) setBootstrap((current) => ({ ...current, preferences: { ...current.preferences, language: next.preferences.language } }));
    }).catch(() => {}).finally(() => { ++preferenceEdits.current.language; });
    return () => { cancelled = true; };
  }, [bootstrap.preferences.language]);

  const updateOffer = useUpdateOffer();
  const goRef = useRef<(next: Page) => void>(() => {});
  const newSessionRef = useRef<(() => void) | null>(null);
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
      // Alt+N starts a session from any page. The workbench keeps its own Alt+N handler while open,
      // so this one only covers the other pages and opens the same new-session dialog there.
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.repeat && (event.code === 'KeyN' || event.key.toLowerCase() === 'n')) {
        const start = newSessionRef.current;
        if (!start || activePage.current === 'sessions' || document.querySelector('dialog[open]') || isEditableTarget(event.target)) return;
        event.preventDefault();
        start();
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
  const visibleDescriptors = useMemo(() => (catalog?.registered ?? []).filter((item) => catalog?.managedIds.includes(item.id)), [catalog]);
  const selectedTool = visible.some((item) => item.id === tool) ? tool : visible[0]?.id;
  const selectedToolName = visible.find((item) => item.id === selectedTool)?.name ?? selectedTool;
  const title: [string, string] = [t(`common.pages.${page}.title`), page === 'records' && remoteTargetId !== 'local' ? t('records.page.remoteSubtitle') : t(`common.pages.${page}.subtitle`)];
  const brandLatin = t('common.shell.brandLatin');
  // The window title names the current page, so the taskbar and the WebView title match
  // what the sidebar marks as current, and it follows a language change immediately.
  useEffect(() => {
    document.title = title[0] === brandLatin ? brandLatin : `${title[0]} · ${brandLatin}`;
  }, [title[0], brandLatin]);

  async function go(next: Page) {
    return transition(next);
  }
  async function transition(next: Page, host = activeHost.current) {
    if (transitionPending.current) return false;
    const previousPage = activePage.current;
    const previousHost = activeHost.current;
    if (next === previousPage && host === previousHost) return true;
    const sourceIdentity = activeIdentity.current;
    const destination = host === 'local' ? null : availableHosts.current.find(target => target.id === host && target.enabled);
    if (host !== 'local' && !destination) return false;
    const destinationIdentity = destination ? JSON.stringify(destination) : '';
    const valid = () => activePage.current === previousPage && activeHost.current === previousHost
      && activeIdentity.current === sourceIdentity
      && (host === 'local' || availableHosts.current.some(target => target.id === host && target.enabled && JSON.stringify(target) === destinationIdentity));
    transitionPending.current = true;
    try {
      if (!await canLeave(next, valid, host !== previousHost) || !valid()) return false;
      pageScroll.save();
      activePage.current = next;
      setPage(next);
      if (next !== previousPage || host !== previousHost) setSpotlight(null);
      if (host !== previousHost) {
        activeHost.current = host;
        setRemoteTargetId(host);
        try { localStorage.setItem('cliora:remote-target', host); } catch { /* optional preference */ }
        window.dispatchEvent(new CustomEvent('cliora:remote-target-changed', { detail: host }));
      }
      if (loaded) setError(null);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true }));
      return true;
    } finally { transitionPending.current = false; }
  }
  transitionRef.current = transition;
  goRef.current = go;
  const canStartSession = nativeAvailable && visibleDescriptors.some((item) => item.launchForm !== 'desktop');
  function startNewSession() {
    window.dispatchEvent(new CustomEvent('cliora:open-remote-session-request', { detail: { targetId: remoteTargetId } }));
  }
  newSessionRef.current = canStartSession ? startNewSession : null;

  // The header CLI switcher and palette tool items share one channel. On the tools page only the
  // open sequence moves, so ToolWorkspace's own discard prompt is the single confirmation.
  function openTool(id: string) {
    setTool(id);
    setToolIntent(null);
    setToolOpenSequence((value) => value + 1);
    if (activePage.current !== 'connections') void go('connections');
  }

  async function revealProject(id: string) {
    if (await go('home')) { pageScroll.cancel(); setScrollIntent(value => value + 1); setSpotlight({ target: 'project', id, token: Date.now() }); }
  }

  async function revealLibraryItem(kind: LibraryKind, id: string) {
    if (await go('library')) { pageScroll.cancel(); setScrollIntent(value => value + 1); setSpotlight({ target: 'library', kind, id, token: Date.now() }); }
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

  /** Resume an indexed conversation; the palette and the home recents share this flow. */
  async function resumePaletteSession(id: string, knownToolId?: string): Promise<'workbench' | 'terminal' | 'failed'> {
    try {
      const result = await native.resumeHistorySession(id, 'normal');
      const opened = workbenchSessionId(result);
      if (opened) { openWorkbenchSession(opened); return 'workbench'; }
      return 'terminal';
    } catch (value) {
      const toolId = knownToolId ?? paletteSessions.find((item) => item.id === id)?.toolId;
      const desktop = (catalog?.registered ?? []).find((item) => item.id === toolId)?.launchForm === 'desktop';
      if (await failedInWorkbench(desktop)) {
        openWorkbenchFailure({ detail: formatFailure(value, t('sessions.launchFailed'), t('sessions.failureHint')), retry: { kind: 'resume', id, mode: 'normal' } });
        return 'failed';
      }
      const detail = launchFailureDetail(value);
      setError(detail ? { code: 'terminal_command_too_long', message: detail, action: '', data_directory: null } : value as ApiError);
      return 'failed';
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
  const recentProjects = useMemo(() => [...paletteProjects].sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0)), [paletteProjects]);
  const projectCommands: CommandItem[] = recentProjects.map((project, index) => ({
    id: `project-${project.id}`,
    group: t('common.palette.groupProjects'),
    label: project.name,
    hint: project.available ? t('common.palette.hintLocateProject') : t('common.palette.hintRebindProject'),
    keywords: project.path ?? '',
    icon: 'folder' as const,
    contextBoost: (page === 'home' ? 6 : 4) + (index < 5 ? 2 : 0),
    run: () => { void revealProject(project.id); },
  }));
  const sessionCommands: CommandItem[] = paletteSessions.map((session) => ({
    id: `session-${session.id}`,
    group: t('common.palette.groupSessions'),
    label: session.title.trim() || t('common.palette.untitledSession'),
    hint: t('common.palette.hintResumeSession'),
    keywords: session.toolId,
    toolId: session.toolId,
    contextBoost: session.toolId === selectedTool ? 6 : 4,
    run: () => { void resumePaletteSession(session.id); },
    secondaryLabel: t('common.palette.hintOpenRecords'),
    onSecondary: () => { void go('records'); },
  }));
  const pageCommands: CommandItem[] = pages.map((item) => {
    const shortcut = pages.findIndex((pageItem) => pageItem.id === item.id);
    return {
      id: `page-${item.id}`,
      group: t('common.palette.groupPages'),
      label: t(`common.nav.${item.id}`),
      hint: shortcut >= 0 ? `${modLabel}+${shortcut + 1}` : undefined,
      keywords: item.id,
      icon: item.glyph,
      contextBoost: page === item.id ? 2 : 5,
      run: () => { void go(item.id); },
    };
  });
  const libraryCommands: CommandItem[] = paletteLibrary.map((item) => ({
    id: `library-${item.id}`,
    group: t('common.palette.groupLibrary'),
    label: item.title,
    hint: t('common.palette.hintOpenItem'),
    keywords: libraryKindLabel(item.kind),
    icon: 'library' as const,
    contextBoost: page === 'library' ? 5 : 2,
    run: () => { void revealLibraryItem(item.kind, item.id); },
  }));
  const toolCommands: CommandItem[] = visible.map((item) => {
    const canWorkbench = nativeAvailable && (!('launchForm' in item) || item.launchForm !== 'desktop');
    return {
      id: `tool-${item.id}`,
      group: t('common.palette.groupTools'),
      label: item.name,
      hint: t('common.palette.hintOpenConfig'),
      keywords: item.id,
      toolId: item.id,
      contextBoost: item.id === selectedTool ? 8 : 3,
      run: () => openTool(item.id),
      secondaryLabel: canWorkbench ? t('common.palette.hintOpenWorkbench') : undefined,
      onSecondary: canWorkbench ? () => {
        window.dispatchEvent(new CustomEvent('cliora:open-remote-session-request', { detail: { targetId: remoteTargetId, toolId: item.id } }));
      } : undefined,
    };
  });
  // Starting a session is the most common action, so it leads the palette instead of trailing the actions.
  const startCommands: CommandItem[] = canStartSession ? [
    { id: 'new-session', group: t('common.palette.groupStart'), label: t('home.hero.newSession'), hint: 'Alt+N', keywords: 'new session terminal 新建 会话 终端', icon: 'plus', contextBoost: 4, run: startNewSession },
  ] : [];
  const actionCommands: CommandItem[] = [
    { id: 'sidebar', group: t('common.palette.groupActions'), label: sidebarCollapsed ? t('common.shell.sidebarExpand') : t('common.shell.sidebarCollapse'), hint: `${modLabel}+\\`, icon: sidebarCollapsed ? 'sidebarOpen' : 'sidebarClose', run: toggleSidebar },
    ...themes.map((item) => ({ id: `theme-${item.id}`, group: t('common.palette.groupActions'), label: t(`common.theme.${item.id}`), hint: bootstrap.preferences.theme === item.id ? t('common.theme.current') : t('common.theme.switch'), icon: item.glyph, run: () => { if (bootstrap.preferences.theme !== item.id) void updateTheme(item.id); } })),
    { id: 'help', group: t('common.palette.groupActions'), label: t('common.shortcuts.title'), hint: '?', icon: 'info', run: () => setHelpOpen(true) },
  ];
  const hasRecentWork = projectCommands.length > 0 || sessionCommands.length > 0;
  const commands: CommandItem[] = hasRecentWork
    ? [
      ...startCommands,
      ...projectCommands.slice(0, 5),
      ...sessionCommands,
      ...pageCommands,
      ...toolCommands,
      ...libraryCommands,
      ...actionCommands,
      ...projectCommands.slice(5),
    ]
    : [
      ...startCommands,
      ...pageCommands,
      ...toolCommands,
      ...libraryCommands,
      ...actionCommands,
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
    if (!nativeAvailable) { setBootstrap((current) => ({ ...current, preferences: { ...current.preferences, theme } })); return; }
    if (busy) return;
    ++preferenceEdits.current.theme;
    setBusy(true); setError(null);
    try {
      const next = await native.setTheme(theme);
      setBootstrap((current) => ({ ...current, preferences: { ...current.preferences, theme: next.preferences.theme } }));
    }
    catch (value) { setError(value as ApiError); }
    finally { ++preferenceEdits.current.theme; setBusy(false); }
  }

  async function updateRemoteSsh(enabled: boolean) {
    if (!nativeAvailable || busy) return;
    ++preferenceEdits.current.remote_ssh_enabled;
    setBusy(true); setError(null);
    try {
      const next = await native.setRemoteSshEnabled(enabled);
      setBootstrap((current) => ({ ...current, preferences: { ...current.preferences, remote_ssh_enabled: next.preferences.remote_ssh_enabled } }));
    }
    catch (value) { setError(value as ApiError); }
    finally { ++preferenceEdits.current.remote_ssh_enabled; setBusy(false); }
  }

  async function updateIcon(toolId: string, dataUrl: string | null) {
    if (!nativeAvailable || busy) return;
    ++preferenceEdits.current.tool_icons;
    setBusy(true); setError(null);
    try {
      const next = await native.setToolIcon(toolId, dataUrl);
      setBootstrap((current) => ({ ...current, preferences: { ...current.preferences, tool_icons: next.preferences.tool_icons } }));
    }
    catch (value) { setError(value as ApiError); throw value; }
    finally { ++preferenceEdits.current.tool_icons; setBusy(false); }
  }

  return <ToolIconsContext value={bootstrap.preferences.tool_icons ?? {}}><div className="titlebar-drag" data-tauri-drag-region /><div className="shell" data-sidebar-collapsed={sidebarCollapsed} data-page={page} data-context={railDocked ? 'workbench' : undefined} data-focus={focusLayout || undefined}>
    <a className="skip-link" href="#main" onClick={(event) => { event.preventDefault(); const main = document.getElementById('main'); main?.focus(); main?.scrollTo({ top: 0 }); }}>{t('common.shell.skipToContent')}</a>
    <aside className="sidebar" aria-label={t('common.nav.mainLabel')}>
      <div className="brand">
        <img className="brandmark" src={brandIcon} alt="" />
        <span className="brand-name"><strong>{t('common.shell.brand')}</strong>{t('common.shell.brand') !== brandLatin && <small>{brandLatin}</small>}</span>
        <button type="button" className="sidebar-toggle" aria-label={sidebarCollapsed ? t('common.shell.sidebarExpand') : t('common.shell.sidebarCollapse')} title={`${sidebarCollapsed ? t('common.shell.sidebarExpand') : t('common.shell.sidebarCollapse')} (${modLabel}+\\)`} aria-expanded={!sidebarCollapsed} aria-controls="main-navigation" onClick={toggleSidebar}><img className="sidebar-toggle-brand" src={brandIcon} alt="" /><span className="sidebar-toggle-icon"><Icon name={sidebarCollapsed ? 'sidebarOpen' : 'sidebarClose'} size={18} /></span></button>
      </div>
      {bootstrap.preferences.remote_ssh_enabled && <div className="sidebar-host"><HostSwitcher targets={remoteTargets} value={remoteTargetId} onChange={changeRemoteTarget} onManage={openHostManagement} collapsed={sidebarCollapsed} /></div>}
      <div className="sidebar-primary">
      <button type="button" className="sidebar-command" aria-label={t('common.shell.commandTitle', { shortcut: `${modLabel}+K` })} title={t('common.shell.commandTitle', { shortcut: `${modLabel}+K` })} onClick={() => setPaletteOpen(true)}><Icon name="search" size={15} /><span>{t('common.palette.title')}</span><kbd>{modLabel} K</kbd></button>
      <nav ref={navRef} className="nav" id="main-navigation" aria-label={t('common.nav.label')}>
        {(railDocked ? [{ label: 'workspace', pages: dockedNavPages }] : navGroups).map((group) => <div className="nav-group" key={group.label} data-group={group.label}>{!railDocked && group.label !== 'settingsGroup' && <span className="nav-caption" aria-hidden="true">{t(group.label === 'tools' ? 'common.nav.manage' : `common.nav.${group.label}`)}</span>}{group.pages.map((pageId) => { const item = pages.find((candidate) => candidate.id === pageId)!; const label = t(`common.nav.${item.id}`); const shortcut = pages.findIndex((pageItem) => pageItem.id === item.id); const shortcutLabel = shortcut >= 0 ? `${modLabel}+${shortcut + 1}` : ''; return <Fragment key={item.id}><button type="button" className={page === item.id ? 'active' : ''} aria-label={label} aria-current={page === item.id ? 'page' : undefined} aria-keyshortcuts={shortcut >= 0 ? `${modAria}+${shortcut + 1}` : undefined} title={shortcutLabel ? t('common.nav.itemTitle', { label, shortcut: shortcutLabel }) : label} onClick={() => go(item.id)}><span className="nav-glyph" aria-hidden="true"><Icon name={item.glyph} /></span><span className="nav-text">{label}</span></button></Fragment>; })}</div>)}
        {railDocked && overflowNavPages.length > 0 && <div className="nav-group" data-group="more"><RowMenu label={t('common.nav.more')} title={t('common.nav.more')} className="nav-more" side={sidebarCollapsed} icon={<span className="nav-glyph" aria-hidden="true"><Icon name="more" /></span>}>{overflowNavPages.map((item) => { const shortcut = pages.indexOf(item); return <button key={item.id} type="button" role="menuitem" aria-keyshortcuts={`${modAria}+${shortcut + 1}`} onClick={() => { void go(item.id); }}><Icon name={item.glyph} size={15} /><span>{t(`common.nav.${item.id}`)}</span><kbd>{`${modLabel}+${shortcut + 1}`}</kbd></button>; })}</RowMenu></div>}
      </nav>
      </div>
      {/* The workbench fills this slot with its session list; other pages leave it empty. */}
      <div className="sidebar-context" ref={setRailHost} hidden={!railDocked} />
      <div className="sidebar-foot">
        {updateOffer && <button type="button" className="sidebar-update" title={t('common.shell.updateTitle', { version: updateOffer.version })} aria-label={t('common.shell.updateTitle', { version: updateOffer.version })} onClick={openAppUpdate}><span className="sidebar-update-glyph" aria-hidden="true"><Icon name="download" size={14} /></span><span className="sidebar-update-text">{t('common.shell.updateAvailable', { version: updateOffer.version })}</span><span className="sidebar-update-action" aria-hidden="true">{t('common.shell.updateAction')}</span></button>}
        {!bootstrap.preferences.remote_ssh_enabled && <div className="sidebar-status" title={nativeAvailable ? t('common.shell.statusLocalTitle') : t('common.shell.statusPreviewTitle')}><span className="status-dot" data-tone={nativeAvailable ? undefined : 'preview'} /><span className="status-text" data-short={nativeAvailable ? t('common.shell.statusLocalShort') : t('common.shell.statusPreviewShort')}>{nativeAvailable ? t('common.shell.statusLocal') : t('common.shell.statusPreview')}</span></div>}
        {(() => { const index = Math.max(0, themes.findIndex((item) => item.id === bootstrap.preferences.theme)); const current = themes[index]; const next = themes[(index + 1) % themes.length]; const label = `${t('common.theme.switch')} (${t(`common.theme.${current.id}`)} → ${t(`common.theme.${next.id}`)})`; return <button type="button" className="theme-cycle" aria-label={label} title={label} disabled={busy} onClick={() => void updateTheme(next.id)}><Icon name={current.glyph} size={16} /></button>; })()}
        <div className="theme-switch" role="group" aria-label={t('common.theme.switch')}>{themes.map((item) => { const label = t(`common.theme.${item.id}`); return <button key={item.id} type="button" aria-label={label} title={label} aria-pressed={bootstrap.preferences.theme === item.id} disabled={busy} onClick={() => { if (bootstrap.preferences.theme !== item.id) void updateTheme(item.id); }}><Icon name={item.glyph} size={14} /></button>; })}</div>
      </div>
    </aside>
    <main className={`content${page === 'records' || page === 'sessions' ? ' content-locked' : ''}${page === 'sessions' ? ' content-workbench' : ''}`} id="main" tabIndex={-1}><div className="content-inner">
      {!nativeAvailable && <div className="environment-banner" role="status"><span className="banner-icon"><Icon name="info" size={16} /></span><span>{t('common.shell.previewBanner')}</span></div>}
      {(error || writeRecoveryFallback) && <div className="error-banner" role="alert"><span className="banner-icon"><Icon name="alert" size={16} /></span><div className="error-copy"><strong>{error?.message ?? t('common.remoteWrite.unknown')}</strong>{error && <span>{error.action}</span>}{writeRecoveryFallback && error && error.message !== t('common.remoteWrite.unknown') && <span>{t('common.remoteWrite.unknown')}</span>}{error?.data_directory && <code>{error.data_directory}</code>}</div>{writeRecoveryFallback && <IconButton size="sm" icon={<Icon name="refresh" size={14} />} onClick={() => requestWriteRecovery(remoteTargetId)} aria-label={t('common.remoteWrite.open')} title={t('common.remoteWrite.open')} />}{error && loaded && <button type="button" onClick={() => setError(null)} aria-label={t('common.dismissError')}><Icon name="close" size={14} /></button>}</div>}
      {page === 'home' && <PageHeader title={title[0]} subtitle={title[1]} eyebrow={<><span className="page-eyebrow-dot" aria-hidden="true" />{t(`home.hero.${greetingPart()}`)}<span aria-hidden="true">·</span><time>{new Intl.DateTimeFormat(i18n.language?.startsWith('en') ? 'en-US' : 'zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date())}</time></>} actions={nativeAvailable && visibleDescriptors.some((item) => item.launchForm !== 'desktop') ? <Button variant="primary" icon={<Icon name="plus" size={15} />} title={`${t('home.hero.newSessionTitle')} (Alt+N)`} aria-keyshortcuts="Alt+N" onClick={startNewSession}>{t('home.hero.newSession')}</Button> : undefined} />}
      {page !== 'sessions' && page !== 'home' && <PageHeader title={title[0]} subtitle={title[1]} compact={page === 'records' || page === 'connections'} />}
      {loading ? <PageSkeleton /> : !loaded ? <EmptyState icon="alert" title={t('common.shell.loadFailedTitle')} detail={t('common.shell.loadFailedDetail')} action={<Button variant="primary" size="sm" className="empty-state-action" onClick={loadBootstrap}>{t('common.shell.loadFailedRetry')}</Button>} /> : <>
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
          {nativeAvailable ? <ProjectLauncher tools={visibleDescriptors} projectQuery={projectQueries[remoteIdentity] ?? ''} onQueryChange={query => setProjectQueries(old => ({ ...old, [remoteIdentity]: query }))} remoteSshEnabled={bootstrap.preferences.remote_ssh_enabled} remoteTargetId={remoteTargetId} repair={trayRepair?.page === 'home' ? trayRepair : null} spotlight={page === 'home' && spotlight?.target === 'project' ? spotlight : null} onWorkbenchSession={openWorkbenchSession} onWorkbenchFailure={openWorkbenchFailure} /> : <section className="home-secondary"><div className="section-heading"><h2>{t('home.projects.title')}</h2></div><div className="subtle-panel"><span className="empty-symbol" aria-hidden="true"><Icon name="folder" size={20} /></span><strong>{t('home.projects.panelTitle')}</strong><p>{t('home.projects.panelDetail')}</p></div></section>}          {nativeAvailable && remoteTargetId === 'local' && <RecentSessions tools={visibleDescriptors} active={page === 'home'} onResume={(session) => resumePaletteSession(session.id, session.toolId)} onOpenRecords={() => { void go('records'); }} />}
          <section className="home-tools" data-home-section="tools">
            <div className="section-heading"><h2 id="home-tools-title">{t('home.managed.title')}<Badge className="heading-count" aria-hidden="true">{visible.length}</Badge></h2><Button variant="ghost" size="sm" onClick={() => go('settings')}>{t('home.managed.adjust')} <span aria-hidden="true">→</span></Button></div>
            <p className="home-section-hint">{t('home.managed.hint')}</p>
            {visible.length ? nativeAvailable ? <ManagedTools key={remoteIdentity} visible={page === 'home'} tools={visibleDescriptors} remoteTargetId={remoteTargetId} onOpenTool={(id, intent) => { setTool(id); setToolIntent(intent ?? null); setToolOpenSequence((value) => value + 1); void go('connections'); }} onWorkbenchSession={openWorkbenchSession} onWorkbenchFailure={openWorkbenchFailure} /> : <div className="tool-table"><div className="table-head"><span>{t('home.preview.tool')}</span><span>{t('home.preview.state')}</span><span>{t('home.preview.actions')}</span></div>{visible.map((item) => <div className="tool-row" key={item.id}><div className="tool-identity"><span className="tool-icon" aria-hidden="true"><ToolIcon toolId={item.id} /></span><strong>{item.name}</strong></div><div className="tool-state">{t('home.preview.unchecked')}</div><Button size="sm" className="tool-row-action" onClick={() => { setTool(item.id); go('connections'); }}>{t('home.preview.open')} <span aria-hidden="true">→</span></Button></div>)}</div> : <EmptyState title={t('home.empty.title')} detail={t('home.empty.detail')} action={<Button variant="primary" size="sm" className="empty-state-action" onClick={() => go('settings')}>{t('common.goSettings')}</Button>} />}
          </section>

        </div>}
        {(page === 'connections' || hasVisited('connections')) && <div hidden={page !== 'connections'}>
          {selectedTool ? nativeAvailable ? <Suspense fallback={<PageSkeleton />}><ToolWorkspacePage key={remoteIdentity} managedTools={visibleDescriptors} remoteTargetId={remoteTargetId} initialTool={selectedTool} openSequence={toolOpenSequence} openIntent={toolIntent} active={page === 'connections'} repair={trayRepair?.page === 'connections' ? trayRepair : null} onDirtyChange={onWorkspaceDirtyChange} discardSignal={workspaceDiscard} onWorkbenchSession={openWorkbenchSession} onWorkbenchFailure={openWorkbenchFailure} onOpenMcpLibrary={definitionId => void openMcpLibrary(definitionId)} onPickTool={openTool} /></Suspense> : <EmptyState title={t('tools.preview.configTitle', { name: selectedToolName })} detail={t('tools.preview.emptyDetail')} /> : <EmptyState title={t('tools.empty.title')} detail={t('tools.empty.detail')} action={<Button variant="primary" size="sm" className="empty-state-action" onClick={() => go('settings')}>{t('common.goSettings')}</Button>} />}
        </div>}
        <div hidden={page !== 'library'}>{hasVisited('library') && <Suspense fallback={<PageSkeleton />}><LibraryPage key={remoteIdentity} managedTools={visibleDescriptors} remoteTargetId={remoteTargetId} active={page === 'library'} spotlight={page === 'library' && spotlight?.target === 'library' ? spotlight : null} mcpSpotlight={page === 'library' && spotlight?.target === 'mcp' ? spotlight : null} onOpenConnections={() => { setSpotlight(null); void go('connections'); }} onWorkbenchSession={openWorkbenchSession} onWorkbenchFailure={openWorkbenchFailure} /></Suspense>}</div>
        <div className="records-shell" hidden={page !== 'records'}>{hasVisited('records') && <Suspense fallback={<PageSkeleton />}><RecordsPage key={remoteIdentity} active={page === 'records'} remoteTargetId={remoteTargetId} tools={visibleDescriptors} onOpenProjects={() => go('home')} onWorkbenchSession={openWorkbenchSession} onWorkbenchFailure={openWorkbenchFailure} /></Suspense>}</div>
        <div className={sessionStyles.shell} hidden={page !== 'sessions'}>{(page === 'sessions' || hasVisited('sessions')) && <Suspense fallback={<PageSkeleton />}><SessionWorkbench remoteIntent={remoteWorkbenchIntent} active={page === 'sessions'} tools={visibleDescriptors} remoteSshEnabled={bootstrap.preferences.remote_ssh_enabled} remoteTargetId={remoteTargetId} syncedRemoteTargets={remoteTargets} onRemoteTargetChange={changeRemoteTarget} focusSessionId={workbenchFocus} focusToken={workbenchToken} reviewSignal={reviewSignal} failure={workbenchFailure} onFailure={setWorkbenchFailure} onOpenHome={() => { void go('home'); }} railHost={page === 'sessions' && wideShell ? railHost : null} railSlim={navCollapsed.workbench} onToggleRailSlim={toggleNavCollapsed} onRailLayout={onRailLayout} railToggleRef={workbenchRailToggle} /></Suspense>}</div>
        {page === 'settings' && <Tabs label={t('settings.tabs.label')} items={[['general', t('settings.tabs.general')], ...(bootstrap.preferences.remote_ssh_enabled ? [['hosts', t('settings.tabs.hosts')] as [SettingsTab, string]] : []), ['migration', t('settings.tabs.migration')]]} value={settingsTab} onChange={setSettingsTab} />}
        {page === 'settings' && settingsTab === 'general' && <Suspense fallback={<PageSkeleton />}><GeneralSettings
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
        /></Suspense>}
        {page === 'settings' && settingsTab === 'hosts' && <Suspense fallback={<PageSkeleton />}><RemoteSshSettings enabled={bootstrap.preferences.remote_ssh_enabled} busy={busy} onChange={(enabled) => void updateRemoteSsh(enabled)} showHosts showToggle={false} /></Suspense>}
        <div hidden={page !== 'settings' || settingsTab !== 'migration'}>{hasVisited('settings:migration') && <Suspense fallback={<PageSkeleton />}><MigrationSettings active={page === 'settings' && settingsTab === 'migration'} onImported={() => void refreshAfterImport()} /></Suspense>}</div>
      </>}
    </div></main>
  </div>{nativeAvailable && bootstrap.preferences.remote_ssh_enabled && <RemoteWriteRecovery target={remoteTargets.find(item => item.id === remoteTargetId) ?? null} />}<CommandPalette open={paletteOpen} commands={commands} sourceFailed={paletteSourceFailed} onRetrySources={() => setPaletteReload((value) => value + 1)} onClose={() => setPaletteOpen(false)} /><ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} /><ConfirmationHost /></ToolIconsContext>;
}
