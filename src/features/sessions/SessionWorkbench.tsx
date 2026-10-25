import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import { formatFailure } from '../../lib/feedback';
import { displayPath, shortPath } from '../../lib/paths';
import { writeClipboard } from '../../lib/clipboard';
import { confirmAction } from '../../lib/confirm';
import { modLabel } from '../../lib/shortcut';
import { FilterSelect, type FilterSelectOption } from '../../components/FilterSelect';
import { GuideDialog } from '../../components/GuideDialog';
import { Icon } from '../../components/Icon';
import rowMenuStyles from '../../components/RowMenu.module.css';
import { ToolIcon, toolOptions } from '../../components/ToolIcon';
import type { LaunchMode, LaunchRequest, LaunchResult, LaunchSettings, Project, WorkbenchSession } from '../../types/launch';
import { preferredLaunchMode } from '../../types/launch';
import type { LibraryItem } from '../../types/library';
import type { AdapterDescriptor } from '../../types/native';
import { SessionTerminal, cleanTerminalTitle, encodeBase64, quoteDroppedPaths, type TerminalBridge, type TerminalHandle, type TerminalMatch } from './SessionTerminal';
import { SessionActivityIcon } from './SessionActivityIcon';
import type { TerminalTheme, TerminalThemePreference } from './terminalTheme';
import { SessionRail, type RailFilter, type RailSession, type SessionTone } from './SessionRail';
import { WorkbenchComposer } from './WorkbenchComposer';
import { DENSITY_LINE_HEIGHT, TerminalAppearance, type TerminalDensity } from './TerminalAppearance';
import { WorkbenchEmpty } from './WorkbenchEmpty';
import { WorkbenchShortcuts } from './WorkbenchShortcuts';
import styles from './SessionWorkbench.module.css';

export type WorkbenchRetry =
  | { kind: 'launch'; request: LaunchRequest }
  | { kind: 'resume'; id: string; mode: LaunchMode };

export type WorkbenchFailure = { detail: string; retry: WorkbenchRetry };

export function workbenchSessionId(result: LaunchResult): string | null {
  return result.status === 'session_started' && result.sessionId ? result.sessionId : null;
}

/** Desktop launches never become workbench sessions. Only an explicit workbench preference routes a failure onto this page. */
export async function failedInWorkbench(desktop = false): Promise<boolean> {
  if (desktop || !nativeAvailable) return false;
  try { return (await native.getLaunchSettings()).selected === 'workbench'; }
  catch { return false; }
}

const DEFAULT_RAIL_WIDTH = 272;
const MIN_RAIL_WIDTH = 232;
const MAX_RAIL_WIDTH = 392;
const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 20;
const MAC = /Mac/i.test(navigator.platform || navigator.userAgent);

function readStoredFontSize(): number {
  try {
    const raw = Number(localStorage.getItem('cliora:workbench-font-size'));
    if (Number.isInteger(raw) && raw >= MIN_FONT_SIZE && raw <= MAX_FONT_SIZE) return raw;
  } catch { /* Storage is optional. */ }
  return DEFAULT_FONT_SIZE;
}

function readStoredRailWidth(): number {
  try {
    const raw = Number(localStorage.getItem('cliora:workbench-rail-width'));
    if (Number.isFinite(raw) && raw >= MIN_RAIL_WIDTH && raw <= MAX_RAIL_WIDTH) return Math.round(raw);
  } catch { /* Storage is optional. */ }
  return DEFAULT_RAIL_WIDTH;
}

function readStoredSoundEnabled(): boolean {
  try { return localStorage.getItem('cliora:workbench-sound') !== 'false'; }
  catch { return true; }
}

function readStoredTerminalTheme(): TerminalThemePreference {
  try {
    const raw = localStorage.getItem('cliora:workbench-terminal-theme');
    if (raw === 'dark' || raw === 'light' || raw === 'auto') return raw;
  } catch { /* Storage is optional. */ }
  return 'auto';
}

function readStoredCursorBlink(): boolean {
  try { return localStorage.getItem('cliora:workbench-cursor-blink') !== 'false'; }
  catch { return true; }
}

function readStoredDensity(): TerminalDensity {
  try {
    const raw = localStorage.getItem('cliora:workbench-density');
    if (raw === 'compact' || raw === 'standard' || raw === 'relaxed') return raw;
  } catch { /* Storage is optional. */ }
  return 'standard';
}

function readStoredRailSlim(): boolean {
  try { return localStorage.getItem('cliora:workbench-rail-slim') === 'true'; }
  catch { return false; }
}

function toggleInSet(current: Set<string>, id: string, present: boolean): Set<string> {
  if (current.has(id) === present) return current;
  const next = new Set(current);
  if (present) next.add(id); else next.delete(id);
  return next;
}

type RailArrangement = { pinned: string[]; order: string[] };
const RAIL_ARRANGE_KEY = 'cliora:workbench-rail-arrange';

function readRailArrangement(): RailArrangement {
  try {
    const raw = JSON.parse(localStorage.getItem(RAIL_ARRANGE_KEY) ?? '') as Partial<RailArrangement> | null;
    if (raw && Array.isArray(raw.pinned) && Array.isArray(raw.order)) {
      return { pinned: raw.pinned.filter((id) => typeof id === 'string'), order: raw.order.filter((id) => typeof id === 'string') };
    }
  } catch { /* Storage is optional. */ }
  return { pinned: [], order: [] };
}

function currentAppTheme(): TerminalTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function formatDuration(startedAt: number | undefined, now: number): string {
  if (!startedAt || startedAt <= 0 || now < startedAt) return '';
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

let sharedAudioCtx: AudioContext | null = null;
let lastChimeAt = 0;

function playWorkbenchChime(kind: 'bell' | 'exit') {
  const now = performance.now();
  if (now - lastChimeAt < 350) return;
  lastChimeAt = now;
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    if (!sharedAudioCtx) sharedAudioCtx = new Ctx();
    if (sharedAudioCtx.state === 'suspended') void sharedAudioCtx.resume().catch(() => {});
    const t0 = sharedAudioCtx.currentTime;
    const osc = sharedAudioCtx.createOscillator();
    const gain = sharedAudioCtx.createGain();
    osc.type = 'sine';
    if (kind === 'bell') {
      osc.frequency.setValueAtTime(587.33, t0);
      osc.frequency.exponentialRampToValueAtTime(880, t0 + 0.09);
    } else {
      osc.frequency.setValueAtTime(523.25, t0);
      osc.frequency.exponentialRampToValueAtTime(659.25, t0 + 0.11);
    }
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.06, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    osc.connect(gain);
    gain.connect(sharedAudioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.23);
  } catch { /* Audio is unavailable in restricted contexts. */ }
}

type MenuState =
  | { kind: 'session'; sessionId: string; x: number; y: number; besideId: string | null }
  | { kind: 'terminal'; sessionId: string; x: number; y: number; hasSelection: boolean };

