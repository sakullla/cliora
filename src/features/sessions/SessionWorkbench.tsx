import { useRemoteIdentity } from '../../lib/remoteReads';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import { formatFailure } from '../../lib/feedback';
import { compactText, displayPath, shortPath } from '../../lib/paths';
import { writeClipboard } from '../../lib/clipboard';
import { confirmAction } from '../../lib/confirm';
import { modLabel } from '../../lib/shortcut';
import { FilterSelect, type FilterSelectOption } from '../../components/FilterSelect';
import { GuideDialog } from '../../components/GuideDialog';
import { Icon } from '../../components/Icon';
import { Badge, Button, IconButton } from '../../components/ui';
import rowMenuStyles from '../../components/RowMenu.module.css';
import { ToolIcon, toolOptions } from '../../components/ToolIcon';
import type { LaunchMode, LaunchRequest, LaunchSettings, Project, WorkbenchExit, WorkbenchGitContext, WorkbenchOutput, WorkbenchSession } from '../../types/launch';
import { preferredLaunchMode } from '../../types/launch';
import type { LibraryItem } from '../../types/library';
import type { AdapterDescriptor } from '../../types/native';
import type { RemoteProject, RemoteTarget } from '../../types/remote';
import { SessionTitle, stableTitle } from './SessionTitle';
import { SessionTerminal, cleanTerminalTitle, encodeBase64, quoteDroppedPaths, type OutputChunk, type TerminalBridge, type TerminalHandle, type TerminalMatch } from './SessionTerminal';
import { SessionActivityIcon, sessionBadgeTone } from './SessionActivityIcon';
import type { TerminalTheme, TerminalThemePreference } from './terminalTheme';
import { SessionRail, type RailSession, type SessionTone } from './SessionRail';
import { remoteSessionMayExist, sessionConfirmedEnded } from './sessionState';
import { railPlace, railTaskTitle } from './railTitle';
import { WorkbenchComposer } from './WorkbenchComposer';
import { PromptPicker } from './PromptPicker';
import { StatusBanner } from '../../components/StatusBanner';
import { DENSITY_LINE_HEIGHT, TerminalAppearance, type TerminalDensity } from './TerminalAppearance';
import { WorkbenchEmpty } from './WorkbenchEmpty';
import { WorkbenchShortcuts } from './WorkbenchShortcuts';
import { RemoteProjectDialog } from '../remote/RemoteProjectDialog';
import { requestWriteRecovery, useWriteRecoveryNeeded } from '../remote/writeReceipts';
import { RemoteSshSettings } from '../settings/GeneralSettings';
import styles from './SessionWorkbench.module.css';

import { workbenchSessionId, type WorkbenchFailure, type RemoteWorkbenchIntent } from './workbenchLaunch';