export function SessionWorkbench({ active, tools, focusSessionId, focusToken, failure, onFailure, onOpenHome }: {
  active: boolean;
  tools: AdapterDescriptor[];
  focusSessionId: string | null;
  focusToken: number;
  failure: WorkbenchFailure | null;
  onFailure: (failure: WorkbenchFailure | null) => void;
  onOpenHome: () => void;
}) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<WorkbenchSession[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [libraryPrompts, setLibraryPrompts] = useState<LibraryItem[]>([]);
  const [launchSettings, setLaunchSettings] = useState<LaunchSettings | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(focusSessionId);
  const [loading, setLoading] = useState(nativeAvailable);
  const [listError, setListError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [reload, setReload] = useState(0);

  const [railWidth, setRailWidth] = useState<number>(readStoredRailWidth);
  const [focusMode, setFocusMode] = useState(false);
  const [railFilter, setRailFilter] = useState<RailFilter>('all');
  const [railSearch, setRailSearch] = useState('');
  const [arrangement, setArrangement] = useState<RailArrangement>(readRailArrangement);
  const [fontSize, setFontSize] = useState<number>(readStoredFontSize);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(readStoredSoundEnabled);
  const [themePreference, setThemePreference] = useState<TerminalThemePreference>(readStoredTerminalTheme);
  const [appTheme, setAppTheme] = useState<TerminalTheme>(currentAppTheme);
  const [cursorBlink, setCursorBlink] = useState<boolean>(readStoredCursorBlink);
  const [density, setDensity] = useState<TerminalDensity>(readStoredDensity);
  const [railSlim, setRailSlim] = useState<boolean>(readStoredRailSlim);
  const [split, setSplit] = useState<[string, string] | null>(null);
  const [unreadIds, setUnreadIds] = useState<Set<string>>(() => new Set());
  const [grids, setGrids] = useState<Map<string, { cols: number; rows: number }>>(() => new Map());
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [findCase, setFindCase] = useState(false);
  const terminalMode: TerminalTheme = themePreference === 'auto' ? appTheme : themePreference;

  const [attentionIds, setAttentionIds] = useState<Set<string>>(() => new Set());
  const [activeOutputIds, setActiveOutputIds] = useState<Set<string>>(() => new Set());
  const [scrolledIds, setScrolledIds] = useState<Set<string>>(() => new Set());
  const [titles, setTitles] = useState<Map<string, string>>(() => new Map());
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuBox, setMenuBox] = useState<{ top: number; left: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrowFrame, setNarrowFrame] = useState(false);
  const [compactFrame, setCompactFrame] = useState(false);
  const [splitRoom, setSplitRoom] = useState(true);

  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [launchToolId, setLaunchToolId] = useState('');
  const [workspaceValue, setWorkspaceValue] = useState('__home');
  const [customFolderPath, setCustomFolderPath] = useState('');
  const [launchMode, setLaunchMode] = useState<LaunchMode>('normal');
  const [resumeLatest, setResumeLatest] = useState(false);
  const [initialPrompt, setInitialPrompt] = useState('');
  const [launchingNew, setLaunchingNew] = useState(false);
  const [dialogError, setDialogError] = useState('');

  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findMatches, setFindMatches] = useState<TerminalMatch[]>([]);
  const [findIndex, setFindIndex] = useState(0);
  const [findRevision, setFindRevision] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const findIndexRef = useRef(0);
  const findKeyRef = useRef('');
  const findRefreshTimer = useRef(0);

  const [composerOpen, setComposerOpen] = useState(false);
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({});
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const [copiedState, setCopiedState] = useState<'path' | 'output' | 'selection' | 'empty' | null>(null);
  const copyTimerRef = useRef<number>(0);

  const firstSeenAt = useRef(new Map<string, number>());
  const [clock, setClock] = useState(() => Date.now());
  const writers = useRef(new Map<string, (data: string) => void>());
  const pending = useRef(new Map<string, string[]>());
  const pendingBytes = useRef(new Map<string, number>());
  const handles = useRef(new Map<string, TerminalHandle>());
  const MAX_PENDING_OUTPUT_BYTES = 512 * 1024;
  // Ended sessions keep their xterm buffers alive; mounting only the running, selected,
  // and recently selected terminals bounds that memory. Re-selecting remounts from replay.
  const MOUNTED_ENDED_LIMIT = 6;
  const [recentSessionIds, setRecentSessionIds] = useState<string[]>([]);
  useEffect(() => {
    if (!selectedId) return;
    setRecentSessionIds((current) => current[0] === selectedId ? current : [selectedId, ...current.filter((id) => id !== selectedId)].slice(0, MOUNTED_ENDED_LIMIT));
  }, [selectedId]);

  // Split view keeps two panes in fixed positions. Selecting a session that is not on
  // screen replaces the pane that had focus; selecting the other pane only moves focus.
  const previousSelectedRef = useRef(selectedId);
  useEffect(() => {
    const previous = previousSelectedRef.current;
    previousSelectedRef.current = selectedId;
    if (!selectedId) { setSplit(null); return; }
    setSplit((current) => {
      if (!current || current.includes(selectedId)) return current;
      const slot = previous ? current.indexOf(previous) : -1;
      const next: [string, string] = [current[0], current[1]];
      next[slot >= 0 ? slot : 0] = selectedId;
      return next[0] === next[1] ? null : next;
    });
  }, [selectedId]);
  const visibleIds = useMemo(() => split ?? (selectedId ? [selectedId] : []), [split, selectedId]);
  const visibleIdsRef = useRef(visibleIds);
  visibleIdsRef.current = visibleIds;
  useEffect(() => {
    setUnreadIds((current) => visibleIds.some((id) => current.has(id)) ? new Set([...current].filter((id) => !visibleIds.includes(id))) : current);
  }, [visibleIds]);
  useEffect(() => {
    setSplit((current) => current && current.every((id) => sessions.some((item) => item.id === id)) ? current : null);
  }, [sessions]);

  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const findOpenRef = useRef(findOpen);
  findOpenRef.current = findOpen;
  const findQueryRef = useRef(findQuery);
  findQueryRef.current = findQuery;

  // WebView2 can resolve a stale container query width; observe the actual workbench instead.
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const update = () => {
      const width = node.clientWidth;
      setNarrowFrame((current) => current === width <= 720 ? current : width <= 720);
      setCompactFrame((current) => current === width <= 620 ? current : width <= 620);
      setSplitRoom((current) => current === width >= 860 ? current : width >= 860);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const terminalTools = useMemo(
    () => tools.filter((item) => item.launchForm !== 'desktop' && item.launch?.state !== 'unsupported'),
    [tools],
  );
  const effectiveLaunchToolId = useMemo(
    () => terminalTools.some((item) => item.id === launchToolId) ? launchToolId : terminalTools[0]?.id ?? '',
    [terminalTools, launchToolId],
  );
  const selectedLaunchTool = useMemo(
    () => terminalTools.find((item) => item.id === effectiveLaunchToolId) ?? null,
    [terminalTools, effectiveLaunchToolId],
  );
  const selected = sessions.find((item) => item.id === selectedId) ?? null;
  const showEmpty = !loading && !sessions.length;
  const runningCount = sessions.filter((item) => item.running).length;
  const endedCount = sessions.length - runningCount;

  function flashCopied(state: 'path' | 'output' | 'selection' | 'empty') {
    window.clearTimeout(copyTimerRef.current);
    setCopiedState(state);
    copyTimerRef.current = window.setTimeout(() => setCopiedState(null), 1800);
  }

  const updateFontSize = useCallback((nextSize: number) => {
    const clamped = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, nextSize));
    setFontSize(clamped);
    try { localStorage.setItem('cliora:workbench-font-size', String(clamped)); } catch { /* Storage is optional. */ }
  }, []);

  function openFind() {
    setAppearanceOpen(false);
    setShortcutsOpen(false);
    setFindOpen(true);
    requestAnimationFrame(() => { findInputRef.current?.focus(); findInputRef.current?.select(); });
  }

  function toggleComposer(target?: boolean) {
    const next = target ?? !composerOpen;
    setAppearanceOpen(false);
    setComposerOpen(next);
    if (next) requestAnimationFrame(() => composerInputRef.current?.focus());
    else if (selectedId) handles.current.get(selectedId)?.focus();
  }

  const closeAppearance = useCallback(() => setAppearanceOpen(false), []);
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);

  const bridge = useRef<TerminalBridge>(null as unknown as TerminalBridge);
  bridge.current = {
    writeError: (error) => setActionError(formatFailure(error, t('sessions.writeFailed'), t('sessions.retry'))),
    linkError: (error) => setActionError(formatFailure(error, t('common.externalLink.openFailed'), t('sessions.retry'))),
    bell: (id) => {
      if (soundEnabledRef.current) playWorkbenchChime('bell');
      if (id === selectedIdRef.current && document.hasFocus()) return;
      setAttentionIds((current) => {
        if (current.has(id)) return current;
        const next = new Set(current);
        next.add(id);
        return next;
      });
    },
    title: (id, raw) => {
      const title = cleanTerminalTitle(raw);
      setTitles((current) => {
        if ((current.get(id) ?? '') === title) return current;
        const next = new Map(current);
        if (title) next.set(id, title); else next.delete(id);
        return next;
      });
    },
    outputActive: (id, isActive) => {
      setActiveOutputIds((current) => toggleInSet(current, id, isActive));
      if (isActive && !visibleIdsRef.current.includes(id)) setUnreadIds((current) => toggleInSet(current, id, true));
    },
    outputWritten: (id) => {
      if (id !== selectedIdRef.current || !findOpenRef.current || !findQueryRef.current.trim() || findRefreshTimer.current) return;
      findRefreshTimer.current = window.setTimeout(() => {
        findRefreshTimer.current = 0;
        setFindRevision((current) => current + 1);
      }, 140);
    },
    shortcut: (action) => {
      if (action === 'find') openFind();
      else if (action === 'composer') { if (selected?.running) toggleComposer(); }
      else if (action === 'split') toggleSplit();
      else if (action === 'zoomIn') updateFontSize(fontSize + 1);
      else if (action === 'zoomOut') updateFontSize(fontSize - 1);
      else if (action === 'zoomReset') updateFontSize(DEFAULT_FONT_SIZE);
      else if (action === 'newSession') { if (terminalTools.length) openNewSessionDialog(); }
      else stepSession(action === 'nextSession' ? 1 : -1);
    },
    canSwitch: () => filteredSessions.length > 1,
    scrolled: (id, away) => setScrolledIds((current) => {
      if (current.has(id) === away) return current;
      const next = new Set(current);
      if (away) next.add(id); else next.delete(id);
      return next;
    }),
    copied: () => flashCopied('selection'),
    grid: (id, cols, rows) => setGrids((current) => {
      const known = current.get(id);
      if (known && known.cols === cols && known.rows === rows) return current;
      const next = new Map(current);
      next.set(id, { cols, rows });
      return next;
    }),
  };

  useEffect(() => { if (focusSessionId) setSelectedId(focusSessionId); }, [focusSessionId, focusToken]);

  useEffect(() => {
    if (!selectedId) return;
    setAttentionIds((current) => {
      if (!current.has(selectedId)) return current;
      const next = new Set(current);
      next.delete(selectedId);
      return next;
    });
  }, [selectedId]);

  useEffect(() => {
    const observer = new MutationObserver(() => setAppTheme(currentAppTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    window.clearTimeout(copyTimerRef.current);
    window.clearTimeout(findRefreshTimer.current);
  }, []);

  useEffect(() => {
    if (!active || !sessions.some((item) => item.running)) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [active, sessions]);

  useEffect(() => {
    if (!nativeAvailable) { setLoading(false); return; }
    let alive = true;
    const stops: Array<() => void> = [];
    const push = (sessionId: string, data: string) => {
      const write = writers.current.get(sessionId);
      if (write) write(data);
      else {
        const queued = pending.current.get(sessionId) ?? [];
        let bytes = pendingBytes.current.get(sessionId) ?? 0;
        queued.push(data);
        bytes += data.length;
        // A terminal that is not mounted can still receive output while the
        // session list is loading. Keep only a bounded tail; replay() supplies
        // the complete recent output when the terminal mounts.
        while (bytes > MAX_PENDING_OUTPUT_BYTES && queued.length > 1) {
          bytes -= queued.shift()?.length ?? 0;
        }
        pending.current.set(sessionId, queued);
        pendingBytes.current.set(sessionId, bytes);
      }
    };
    void listen<{ sessionId: string; dataBase64: string }>('cliora:session-output', (event) => {
      if (alive) push(event.payload.sessionId, event.payload.dataBase64);
    }).then((stop) => { if (alive) stops.push(stop); else stop(); }).catch(() => {});
    void listen<{ sessionId: string; exitCode: number | null }>('cliora:session-exit', (event) => {
      if (!alive) return;
      if (soundEnabledRef.current) playWorkbenchChime('exit');
      setActiveOutputIds((current) => {
        if (!current.has(event.payload.sessionId)) return current;
        const next = new Set(current);
        next.delete(event.payload.sessionId);
        return next;
      });
      setSessions((current) => current.map((item) => item.id === event.payload.sessionId ? { ...item, running: false, exitCode: event.payload.exitCode ?? null } : item));
    }).then((stop) => { if (alive) stops.push(stop); else stop(); }).catch(() => {});
    return () => { alive = false; stops.forEach((stop) => { void Promise.resolve(stop()).catch(() => {}); }); };
  }, []);

  useEffect(() => {
    if (!active || !nativeAvailable) return;
    let alive = true;
    setLoading(true);
    void Promise.all([
      native.listWorkbenchSessions(),
      native.listProjects().catch(() => [] as Project[]),
      native.listLibraryItems('prompt', null, '').catch(() => [] as LibraryItem[]),
      native.getLaunchSettings().catch(() => null),
    ]).then(([listed, listedProjects, prompts, settings]) => {
      if (!alive) return;
      const next = Array.isArray(listed) ? listed : [];
      const now = Date.now();
      for (const item of next) if (!firstSeenAt.current.has(item.id)) firstSeenAt.current.set(item.id, item.startedAt ?? now);
      setSessions(next);
      setProjects(Array.isArray(listedProjects) ? listedProjects : []);
      setLibraryPrompts(Array.isArray(prompts) ? prompts : []);
      if (settings) setLaunchSettings(settings);
      setListError('');
      setSelectedId((current) => {
        if (focusSessionId && next.some((item) => item.id === focusSessionId)) return focusSessionId;
        if (current && next.some((item) => item.id === current)) return current;
        return next.find((item) => item.running)?.id ?? next[0]?.id ?? null;
      });
      for (const session of next) {
        const queued = pending.current.get(session.id);
        const write = writers.current.get(session.id);
        if (queued?.length && write) {
          queued.splice(0).forEach(write);
          pending.current.delete(session.id);
        }
        if (!pending.current.has(session.id)) pendingBytes.current.delete(session.id);
      }
    }).catch((value) => {
      if (alive) setListError(formatFailure(value, t('sessions.listFailed'), t('sessions.listNext')));
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [active, focusToken, focusSessionId, reload, t]);

  useEffect(() => {
    if (!selectedLaunchTool?.yoloAvailable && launchMode === 'yolo') setLaunchMode('normal');
    if (!selectedLaunchTool?.resumeLatestAvailable && resumeLatest) setResumeLatest(false);
  }, [selectedLaunchTool, launchMode, resumeLatest]);

  useEffect(() => {
    if (!findOpen || !selectedId || !findQuery.trim()) {
      setFindMatches([]);
      setFindIndex(0);
      findIndexRef.current = 0;
      findKeyRef.current = '';
      if (selectedId) handles.current.get(selectedId)?.revealMatch(null);
      return;
    }
    const handle = handles.current.get(selectedId);
    if (!handle) return;
    const matches = handle.findMatches(findQuery, findCase);
    const key = selectedId + '\n' + findQuery + '\n' + findCase;
    const nextIndex = key === findKeyRef.current ? Math.min(findIndexRef.current, Math.max(0, matches.length - 1)) : 0;
    findKeyRef.current = key;
    findIndexRef.current = nextIndex;
    setFindMatches(matches);
    setFindIndex(nextIndex);
    handle.revealMatch(matches[nextIndex] ?? null);
  }, [findOpen, findQuery, findCase, selectedId, findRevision]);

  useEffect(() => { if (!splitRoom) setSplit(null); }, [splitRoom]);

  function toggleSplit() {
    if (split) {
      setSplit(null);
      return;
    }
    const current = selectedIdRef.current;
    if (!current || !splitRoom) return;
    const others = sessionsRef.current.filter((item) => item.id !== current);
    if (!others.length) return;
    const partner = recentSessionIds.find((id) => id !== current && others.some((item) => item.id === id))
      ?? (others.find((item) => item.running) ?? others[0]).id;
    setRailFilter('all');
    setSplit([current, partner]);
  }

  function closePane(id: string) {
    const other = split?.find((item) => item !== id) ?? null;
    setSplit(null);
    if (other && selectedIdRef.current === id) setSelectedId(other);
  }

  const updateDensity = useCallback((next: TerminalDensity) => {
    setDensity(next);
    try { localStorage.setItem('cliora:workbench-density', next); } catch { /* Storage is optional. */ }
  }, []);

  const toggleRailSlim = useCallback(() => {
    setRailSlim((current) => {
      const next = !current;
      try { localStorage.setItem('cliora:workbench-rail-slim', String(next)); } catch { /* Storage is optional. */ }
      return next;
    });
  }, []);

  const toggleSound = useCallback(() => {
    setSoundEnabled((current) => {
      const next = !current;
      try { localStorage.setItem('cliora:workbench-sound', String(next)); } catch { /* Storage is optional. */ }
      if (next) playWorkbenchChime('bell');
      return next;
    });
  }, []);

  const toggleCursorBlink = useCallback(() => {
    setCursorBlink((current) => {
      const next = !current;
      try { localStorage.setItem('cliora:workbench-cursor-blink', String(next)); } catch { /* Storage is optional. */ }
      return next;
    });
  }, []);

  const setTerminalTheme = useCallback((next: TerminalThemePreference) => {
    setThemePreference(next);
    try { localStorage.setItem('cliora:workbench-terminal-theme', next); } catch { /* Storage is optional. */ }
  }, []);

  const updateRailWidth = useCallback((nextWidth: number) => {
    const clamped = Math.max(MIN_RAIL_WIDTH, Math.min(MAX_RAIL_WIDTH, Math.round(nextWidth)));
    setRailWidth(clamped);
    try { localStorage.setItem('cliora:workbench-rail-width', String(clamped)); } catch { /* Storage is optional. */ }
  }, []);

  function startRailResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startW = railWidth;
    document.body.dataset.resizing = 'col';
    const onMove = (moveEvent: PointerEvent) => updateRailWidth(startW + (moveEvent.clientX - startX));
    const onUp = () => {
      delete document.body.dataset.resizing;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function placeOf(session: WorkbenchSession): string {
    const project = session.projectId ? projects.find((item) => item.id === session.projectId) : undefined;
    if (project?.name) return project.name;
    if (session.directory) return shortPath(displayPath(session.directory));
    return t('sessions.placeUnknown');
  }

  function toolName(session: WorkbenchSession): string {
    return tools.find((item) => item.id === session.toolId)?.name ?? session.toolId;
  }

  function taskTitle(session: WorkbenchSession): string {
    const title = titles.get(session.id) ?? '';
    const name = toolName(session);
    return title && title.toLowerCase() !== name.toLowerCase() ? title : '';
  }

  function modeLabel(mode: LaunchMode): string {
    return mode === 'yolo' ? t('sessions.modeYolo') : t('sessions.modeNormal');
  }

  function sessionTone(session: WorkbenchSession): SessionTone {
    if (!session.running) return session.exitCode != null && session.exitCode !== 0 ? 'error' : 'ended';
    if (attentionIds.has(session.id)) return 'bell';
    if (activeOutputIds.has(session.id)) return 'live';
    return 'idle';
  }

  function forgetSession(id: string) {
    firstSeenAt.current.delete(id);
    setTitles((current) => { if (!current.has(id)) return current; const next = new Map(current); next.delete(id); return next; });
    setActiveOutputIds((current) => { if (!current.has(id)) return current; const next = new Set(current); next.delete(id); return next; });
    setScrolledIds((current) => { if (!current.has(id)) return current; const next = new Set(current); next.delete(id); return next; });
    setAttentionIds((current) => { if (!current.has(id)) return current; const next = new Set(current); next.delete(id); return next; });
    setUnreadIds((current) => toggleInSet(current, id, false));
    setGrids((current) => { if (!current.has(id)) return current; const next = new Map(current); next.delete(id); return next; });
    setComposerDrafts((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    pending.current.delete(id);
    pendingBytes.current.delete(id);
    writers.current.delete(id);
    handles.current.delete(id);
  }

  async function endSession(session: WorkbenchSession) {
    if (busy) return;
    if (session.running) {
      const accepted = await confirmAction(
        t('sessions.endConfirmMessage', { tool: toolName(session), place: placeOf(session) }),
        () => sessionsRef.current.some((item) => item.id === session.id && item.running),
        { title: t('sessions.endConfirmTitle'), confirmLabel: t('sessions.endConfirmAction'), destructive: true },
      );
      if (!accepted || busy) return;
    }
    setBusy(session.id);
    setActionError('');
    try {
      await native.closeWorkbenchSession(session.id);
      forgetSession(session.id);
      const rest = sessionsRef.current.filter((item) => item.id !== session.id);
      setSessions(rest);
      setSelectedId((current) => current === session.id ? (rest.find((item) => item.running)?.id ?? rest[0]?.id ?? null) : current);
    } catch (value) {
      setActionError(formatFailure(value, t('sessions.closeFailed'), t('sessions.closeNext')));
    } finally { setBusy(''); }
  }

  async function clearEndedSessions() {
    const ended = sessions.filter((item) => !item.running);
    if (!ended.length || busy) return;
    setBusy('__clear_ended');
    setActionError('');
    try {
      const closedIds = new Set<string>();
      for (const session of ended) {
        await native.closeWorkbenchSession(session.id);
        closedIds.add(session.id);
        forgetSession(session.id);
      }
      const rest = sessions.filter((item) => !closedIds.has(item.id));
      setSessions(rest);
      if (railFilter === 'ended') setRailFilter('all');
      setSelectedId((current) => current && closedIds.has(current) ? (rest.find((item) => item.running)?.id ?? rest[0]?.id ?? null) : current);
    } catch (value) {
      setActionError(formatFailure(value, t('sessions.closeFailed'), t('sessions.closeNext')));
    } finally { setBusy(''); }
  }

  async function retry() {
    if (!failure || retrying) return;
    setRetrying(true);
    setNotice('');
    setActionError('');
    try {
      const result = failure.retry.kind === 'launch' ? await native.launchCli(failure.retry.request) : await native.resumeHistorySession(failure.retry.id, failure.retry.mode);
      const opened = workbenchSessionId(result);
      if (opened) {
        onFailure(null);
        setSelectedId(opened);
        const listed = await native.listWorkbenchSessions().catch(() => sessions);
        if (Array.isArray(listed)) setSessions(listed);
        return;
      }
      onFailure(null);
      setNotice(result.status === 'desktop_requested' ? t('sessions.desktopOpened') : t('sessions.externalOpened'));
    } catch (value) {
      onFailure({ ...failure, detail: formatFailure(value, t('sessions.launchFailed'), t('sessions.failureHint')) });
    } finally { setRetrying(false); }
  }

  function openNewSessionDialog(prefill?: { toolId?: string; projectId?: string }) {
    setDialogError('');
    let nextToolId = effectiveLaunchToolId;
    if (prefill?.projectId) {
      const project = projects.find((item) => item.id === prefill.projectId);
      setWorkspaceValue('project:' + prefill.projectId);
      if (project?.preferredTool && terminalTools.some((item) => item.id === project.preferredTool)) nextToolId = project.preferredTool;
    }
    if (prefill?.toolId && terminalTools.some((item) => item.id === prefill.toolId)) nextToolId = prefill.toolId;
    if (prefill) {
      setLaunchToolId(nextToolId);
      const nextTool = terminalTools.find((item) => item.id === nextToolId);
      setLaunchMode(preferredLaunchMode(launchSettings, prefill.projectId ? 'project' : 'cli', !!nextTool?.yoloAvailable));
    }
    setNewDialogOpen(true);
  }

  async function pickCustomWorkspaceFolder() {
    try {
      const picked = await open({ directory: true, multiple: false, title: t('sessions.pickFolder') });
      if (typeof picked === 'string' && picked.trim()) {
        const clean = picked.trim();
        setCustomFolderPath(clean);
        setWorkspaceValue(`custom:${clean}`);
      }
    } catch { /* Folder dialog cancellation needs no feedback. */ }
  }

  async function launchFromDialog() {
    if (!effectiveLaunchToolId || launchingNew) return;
    setLaunchingNew(true);
    setDialogError('');
    setActionError('');
    setNotice('');
    try {
      if (launchSettings && launchSettings.selected !== 'workbench') {
        const updated = await native.setPreferredTerminal('workbench').catch(() => null);
        if (updated) setLaunchSettings(updated);
      }
      const projectId = workspaceValue.startsWith('project:') ? workspaceValue.slice('project:'.length) : null;
      const directory = workspaceValue.startsWith('custom:') ? workspaceValue.slice('custom:'.length) : null;
      const promptText = initialPrompt.trim() || null;
      const request: LaunchRequest = {
        toolId: effectiveLaunchToolId,
        projectId,
        sessionId: null,
        mode: selectedLaunchTool?.yoloAvailable ? launchMode : 'normal',
        directory,
        ...(promptText ? { initialPrompt: promptText } : {}),
        ...(resumeLatest && selectedLaunchTool?.resumeLatestAvailable ? { resumeLatest: true } : {}),
      };
      const result = await native.launchCli(request);
      const opened = workbenchSessionId(result);
      if (opened) {
        onFailure(null);
        setNewDialogOpen(false);
        setInitialPrompt('');
        setRailFilter('all');
        setSelectedId(opened);
        const listed = await native.listWorkbenchSessions().catch(() => sessions);
        if (Array.isArray(listed)) setSessions(listed);
        return;
      }
      setNewDialogOpen(false);
      setNotice(result.status === 'desktop_requested' ? t('sessions.desktopOpened') : t('sessions.externalOpened'));
    } catch (value) {
      setDialogError(formatFailure(value, t('sessions.launchFailed'), t('sessions.failureHint')));
    } finally { setLaunchingNew(false); }
  }

  async function restartOrCloneSession(session: WorkbenchSession, replaceEnded: boolean) {
    if (busy) return;
    setBusy(replaceEnded ? `restart:${session.id}` : `clone:${session.id}`);
    setActionError('');
    setNotice('');
    try {
      if (launchSettings && launchSettings.selected !== 'workbench') {
        const updated = await native.setPreferredTerminal('workbench').catch(() => null);
        if (updated) setLaunchSettings(updated);
      }
      const result = await native.launchCli({
        toolId: session.toolId,
        projectId: session.projectId,
        sessionId: null,
        mode: session.mode,
        directory: session.directory || null,
      });
      const opened = workbenchSessionId(result);
      if (opened) {
        if (replaceEnded && !session.running) {
          await native.closeWorkbenchSession(session.id).catch(() => {});
          forgetSession(session.id);
        }
        onFailure(null);
        setSelectedId(opened);
        const listed = await native.listWorkbenchSessions().catch(() => sessions);
        if (Array.isArray(listed)) setSessions(listed);
        return;
      }
      setNotice(result.status === 'desktop_requested' ? t('sessions.desktopOpened') : t('sessions.externalOpened'));
    } catch (value) {
      setActionError(formatFailure(value, t('sessions.launchFailed'), t('sessions.failureHint')));
    } finally { setBusy(''); }
  }

  async function sendToSession(session: WorkbenchSession, rawText: string): Promise<boolean> {
    if (!session.running || !rawText) return false;
    setActionError('');
    try {
      await native.writeWorkbenchSession(session.id, encodeBase64(new TextEncoder().encode(rawText)));
      if (selectedIdRef.current === session.id) handles.current.get(session.id)?.focus();
      return true;
    } catch (error) {
      bridge.current.writeError(error);
      return false;
    }
  }

  async function submitComposer() {
    if (!selected || !selected.running) return;
    const text = composerDrafts[selected.id] ?? '';
    if (!await sendToSession(selected, text ? `${text}\r` : '\r')) return;
    if (text) setComposerDrafts((current) => current[selected.id] === text ? { ...current, [selected.id]: '' } : current);
    if (selectedIdRef.current === selected.id) requestAnimationFrame(() => composerInputRef.current?.focus());
  }

  function updateComposerDraft(text: string) {
    if (!selectedId) return;
    setComposerDrafts((current) => ({ ...current, [selectedId]: text }));
  }

  async function copySessionPath(session: WorkbenchSession) {
    const value = session.directory ? displayPath(session.directory) : '';
    if (value && await writeClipboard(value)) flashCopied('path');
  }

  async function copyTerminalOutput(session: WorkbenchSession) {
    const text = handles.current.get(session.id)?.readOutput() ?? '';
    if (!text.trim()) { flashCopied('empty'); return; }
    if (await writeClipboard(text)) flashCopied('output');
  }

  async function pasteIntoSession(session: WorkbenchSession) {
    const handle = handles.current.get(session.id);
    if (!handle || !session.running) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) handle.paste(text);
      handle.focus();
    } catch {
      setNotice(t('sessions.pasteFailed', { shortcut: `${modLabel}+V` }));
      handle.focus();
    }
  }

  function stepFindMatch(delta: -1 | 1) {
    if (!findMatches.length || !selectedId) return;
    const next = (findIndexRef.current + delta + findMatches.length) % findMatches.length;
    findIndexRef.current = next;
    setFindIndex(next);
    handles.current.get(selectedId)?.revealMatch(findMatches[next] ?? null);
  }

  function closeFind() {
    setFindOpen(false);
    if (selectedId) handles.current.get(selectedId)?.focus();
  }

  const filteredSessions = useMemo(() => {
    const query = railSearch.trim().toLowerCase();
    return sessions.filter((session) => {
      if (railFilter === 'running' && !session.running) return false;
      if (railFilter === 'ended' && session.running) return false;
      if (!query) return true;
      return toolName(session).toLowerCase().includes(query)
        || (titles.get(session.id) ?? '').toLowerCase().includes(query)
        || placeOf(session).toLowerCase().includes(query)
        || (session.directory ?? '').toLowerCase().includes(query);
    });
  }, [sessions, railFilter, railSearch, projects, tools, titles]);

  const arrangedSessions = useMemo(() => {
    const present = new Set(filteredSessions.map((session) => session.id));
    const pinned = arrangement.pinned.filter((id) => present.has(id));
    const pinnedSet = new Set(pinned);
    const rest = filteredSessions.filter((session) => !pinnedSet.has(session.id));
    const rank = new Map(arrangement.order.map((id, index) => [id, index]));
    rest.sort((a, b) => {
      const ra = rank.get(a.id);
      const rb = rank.get(b.id);
      if (ra === rb) return 0;
      if (ra === undefined) return -1;
      if (rb === undefined) return 1;
      return ra - rb;
    });
    const byId = new Map(filteredSessions.map((session) => [session.id, session]));
    return [...pinned.map((id) => byId.get(id)!), ...rest];
  }, [filteredSessions, arrangement]);

  useEffect(() => {
    try { localStorage.setItem(RAIL_ARRANGE_KEY, JSON.stringify(arrangement)); } catch { /* Storage is optional. */ }
  }, [arrangement]);

  const pinnedIds = useMemo(() => new Set(arrangement.pinned), [arrangement]);

  function togglePinSession(id: string) {
    setArrangement((current) => current.pinned.includes(id)
      ? { pinned: current.pinned.filter((item) => item !== id), order: current.order }
      : { pinned: [...current.pinned, id], order: current.order.filter((item) => item !== id) });
  }

  function stepSession(step: 1 | -1) {
    if (arrangedSessions.length < 2) return;
    setSelectedId((current) => {
      const index = arrangedSessions.findIndex((item) => item.id === current);
      return arrangedSessions[(index + step + arrangedSessions.length) % arrangedSessions.length].id;
    });
  }

  useEffect(() => { if (!menu) setMenuBox(null); }, [menu]);
  useLayoutEffect(() => {
    if (!menu) return;
    const node = menuRef.current;
    if (!node) return;
    const left = Math.max(8, Math.min(menu.x, window.innerWidth - node.offsetWidth - 8));
    const top = Math.max(8, Math.min(menu.y, window.innerHeight - node.offsetHeight - 8));
    setMenuBox({ top, left });
    node.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      const current = menu;
      setMenu(null);
      if (current.kind === 'session') document.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(current.sessionId)}"]`)?.focus();
      else handles.current.get(current.sessionId)?.focus();
    };
    const close = () => setMenu(null);
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  function openRowMenu(session: WorkbenchSession, x: number, y: number) {
    const previous = selectedIdRef.current;
    setSelectedId(session.id);
    setAppearanceOpen(false);
    setShortcutsOpen(false);
    setMenu({ kind: 'session', sessionId: session.id, x, y, besideId: previous && previous !== session.id ? previous : null });
  }

  function openTerminalMenu(session: WorkbenchSession, x: number, y: number) {
    setAppearanceOpen(false);
    setMenu({ kind: 'terminal', sessionId: session.id, x, y, hasSelection: !!handles.current.get(session.id)?.hasSelection() });
  }

  function menuNavigate(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = [...menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []];
    if (!items.length) return;
    if (event.key === 'Tab') { event.preventDefault(); setMenu(null); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }

  const availableProjects = useMemo(() => projects.filter((item) => item.available && item.path), [projects]);

  useEffect(() => {
    if (!active || newDialogOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const mod = MAC ? event.metaKey : event.ctrlKey;
      if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f' && selectedIdRef.current) {
        event.preventDefault();
        openFind();
        return;
      }
      if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'm' && selected?.running) {
        event.preventDefault();
        toggleComposer();
        return;
      }
      if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'd' && selectedIdRef.current) {
        event.preventDefault();
        toggleSplit();
        return;
      }
      if (event.ctrlKey && !event.altKey && !event.metaKey && event.key === 'Tab' && filteredSessions.length > 1) {
        event.preventDefault();
        stepSession(event.shiftKey ? -1 : 1);
        return;
      }
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (step) {
        if (filteredSessions.length < 2) return;
        event.preventDefault();
        stepSession(step);
        return;
      }
      if (event.key.toLowerCase() === 'n' && terminalTools.length > 0) {
        event.preventDefault();
        openNewSessionDialog();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, newDialogOpen, filteredSessions, terminalTools, selected?.running]);

  useEffect(() => {
    if (!active || !nativeAvailable) return;
    let alive = true;
    let stop: (() => void) | null = null;
    // The pane under the pointer receives the paths; in a split that need not be the focused one.
    const paneAt = (position: { x: number; y: number } | undefined): string | null => {
      if (!position || document.querySelector('dialog[open]')) return null;
      const scale = window.devicePixelRatio || 1;
      const x = position.x / scale;
      const y = position.y / scale;
      const panes = canvasRef.current?.querySelectorAll<HTMLElement>('[data-pane-session]:not([hidden])') ?? [];
      for (const pane of panes) {
        const rect = pane.getBoundingClientRect();
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
        const id = pane.dataset.paneSession ?? '';
        return sessionsRef.current.some((item) => item.id === id && item.running) ? id : null;
      }
      return null;
    };
    try {
      void getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload as { type: string; paths?: string[]; position?: { x: number; y: number } };
        if (payload.type === 'leave') { setDropTarget(null); return; }
        if (payload.type === 'enter' || payload.type === 'over') { setDropTarget(paneAt(payload.position)); return; }
        if (payload.type === 'drop') {
          setDropTarget(null);
          const id = paneAt(payload.position);
          if (!id) return;
          const text = quoteDroppedPaths(payload.paths ?? []);
          const handle = handles.current.get(id);
          if (!text || !handle) return;
          setSelectedId(id);
          handle.paste(text);
          handle.focus();
        }
      }).then((unlisten) => { if (alive) stop = unlisten; else unlisten(); }).catch(() => {});
    } catch { /* Browser previews have no native drag events. */ }
    return () => { alive = false; stop?.(); setDropTarget(null); };
  }, [active]);

  const cliSelectOptions = useMemo<FilterSelectOption[]>(() => toolOptions(terminalTools), [terminalTools]);
  const workspaceSelectOptions = useMemo<FilterSelectOption[]>(() => {
    const list: FilterSelectOption[] = [
      { value: '__home', label: t('sessions.workspaceHome'), icon: <Icon name="home" size={14} /> },
      ...availableProjects.map((project) => ({ value: `project:${project.id}`, label: project.name, detail: project.path ? shortPath(displayPath(project.path)) : undefined, icon: <Icon name="folder" size={14} /> })),
    ];
    if (customFolderPath) list.push({ value: `custom:${customFolderPath}`, label: shortPath(displayPath(customFolderPath)), detail: displayPath(customFolderPath), icon: <Icon name="folder" size={14} /> });
    return list;
  }, [availableProjects, customFolderPath, t]);

  const railSessions: RailSession[] = arrangedSessions.map((session) => ({
    session,
    name: toolName(session),
    title: taskTitle(session),
    place: placeOf(session),
    directory: session.directory ? displayPath(session.directory) : '',
    elapsed: formatDuration(session.startedAt ?? firstSeenAt.current.get(session.id), clock),
    tone: sessionTone(session),
    pinned: pinnedIds.has(session.id),
    attention: attentionIds.has(session.id),
    unread: unreadIds.has(session.id),
    pane: split ? (split.indexOf(session.id) >= 0 ? split.indexOf(session.id) : null) : null,
  }));

  const copiedMessage = copiedState === 'path' ? t('sessions.pathCopied')
    : copiedState === 'output' ? t('sessions.outputCopied')
      : copiedState === 'selection' ? t('sessions.selectionCopied') : t('sessions.outputEmpty');

  function stateLabel(session: WorkbenchSession, tone: SessionTone): string {
    if (!session.running) return tone === 'error' ? t('sessions.stateError') : t('sessions.ended');
    if (tone === 'bell') return t('sessions.bellBadge');
    return tone === 'live' ? t('sessions.stateStreaming') : t('sessions.stateIdle');
  }

  const mountedSessions = sessions.filter((session) => session.running || visibleIds.includes(session.id) || recentSessionIds.includes(session.id));

  return <div ref={rootRef} className={styles.root} data-focus-mode={focusMode || undefined} data-empty={(showEmpty && !listError) || undefined} data-term-theme={terminalMode} data-narrow={narrowFrame || undefined} data-compact={compactFrame || undefined} data-rail-slim={(railSlim && !narrowFrame) || undefined}>
    {(focusMode || (showEmpty && !listError)) && <h1 className={styles.srOnly} tabIndex={-1}>{t('common.pages.sessions.title')}</h1>}
    {listError && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><strong>{t('sessions.listFailed')}</strong><p>{listError}</p></div><button type="button" className={styles.ghostButton} onClick={() => setReload((value) => value + 1)}>{t('sessions.retry')}</button></div>}

    <div className={styles.layout} style={{ '--rail-w': railWidth + 'px' } as CSSProperties}>
      <SessionRail sessions={railSessions} total={sessions.length} running={runningCount} ended={endedCount} filter={railFilter} search={railSearch} selectedId={selectedId} narrow={narrowFrame} slim={railSlim} busy={!!busy} canLaunch={terminalTools.length > 0}
        onFilter={setRailFilter} onSearch={setRailSearch} onSelect={setSelectedId} onNewSession={() => openNewSessionDialog()} onOpenMenu={openRowMenu} onRemove={(session) => void endSession(session)} onClearEnded={() => void clearEndedSessions()} onToggleSlim={toggleRailSlim} />
      <div className={styles.resizer} role="separator" aria-orientation="vertical" aria-label={t('sessions.resizeRail')} title={t('sessions.resizeRail')} tabIndex={0} onPointerDown={startRailResize} onDoubleClick={() => updateRailWidth(DEFAULT_RAIL_WIDTH)} onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); updateRailWidth(railWidth - 16); }
        if (event.key === 'ArrowRight') { event.preventDefault(); updateRailWidth(railWidth + 16); }
      }} />

      <section className={styles.stage} aria-label={t('sessions.stageLabel')}>
        {failure && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><strong>{t('sessions.launchFailed')}</strong><p>{failure.detail}</p><p>{t('sessions.failureHint')}</p></div><div className={styles.bannerActions}><button type="button" className="button primary" onClick={() => void retry()} disabled={retrying}><Icon name="refresh" size={14} /><span>{retrying ? t('sessions.loading') : t('sessions.retry')}</span></button><button type="button" className={styles.ghostButton} onClick={() => onFailure(null)}>{t('sessions.dismissBanner')}</button></div></div>}
        {actionError && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><p>{actionError}</p></div><button type="button" className={styles.ghostButton} onClick={() => setActionError('')} aria-label={t('common.dismissError')}><Icon name="close" size={14} /></button></div>}
        {notice && <div className={styles.banner} data-tone="status" role="status"><div className={styles.bannerCopy}><p>{notice}</p></div><button type="button" className={styles.ghostButton} onClick={() => setNotice('')} aria-label={t('common.dismissError')}><Icon name="close" size={14} /></button></div>}

        {selected && (() => {
          const elapsed = formatDuration(selected.startedAt ?? firstSeenAt.current.get(selected.id), clock);
          const title = taskTitle(selected);
          const tone = sessionTone(selected);
          const currentStateLabel = stateLabel(selected, tone);
          const stateReserves = [
            t('sessions.stateIdle'),
            t('sessions.stateStreaming'),
            t('sessions.bellBadge'),
            t('sessions.stateError'),
            t('sessions.ended'),
          ].filter((label) => label !== currentStateLabel);
          const endLabel = busy === selected.id ? t('sessions.ending') : selected.running ? t('sessions.endShort') : t('sessions.closeTabShort');
          const endReserves = [t('sessions.ending'), t('sessions.endShort'), t('sessions.closeTabShort')]
            .filter((label) => label !== endLabel);
          const grid = grids.get(selected.id);
          const canSplit = splitRoom && sessions.length > 1;
          const splitLabel = split ? t('sessions.splitViewExit') : canSplit ? t('sessions.splitView') : t('sessions.splitNeedsTwo');
          return <>
            <header className={styles.stageBar}>
              <div className={styles.stageLead}>
                <button type="button" className={styles.focusBtn} aria-pressed={focusMode} aria-label={focusMode ? t('sessions.exitFocusMode') : t('sessions.focusMode')} title={focusMode ? t('sessions.exitFocusMode') : t('sessions.focusMode')} onClick={() => setFocusMode((current) => !current)}><Icon name={focusMode ? 'sidebarOpen' : 'sidebarClose'} size={16} /></button>
                <span className={styles.stageIcon} data-tone={tone}><ToolIcon toolId={selected.toolId} size={18} /><SessionActivityIcon tone={tone} slot="stage" className={styles.stageIconDot} /></span>
                <div className={styles.identityText}>
                  <div className={styles.identityTitleRow}><h2 title={title ? toolName(selected) + ' · ' + title : toolName(selected)}>{title || toolName(selected)}</h2><span className={styles.statusChip} data-tone={tone}><SessionActivityIcon tone={tone} slot="status" className={styles.statusDot} /><span className={styles.statusLabel}><span>{currentStateLabel}</span>{stateReserves.map((label) => <span key={label} aria-hidden="true">{label}</span>)}</span></span></div>
                  <div className={styles.identitySub}>
                    {title && <span className={styles.identityTool}>{toolName(selected)}</span>}
                    <button type="button" className={styles.pathChip} title={selected.directory ? displayPath(selected.directory) + ' · ' + t('sessions.copyPath') : placeOf(selected)} onClick={() => void copySessionPath(selected)}><Icon name={copiedState === 'path' ? 'check' : 'folder'} size={12} /><span>{copiedState === 'path' ? t('sessions.pathCopied') : placeOf(selected)}</span></button>
                    <span className={styles.modeChip} data-mode={selected.mode}><Icon name={selected.mode === 'yolo' ? 'sparkle' : 'shield'} size={12} />{modeLabel(selected.mode)}</span>
                    {elapsed && <span className={styles.sessionElapsed}><Icon name="clock" size={12} />{elapsed}</span>}
                    {!selected.running && selected.exitCode != null && <span className={styles.exitCode} data-failed={selected.exitCode !== 0 || undefined}>{t('sessions.exitCode', { code: selected.exitCode })}</span>}
                  </div>
                </div>
              </div>
              <div className={styles.stageTail}>
                <div className={styles.terminalActions} role="toolbar" aria-label={t('sessions.terminalMenu')}>
                  <button type="button" className={styles.toolButton} aria-label={t('sessions.findOutput')} aria-pressed={findOpen} title={t('sessions.findOutput') + ` (${modLabel}+Shift+F)`} onClick={openFind}><Icon name="search" size={16} /><span>{t('sessions.findOutput')}</span></button>
                  <button type="button" className={styles.toolButton} aria-label={t('sessions.copyOutput')} title={t('sessions.copyOutput')} onClick={() => void copyTerminalOutput(selected)}><Icon name="copy" size={16} /><span>{t('sessions.copyOutput')}</span></button>
                  <span className={styles.runningActions} data-running={selected.running || undefined} aria-hidden={selected.running ? undefined : true}>
                    <button type="button" className={`${styles.toolButton} ${styles.composerTrigger}`} aria-label={t('sessions.composerShort')} aria-pressed={composerOpen} title={t('sessions.composerShort') + ` (${modLabel}+Shift+M)`} disabled={!selected.running} onClick={() => toggleComposer()}><Icon name="pencil" size={16} /><span>{t('sessions.composerShort')}</span></button>
                    <button type="button" className={`${styles.toolButton} ${styles.interruptBtn}`} aria-label={t('sessions.sendInterrupt')} title={t('sessions.sendInterrupt')} disabled={!selected.running} onClick={() => void sendToSession(selected, '\x03')}><Icon name="square" size={14} /><span>{t('sessions.interruptShort')}</span></button>
                  </span>
                  <span className={styles.toolDivider} aria-hidden="true" />
                  {splitRoom && <button type="button" className={styles.toolButton} aria-label={t('sessions.splitView')} aria-pressed={!!split} disabled={!split && !canSplit} title={splitLabel + ` (${modLabel}+Shift+D)`} onClick={toggleSplit}><Icon name="columns" size={16} /><span>{splitLabel}</span></button>}
                  <TerminalAppearance open={appearanceOpen} theme={themePreference} fontSize={fontSize} defaultFontSize={DEFAULT_FONT_SIZE} minFontSize={MIN_FONT_SIZE} maxFontSize={MAX_FONT_SIZE} density={density} cursorBlink={cursorBlink} soundEnabled={soundEnabled} onToggle={() => { setMenu(null); setShortcutsOpen(false); setAppearanceOpen((current) => !current); }} onClose={closeAppearance} onTheme={setTerminalTheme} onFontSize={updateFontSize} onDensity={updateDensity} onCursorBlink={toggleCursorBlink} onSound={toggleSound} />
                  <button type="button" className={`${styles.toolButton} ${styles.moreButton}`} aria-label={t('sessions.moreActions')} title={t('sessions.moreActions')} aria-haspopup="menu" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); openTerminalMenu(selected, rect.right, rect.bottom + 5); }}><Icon name="more" size={16} /></button>
                </div>
                <button type="button" className={styles.endBtn} data-running={selected.running || undefined} onClick={() => void endSession(selected)} disabled={!!busy} aria-label={selected.running ? t('sessions.end') : t('sessions.closeTab')} title={selected.running ? t('sessions.end') : t('sessions.closeTab')}><span className={styles.endIcon}><Icon name={selected.running ? 'square' : 'close'} size={selected.running ? 12 : 14} /></span><span className={styles.statusLabel}><span>{endLabel}</span>{endReserves.map((label) => <span key={label} aria-hidden="true">{label}</span>)}</span></button>
              </div>
            </header>

            <div className={styles.screen}>
              {findOpen && <div className={styles.findLayer} data-split={split ? 'true' : undefined} data-pane={split ? split.indexOf(selected.id) : undefined}>
                <div className={styles.findPanel} role="search">
                  <div className={styles.findField}><Icon name="search" size={14} /><input ref={findInputRef} type="search" value={findQuery} placeholder={t('sessions.findPlaceholder')} aria-label={t('sessions.findPlaceholder')} onChange={(event) => setFindQuery(event.target.value)} onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); stepFindMatch(event.shiftKey ? -1 : 1); }
                    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFind(); }
                  }} /><span className={styles.findCount} data-empty={(findQuery.trim() && !findMatches.length) || undefined}>{!findQuery.trim() ? '' : findMatches.length > 0 ? t('sessions.findMatchCount', { current: findIndex + 1, total: findMatches.length }) : t('sessions.findNoMatch')}</span></div>
                  <button type="button" className={styles.findToggle} aria-pressed={findCase} aria-label={t('sessions.findCase')} title={t('sessions.findCase')} onClick={() => { setFindCase((current) => !current); findInputRef.current?.focus(); }}>Aa</button>
                  <span className={styles.findDivider} aria-hidden="true" />
                  <button type="button" className={styles.iconBtn} disabled={!findMatches.length} aria-label={t('sessions.findPrev')} title={t('sessions.findPrev') + ' (Shift+Enter)'} onClick={() => stepFindMatch(-1)}><Icon name="arrowUp" size={14} /></button>
                  <button type="button" className={styles.iconBtn} disabled={!findMatches.length} aria-label={t('sessions.findNext')} title={t('sessions.findNext') + ' (Enter)'} onClick={() => stepFindMatch(1)}><Icon name="arrowDown" size={14} /></button>
                  <button type="button" className={styles.iconBtn} aria-label={t('common.dialog.close')} title={t('common.dialog.close') + ' (Esc)'} onClick={closeFind}><Icon name="close" size={14} /></button>
                </div>
              </div>}

              <div ref={canvasRef} className={styles.canvas} data-split={split ? 'true' : undefined}
                onPointerDownCapture={(event) => {
                  const id = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-pane-session]')?.dataset.paneSession : undefined;
                  if (id && id !== selectedIdRef.current && visibleIdsRef.current.includes(id)) setSelectedId(id);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  const id = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-pane-session]')?.dataset.paneSession : undefined;
                  openTerminalMenu(sessions.find((item) => item.id === id) ?? selected, event.clientX, event.clientY);
                }}>
                {mountedSessions.map((session) => {
                  const pane = visibleIds.indexOf(session.id);
                  const visible = pane >= 0;
                  const focused = session.id === selectedId;
                  const paneTitle = taskTitle(session);
                  const failed = !session.running && session.exitCode != null && session.exitCode !== 0;
                  return <SessionTerminal key={session.id} sessionId={session.id} label={t('sessions.terminalLabel', { tool: toolName(session) })} active={visible} focused={focused} pane={split ? pane : undefined} running={session.running} fontSize={fontSize} lineHeight={DENSITY_LINE_HEIGHT[density]} theme={terminalMode} cursorBlink={cursorBlink} writers={writers} pending={pending} handles={handles} bridge={bridge}
                    header={split && visible ? <div className={styles.paneHead}>
                      <SessionActivityIcon tone={sessionTone(session)} slot="pane" className={styles.paneDot} label={stateLabel(session, sessionTone(session))} />
                      <ToolIcon toolId={session.toolId} size={14} />
                      <strong>{paneTitle || toolName(session)}</strong>
                      <span className={styles.panePlace}>{paneTitle ? toolName(session) + ' · ' + placeOf(session) : placeOf(session)}</span>
                      {focused && <span className={styles.paneFocus}>{t('sessions.paneFocused')}</span>}
                      <button type="button" className={styles.paneClose} aria-label={t('sessions.closePane', { name: toolName(session) })} title={t('sessions.closePane', { name: toolName(session) })} onClick={(event) => { event.stopPropagation(); closePane(session.id); }}><Icon name="close" size={12} /></button>
                    </div> : null}
                    overlay={visible ? <>
                      {scrolledIds.has(session.id) && <button type="button" className={styles.jumpLatest} aria-label={t('sessions.jumpToBottom')} title={t('sessions.jumpToBottom')} onClick={() => { const handle = handles.current.get(session.id); handle?.scrollToBottom(); handle?.focus(); }}><Icon name="arrowDown" size={14} /><span>{t('sessions.jumpToBottom')}</span></button>}
                      {dropTarget === session.id && <div className={styles.dropOverlay} aria-hidden="true"><div className={styles.dropCard}><Icon name="upload" size={22} /><strong>{t('sessions.dropHint')}</strong><span>{t('sessions.dropHintDetail', { tool: toolName(session) })}</span></div></div>}
                    </> : null}
                    footer={visible && !session.running ? <div className={styles.endedBar} data-failed={failed || undefined}>
                      <span className={styles.endedGlyph}><Icon name={failed ? 'alert' : 'info'} size={14} /></span>
                      <span className={styles.endedText}><strong>{t('sessions.sessionEndedBanner')}</strong>{session.exitCode != null && <span className={styles.endedCode}>{t('sessions.exitCode', { code: session.exitCode })}</span>}<span className={styles.endedDetail}>{t('sessions.endedHintShort')}</span></span>
                      <button type="button" className={styles.endedRestart} disabled={!!busy} title={t('sessions.restartHint')} onClick={() => void restartOrCloneSession(session, true)}><Icon name="refresh" size={12} /><span>{busy === 'restart:' + session.id ? t('sessions.restarting') : t('sessions.restartSession')}</span></button>
                    </div> : null} />;
                })}
                {copiedState && <div className={styles.toastPill} role="status"><Icon name={copiedState === 'empty' ? 'info' : 'check'} size={14} /><span>{copiedMessage}</span></div>}
              </div>
              {selected.running && composerOpen && <WorkbenchComposer toolId={selected.toolId} toolName={toolName(selected)} place={placeOf(selected)} draft={composerDrafts[selected.id] ?? ''} prompts={libraryPrompts} inputRef={composerInputRef} onChange={updateComposerDraft} onSubmit={() => void submitComposer()} onClose={() => toggleComposer(false)} />}
              <footer className={styles.statusBar}>
                <span className={styles.statusState} data-tone={tone}><SessionActivityIcon tone={tone} slot="footer" className={styles.footerDot} /><span className={styles.statusLabel}><span>{currentStateLabel}</span>{stateReserves.map((label) => <span key={label} aria-hidden="true">{label}</span>)}</span></span>
                <span className={styles.statusItem}><ToolIcon toolId={selected.toolId} size={12} />{toolName(selected)}</span>
                {selected.directory && <span className={styles.statusPath} title={displayPath(selected.directory)}><Icon name="folder" size={12} /><span>{displayPath(selected.directory)}</span></span>}
                {selected.projectId?.startsWith('remote:') && <span className={styles.statusItem} data-tone={selected.connectionState === 'disconnected' ? 'error' : undefined} title={selected.exitReason === 'connection_lost' ? 'SSH 连接中断' : '远程 SSH 会话'}>SSH · {selected.connectionState === 'disconnected' ? '连接中断' : selected.running ? '已连接' : '已结束'}</span>}
                <span className={styles.statusSpacer} />
                {scrolledIds.has(selected.id) && <span className={styles.statusItem} data-tone="scrolled"><Icon name="arrowUp" size={12} />{t('sessions.scrolledBack')}</span>}
                {split && <span className={styles.statusItem}><Icon name="columns" size={12} />{t('sessions.splitView')}</span>}
                {grid && <span className={styles.statusItem} data-mono title={t('sessions.gridSize', { cols: grid.cols, rows: grid.rows })}>{grid.cols}×{grid.rows}</span>}
                <span className={styles.statusItem} data-mono title={t('sessions.fontSize')}>{fontSize}px</span>
                <span className={styles.statusItem} title={t('sessions.terminalInputHint')}><Icon name="lock" size={12} />{t('sessions.localSessions')}</span>
                <WorkbenchShortcuts open={shortcutsOpen} onToggle={() => { setAppearanceOpen(false); setShortcutsOpen((current) => !current); }} onClose={closeShortcuts} />
              </footer>
            </div>
          </>;
        })()}

        {loading && !sessions.length && <div className={styles.loading}><span className={styles.loadingMark} aria-hidden="true" /><p>{t('sessions.loading')}</p></div>}
        {showEmpty && !listError && <WorkbenchEmpty tools={terminalTools} projects={availableProjects} onNewSession={openNewSessionDialog} onOpenHome={onOpenHome} />}
      </section>
    </div>

    {menu && (() => {
      const session = sessions.find((item) => item.id === menu.sessionId);
      if (!session) return null;
      const name = toolName(session);
      const handle = handles.current.get(session.id);
      return createPortal(<div ref={menuRef} className={`${rowMenuStyles.rowMenuList} ${styles.contextMenu}`} role="menu" aria-label={menu.kind === 'session' ? t('sessions.sessionMenu', { name }) : t('sessions.terminalMenu')} style={menuBox ?? { top: 0, left: -10000 }} onKeyDown={menuNavigate} onContextMenu={(event) => event.preventDefault()} onClick={() => setMenu(null)}>
        {menu.kind === 'terminal' ? <>
          <button role="menuitem" disabled={!menu.hasSelection} onClick={() => { handle?.copySelection(); handle?.focus(); }}><Icon name="copy" size={14} /><span>{t('sessions.copySelection')}</span><kbd>{modLabel}+C</kbd></button>
          <button role="menuitem" disabled={!session.running} onClick={() => void pasteIntoSession(session)}><Icon name="clipboard" size={14} /><span>{t('sessions.pasteClipboard')}</span><kbd>{modLabel}+V</kbd></button>
          <button role="menuitem" onClick={() => handle?.selectAll()}><Icon name="check" size={14} /><span>{t('sessions.selectAll')}</span></button>
          <span className={styles.menuDivider} role="separator" />
          {session.running && <button role="menuitem" onClick={() => toggleComposer(true)}><Icon name="pencil" size={14} /><span>{t('sessions.composerShort')}</span><kbd>{modLabel}+Shift+M</kbd></button>}
          <button role="menuitem" onClick={openFind}><Icon name="search" size={14} /><span>{t('sessions.findOutput')}</span><kbd>{modLabel}+Shift+F</kbd></button>
          <button role="menuitem" onClick={() => void copyTerminalOutput(session)}><Icon name="clipboard" size={14} /><span>{t('sessions.copyOutput')}</span></button>
          {session.directory && <button role="menuitem" onClick={() => void copySessionPath(session)}><Icon name="folder" size={14} /><span>{t('sessions.copyPath')}</span></button>}
          {session.projectId && !session.projectId.startsWith('remote:') && <button role="menuitem" onClick={() => void native.openProjectDirectory(session.projectId!).catch(() => {})}><Icon name="arrowUpRight" size={14} /><span>{t('sessions.openFolder')}</span></button>}
          <button role="menuitem" title={t('sessions.clearViewHint')} onClick={() => { handle?.clear(); handle?.focus(); }}><Icon name="trash" size={14} /><span>{t('sessions.clearView')}</span></button>
          <span className={styles.menuDivider} role="separator" />
          {session.running && <button role="menuitem" onClick={() => void sendToSession(session, '\x03')}><Icon name="square" size={12} /><span>{t('sessions.sendInterrupt')}</span></button>}
          <button role="menuitem" disabled={!!busy} title={!session.running ? t('sessions.restartHint') : undefined} onClick={() => void restartOrCloneSession(session, !session.running)}><Icon name={session.running ? 'plus' : 'refresh'} size={14} /><span>{session.running ? t('sessions.cloneSession') : t('sessions.restartSession')}</span></button>
          <button role="menuitem" onClick={() => setAppearanceOpen(true)}><Icon name="sliders" size={14} /><span>{t('sessions.displaySettings')}</span></button>
          <span className={styles.menuDivider} role="separator" />
          <button role="menuitem" data-danger="true" disabled={!!busy} onClick={() => void endSession(session)}><Icon name="close" size={14} /><span>{session.running ? t('sessions.end') : t('sessions.closeTab')}</span></button>
        </> : <>
          <button role="menuitem" aria-pressed={pinnedIds.has(session.id)} onClick={() => togglePinSession(session.id)}><Icon name="pin" size={14} /><span>{pinnedIds.has(session.id) ? t('sessions.unpinSession') : t('sessions.pinSession')}</span>{pinnedIds.has(session.id) && <span className={styles.menuCheck}><Icon name="check" size={14} /></span>}</button>
          {splitRoom && menu.besideId && sessions.some((item) => item.id === menu.besideId) && <button role="menuitem" onClick={() => { setRailFilter('all'); setSplit([menu.besideId!, session.id]); }}><Icon name="columns" size={14} /><span>{t('sessions.openBeside', { name: toolName(sessions.find((item) => item.id === menu.besideId)!) })}</span></button>}
          <span className={styles.menuDivider} role="separator" />
          {session.running && <button role="menuitem" onClick={() => void sendToSession(session, '\x03')}>{t('sessions.sendInterrupt')}</button>}
          <button role="menuitem" disabled={!!busy} onClick={() => void restartOrCloneSession(session, !session.running)}>{session.running ? t('sessions.cloneSession') : t('sessions.restartSession')}</button>
          <button role="menuitem" onClick={() => void copyTerminalOutput(session)}>{t('sessions.copyOutput')}</button>
          {session.directory && <button role="menuitem" onClick={() => void copySessionPath(session)}>{t('sessions.copyPath')}</button>}
          {session.projectId && !session.projectId.startsWith('remote:') && <button role="menuitem" onClick={() => void native.openProjectDirectory(session.projectId!).catch(() => {})}>{t('sessions.openFolder')}</button>}
          <button role="menuitem" data-danger="true" disabled={!!busy} onClick={() => void endSession(session)}>{session.running ? t('sessions.end') : t('sessions.removeSession')}</button>
        </>}
      </div>, document.body);
    })()}

    <GuideDialog open={newDialogOpen} title={t('sessions.newSessionDialogTitle')} hint={t('sessions.newSessionDialogHint')} wide onClose={() => setNewDialogOpen(false)}>
      <div className={styles.dialogForm}>
        {dialogError && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><p>{dialogError}</p></div></div>}
        <div className={styles.dialogPrimaryGrid}>
          <div className={styles.dialogField}><span className={styles.fieldLabel}>{t('sessions.pickToolLabel')}</span><FilterSelect label={t('sessions.pickToolLabel')} value={effectiveLaunchToolId} options={cliSelectOptions} placeholder={t('home.launcher.pickTool')} searchLabel={t('sessions.searchCliTool')} onChange={(value) => {
            setLaunchToolId(value);
            const nextTool = terminalTools.find((item) => item.id === value);
            setLaunchMode(preferredLaunchMode(launchSettings, workspaceValue.startsWith('project:') ? 'project' : 'cli', !!nextTool?.yoloAvailable));
          }} /></div>
          <div className={styles.dialogField}><span className={styles.fieldLabel}>{t('sessions.pickWorkspaceLabel')}</span><FilterSelect label={t('sessions.pickWorkspaceLabel')} value={workspaceValue} options={workspaceSelectOptions} searchable searchLabel={t('sessions.searchWorkspace')} onPickFolder={() => void pickCustomWorkspaceFolder()} pickFolderLabel={t('sessions.pickFolder')} onChange={(value) => {
            setWorkspaceValue(value);
            if (value.startsWith('project:')) {
              const project = availableProjects.find((item) => 'project:' + item.id === value);
              if (project?.preferredTool && terminalTools.some((item) => item.id === project.preferredTool)) setLaunchToolId(project.preferredTool);
            }
          }} /></div>
        </div>
        <div className={styles.dialogField}><span className={styles.fieldLabel}>{t('sessions.launchModeLabel')}</span><div className={styles.modeCards} role="radiogroup" aria-label={t('sessions.launchModeLabel')}>
          <button type="button" role="radio" aria-checked={launchMode === 'normal'} className={styles.modeCard} onClick={() => setLaunchMode('normal')}><span className={styles.modeCardGlyph} aria-hidden="true"><Icon name="shield" size={16} /></span><span className={styles.modeCardCopy}><strong>{t('sessions.modeNormal')}</strong><small>{t('sessions.modeNormalDesc')}</small></span><span className={styles.modeCardCheck}><Icon name="check" size={12} /></span></button>
          <button type="button" role="radio" aria-checked={launchMode === 'yolo'} disabled={!selectedLaunchTool?.yoloAvailable} title={!selectedLaunchTool?.yoloAvailable ? t('sessions.yoloUnsupported') : undefined} className={styles.modeCard} onClick={() => setLaunchMode('yolo')}><span className={styles.modeCardGlyph} aria-hidden="true"><Icon name="sparkle" size={16} /></span><span className={styles.modeCardCopy}><strong>{t('sessions.modeYolo')}</strong><small>{selectedLaunchTool?.yoloAvailable ? t('sessions.modeYoloDesc') : t('sessions.yoloUnsupported')}</small></span><span className={styles.modeCardCheck}><Icon name="check" size={12} /></span></button>
        </div>{selectedLaunchTool?.resumeLatestAvailable && <label className={styles.checkboxRow}><input type="checkbox" checked={resumeLatest} onChange={(event) => setResumeLatest(event.target.checked)} /><span>{t('sessions.resumeLatest')}</span></label>}</div>
        <div className={styles.dialogField}><span className={styles.fieldLabel}>{t('sessions.initialPromptLabel')}</span><textarea rows={3} className={styles.dialogTextarea} value={initialPrompt} placeholder={t('sessions.initialPromptPlaceholder')} aria-label={t('sessions.initialPromptLabel')} onChange={(event) => setInitialPrompt(event.target.value)} />{libraryPrompts.length > 0 && <div className={styles.dialogPrompts}><span className={styles.dialogPromptLabel}><Icon name="library" size={12} />{t('sessions.pickLibraryPrompt')}</span>{libraryPrompts.slice(0, 6).map((prompt) => <button key={prompt.id} type="button" className={styles.promptPill} title={prompt.body} onClick={() => setInitialPrompt(prompt.body)}>{prompt.title}</button>)}</div>}</div>
        <div className={styles.dialogSummary}>{effectiveLaunchToolId && <span className={styles.dialogSummaryIcon}><ToolIcon toolId={effectiveLaunchToolId} size={20} /></span>}<span>{t('sessions.launchSummary', { tool: selectedLaunchTool?.name ?? '', place: workspaceValue.startsWith('project:') ? availableProjects.find((item) => 'project:' + item.id === workspaceValue)?.name ?? t('sessions.workspaceHome') : workspaceValue.startsWith('custom:') ? shortPath(displayPath(workspaceValue.slice('custom:'.length))) : t('sessions.workspaceHome'), mode: modeLabel(launchMode) })}</span><Icon name="terminal" size={16} /></div>
        <div className={styles.dialogActions}><button type="button" className="button" onClick={() => setNewDialogOpen(false)}>{t('common.dialog.cancel')}</button><button type="button" className="button primary" data-dialog-save disabled={launchingNew || !effectiveLaunchToolId} onClick={() => void launchFromDialog()}><Icon name="play" size={14} /><span>{launchingNew ? t('sessions.startingSession') : t('sessions.startInWorkbench')}</span></button></div>
      </div>
    </GuideDialog>
  </div>;
}