/** A remote session's library prompts come from that host. `null` means the host is not known yet. */
export function libraryHostId(projectId: string | null | undefined, remoteProjects: RemoteProject[]): string | null {
  if (!projectId?.startsWith('remote:')) return 'local';
  return remoteProjects.find((item) => `remote:${item.id}` === projectId)?.targetId ?? null;
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

function readStoredEndedCollapsed(): boolean {
  try { return localStorage.getItem('cliora:workbench-ended-collapsed') === 'true'; }
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

/** What the shell needs to know about the session list it hosts in the app sidebar. */
export type WorkbenchRailLayout = { docked: boolean; focus: boolean };

export function SessionWorkbench({ active, tools, remoteSshEnabled = false, remoteTargetId = 'local', syncedRemoteTargets = [], onRemoteTargetChange, focusSessionId, focusToken, failure, onFailure, onOpenHome, remoteIntent, railHost = null, railSlim = false, onToggleRailSlim, onRailLayout, railToggleRef }: {
  remoteIntent?: RemoteWorkbenchIntent | null;
  /** The app sidebar slot that shows the session list. Null keeps the list as a strip above the terminal. */
  railHost?: HTMLElement | null;
  /** The shared sidebar collapse state: a collapsed sidebar shows session icons only. */
  railSlim?: boolean;
  onToggleRailSlim?: () => void;
  onRailLayout?: (layout: WorkbenchRailLayout) => void;
  /** The shell's sidebar toggle calls this so focus mode is left before the sidebar folds. */
  railToggleRef?: MutableRefObject<(() => void) | null>;
  active: boolean;
  tools: AdapterDescriptor[];
  remoteSshEnabled?: boolean;
  remoteTargetId?: string;
  /** Hosts the shell already loaded. The workbench list starts empty, and must not treat that gap as "no such host". */
  syncedRemoteTargets?: RemoteTarget[];
  onRemoteTargetChange?: (targetId: string) => void;
  focusSessionId: string | null;
  focusToken: number;
  failure: WorkbenchFailure | null;
  onFailure: (failure: WorkbenchFailure | null) => void;
  onOpenHome: () => void;
}) {
  const { t } = useTranslation();
  const writeRecoveryNeeded = useWriteRecoveryNeeded(remoteTargetId);
  const [sessions, setSessions] = useState<WorkbenchSession[]>([]);
  const sessionStateUpdates = useRef(new Map<string, WorkbenchSession>());
  function applyListedSessions(listed: WorkbenchSession[]) {
    setSessions((current) => listed.map((item) => {
      const candidates = [item, current.find(session => session.id === item.id), sessionStateUpdates.current.get(item.id)];
      return candidates.reduce<WorkbenchSession>((newest, candidate) => candidate && (candidate.stateRevision ?? 0) > (newest.stateRevision ?? 0) ? { ...item, ...candidate } : newest, item);
    }));
  }
  const allSessionsRef = useRef(sessions);
  allSessionsRef.current = sessions;
  const [projects, setProjects] = useState<Project[]>([]);
  const [remoteProjects, setRemoteProjects] = useState<RemoteProject[]>([]);
  const [loadedRemoteTargets, setLoadedRemoteTargets] = useState<RemoteTarget[] | null>(null);
  const remoteTargets = loadedRemoteTargets ?? syncedRemoteTargets;
  const [activeTargetId, setActiveTargetId] = useState(remoteTargetId);
  const [hostManagerOpen, setHostManagerOpen] = useState(false);
  const [promptsByHost, setPromptsByHost] = useState<Record<string, LibraryItem[]>>({});
  const [promptStatus, setPromptStatus] = useState<Record<string, { identity: string; stale: boolean; at: number; failed: boolean }>>({});
  const [promptReload, setPromptReload] = useState(0);
  const promptFreshHosts = useRef(new Set<string>());
  const promptRequestSeq = useRef(new Map<string, number>());
  const [launchSettings, setLaunchSettings] = useState<LaunchSettings | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(focusSessionId);
  const pendingSelectionId = useRef<string | null>(focusSessionId);
  const selectionTarget = useRef(activeTargetId);
  function selectPendingSession(id: string) {
    pendingSelectionId.current = id;
    setSelectedId(id);
  }
  const [loading, setLoading] = useState(nativeAvailable);
  const [listError, setListError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [reload, setReload] = useState(0);

  const [railWidth, setRailWidth] = useState<number>(readStoredRailWidth);
  const [focusMode, setFocusMode] = useState(false);
  const [endedCollapsed, setEndedCollapsed] = useState<boolean>(readStoredEndedCollapsed);
  const [railSearch, setRailSearch] = useState('');
  const [arrangement, setArrangement] = useState<RailArrangement>(readRailArrangement);
  const [fontSize, setFontSize] = useState<number>(readStoredFontSize);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(readStoredSoundEnabled);
  const [themePreference, setThemePreference] = useState<TerminalThemePreference>(readStoredTerminalTheme);
  const [appTheme, setAppTheme] = useState<TerminalTheme>(currentAppTheme);
  const [cursorBlink, setCursorBlink] = useState<boolean>(readStoredCursorBlink);
  const [density, setDensity] = useState<TerminalDensity>(readStoredDensity);
  const [split, setSplit] = useState<[string, string] | null>(null);
  const [unreadIds, setUnreadIds] = useState<Set<string>>(() => new Set());
  const [gitContexts, setGitContexts] = useState<Map<string, WorkbenchGitContext | null>>(() => new Map());
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
  const [tightFrame, setTightFrame] = useState(false);
  const stageRef = useRef<HTMLElement | null>(null);
  const [splitRoom, setSplitRoom] = useState(true);

  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [remoteDialogOpen, setRemoteDialogOpen] = useState(false);
  const [launchToolId, setLaunchToolId] = useState('');
  const [workspaceValue, setWorkspaceValue] = useState('__home');
  const [customFolderPath, setCustomFolderPath] = useState('');
  const [launchMode, setLaunchMode] = useState<LaunchMode>('normal');
  const [resumeLatest, setResumeLatest] = useState(false);
  const [initialPrompt, setInitialPrompt] = useState('');
  const [launchingNew, setLaunchingNew] = useState(false);
  const newLaunchPending = useRef(false);
  const [dialogError, setDialogError] = useState('');
  const [remotePrefillToolId, setRemotePrefillToolId] = useState<string | null>(null);
  const [remoteQuickLaunch, setRemoteQuickLaunch] = useState(false);

  const scopedSessions = useMemo(() => {
    if (activeTargetId === 'local') return sessions.filter((item) => !item.projectId?.startsWith('remote:'));
    const remoteProjectIds = new Set(remoteProjects.filter((item) => item.targetId === activeTargetId).map((item) => `remote:${item.id}`));
    return sessions.filter((item) => !!item.projectId && remoteProjectIds.has(item.projectId));
  }, [activeTargetId, remoteProjects, sessions]);
  useEffect(() => {
    const targetChanged = selectionTarget.current !== activeTargetId;
    selectionTarget.current = activeTargetId;
    if (targetChanged) pendingSelectionId.current = null;
    setSelectedId((current) => {
      if (current && scopedSessions.some((item) => item.id === current)) {
        if (pendingSelectionId.current === current) pendingSelectionId.current = null;
        return current;
      }
      if (current && pendingSelectionId.current === current) return current;
      return scopedSessions.find((item) => item.running)?.id ?? scopedSessions[0]?.id ?? null;
    });
    setSplit((current) => current && current.every((id) => scopedSessions.some((item) => item.id === id)) ? current : null);
  }, [activeTargetId, scopedSessions]);

  useEffect(() => { setActiveTargetId(remoteTargetId); }, [remoteTargetId]);
  useEffect(() => {
    const onTarget = (event: Event) => setActiveTargetId((event as CustomEvent<string>).detail || 'local');
    const onManage = () => { setHostManagerOpen(true); };
    const onOpenRemote = (event: Event) => {
      const detail = (event as CustomEvent<{ toolId?: string; targetId?: string; quickLaunch?: boolean; chooseDirectory?: boolean }>).detail;
      const targetId = detail?.targetId || activeTargetId;
      if (targetId) setActiveTargetId(targetId);
      window.setTimeout(() => {
        const toolId = detail?.toolId && tools.some((item) => item.id === detail.toolId && item.launchForm !== 'desktop' && item.launch?.state !== 'unsupported') ? detail.toolId : undefined;
        if (!detail?.quickLaunch || !targetId || targetId === 'local') {
          openNewSessionDialog(toolId ? { toolId } : undefined, targetId);
          return;
        }
        setRemotePrefillToolId(toolId ?? null);
        setRemoteQuickLaunch(true);
        const key = `cliora:remote-launch-project:${targetId}:${toolId ?? ''}`;
        let rememberedId = '';
        try { rememberedId = localStorage.getItem(key) ?? ''; } catch { /* optional */ }
        void (async () => {
          const availableProjects = remoteProjects.length ? remoteProjects : await native.listRemoteProjects().catch(() => [] as RemoteProject[]);
          const candidate = detail.chooseDirectory
            ? undefined
            : (availableProjects.find((item) => item.id === rememberedId && item.targetId === targetId)
              ?? [...availableProjects].filter((item) => item.targetId === targetId && (!toolId || !item.preferredTool || item.preferredTool === toolId)).sort((a, b) => b.updatedAt - a.updatedAt)[0]);
          if (candidate && (!toolId || !candidate.preferredTool || candidate.preferredTool === toolId)) {
            void launchRemoteProject(candidate, toolId);
          } else {
            setNewDialogOpen(false);
            setRemoteDialogOpen(true);
          }
        })();
      }, 0);
    };
    window.addEventListener('cliora:remote-target-changed', onTarget);
    window.addEventListener('cliora:manage-hosts', onManage);
    window.addEventListener('cliora:open-remote-session', onOpenRemote);
    return () => { window.removeEventListener('cliora:remote-target-changed', onTarget); window.removeEventListener('cliora:manage-hosts', onManage); window.removeEventListener('cliora:open-remote-session', onOpenRemote); };
  }, [activeTargetId, remoteProjects, tools]);

  // Carry the launch through the first lazy mount, after the event listener is ready.
  const handledRemoteIntent = useRef<number | null>(null);
  useEffect(() => {
    if (!active || !remoteIntent || handledRemoteIntent.current === remoteIntent.token) return;
    handledRemoteIntent.current = remoteIntent.token;
    window.dispatchEvent(new CustomEvent('cliora:open-remote-session', { detail: remoteIntent }));
  }, [active, remoteIntent]);

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
  const linkErrorTimer = useRef<number>(0);

  const firstSeenAt = useRef(new Map<string, number>());
  const autoRemoteReattachAttempted = useRef(false);
  const autoLocalRestoreAttempted = useRef(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [restoreFailures, setRestoreFailures] = useState<import('../../types/launch').WorkbenchRestoreReport['failures']>([]);
  async function restoreLocalSessions() {
    if (restoring) return;
    setRestoring(true);
    setRestoreError('');
    try {
      const report = await native.restoreWorkbenchSessions();
      // Older preview bridges may not implement restoration.
      if (!report || !report.restored || !Array.isArray(report.failures)) return;
      setRestoreFailures(report.failures);
      if (!Object.keys(report.restored).length) return;
      setArrangement(current => ({ pinned: current.pinned.map(id => report.restored[id] ?? id), order: current.order.map(id => report.restored[id] ?? id) }));
      const listed = await native.listWorkbenchSessions();
      applyListedSessions(listed);
      setSelectedId(current => {
        let previous: string | null = null;
        try { previous = localStorage.getItem('cliora:workbench-selected'); } catch { /* optional */ }
        return (previous && report.restored[previous]) || current || listed[0]?.id || null;
      });
    } catch (value) {
      setRestoreError(formatFailure(value, t('sessions.restoreFailed'), t('sessions.closeNext')));
    } finally { setRestoring(false); }
  }
  useEffect(() => {
    if (!active || !nativeAvailable || autoLocalRestoreAttempted.current) return;
    autoLocalRestoreAttempted.current = true;
    void restoreLocalSessions();
  }, [active]);
  useEffect(() => {
    if (!selectedId || restoring) return;
    try { localStorage.setItem('cliora:workbench-selected', selectedId); } catch { /* optional */ }
  }, [selectedId, restoring]);
  const [clock, setClock] = useState(() => Date.now());
  const writers = useRef(new Map<string, (chunk: OutputChunk) => void>());
  const pending = useRef(new Map<string, OutputChunk[]>());
  const pendingBytes = useRef(new Map<string, number>());
  const handles = useRef(new Map<string, TerminalHandle>());
  const MAX_PENDING_OUTPUT_BYTES = 512 * 1024;
  // Ended sessions keep their xterm buffers alive; mounting only the running, selected,
  // and recently selected terminals bounds that memory. Re-selecting remounts from replay.
  const MOUNTED_ENDED_LIMIT = 3;
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
    setSplit((current) => current && current.every((id) => scopedSessions.some((item) => item.id === id)) ? current : null);
  }, [scopedSessions]);

  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const sessionsRef = useRef(scopedSessions);
  sessionsRef.current = scopedSessions;
  const findOpenRef = useRef(findOpen);
  findOpenRef.current = findOpen;
  const findQueryRef = useRef(findQuery);
  findQueryRef.current = findQuery;

  // WebView2 can resolve a stale container query width; observe the actual workbench instead.
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    // The breakpoints were tuned with a 60px icon rail beside the workbench. A docked session
    // list widens the sidebar instead, so its extra room still counts as part of the frame.
    const sidebar = railHost?.closest('aside') ?? null;
    const update = () => {
      const width = node.clientWidth + (sidebar ? Math.max(0, sidebar.getBoundingClientRect().width - 60) : 0);
      const stageWidth = stageRef.current?.clientWidth ?? width;
      setNarrowFrame((current) => current === width <= 720 ? current : width <= 720);
      setCompactFrame((current) => current === width <= 620 ? current : width <= 620);
      // The header lives in the stage column, so its room depends on the stage, not the window.
      setTightFrame((current) => current === stageWidth <= 700 ? current : stageWidth <= 700);
      setSplitRoom((current) => current === width >= 860 ? current : width >= 860);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    if (stageRef.current) observer.observe(stageRef.current);
    if (sidebar) observer.observe(sidebar);
    return () => observer.disconnect();
  }, [railHost]);

  const terminalTools = useMemo(
    // The host switch changes where a CLI runs. It does not change which CLI
    // choices are available in the launcher. Remote probing is shown on the
    // quick-start page, but must never hide options from the normal launcher.
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
  const selected = scopedSessions.find((item) => item.id === selectedId) ?? null;
  // Git branch is a quiet, best-effort hint for local sessions. Agents switch branches
  // and create worktrees mid-session, so the visible session re-reads it now and then.
  const gitTarget = active && selected && !selected.projectId?.startsWith('remote:') ? selected.id : null;
  useEffect(() => {
    if (!nativeAvailable || !gitTarget) return;
    let alive = true;
    const read = () => {
      if (document.visibilityState === 'hidden') return;
      void native.workbenchGitContext(gitTarget).then((value) => {
        if (!alive) return;
        const next = value && (value.branch || value.commit) ? value : null;
        setGitContexts((current) => {
          if (current.has(gitTarget) && JSON.stringify(current.get(gitTarget)) === JSON.stringify(next)) return current;
          const map = new Map(current);
          map.set(gitTarget, next);
          return map;
        });
      }).catch(() => {});
    };
    read();
    const timer = window.setInterval(read, 15_000);
    window.addEventListener('focus', read);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener('focus', read); };
  }, [gitTarget, selected?.directory]);
  const composerHostId = libraryHostId(selected?.projectId, remoteProjects);
  const dialogHostId = newDialogOpen ? libraryHostId(workspaceValue.startsWith('remote:') ? workspaceValue : null, remoteProjects) : null;
  const composerPrompts = composerHostId ? promptsByHost[composerHostId] ?? [] : [];
  const dialogPrompts = dialogHostId ? promptsByHost[dialogHostId] ?? [] : [];
  // A remote library read is its own SSH handshake. Reuse a recent result when
  // the workbench or composer opens again; a failed read is retried next time.
  const composerIdentity = useRemoteIdentity(composerHostId);
  const dialogIdentity = useRemoteIdentity(dialogHostId);
  const promptHostIdentities = useRef(new Map<string, string>());
  useEffect(() => {
    if (!active || !nativeAvailable) return;
    const controller = new AbortController();
    const hosts = new Set([composerHostId, dialogHostId].filter((host): host is string => !!host));
    for (const hostId of hosts) {
      const identity = hostId === composerHostId ? composerIdentity : dialogIdentity;
      if (promptHostIdentities.current.get(hostId) !== identity) {
        setPromptsByHost(prev => ({ ...prev, [hostId]: [] }));
        promptHostIdentities.current.set(hostId, identity);
      }
      const seq = (promptRequestSeq.current.get(hostId) ?? 0) + 1;
      promptRequestSeq.current.set(hostId, seq);
      const current = () => !controller.signal.aborted && promptRequestSeq.current.get(hostId) === seq;
      const report = (state: { stale: boolean; at: number }) => {
        if (current()) setPromptStatus(previous => ({ ...previous, [hostId]: { identity, ...state, at: state.at || (state.stale && previous[hostId]?.identity === identity ? previous[hostId].at : 0), failed: state.stale } }));
      };
      const fresh = promptFreshHosts.current.delete(hostId);
      const request = hostId === 'local'
        ? native.listLibraryItems('prompt', null, '')
        : native.listRemoteLibraryItems(hostId, 'prompt', '', { signal: controller.signal, fresh, onFreshness: report });
      void request.then(items => {
        if (current()) {
          setPromptsByHost(prev => ({ ...prev, [hostId]: Array.isArray(items) ? items : [] }));
          if (hostId === 'local') report({ stale: false, at: Date.now() });
        }
      }).catch(() => {
        if (current()) setPromptStatus(previous => ({ ...previous, [hostId]: {
          identity, stale: true, at: previous[hostId]?.identity === identity ? previous[hostId].at : 0, failed: true,
        } }));
      });
    }
    return () => controller.abort();
  }, [active, composerHostId, dialogHostId, composerOpen, composerIdentity, dialogIdentity, promptReload]);
  function promptFeedback(hostId: string | null, identity: string) {
    const state = hostId ? promptStatus[hostId] : undefined;
    if (!hostId || !state?.failed || state.identity !== identity) return null;
    return <StatusBanner tone={state.at ? 'warning' : 'error'} action={<Button size="sm" onClick={() => { promptFreshHosts.current.add(hostId); setPromptReload(value => value + 1); }}>{t('sessions.retryPrompts')}</Button>}>
      {t(state.at ? 'sessions.promptsStale' : 'sessions.promptsFailed')}
    </StatusBanner>;
  }
  const showEmpty = !loading && !scopedSessions.length;
  const runningCount = scopedSessions.filter((item) => item.running).length;
  const endedCount = scopedSessions.filter(sessionConfirmedEnded).length;

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
    linkError: (error) => {
      // A link that does not resolve is a passing note, not a standing error: it clears itself.
      const message = formatFailure(error, t('sessions.openLinkFailed'), t('sessions.retry'));
      setActionError(message);
      window.clearTimeout(linkErrorTimer.current);
      linkErrorTimer.current = window.setTimeout(() => setActionError((value) => value === message ? '' : value), 6000);
    },
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
      else if (action === 'rail') toggleRail();
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
    grid: () => {},
    directory: (id, directory) => {
      void native.setWorkbenchDirectory(id, directory).then((canonical) => {
        setSessions((current) => current.map((item) => item.id === id ? { ...item, directory: canonical } : item));
        setGitContexts((current) => {
          if (!current.has(id)) return current;
          const next = new Map(current);
          next.delete(id);
          return next;
        });
      }).catch(() => {});
    },
  };

  // A launch elsewhere asks the workbench to focus its new session once. Returning to the
  // page later must keep whatever the user selected since, not jump back to that launch.
  const appliedFocusToken = useRef<number | null>(null);
  useEffect(() => { if (focusSessionId) selectPendingSession(focusSessionId); }, [focusSessionId, focusToken]);

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
    window.clearTimeout(linkErrorTimer.current);
    window.clearTimeout(findRefreshTimer.current);
  }, []);

  useEffect(() => {
    if (!active || !scopedSessions.some((item) => item.running)) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [active, scopedSessions]);

  useEffect(() => {
    if (!nativeAvailable) { setLoading(false); return; }
    let alive = true;
    const stops: Array<() => void> = [];
    const push = (sessionId: string, chunk: OutputChunk) => {
      const write = writers.current.get(sessionId);
      if (write) write(chunk);
      else {
        const queued = pending.current.get(sessionId) ?? [];
        let bytes = pendingBytes.current.get(sessionId) ?? 0;
        queued.push(chunk);
        bytes += chunk.data.length;
        // A terminal that is not mounted can still receive output while the
        // session list is loading. Keep only a bounded tail; replay() supplies
        // the complete recent output when the terminal mounts.
        while (bytes > MAX_PENDING_OUTPUT_BYTES && queued.length > 1) {
          bytes -= queued.shift()?.data.length ?? 0;
        }
        pending.current.set(sessionId, queued);
        pendingBytes.current.set(sessionId, bytes);
      }
    };
    void listen<WorkbenchOutput>('cliora:session-output', (event) => {
      if (alive) push(event.payload.sessionId, { data: event.payload.dataBase64, offset: typeof event.payload.offset === 'number' ? event.payload.offset : undefined });
    }).then((stop) => { if (alive) stops.push(stop); else stop(); }).catch(() => {});
    void listen<WorkbenchSession>('cliora:session-state', (event) => {
      if (!alive) return;
      const next = event.payload;
      const known = sessionStateUpdates.current.get(next.id);
      if (known && (known.stateRevision ?? 0) > (next.stateRevision ?? 0)) return;
      sessionStateUpdates.current.set(next.id, next);
      // Exit events can trail tab removal. Bound the small pre-list/tail cache
      // rather than retaining one snapshot for every session ever closed.
      const limit = allSessionsRef.current.length + 32;
      while (sessionStateUpdates.current.size > limit) {
        const oldest = sessionStateUpdates.current.keys().next().value;
        if (oldest === undefined) break;
        sessionStateUpdates.current.delete(oldest);
      }
      setSessions((current) => current.map((item) => item.id === next.id && (item.stateRevision ?? 0) <= (next.stateRevision ?? 0) ? { ...item, ...next } : item));
    }).then((stop) => { if (alive) stops.push(stop); else stop(); }).catch(() => {});
    void listen<WorkbenchExit>('cliora:session-exit', (event) => {
      if (!alive) return;
      if (soundEnabledRef.current) playWorkbenchChime('exit');
      setActiveOutputIds((current) => {
        if (!current.has(event.payload.sessionId)) return current;
        const next = new Set(current);
        next.delete(event.payload.sessionId);
        return next;
      });
      setSessions((current) => current.map((item) => item.id === event.payload.sessionId
        && (event.payload.stateRevision === undefined || (item.stateRevision ?? 0) <= event.payload.stateRevision)
        ? { ...item, running: false, exitCode: event.payload.exitCode ?? null, ...(event.payload.stateRevision === undefined ? {} : { stateRevision: event.payload.stateRevision }) } : item));
    }).then((stop) => { if (alive) stops.push(stop); else stop(); }).catch(() => {});
    return () => { alive = false; stops.forEach((stop) => { void Promise.resolve(stop()).catch(() => {}); }); };
  }, []);

  useEffect(() => {
    if (!active || !nativeAvailable) return;
    let alive = true;
    setLoading(true);
    // Attach the terminal as soon as its in-memory session is available. Project
    // directory checks and host/settings discovery can finish after CLI output.
    const listedSessions = native.listWorkbenchSessions();
    void listedSessions.then((listed) => {
      if (!alive) return;
      const next = Array.isArray(listed) ? listed : [];
      const now = Date.now();
      for (const item of next) if (!firstSeenAt.current.has(item.id)) firstSeenAt.current.set(item.id, item.startedAt ?? now);
      applyListedSessions(next);
      setListError('');
      const takeFocus = !!focusSessionId && appliedFocusToken.current !== focusToken && next.some((item) => item.id === focusSessionId);
      if (takeFocus) appliedFocusToken.current = focusToken;
      setSelectedId((current) => {
        if (takeFocus) return focusSessionId;
        if (current && next.some((item) => item.id === current)) return current;
        if (current && pendingSelectionId.current === current) return current;
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
    void native.listProjects().then((listed) => {
      if (alive) setProjects(Array.isArray(listed) ? listed : []);
    }).catch(() => {});
    void native.getLaunchSettings().then((settings) => {
      if (alive && settings) setLaunchSettings(settings);
    }).catch(() => {});
    const listedRemoteProjects = remoteSshEnabled ? native.listRemoteProjects().catch(() => [] as RemoteProject[]) : Promise.resolve([] as RemoteProject[]);
    const listedRemoteTargets = remoteSshEnabled ? native.listRemoteTargets().catch(() => null) : Promise.resolve([] as RemoteTarget[]);
    void listedRemoteProjects.then((listed) => {
      if (alive) setRemoteProjects(Array.isArray(listed) ? listed : []);
    });
    void listedRemoteTargets.then((listed) => {
      // Keep the shell's saved hosts until a real query finishes.
      if (alive && remoteSshEnabled && Array.isArray(listed)) setLoadedRemoteTargets(listed);
    });
    void Promise.all([
      listedSessions,
      listedRemoteProjects,
      listedRemoteTargets,
      remoteSshEnabled ? native.listRemoteSessions().catch(() => []) : Promise.resolve([]),
    ]).then(async ([, remoteProjects, remoteTargets, remoteSessions]) => {
      if (!alive || !remoteSshEnabled || autoRemoteReattachAttempted.current) return;
      // Discovery can finish after local restoration or a user launch. Compare
      // the index with a fresh, unscoped list instead of the startup snapshot.
      const latest = await native.listWorkbenchSessions();
      if (!alive || autoRemoteReattachAttempted.current) return;
      if (Array.isArray(latest)) {
        autoRemoteReattachAttempted.current = true;
        const projectTargets = new Map((Array.isArray(remoteProjects) ? remoteProjects : []).map((item) => [`remote:${item.id}`, item.targetId]));
        const validTargetIds = new Set((Array.isArray(remoteTargets) ? remoteTargets : []).filter((item) => item.enabled).map((item) => item.id));
        const identity = (targetId: string, remoteSessionId: string) => JSON.stringify([targetId, remoteSessionId]);
        const attached = new Set([...latest, ...allSessionsRef.current].flatMap((session) => {
          const targetId = session.projectId ? projectTargets.get(session.projectId) : undefined;
          return targetId && session.remoteSessionId ? [identity(targetId, session.remoteSessionId)] : [];
        }));
        const indexed = Array.isArray(remoteSessions)
          ? remoteSessions.filter((item) => {
            if (!item?.remoteSessionId || !item.projectId || !item.toolId || projectTargets.get(`remote:${item.projectId}`) !== item.targetId || !validTargetIds.has(item.targetId)) return false;
            const key = identity(item.targetId, item.remoteSessionId);
            if (attached.has(key)) return false;
            attached.add(key);
            return true;
          })
          : [];
        const requests = indexed.map((item) => native.launchCli({
          toolId: item.toolId,
          projectId: `remote:${item.projectId}`,
          sessionId: null,
          remoteIntent: { kind: 'reattach', remoteSessionId: item.remoteSessionId },
          mode: item.mode ?? 'normal',
          directory: item.directory ?? null,
          initialPrompt: null,
          resumeLatest: false,
        }));
        if (requests.length) void Promise.allSettled(requests).then(() => native.listWorkbenchSessions()).then((sessions) => { if (alive && Array.isArray(sessions)) applyListedSessions(sessions); }).catch(() => {});
      }
    }).catch(() => { /* Session list failures are reported by the attachment above. */ });
    return () => { alive = false; };
  }, [active, focusToken, focusSessionId, reload, remoteSshEnabled, t]);

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

  const toggleEndedCollapsed = useCallback(() => {
    setEndedCollapsed((current) => {
      const next = !current;
      try { localStorage.setItem('cliora:workbench-ended-collapsed', String(next)); } catch { /* Storage is optional. */ }
      return next;
    });
  }, []);

  /** Double-clicking a session icon, or Mod+Shift+B, flips the rail; focus mode returns to the rail first. */
  function toggleRail() {
    if (focusMode) { setFocusMode(false); return; }
    // Narrow windows show the list as a strip, which has nothing to fold.
    if (railHost) onToggleRailSlim?.();
  }
  if (railToggleRef) railToggleRef.current = active ? toggleRail : null;

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
    const project = session.projectId ? projects.find((item) => item.id === session.projectId) : undefined;
    const title = railTaskTitle(titles.get(session.id) ?? '', toolName(session), [project?.name ?? '', session.directory ?? '']);
    const remoteProject = remoteProjects.find((item) => `remote:${item.id}` === session.projectId);
    return session.projectId?.startsWith('remote:')
      ? `${title || remoteProject?.name || shortPath(displayPath(session.directory)) || toolName(session)} · ${(session.remoteSessionId || session.id).slice(-8)}`
      : title;
  }

  function railPlaceOf(session: WorkbenchSession): string {
    const project = session.projectId ? projects.find((item) => item.id === session.projectId) : undefined;
    return railPlace(project?.name, session.directory) || placeOf(session);
  }

  function modeLabel(mode: LaunchMode): string {
    return mode === 'yolo' ? t('sessions.modeYolo') : t('sessions.modeNormal');
  }

  function sessionTone(session: WorkbenchSession): SessionTone {
    if (!session.running && remoteSessionMayExist(session)) return 'ended';
    if (!session.running) return session.exitCode != null && session.exitCode !== 0 ? 'error' : 'ended';
    if (attentionIds.has(session.id)) return 'bell';
    if (activeOutputIds.has(session.id)) return 'live';
    return 'idle';
  }

  function forgetSession(id: string) {
    sessionStateUpdates.current.delete(id);
    firstSeenAt.current.delete(id);
    setTitles((current) => { if (!current.has(id)) return current; const next = new Map(current); next.delete(id); return next; });
    setActiveOutputIds((current) => { if (!current.has(id)) return current; const next = new Set(current); next.delete(id); return next; });
    setScrolledIds((current) => { if (!current.has(id)) return current; const next = new Set(current); next.delete(id); return next; });
    setAttentionIds((current) => { if (!current.has(id)) return current; const next = new Set(current); next.delete(id); return next; });
    setUnreadIds((current) => toggleInSet(current, id, false));
    setGitContexts((current) => { if (!current.has(id)) return current; const next = new Map(current); next.delete(id); return next; });
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
    if (session.running || remoteSessionMayExist(session)) {
      const accepted = await confirmAction(
        t('sessions.endConfirmMessage', { tool: toolName(session), place: placeOf(session) }),
        () => sessionsRef.current.some((item) => item.id === session.id),
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
      setSessions((current) => current.filter((item) => item.id !== session.id));
      setSelectedId((current) => current === session.id ? (rest.find((item) => item.running)?.id ?? rest[0]?.id ?? null) : current);
    } catch (value) {
      setActionError(formatFailure(value, t('sessions.closeFailed'), t('sessions.closeNext')));
    } finally { setBusy(''); }
  }

  async function reattachSession(session: WorkbenchSession) {
    if (busy || session.running || !session.reattachable) return;
    setBusy('reattach:' + session.id);
    setActionError('');
    try {
      await native.reattachWorkbenchSession(session.id, handles.current.get(session.id)?.size());
      const listed = await native.listWorkbenchSessions();
      applyListedSessions(listed);
      setSelectedId(session.id);
    } catch (value) {
      setActionError(formatFailure(value, t('sessions.reattachFailed'), t('sessions.reattachNext')));
    } finally { setBusy(''); }
  }

  async function clearEndedSessions() {
    const ended = scopedSessions.filter(sessionConfirmedEnded);
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
      const rest = scopedSessions.filter((item) => !closedIds.has(item.id));
      setSessions((current) => current.filter((item) => !closedIds.has(item.id)));
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
      if (result.warnings?.length) setNotice(result.warnings.join('\n'));
      const opened = workbenchSessionId(result);
      if (opened) {
        onFailure(null);
        selectPendingSession(opened);
        const listed = await native.listWorkbenchSessions().catch(() => sessionsRef.current);
        if (Array.isArray(listed)) applyListedSessions(listed);
        return;
      }
      onFailure(null);
      setNotice(result.status === 'desktop_requested' ? t('sessions.desktopOpened') : t('sessions.externalOpened'));
    } catch (value) {
      onFailure({ ...failure, detail: formatFailure(value, t('sessions.launchFailed'), t('sessions.failureHint')) });
    } finally { setRetrying(false); }
  }

  function openNewSessionDialog(prefill?: { toolId?: string; projectId?: string }, targetOverride?: string) {
    setDialogError('');
    const targetId = targetOverride || activeTargetId;
    if (targetId !== 'local' && remoteSshEnabled && !prefill?.projectId) {
      setRemotePrefillToolId(prefill?.toolId && terminalTools.some((item) => item.id === prefill.toolId) ? prefill.toolId : null);
      setNewDialogOpen(false);
      setRemoteDialogOpen(true);
      return;
    }
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

  async function launchRemoteProject(project: RemoteProject, toolOverride?: string) {
    const toolId = toolOverride && terminalTools.some((item) => item.id === toolOverride)
      ? toolOverride
      : project.preferredTool && terminalTools.some((item) => item.id === project.preferredTool)
        ? project.preferredTool
        : effectiveLaunchToolId;
    if (!toolId || newLaunchPending.current) return;
    newLaunchPending.current = true;
    setLaunchingNew(true);
    setDialogError('');
    setActionError('');
    setNotice('');
    try {
      const tool = terminalTools.find((item) => item.id === toolId);
      const mode = preferredLaunchMode(launchSettings, 'project', !!tool?.yoloAvailable);
      const result = await native.launchCli({
        toolId,
        projectId: `remote:${project.id}`,
        sessionId: null,
        remoteIntent: { kind: 'new' },
        mode,
        directory: null,
        initialPrompt: null,
        resumeLatest: false,
      });
      try { localStorage.setItem(`cliora:remote-launch-project:${project.targetId}:${toolId}`, project.id); } catch { /* optional */ }
      if (result.warnings?.length) setNotice(result.warnings.join('\n'));
      const opened = workbenchSessionId(result);
      if (opened) {
        setRemoteQuickLaunch(false);
        setRemotePrefillToolId(null);
        onFailure(null);
        setNewDialogOpen(false);
        setRemoteDialogOpen(false);
        selectPendingSession(opened);
        const listed = await native.listWorkbenchSessions().catch(() => sessionsRef.current);
        if (Array.isArray(listed)) applyListedSessions(listed);
      } else {
        setNotice(result.status === 'desktop_requested' ? t('sessions.desktopOpened') : t('sessions.externalOpened'));
      }
    } catch (value) {
      setActionError(formatFailure(value, t('sessions.launchFailed'), t('sessions.failureHint')));
    } finally { newLaunchPending.current = false; setLaunchingNew(false); }
  }

  function handleRemoteProjectSaved(project: RemoteProject) {
    setRemoteProjects((current) => [...current.filter((item) => item.id !== project.id), project]);
    setWorkspaceValue(`remote:${project.id}`);
    const preferredTool = remotePrefillToolId && terminalTools.some((item) => item.id === remotePrefillToolId)
      ? remotePrefillToolId
      : project.preferredTool && terminalTools.some((item) => item.id === project.preferredTool)
        ? project.preferredTool
        : effectiveLaunchToolId;
    if (preferredTool) setLaunchToolId(preferredTool);
    const nextTool = terminalTools.find((item) => item.id === preferredTool);
    setLaunchMode(preferredLaunchMode(launchSettings, 'project', !!nextTool?.yoloAvailable));
    setRemoteDialogOpen(false);
    if (remoteQuickLaunch) {
      void launchRemoteProject(project, preferredTool);
      setRemoteQuickLaunch(false);
      setRemotePrefillToolId(null);
      return;
    }
    setRemotePrefillToolId(null);
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
    if (!effectiveLaunchToolId || newLaunchPending.current) return;
    newLaunchPending.current = true;
    setLaunchingNew(true);
    setDialogError('');
    setActionError('');
    setNotice('');
    try {
      if (launchSettings && launchSettings.selected !== 'workbench') {
        const updated = await native.setPreferredTerminal('workbench').catch(() => null);
        if (updated) setLaunchSettings(updated);
      }
      const projectId = workspaceValue.startsWith('project:')
        ? workspaceValue.slice('project:'.length)
        : workspaceValue.startsWith('remote:')
          ? workspaceValue
          : null;
      const directory = workspaceValue.startsWith('custom:') ? workspaceValue.slice('custom:'.length) : null;
      const promptText = initialPrompt.trim() || null;
      const request: LaunchRequest = {
        toolId: effectiveLaunchToolId,
        projectId,
        sessionId: null,
        ...(projectId?.startsWith('remote:') ? { remoteIntent: { kind: 'new' as const } } : {}),
        mode: selectedLaunchTool?.yoloAvailable ? launchMode : 'normal',
        directory,
        ...(promptText ? { initialPrompt: promptText } : {}),
        ...(resumeLatest && selectedLaunchTool?.resumeLatestAvailable && !projectId?.startsWith('remote:') ? { resumeLatest: true } : {}),
      };
      const result = await native.launchCli(request);
      if (result.warnings?.length) setNotice(result.warnings.join('\n'));
      const opened = workbenchSessionId(result);
      if (opened) {
        onFailure(null);
        setNewDialogOpen(false);
        setInitialPrompt('');
        selectPendingSession(opened);
        const listed = await native.listWorkbenchSessions().catch(() => sessions);
        if (Array.isArray(listed)) applyListedSessions(listed);
        return;
      }
      setNewDialogOpen(false);
      setNotice(result.status === 'desktop_requested' ? t('sessions.desktopOpened') : t('sessions.externalOpened'));
    } catch (value) {
      setDialogError(formatFailure(value, t('sessions.launchFailed'), t('sessions.failureHint')));
    } finally { newLaunchPending.current = false; setLaunchingNew(false); }
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
      if (result.warnings?.length) setNotice(result.warnings.join('\n'));
      const opened = workbenchSessionId(result);
      if (opened) {
        if (replaceEnded && !session.running) {
          await native.closeWorkbenchSession(session.id).catch(() => {});
          forgetSession(session.id);
        }
        onFailure(null);
        selectPendingSession(opened);
        const listed = await native.listWorkbenchSessions().catch(() => sessions);
        if (Array.isArray(listed)) applyListedSessions(listed);
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
    return scopedSessions.filter((session) => {
      if (!query) return true;
      return toolName(session).toLowerCase().includes(query)
        || (titles.get(session.id) ?? '').toLowerCase().includes(query)
        || placeOf(session).toLowerCase().includes(query)
        || (session.directory ?? '').toLowerCase().includes(query);
    });
  }, [scopedSessions, railSearch, projects, tools, titles]);

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
  const availableRemoteProjects = useMemo(() => activeTargetId === 'local' ? [] : remoteProjects.filter((item) => item.path && item.targetId === activeTargetId), [activeTargetId, remoteProjects]);
  useEffect(() => {
    // An empty list means "not loaded yet" until either this screen or the shell has hosts.
    // Resetting earlier snaps a selected SSH host back to this computer while the sidebar stays put.
    if (activeTargetId === 'local') return;
    if (loadedRemoteTargets === null && syncedRemoteTargets.length === 0) return;
    if (remoteTargets.some((target) => target.enabled && target.id === activeTargetId)) return;
    setActiveTargetId('local');
    onRemoteTargetChange?.('local');
  }, [activeTargetId, loadedRemoteTargets, remoteTargets, syncedRemoteTargets]);

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
      if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggleRail();
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
  }, [active, newDialogOpen, filteredSessions, terminalTools, selected?.running, focusMode, narrowFrame]);

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
      ...(remoteSshEnabled ? availableRemoteProjects.map((project) => ({ value: `remote:${project.id}`, label: project.name, detail: `${remoteTargets.find((target) => target.id === project.targetId)?.name ?? project.targetId} · ${project.path}`, icon: <Icon name="globe" size={14} /> })) : []),
    ];
    if (customFolderPath) list.push({ value: `custom:${customFolderPath}`, label: shortPath(displayPath(customFolderPath)), detail: displayPath(customFolderPath), icon: <Icon name="folder" size={14} /> });
    return list;
  }, [availableProjects, availableRemoteProjects, customFolderPath, remoteSshEnabled, remoteTargets, t]);

  const railSessions: RailSession[] = arrangedSessions.map((session) => ({
    session,
    name: toolName(session),
    title: taskTitle(session),
    place: railPlaceOf(session),
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
    if (!session.running && remoteSessionMayExist(session)) return t('sessions.activityUnknown');
    if (!session.running) return tone === 'error' ? t('sessions.stateError') : t('sessions.ended');
    if (tone === 'bell') return t('sessions.bellBadge');
    return tone === 'live' ? t('sessions.stateStreaming') : t('sessions.stateIdle');
  }

  // Every live terminal stays mounted, including other hosts' sessions: a remount replays history
  // into a fresh xterm. Ended ones are mounted only while on screen or recently viewed.
  const mountedSessions = sessions.filter((session) => session.running || visibleIds.includes(session.id) || recentSessionIds.includes(session.id));
  // A pending selection has no input target until that identity has been listed.
  const stageSession = selected;

  const railDocked = !!railHost;
  const showRail = !focusMode && !(showEmpty && !listError);
  const railShown = railDocked && showRail;
  useEffect(() => {
    onRailLayout?.({ docked: railShown, focus: railDocked && focusMode });
  }, [onRailLayout, railShown, railDocked, focusMode]);
  // The sidebar is the rail's column now: its width follows the stored rail width.
  useEffect(() => {
    const shell = railHost?.closest<HTMLElement>('.shell');
    if (!shell) return;
    shell.style.setProperty('--rail-w', railWidth + 'px');
    return () => { shell.style.removeProperty('--rail-w'); };
  }, [railHost, railWidth]);
  const rail = <SessionRail sessions={railSessions} total={scopedSessions.length} running={runningCount} ended={endedCount} search={railSearch} selectedId={selectedId} narrow={!railDocked} slim={railDocked && railSlim} docked={railDocked} busy={!!busy} canLaunch={terminalTools.length > 0}
    endedCollapsed={endedCollapsed} onToggleEnded={toggleEndedCollapsed} onSearch={setRailSearch} onSelect={(id, focusTerminal = true) => {
      setSelectedId(id);
      if (focusTerminal) requestAnimationFrame(() => {
        if (selectedIdRef.current === id) handles.current.get(id)?.focus();
      });
    }} onNewSession={() => openNewSessionDialog()} onOpenMenu={openRowMenu} onRemove={(session) => void endSession(session)} onClearEnded={() => void clearEndedSessions()} onToggleSlim={toggleRail} />;

  return <div ref={rootRef} className={styles.root} data-focus-mode={focusMode || undefined} data-empty={(showEmpty && !listError) || undefined} data-term-theme={terminalMode} data-narrow={narrowFrame || undefined} data-compact={compactFrame || undefined} data-tight={tightFrame || undefined} data-rail-docked={railDocked || undefined}>
    {(focusMode || (showEmpty && !listError)) && <h1 className={styles.srOnly} tabIndex={-1}>{t('common.pages.sessions.title')}</h1>}
    {listError && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><strong>{t('sessions.listFailed')}</strong><p>{listError}</p></div><Button size="sm" onClick={() => setReload((value) => value + 1)}>{t('sessions.retry')}</Button></div>}

    <div className={styles.layout} data-strip={(!railDocked && showRail) || undefined}>
      {!railDocked && showRail && rail}

      <section ref={stageRef} className={styles.stage} aria-label={t('sessions.stageLabel')}>
        {writeRecoveryNeeded && !stageSession && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><p>{t('common.remoteWrite.unknown')}</p></div><div className={styles.bannerActions}><Button size="sm" onClick={() => requestWriteRecovery(remoteTargetId)}>{t('common.remoteWrite.open')}</Button></div></div>}
        {failure && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><strong>{t('sessions.launchFailed')}</strong><p>{failure.detail}</p><p>{t('sessions.failureHint')}</p></div><div className={styles.bannerActions}><Button variant="primary" size="sm" icon={<Icon name="refresh" size={14} />} onClick={() => void retry()} disabled={retrying}>{retrying ? t('sessions.loading') : t('sessions.retry')}</Button><Button size="sm" onClick={() => onFailure(null)}>{t('sessions.dismissBanner')}</Button></div></div>}
        {actionError && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><p>{actionError}</p></div><IconButton size="sm" icon={<Icon name="close" size={14} />} onClick={() => setActionError('')} aria-label={t('common.dismissError')} /></div>}
        {restoring && <div className={styles.banner} role="status"><p>{t('sessions.restoringPrevious')}</p></div>}
        {restoreError && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><p>{restoreError}</p></div><Button size="sm" disabled={restoring} onClick={() => void restoreLocalSessions()}>{t('sessions.retryRestore')}</Button></div>}
        {restoreFailures.map(({ session, detail }) => <div className={styles.banner} role="status" key={session.id}>
          <div className={styles.bannerCopy}><strong>{t('sessions.restorePending', { tool: tools.find(tool => tool.id === session.toolId)?.name ?? session.toolId })}</strong><p>{displayPath(session.directory)} · {detail}</p></div>
          <div className={styles.bannerActions}><Button size="sm" disabled={restoring} onClick={() => void restoreLocalSessions()}>{t('sessions.retryRestore')}</Button><Button size="sm" disabled={restoring} onClick={() => void native.forgetWorkbenchRestore(session.id).then(() => setRestoreFailures(current => current.filter(item => item.session.id !== session.id))).catch(value => setActionError(String(value?.message ?? value)))}>{t('sessions.dismissRestore')}</Button></div>
        </div>)}
        {notice && <div className={styles.banner} data-tone="status" role="status"><div className={styles.bannerCopy}><p>{notice}</p></div><IconButton size="sm" icon={<Icon name="close" size={14} />} onClick={() => setNotice('')} aria-label={t('common.dismissError')} /></div>}

        {mountedSessions.length > 0 && (() => {
          // Terminals stay mounted while the selection briefly points at a session the list has not
          // returned yet (a launch, a restore). Unmounting them would replay history into a fresh
          // xterm, and the replay's device queries would be answered into the running CLI.
          const current = stageSession;
          const tone = current ? sessionTone(current) : 'ended';
          const title = current ? taskTitle(current) : '';
          const elapsed = current ? formatDuration(current.startedAt ?? firstSeenAt.current.get(current.id), clock) : '';
          const currentStateLabel = current ? stateLabel(current, tone) : '';
          const stateReserves = [
            t('sessions.stateIdle'),
            t('sessions.stateStreaming'),
            t('sessions.bellBadge'),
            t('sessions.stateError'),
            t('sessions.ended'),
          ].filter((label) => label !== currentStateLabel);
          const endLabel = current && busy === current.id ? t('sessions.ending') : current && (current.running || remoteSessionMayExist(current)) ? t('sessions.endShort') : t('sessions.closeTabShort');
          const endReserves = [t('sessions.ending'), t('sessions.endShort'), t('sessions.closeTabShort')]
            .filter((label) => label !== endLabel);
          const git = current ? gitContexts.get(current.id) ?? null : null;
          const gitLabel = git ? git.branch ?? git.commit ?? '' : '';
          const worktreeLabel = git?.worktree ? compactText(git.worktree, 18) : '';
          const gitTitle = git ? [git.branch ? t('sessions.gitBranch', { name: git.branch }) : t('sessions.gitDetached', { commit: git.commit }), git.worktree ? t('sessions.gitWorktree', { name: git.worktree }) : '', git.repository ? t('sessions.gitRepository', { name: git.repository }) : ''].filter(Boolean).join(' · ') : '';
          const canSplit = splitRoom && scopedSessions.length > 1;
          const splitLabel = split ? t('sessions.splitViewExit') : canSplit ? t('sessions.splitView') : t('sessions.splitNeedsTwo');
          const remote = !!current?.projectId?.startsWith('remote:');
          const remoteProject = remote ? remoteProjects.find((project) => `remote:${project.id}` === current?.projectId) : undefined;
          const remoteHost = remoteProject ? remoteTargets.find((target) => target.id === remoteProject.targetId) : undefined;
          const hostLabel = remote ? remoteHost?.name ?? 'SSH' : t('common.host.local');
          return <div className={styles.window} hidden={!current} data-split={split ? 'true' : undefined} data-tone={tone}>
            {current && <header className={styles.stageBar} onDoubleClick={(event) => {
              // Double-clicking the bare title bar toggles focus mode, like maximizing a window.
              if (!(event.target instanceof Element) || event.target.closest('button, a, input, [role="toolbar"], [data-stage-icon]')) return;
              setFocusMode((value) => !value);
            }}>
              <div className={styles.stageLead}>
                <span className={styles.stageIcon} data-tone={tone} data-stage-icon="" title={t('sessions.stageIconHint')} onDoubleClick={(event) => { event.stopPropagation(); toggleRail(); }}><ToolIcon toolId={current.toolId} size={20} /><SessionActivityIcon tone={tone} slot="stage" className={styles.stageIconDot} /></span>
                <div className={styles.identityText}>
                  <div className={styles.identityTitleRow}><h2 title={title ? toolName(current) + ' · ' + stableTitle(title) : toolName(current)}>{title ? <SessionTitle title={title} /> : toolName(current)}</h2><Badge className={styles.statusChip} tone={sessionBadgeTone(tone)} data-state={tone} title={currentStateLabel}><SessionActivityIcon tone={tone} slot="status" className={styles.statusDot} /><span className={styles.statusLabel}><span>{currentStateLabel}</span>{stateReserves.map((label) => <span key={label} aria-hidden="true">{label}</span>)}</span></Badge></div>
                  <div className={styles.identitySub}>
                    {title && <span className={styles.identityTool}>{toolName(current)}</span>}
                    <button type="button" className={styles.pathChip} title={current.directory ? displayPath(current.directory) + ' · ' + t('sessions.copyPath') : placeOf(current)} onClick={() => void copySessionPath(current)}><Icon name={copiedState === 'path' ? 'check' : 'folder'} size={12} /><span>{copiedState === 'path' ? t('sessions.pathCopied') : placeOf(current)}</span></button>
                    {current.mode === 'yolo' && <span className={styles.modeChip} data-mode="yolo" title={t('sessions.modeYoloDesc')}><Icon name="sparkle" size={11} />{modeLabel(current.mode)}</span>}
                    {elapsed && <span className={styles.sessionElapsed}><Icon name="clock" size={12} />{elapsed}</span>}
                    {!current.running && current.exitCode != null && <span className={styles.exitCode} data-failed={current.exitCode !== 0 || undefined}>{t('sessions.exitCode', { code: current.exitCode })}</span>}
                  </div>
                </div>
              </div>
              <div className={styles.stageTail}>
                <div className={styles.terminalActions} role="toolbar" aria-label={t('sessions.terminalMenu')}>
                  <span className={`${styles.actionGroup} ${styles.runningActions}`} data-running={current.running || undefined} aria-hidden={current.running ? undefined : true}>
                    <Button variant="ghost" size="sm" className={`${styles.toolButton} ${styles.composerTrigger}`} aria-label={t('sessions.composerShort')} aria-pressed={composerOpen} title={t('sessions.composerShort') + ` (${modLabel}+Shift+M)`} disabled={!current.running} onClick={() => toggleComposer()} icon={<Icon name="pencil" size={14} />}><span className={styles.toolLabel}>{t('sessions.composerShort')}</span></Button>
                    <Button variant="ghost" size="sm" className={`${styles.toolButton} ${styles.interruptBtn}`} aria-label={t('sessions.sendInterrupt')} title={t('sessions.sendInterrupt')} disabled={!current.running} onClick={() => void sendToSession(current, '\x03')} icon={<Icon name="ban" size={14} />}><span className={styles.toolLabel}>{t('sessions.interruptShort')}</span></Button>
                  </span>
                  {(current.reattachable || writeRecoveryNeeded) && <span className={styles.actionGroup}>{current.reattachable && <Button variant="ghost" size="sm" className={`${styles.toolButton} ${styles.reattachBtn}`} aria-label={t('sessions.reattachRemote')} title={t('sessions.reattachRemote')} disabled={!!busy} onClick={() => void reattachSession(current)} icon={<Icon name="refresh" size={14} />}><span className={styles.toolLabel}>{busy === 'reattach:' + current.id ? t('sessions.reattaching') : t('sessions.reattachShort')}</span></Button>}{writeRecoveryNeeded && <Button variant="ghost" size="sm" className={`${styles.toolButton} ${styles.reattachBtn}`} aria-label={t('common.remoteWrite.open')} title={t('common.remoteWrite.unknown')} disabled={!!busy} onClick={() => requestWriteRecovery(remoteTargetId)} icon={<Icon name="alert" size={14} />}><span className={styles.toolLabel}>{t('common.remoteWrite.open')}</span></Button>}</span>}
                  <span className={styles.actionGroup}>
                    <IconButton size="sm" className={styles.toolButton} aria-label={t('sessions.findOutput')} aria-pressed={findOpen} title={t('sessions.findOutput') + ` (${modLabel}+Shift+F)`} onClick={openFind} icon={<Icon name="search" size={15} />} />
                    {splitRoom && <IconButton size="sm" className={styles.toolButton} data-tool="split" aria-label={t('sessions.splitView')} aria-pressed={!!split} disabled={!split && !canSplit} title={splitLabel + ` (${modLabel}+Shift+D)`} onClick={toggleSplit} icon={<Icon name="columns" size={15} />} />}
                    <IconButton size="sm" className={`${styles.toolButton} ${styles.focusBtn}`} aria-pressed={focusMode} aria-label={focusMode ? t('sessions.exitFocusMode') : t('sessions.focusMode')} title={(focusMode ? t('sessions.exitFocusMode') : t('sessions.focusMode')) + ' · ' + t('sessions.focusHint')} onClick={() => setFocusMode((value) => !value)} icon={<Icon name={focusMode ? 'minimize' : 'maximize'} size={15} />} />
                    <IconButton size="sm" className={styles.toolButton} aria-label={t('sessions.moreActions')} aria-haspopup="menu" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); openTerminalMenu(current, rect.right, rect.bottom + 6); }} icon={<Icon name="more" size={15} />} />
                  </span>
                </div>
                <Button size="sm" className={styles.endBtn} data-running={current.running || undefined} onClick={() => void endSession(current)} disabled={!!busy} aria-label={current.running || remoteSessionMayExist(current) ? t('sessions.end') : t('sessions.closeTab')} title={current.running || remoteSessionMayExist(current) ? t('sessions.end') : t('sessions.closeTab')} icon={<span className={styles.endIcon}><Icon name={current.running || remoteSessionMayExist(current) ? 'square' : 'close'} size={current.running || remoteSessionMayExist(current) ? 11 : 13} /></span>}><span className={styles.statusLabel}><span>{endLabel}</span>{endReserves.map((label) => <span key={label} aria-hidden="true">{label}</span>)}</span></Button>
              </div>
            </header>}

            <div className={styles.screen}>
              {current && findOpen && <div className={styles.findLayer} data-split={split ? 'true' : undefined} data-pane={split ? split.indexOf(current.id) : undefined}>
                <div className={styles.findPanel} role="search">
                  <div className={styles.findField} data-field-frame=""><Icon name="search" size={14} /><input ref={findInputRef} type="search" value={findQuery} placeholder={t('sessions.findPlaceholder')} aria-label={t('sessions.findPlaceholder')} onChange={(event) => setFindQuery(event.target.value)} onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); stepFindMatch(event.shiftKey ? -1 : 1); }
                    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFind(); }
                  }} /><span className={styles.findCount} data-empty={(findQuery.trim() && !findMatches.length) || undefined}>{!findQuery.trim() ? '' : findMatches.length > 0 ? t('sessions.findMatchCount', { current: findIndex + 1, total: findMatches.length }) : t('sessions.findNoMatch')}</span></div>
                  <Button variant="ghost" size="sm" className={styles.findToggle} aria-pressed={findCase} aria-label={t('sessions.findCase')} title={t('sessions.findCase')} onClick={() => { setFindCase((value) => !value); findInputRef.current?.focus(); }}>Aa</Button>
                  <span className={styles.findDivider} aria-hidden="true" />
                  <IconButton size="sm" className={styles.iconBtn} disabled={!findMatches.length} aria-label={t('sessions.findPrev')} title={t('sessions.findPrev') + ' (Shift+Enter)'} onClick={() => stepFindMatch(-1)} icon={<Icon name="arrowUp" size={14} />} />
                  <IconButton size="sm" className={styles.iconBtn} disabled={!findMatches.length} aria-label={t('sessions.findNext')} title={t('sessions.findNext') + ' (Enter)'} onClick={() => stepFindMatch(1)} icon={<Icon name="arrowDown" size={14} />} />
                  <IconButton size="sm" className={styles.iconBtn} aria-label={t('common.dialog.close')} title={t('common.dialog.close') + ' (Esc)'} onClick={closeFind} icon={<Icon name="close" size={14} />} />
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
                  const target = scopedSessions.find((item) => item.id === id) ?? current;
                  if (target) openTerminalMenu(target, event.clientX, event.clientY);
                }}>
                {mountedSessions.map((session) => {
                  const pane = visibleIds.indexOf(session.id);
                  const visible = pane >= 0;
                  const focused = session.id === selectedId;
                  const paneTitle = taskTitle(session);
                  const failed = !session.running && session.exitCode != null && session.exitCode !== 0;
                  return <SessionTerminal key={session.id} sessionId={session.id} label={t('sessions.terminalLabel', { tool: toolName(session) })} active={visible} focused={focused} pane={split ? pane : undefined} running={session.running} remote={!!session.projectId?.startsWith('remote:')} startedAt={session.startedAt ?? firstSeenAt.current.get(session.id)} fontSize={fontSize} lineHeight={DENSITY_LINE_HEIGHT[density]} theme={terminalMode} cursorBlink={cursorBlink} writers={writers} pending={pending} handles={handles} bridge={bridge}
                    header={split && visible ? <div className={styles.paneHead}>
                      <SessionActivityIcon tone={sessionTone(session)} slot="pane" className={styles.paneDot} label={stateLabel(session, sessionTone(session))} />
                      <ToolIcon toolId={session.toolId} size={14} />
                      <strong>{paneTitle ? <SessionTitle title={paneTitle} /> : toolName(session)}</strong>
                      <span className={styles.panePlace}>{paneTitle ? toolName(session) + ' · ' + placeOf(session) : placeOf(session)}</span>
                      {focused && <span className={styles.paneFocus}>{t('sessions.paneFocused')}</span>}
                      <button type="button" className={styles.paneClose} aria-label={t('sessions.closePane', { name: toolName(session) })} title={t('sessions.closePane', { name: toolName(session) })} onClick={(event) => { event.stopPropagation(); closePane(session.id); }}><Icon name="close" size={12} /></button>
                    </div> : null}
                    overlay={visible ? <>
                      {scrolledIds.has(session.id) && <button type="button" className={styles.jumpLatest} aria-label={t('sessions.jumpToBottom')} title={t('sessions.jumpToBottom')} onClick={() => { const handle = handles.current.get(session.id); handle?.scrollToBottom(); handle?.focus(); }}><Icon name="arrowDown" size={14} /><span>{t('sessions.jumpToBottom')}</span></button>}
                      {dropTarget === session.id && <div className={styles.dropOverlay} aria-hidden="true"><div className={styles.dropCard}><span className={styles.dropGlyph}><Icon name="upload" size={22} /></span><strong>{t('sessions.dropHint')}</strong><span>{t('sessions.dropHintDetail', { tool: toolName(session) })}</span></div></div>}
                    </> : null}
                    footer={visible && !session.running ? <div className={styles.endedBar} data-failed={failed || undefined}>
                      <span className={styles.endedGlyph}><Icon name={failed ? 'alert' : 'info'} size={15} /></span>
                      <span className={styles.endedText}><strong>{session.reattachable ? t(session.connectionState === 'unknown' ? 'sessions.sshUnknown' : 'sessions.sshDisconnectedReattachable') : t('sessions.sessionEndedBanner')}</strong>{session.exitCode != null && <span className={styles.endedCode}>{t('sessions.exitCode', { code: session.exitCode })}</span>}<span className={styles.endedDetail}>{session.reattachable ? t('sessions.reattachNext') : t('sessions.endedHintShort')}</span></span>
                      <Button variant="primary" size="sm" className={styles.endedRestart} disabled={!!busy} title={session.reattachable ? t('sessions.reattachRemote') : t('sessions.restartHint')} onClick={() => void (session.reattachable ? reattachSession(session) : restartOrCloneSession(session, true))} icon={<Icon name="refresh" size={13} />}><span className={styles.endedRestartLabel}>{session.reattachable ? t(busy === 'reattach:' + session.id ? 'sessions.reattaching' : 'sessions.reattachShort') : busy === 'restart:' + session.id ? t('sessions.restarting') : t('sessions.restartSession')}</span></Button>
                      {writeRecoveryNeeded && <Button variant="primary" size="sm" className={styles.endedRestart} disabled={!!busy} title={t('common.remoteWrite.unknown')} onClick={() => requestWriteRecovery(remoteTargetId)} icon={<Icon name="alert" size={13} />}><span className={styles.endedRestartLabel}>{t('common.remoteWrite.open')}</span></Button>}
                    </div> : null} />;
                })}
                {copiedState && <div className={styles.toastPill} role="status"><Icon name={copiedState === 'empty' ? 'info' : 'check'} size={14} /><span>{copiedMessage}</span></div>}
              </div>
              {current?.running && composerOpen && <WorkbenchComposer toolId={current.toolId} toolName={toolName(current)} place={placeOf(current)} draft={composerDrafts[current.id] ?? ''} prompts={composerPrompts} promptFeedback={promptFeedback(composerHostId, composerIdentity)} inputRef={composerInputRef} onChange={updateComposerDraft} onSubmit={() => void submitComposer()} onClose={() => toggleComposer(false)} />}
              {current && <footer className={styles.statusBar}>
                <span className={styles.statusItem} data-host={remote ? 'remote' : 'local'} title={`${t('common.host.label')}：${hostLabel}${remoteHost ? ` · ${remoteHost.user}@${remoteHost.host}` : ''}`}><Icon name={remote ? 'server' : 'monitor'} size={12} />{hostLabel}</span>
                {gitLabel && <span className={styles.statusGit} title={gitTitle} aria-label={gitTitle}><Icon name="branch" size={12} /><span>{gitLabel}</span>{git?.worktree && <span className={styles.statusWorktree} title={git.worktree}>{t('sessions.gitWorktreeShort')} · {worktreeLabel}</span>}</span>}
                {remote && <Badge className={styles.statusBadge} tone={current.connectionState === 'connected' ? 'success' : current.connectionState === 'disconnected' || current.connectionState === 'unknown' ? 'warning' : 'neutral'} title={current.exitReason === 'connection_lost' ? t('sessions.sshConnectionLostHint') : t('sessions.sshRemoteSession')}>SSH · {t(current.connectionState === 'connected' ? 'sessions.sshConnected' : current.connectionState === 'connecting' ? 'sessions.sshConnecting' : current.connectionState === 'disconnected' ? 'sessions.sshDisconnectedReattachable' : current.connectionState === 'remote_ended' ? 'sessions.sshEnded' : 'sessions.sshUnknown')}{current.remoteSessionId ? ` · ${current.remoteSessionId}` : ''}{current.remoteEndResult && current.remoteEndResult.outcome !== 'confirmed_absent' ? ` · ${t('sessions.sshEndUnconfirmed')}${current.remoteEndResult.exitCode != null ? ` (${current.remoteEndResult.exitCode})` : ''}` : ''}</Badge>}
                <span className={styles.statusSpacer} />
                {scrolledIds.has(current.id) && <Badge className={styles.statusBadge} tone="warning"><Icon name="arrowUp" size={12} />{t('sessions.scrolledBack')}</Badge>}
                {split && <span className={styles.statusItem} data-tone="accent"><Icon name="columns" size={12} />{t('sessions.splitView')}</span>}
                <span className={styles.statusTools}>
                  <TerminalAppearance open={appearanceOpen} theme={themePreference} fontSize={fontSize} defaultFontSize={DEFAULT_FONT_SIZE} minFontSize={MIN_FONT_SIZE} maxFontSize={MAX_FONT_SIZE} density={density} cursorBlink={cursorBlink} soundEnabled={soundEnabled} onToggle={() => { setMenu(null); setShortcutsOpen(false); setAppearanceOpen((value) => !value); }} onClose={closeAppearance} onTheme={setTerminalTheme} onFontSize={updateFontSize} onDensity={updateDensity} onCursorBlink={toggleCursorBlink} onSound={toggleSound} />
                  <WorkbenchShortcuts open={shortcutsOpen} onToggle={() => { setAppearanceOpen(false); setShortcutsOpen((value) => !value); }} onClose={closeShortcuts} />
                </span>
              </footer>}
            </div>
          </div>;
        })()}

        {((loading && !scopedSessions.length) || (selectedId && !selected)) && <div className={styles.loading} role="status"><span className={styles.loadingMark} aria-hidden="true" /><p>{t('sessions.loading')}</p></div>}
        {showEmpty && !listError && <WorkbenchEmpty tools={terminalTools} projects={availableProjects} remoteTargets={remoteTargets.filter((target) => target.enabled)} remoteEnabled={remoteSshEnabled} activeTargetId={activeTargetId} onTargetChange={(targetId) => { setActiveTargetId(targetId); onRemoteTargetChange?.(targetId); }} onManageHosts={() => setHostManagerOpen(true)} onNewSession={openNewSessionDialog} onOpenHome={onOpenHome} />}
      </section>
    </div>

    {/* Wide windows show the session list in the app sidebar, where it replaces the page list. */}
    {railHost && showRail && createPortal(<>
      {rail}
      {!railSlim && <div className={styles.resizer} role="separator" aria-orientation="vertical" aria-label={t('sessions.resizeRail')} title={t('sessions.resizeRail')} tabIndex={0} onPointerDown={startRailResize} onDoubleClick={() => updateRailWidth(DEFAULT_RAIL_WIDTH)} onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); updateRailWidth(railWidth - 16); }
        if (event.key === 'ArrowRight') { event.preventDefault(); updateRailWidth(railWidth + 16); }
      }} />}
    </>, railHost)}

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
          {splitRoom && menu.besideId && sessions.some((item) => item.id === menu.besideId) && <button role="menuitem" onClick={() => setSplit([menu.besideId!, session.id])}><Icon name="columns" size={14} /><span>{t('sessions.openBeside', { name: toolName(sessions.find((item) => item.id === menu.besideId)!) })}</span></button>}
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
            setLaunchMode(preferredLaunchMode(launchSettings, workspaceValue.startsWith('project:') || workspaceValue.startsWith('remote:') ? 'project' : 'cli', !!nextTool?.yoloAvailable));
          }} /></div>
          <div className={styles.dialogField}><span className={styles.fieldLabel}>{t('sessions.pickWorkspaceLabel')}</span><FilterSelect label={t('sessions.pickWorkspaceLabel')} value={workspaceValue} options={workspaceSelectOptions} searchable searchLabel={t('sessions.searchWorkspace')} onPickFolder={() => void pickCustomWorkspaceFolder()} pickFolderLabel={t('sessions.pickFolder')} onChange={(value) => {
            setWorkspaceValue(value);
            if (value.startsWith('project:')) {
              const project = availableProjects.find((item) => 'project:' + item.id === value);
              if (project?.preferredTool && terminalTools.some((item) => item.id === project.preferredTool)) setLaunchToolId(project.preferredTool);
            } else if (value.startsWith('remote:')) {
              const project = availableRemoteProjects.find((item) => 'remote:' + item.id === value);
              if (project?.preferredTool && terminalTools.some((item) => item.id === project.preferredTool)) setLaunchToolId(project.preferredTool);
            }
          }} /></div>
        </div>
        <div className={styles.dialogField}><span className={styles.fieldLabel}>{t('sessions.launchModeLabel')}</span><div className={styles.modeCards} role="radiogroup" aria-label={t('sessions.launchModeLabel')}>
          <button type="button" role="radio" aria-checked={launchMode === 'normal'} className={styles.modeCard} onClick={() => setLaunchMode('normal')}><span className={styles.modeCardGlyph} aria-hidden="true"><Icon name="shield" size={16} /></span><span className={styles.modeCardCopy}><strong>{t('sessions.modeNormal')}</strong><small>{t('sessions.modeNormalDesc')}</small></span><span className={styles.modeCardCheck}><Icon name="check" size={12} /></span></button>
          <button type="button" role="radio" aria-checked={launchMode === 'yolo'} disabled={!selectedLaunchTool?.yoloAvailable} title={!selectedLaunchTool?.yoloAvailable ? t('sessions.yoloUnsupported') : undefined} className={styles.modeCard} onClick={() => setLaunchMode('yolo')}><span className={styles.modeCardGlyph} aria-hidden="true"><Icon name="sparkle" size={16} /></span><span className={styles.modeCardCopy}><strong>{t('sessions.modeYolo')}</strong><small>{selectedLaunchTool?.yoloAvailable ? t('sessions.modeYoloDesc') : t('sessions.yoloUnsupported')}</small></span><span className={styles.modeCardCheck}><Icon name="check" size={12} /></span></button>
        </div>{selectedLaunchTool?.resumeLatestAvailable && <label className={styles.checkboxRow}><input type="checkbox" checked={resumeLatest} onChange={(event) => setResumeLatest(event.target.checked)} /><span>{t('sessions.resumeLatest')}</span></label>}</div>
        <div className={styles.dialogField}><span className={styles.fieldLabel}>{t('sessions.initialPromptLabel')}</span><textarea rows={3} className={styles.dialogTextarea} value={initialPrompt} placeholder={t('sessions.initialPromptPlaceholder')} aria-label={t('sessions.initialPromptLabel')} onChange={(event) => setInitialPrompt(event.target.value)} /><PromptPicker className={styles.dialogPrompts} labelClassName={styles.dialogPromptLabel} prompts={dialogPrompts} onPick={(prompt) => setInitialPrompt(prompt.body)} />{promptFeedback(dialogHostId, dialogIdentity)}</div>
        <div className={styles.dialogSummary}>{effectiveLaunchToolId && <span className={styles.dialogSummaryIcon}><ToolIcon toolId={effectiveLaunchToolId} size={20} /></span>}<span>{t('sessions.launchSummary', { tool: selectedLaunchTool?.name ?? '', place: workspaceValue.startsWith('project:') ? availableProjects.find((item) => 'project:' + item.id === workspaceValue)?.name ?? t('sessions.workspaceHome') : workspaceValue.startsWith('remote:') ? availableRemoteProjects.find((item) => 'remote:' + item.id === workspaceValue)?.name ?? t('sessions.workspaceHome') : workspaceValue.startsWith('custom:') ? shortPath(displayPath(workspaceValue.slice('custom:'.length))) : t('sessions.workspaceHome'), mode: modeLabel(launchMode) })}</span><Icon name="terminal" size={16} /></div>
        <div className={styles.dialogActions}><Button onClick={() => setNewDialogOpen(false)}>{t('common.dialog.cancel')}</Button><Button variant="primary" className={styles.dialogPrimary} data-dialog-save disabled={launchingNew || !effectiveLaunchToolId} onClick={() => void launchFromDialog()} icon={<Icon name="play" size={14} />}>{launchingNew ? t('sessions.startingSession') : t('sessions.startInWorkbench')}</Button></div>
      </div>
    </GuideDialog>
    <RemoteProjectDialog open={remoteDialogOpen} targets={remoteTargets.filter((target) => target.enabled)} projects={remoteProjects} tools={terminalTools} initialTargetId={activeTargetId === 'local' ? undefined : activeTargetId} onClose={() => { setRemoteDialogOpen(false); if (remoteQuickLaunch) { setRemoteQuickLaunch(false); setRemotePrefillToolId(null); } else setNewDialogOpen(true); }} onSaved={handleRemoteProjectSaved} />
    <GuideDialog open={hostManagerOpen} title={t('sessions.manageHosts')} hint={t('settings.remoteSsh.description')} onClose={() => { setHostManagerOpen(false); setReload((value) => value + 1); }}><RemoteSshSettings enabled={remoteSshEnabled} busy={false} onChange={() => {}} showHosts showToggle={false} /></GuideDialog>
  </div>;
}
