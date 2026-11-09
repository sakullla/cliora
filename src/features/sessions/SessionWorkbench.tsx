import { useRemoteIdentity } from '../../lib/remoteReads';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import type { WindowChrome } from '../../components/WindowControls';
import { formatFailure } from '../../lib/feedback';
import { displayPath, shortPath } from '../../lib/paths';
import { writeClipboard } from '../../lib/clipboard';
import { uiAdapterFor } from '../../adapters';
import { attachmentPastes } from '../../adapters/attachments';
import { confirmAction } from '../../lib/confirm';
import { modLabel } from '../../lib/shortcut';
import { FilterSelect, type FilterSelectOption } from '../../components/FilterSelect';
import { GuideDialog } from '../../components/GuideDialog';
import { Icon } from '../../components/Icon';
import { Badge, Button, IconButton } from '../../components/ui';
import rowMenuStyles from '../../components/RowMenu.module.css';
import { ToolIcon, toolOptions } from '../../components/ToolIcon';
import type { LaunchMode, LaunchRequest, LaunchResult, LaunchSettings, Project, SavedWorkbenchSession, TwiglaneReviewSignal, TwiglaneReviewState, WorkbenchCodeStatus, WorkbenchExit, WorkbenchGitContext, WorkbenchWorktree, WorkbenchOutput, WorkbenchRestoreCandidate, WorkbenchRestoreEvent, WorkbenchRestoreStage, WorkbenchSession, WorktreeBase, WorktreeBasePreview, WorktreeLaunchEvent, WorktreeLaunchIntent, WorktreeLaunchStage, WorktreeLedgerEntry, WorktreeMenuStatus } from '../../types/launch';
import { preferredLaunchMode } from '../../types/launch';
import type { LibraryItem } from '../../types/library';
import type { AdapterDescriptor } from '../../types/native';
import type { RemoteProject, RemoteTarget } from '../../types/remote';
import { SessionTitle, stableTitle } from './SessionTitle';
import { SessionTerminal, cleanTerminalTitle, encodeBase64, type OutputChunk, type TerminalBridge, type TerminalHandle, type TerminalMatch } from './SessionTerminal';
import { PendingTerminalOutput } from './pendingOutput';
import { SessionActivityIcon, sessionBadgeTone } from './SessionActivityIcon';
import type { TerminalTheme, TerminalThemePreference } from './terminalTheme';
import { SessionRail, type RailSession, type SessionTone } from './SessionRail';
import { remoteSessionMayExist, sessionConfirmedEnded } from './sessionState';
import { railPlace, railTaskTitle } from './railTitle';
import { uploadDisplayName, useSessionUploads, type SessionUploadTask } from './sessionUploads';
import uploadStyles from './sessionUploads.module.css';
import { WorkbenchComposer } from './WorkbenchComposer';
import { PromptPicker } from './PromptPicker';
import { StatusBanner } from '../../components/StatusBanner';
import { DENSITY_LINE_HEIGHT, TerminalAppearance, type TerminalDensity } from './TerminalAppearance';
import { WorkbenchEmpty } from './WorkbenchEmpty';
import { WorkbenchShortcuts } from './WorkbenchShortcuts';
import { ensureRemoteProject, lastRemoteDir, rememberRemoteDir, rememberedRemoteDir, remoteBaseName, remoteStartPath, useRemoteFolderPicker } from '../remote/remoteLaunch';
import { requestWriteRecovery, useWriteRecoveryNeeded } from '../remote/writeReceipts';
import { RemoteSshSettings } from '../settings/GeneralSettings';
import styles from './SessionWorkbench.module.css';

import { workbenchSessionId, type WorkbenchFailure, type RemoteWorkbenchIntent } from './workbenchLaunch';

function subscribeVisibility(notify: () => void): () => void {
  document.addEventListener('visibilitychange', notify);
  return () => document.removeEventListener('visibilitychange', notify);
}
const documentVisible = () => document.visibilityState !== 'hidden';

function sameDirectory(left: string, right: string): boolean {
  const norm = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  return norm(left) === norm(right) || norm(left).toLowerCase() === norm(right).toLowerCase();
}

/** Whether `child` is `root` itself or lies inside it. A sibling such as `repo-other`
 *  never matches `repo`, so a running session guard cannot pass for the wrong checkout. */
function withinDirectory(root: string, child: string): boolean {
  const norm = (value: string) => {
    const clean = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return /^[a-zA-Z]:/.test(clean) ? clean.toLowerCase() : clean;
  };
  const base = norm(root);
  const target = norm(child);
  if (!base || !target) return false;
  return target === base || target.startsWith(base + '/');
}

/** One explicit worktree creation or prepare retry the user is waiting for.
 *  It is a progress notice, not a task store: nothing else is persisted. */
type WorktreeOperation = {
  operationId: string;
  stage: WorktreeLaunchStage;
  worktreePath: string | null;
  branch: string | null;
  sessionId: string | null;
  error: string | null;
  /** Repeated when a creation failed before any worktree existed. */
  request: LaunchRequest;
  /** A prepare retry reuses an existing worktree: it never reports `creating` again. */
  retry: boolean;
  /** The stage that was running when the operation failed, so the steps can show where. */
  failedAt: WorktreeLaunchStage | null;
  /** The repository has a setup command. Without one the setup step is not shown:
   *  native still reports a momentary `preparing`, which then reads as starting. */
  prepare: boolean;
};
const WORKTREE_STAGE_RANK: Record<WorktreeLaunchStage, number> = { creating: 0, preparing: 1, starting: 2, succeeded: 3, failed: 4 };
type WorktreeStep = 'creating' | 'preparing' | 'starting';
type WorktreeStepState = 'done' | 'active' | 'failed' | 'pending';

function worktreeSteps(operation: WorktreeOperation): WorktreeStep[] {
  return operation.prepare ? ['creating', 'preparing', 'starting'] : ['creating', 'starting'];
}

/** The step an operation is on, or failed at. A failure without a recorded stage is
 *  placed by what exists: no worktree means creation failed, an existing one means
 *  the setup command (or, without one, the start) did. */
function worktreeCurrentStep(operation: WorktreeOperation): WorktreeStep {
  const failed = operation.stage === 'failed';
  let at: WorktreeLaunchStage = failed ? (operation.failedAt ?? 'creating') : operation.stage;
  if (failed && (at === 'failed' || at === 'succeeded' || (at === 'creating' && operation.worktreePath))) at = operation.worktreePath ? 'preparing' : 'creating';
  if (at === 'preparing' && !operation.prepare) return 'starting';
  return at === 'succeeded' || at === 'failed' ? 'starting' : at;
}

/** Visual progress of one creation. */
function worktreeStepStates(operation: WorktreeOperation): WorktreeStepState[] {
  const steps = worktreeSteps(operation);
  if (operation.stage === 'succeeded') return steps.map(() => 'done');
  const failed = operation.stage === 'failed';
  const index = steps.indexOf(worktreeCurrentStep(operation));
  return steps.map((_, step) => step < index ? 'done' : step === index ? (failed ? 'failed' : 'active') : 'pending');
}

function newWorktreeOperationId(): string {
  return 'wt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/** A remote session's library prompts come from that host. `null` means the host is not known yet. */
export function libraryHostId(projectId: string | null | undefined, remoteProjects: RemoteProject[]): string | null {
  if (!projectId?.startsWith('remote:')) return 'local';
  return remoteProjects.find((item) => `remote:${item.id}` === projectId)?.targetId ?? null;
}

/** CLIs offered as one-click picks under the tool list in the new-session dialog. */
const DIALOG_QUICK_TOOLS = 8;
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
/** Ranks kept for sessions that are not on screen (waiting for a restore) are capped here. */
const RAIL_ORDER_LIMIT = 200;

/** Carry ranks across a restore: each restored session takes its old id's place. A new id
 *  that was already ranked (listed before the report arrived) gives up that later slot. */
export function remapArrangement(current: RailArrangement, restored: Record<string, string>): RailArrangement {
  const fresh = new Set(Object.values(restored));
  const remap = (ids: string[]) => {
    const mapped = ids.map((id) => restored[id] ?? (fresh.has(id) ? null : id)).filter((id): id is string => id !== null);
    return mapped.filter((id, index) => mapped.indexOf(id) === index);
  };
  return { pinned: remap(current.pinned), order: remap(current.order) };
}

/** The session the user last had selected; a restore maps it to its new id. */
function readStoredSelection(): string | null {
  try { return localStorage.getItem('cliora:workbench-selected'); } catch { return null; }
}

/** Native skips a saved record whose id is already live (`restore_with` keeps `!live`), and a
 *  launch writes the record with the session's own id. The view must agree, or a session started
 *  before the workbench opened leaves a "waiting to restore" row that nothing can clear.
 *  A record with another id still describes the same terminal when the directory, the CLI and the
 *  start time (the store's own 2 s precision window) match a running session. */
function savedRecordIsLive(saved: SavedWorkbenchSession, sessions: WorkbenchSession[]): boolean {
  return sessions.some((session) => {
    if (session.projectId?.startsWith('remote:')) return false;
    if (session.id === saved.id) return true;
    // A record that names its native session has an exact identity: a shared
    // directory and a close start time must not make it look like that terminal.
    if (saved.nativeId) return false;
    if (!session.running || session.toolId !== saved.toolId || !sameDirectory(session.directory, saved.directory)) return false;
    const started = session.startedAt ?? 0;
    return started > 0 && started >= saved.startedAt - 2000 && started <= saved.startedAt + 2000;
  });
}

/** One saved record on screen before it becomes a real session again. */
type RestoreRow = {
  saved: SavedWorkbenchSession;
  stage: 'queued' | 'discovering' | 'starting' | 'failed';
  detail: string;
  candidates: WorkbenchRestoreCandidate[];
};

/** Stage order inside one restore: a repeat or a late event never moves a row backwards. */
const RESTORE_STAGE_RANK: Record<WorkbenchRestoreStage, number> = { discovering: 1, starting: 2, restored: 3, failed: 3 };

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

const MENU_ITEM = '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)';
/** 等不到 accepted/rejected 的期限：超过它只能显示"打开结果未知"。 */
const REVIEW_UNKNOWN_MS = 10_000;
/** 协议里的稳定错误码到界面文案。未知码回退到通用说明，不显示后端原始文本。 */
const REVIEW_REASON_KEYS: Record<string, string> = {
  session_unknown: 'sessions.reviewCodeSessionUnknown',
  remote_session: 'sessions.reviewCodeRemoteSession',
  invalid_path: 'sessions.reviewCodeInvalidPath',
  not_a_worktree: 'sessions.reviewCodeNotAWorktree',
  git_missing: 'sessions.reviewCodeGitMissing',
  open_failed: 'sessions.reviewCodeOpenFailed',
  output_too_large: 'sessions.reviewCodeOutputTooLarge',
  path_too_long: 'sessions.reviewCodePathTooLong',
  read_failed: 'sessions.reviewCodeReadFailed',
  malformed_request: 'sessions.reviewCodeMalformedRequest',
  unsupported_version: 'sessions.reviewCodeUnsupportedVersion',
};
function reviewReasonText(t: (key: string) => string, code: string | null | undefined): string {
  return t(code && REVIEW_REASON_KEYS[code] ? REVIEW_REASON_KEYS[code] : 'sessions.reviewCodeUnknown');
}

function firstTaskLine(text: string | null | undefined): string | null {
  const line = text?.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  return line || null;
}

/** What the shell needs to know about the session list it hosts in the app sidebar. */
export type WorkbenchRailLayout = { docked: boolean; focus: boolean };

/** Per-pane upload feedback for a remote session: an n/m progress badge or a
    failure banner whose retry re-runs the same dropped inputs. */
function SessionUploadNotice({ task, progressLabel, progressText, failedTitle, retryLabel, dismissLabel, onRetry, onDismiss }: {
  task: SessionUploadTask;
  progressLabel: string;
  progressText: string;
  failedTitle: string;
  retryLabel: string;
  dismissLabel: string;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  if (task.phase === 'uploading') {
    return <div className={`${uploadStyles.notice} ${uploadStyles.progress}`} role="status" title={task.names.join('、')} aria-label={progressLabel}><Icon name="upload" size={12} /><span>{progressText}</span></div>;
  }
  return <div className={`${uploadStyles.notice} ${uploadStyles.failure}`} role="alert">
    <div className={uploadStyles.failureCopy}><strong>{failedTitle}</strong><span className={uploadStyles.failureDetail} title={task.error}>{task.error}</span></div>
    <div className={uploadStyles.failureActions}>
      <Button variant="primary" size="sm" onClick={onRetry} icon={<Icon name="refresh" size={13} />}>{retryLabel}</Button>
      <IconButton size="sm" icon={<Icon name="close" size={14} />} aria-label={dismissLabel} onClick={onDismiss} />
    </div>
  </div>;
}

export function SessionWorkbench({ active, tools, remoteSshEnabled = false, remoteTargetId = 'local', syncedRemoteTargets = [], onRemoteTargetChange, focusSessionId, focusToken, reviewSignal = null, failure, onFailure, onOpenHome, remoteIntent, railHost = null, railSlim = false, onToggleRailSlim, onRailLayout, railToggleRef, windowChrome = null, captionSlotRef }: {
  remoteIntent?: RemoteWorkbenchIntent | null;
  /** The native window frame; set, the session title bar is also the window's title bar. */
  windowChrome?: WindowChrome | null;
  /** Receives the title-bar slot where the app places the window's caption buttons. */
  captionSlotRef?: (node: HTMLElement | null) => void;
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
  /** A routed cliora://review receipt for one session; a new token means re-read it. */
  reviewSignal?: TwiglaneReviewSignal | null;
  failure: WorkbenchFailure | null;
  onFailure: (failure: WorkbenchFailure | null) => void;
  onOpenHome: () => void;
}) {
  const { t } = useTranslation();
  const writeRecoveryNeeded = useWriteRecoveryNeeded(remoteTargetId);
  const windowVisible = useSyncExternalStore(subscribeVisibility, documentVisible);
  const renderActive = active && windowVisible;
  const [sessions, setSessions] = useState<WorkbenchSession[]>([]);
  const sessionStateUpdates = useRef(new Map<string, WorkbenchSession>());
  /** A restored snapshot can arrive before any list contains it. It survives the list reads
   *  that have not seen it yet; once the native list names that id, the list is authoritative. */
  const pendingRestored = useRef(new Map<string, WorkbenchSession>());
  /** Ids the workbench has listed or restored. Kept in step with every list, so a restore can tell
   *  whether a real session is already on screen without waiting for a render. */
  const liveSessionIds = useRef(new Set<string>());
  function applyListedSessions(listed: WorkbenchSession[]) {
    const known = new Set(listed.map((item) => item.id));
    for (const id of [...pendingRestored.current.keys()]) if (known.has(id)) pendingRestored.current.delete(id);
    const extra = [...pendingRestored.current.values()].filter((item) => !known.has(item.id));
    if (pendingRestored.current.size > 16) pendingRestored.current.clear();
    const rows = extra.length ? [...listed, ...extra] : listed;
    liveSessionIds.current = new Set(rows.map((item) => item.id));
    pruneLiveRestoreRows(rows);
    setSessions((current) => rows.map((item) => {
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
  // Keep only the current menu's list, rather than every repository ever visited.
  const [gitWorktrees, setGitWorktrees] = useState<{ anchor: string; trees: WorkbenchWorktree[] } | null>(null);
  // An empty list and a failed read are different facts: the menu says which one it saw.
  const [worktreeListState, setWorktreeListState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [worktreeListError, setWorktreeListError] = useState('');
  const [worktreeStatuses, setWorktreeStatuses] = useState<Map<string, { status: WorktreeMenuStatus | null; error: string }>>(() => new Map());
  const [worktreeStatusSeq, setWorktreeStatusSeq] = useState(0);
  const gitReadPending = useRef<Promise<unknown> | null>(null);
  const codeReadPending = useRef<Promise<unknown> | null>(null);
  const [worktreeMenuOpen, setWorktreeMenuOpen] = useState(false);
  const [gitReadSeq, setGitReadSeq] = useState(0);
  // 审查状态只在 native 注册表里判定；这里是它的展示副本，按 sessionId 索引。
  const [reviewStates, setReviewStates] = useState<Map<string, TwiglaneReviewState>>(() => new Map());
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [codeStatuses, setCodeStatuses] = useState<Map<string, WorkbenchCodeStatus>>(() => new Map());
  const [codeStatusUnknown, setCodeStatusUnknown] = useState<Map<string, boolean>>(() => new Map());
  const [codeStatusReviews, setCodeStatusReviews] = useState<Map<string, string>>(() => new Map());
  const [codeReadSeq, setCodeReadSeq] = useState(0);
  const [reviewClock, setReviewClock] = useState(() => Date.now());
  const announcedReviews = useRef(new Set<string>());
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
  const worktreeMenuRef = useRef<HTMLDivElement>(null);
  const worktreeSwitchRef = useRef<HTMLSpanElement>(null);
  const gitChipRef = useRef<HTMLButtonElement>(null);
  // Worktree management (cleanup and the repository setup command) lives in its own dialog.
  // `directory` is the repository the setup command belongs to; null means none was chosen.
  // The same prepare state backs the new-session dialog, which is never open at the same time.
  const [worktreeSetup, setWorktreeSetup] = useState<{ directory: string | null } | null>(null);
  const [prepareSavedCommand, setPrepareSavedCommand] = useState<string | null>(null);
  const [prepareJustSaved, setPrepareJustSaved] = useState(false);
  const [prepareCommand, setPrepareCommand] = useState('');
  const [prepareTarget, setPrepareTarget] = useState<string | null>(null);
  const [prepareError, setPrepareError] = useState('');
  const [prepareSaving, setPrepareSaving] = useState(false);
  const [ledger, setLedger] = useState<WorktreeLedgerEntry[]>([]);
  const [cleanupError, setCleanupError] = useState('');
  const [cleanupBusy, setCleanupBusy] = useState('');
  const prepareRequest = useRef(0);
  // The per-launch worktree choice; the saved preference only seeds it.
  const [dialogPlace, setDialogPlace] = useState<'direct' | 'worktree'>('direct');
  const dialogPlaceTouched = useRef(false);
  const [dialogDirectory, setDialogDirectory] = useState<string | null>(null);
  const [baseChoice, setBaseChoice] = useState<WorktreeBase | null>(null);
  const [baseRef, setBaseRef] = useState('');
  const [basePreview, setBasePreview] = useState<WorktreeBasePreview | null>(null);
  const [baseBusy, setBaseBusy] = useState(false);
  const [baseError, setBaseError] = useState('');
  const [baseStale, setBaseStale] = useState(false);
  // Base and branch are shown as values and edited in place; no separate advanced step.
  const [baseEditing, setBaseEditing] = useState(false);
  const [branchEditing, setBranchEditing] = useState(false);
  const [branchDraft, setBranchDraft] = useState('');
  const baseRequest = useRef(0);
  const [worktreeOps, setWorktreeOps] = useState<WorktreeOperation[]>([]);
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
  const [launchToolId, setLaunchToolId] = useState('');
  const [workspaceValue, setWorkspaceValue] = useState('__home');
  const [customFolderPath, setCustomFolderPath] = useState('');
  const [launchMode, setLaunchMode] = useState<LaunchMode>('normal');
  const [resumeLatest, setResumeLatest] = useState(false);
  const [initialPrompt, setInitialPrompt] = useState('');
  const [launchingNew, setLaunchingNew] = useState(false);
  const newLaunchPending = useRef(false);
  const [dialogError, setDialogError] = useState('');
  const [customRemotePath, setCustomRemotePath] = useState('');
  const remotePicker = useRemoteFolderPicker();

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
        void quickRemoteLaunch(targetId, toolId, !!detail.chooseDirectory);
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
  const [copiedState, setCopiedState] = useState<'path' | 'output' | 'selection' | 'empty' | 'branch' | null>(null);
  const copyTimerRef = useRef<number>(0);
  const linkErrorTimer = useRef<number>(0);

  const firstSeenAt = useRef(new Map<string, number>());
  const autoRemoteReattachAttempted = useRef(false);
  const autoLocalRestoreAttempted = useRef(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  // Saved records are shown before anything is restored, then replaced one by one as each
  // session reports its own result. A slow or failing record never hides the other rows.
  const [restoreRows, setRestoreRows] = useState<RestoreRow[]>([]);
  // The ref is the source of truth: native events can arrive before React commits a render,
  // and a stale read there would drop a row or place it twice.
  const restoreRowsRef = useRef<RestoreRow[]>([]);
  function writeRestoreRows(next: RestoreRow[]) {
    restoreRowsRef.current = next;
    setRestoreRows(next);
  }
  // Until the saved-record read answers, an empty session list means "unknown", not "empty".
  const [restoreListReady, setRestoreListReady] = useState(false);
  // The saved-record read can land before the session list. Rows may show at once, but the batch
  // waits for that first list so a record for an already-running session starts no pointless
  // restore. The promise resolves on success, on failure and when the list is not read at all.
  const sessionListReady = useRef<Promise<void> | null>(null);
  const resolveSessionList = useRef<(() => void) | null>(null);
  if (!sessionListReady.current) {
    sessionListReady.current = new Promise<void>((resolve) => { resolveSessionList.current = resolve; });
  }
  const [restoringIds, setRestoringIds] = useState<Set<string>>(() => new Set());
  const [restoreChoice, setRestoreChoice] = useState<import('../../types/launch').WorkbenchRestoreReport['failures'][number] | null>(null);
  const [restoreChoiceError, setRestoreChoiceError] = useState('');
  // One restore call shares a restore id; (restoreId, savedSessionId) publishes an ordered
  // stage stream, so a repeated or late event is dropped instead of reopening a done row.
  const restoreStages = useRef(new Map<string, number>());
  /** Only the first completion (or the record selected before the restart) takes the selection. */
  const restoreSelectionTaken = useRef(false);
  const restorePreferred = useRef<string | null>(readStoredSelection());
  function toRestoreRows(saved: SavedWorkbenchSession[]): RestoreRow[] {
    return saved.map((session) => ({ saved: session, stage: 'queued' as const, detail: '', candidates: [] }));
  }
  function markRestoreRowFailed(saved: SavedWorkbenchSession, detail: string, candidates: WorkbenchRestoreCandidate[]) {
    const row: RestoreRow = { saved, stage: 'failed', detail, candidates };
    const index = restoreRowsRef.current.findIndex((item) => item.saved.id === saved.id);
    if (index < 0) { writeRestoreRows([...restoreRowsRef.current, row]); return; }
    const copy = [...restoreRowsRef.current];
    copy[index] = row;
    writeRestoreRows(copy);
  }
  function setRestoreRowStage(savedId: string, stage: RestoreRow['stage']) {
    const index = restoreRowsRef.current.findIndex((item) => item.saved.id === savedId);
    if (index < 0) return;
    const copy = [...restoreRowsRef.current];
    copy[index] = { ...copy[index], stage, detail: '' };
    writeRestoreRows(copy);
  }
  function dropRestoreRow(savedId: string) {
    if (!restoreRowsRef.current.some((item) => item.saved.id === savedId)) return;
    writeRestoreRows(restoreRowsRef.current.filter((item) => item.saved.id !== savedId));
  }
  /** Forget one saved record and its row: the exit every row has, whatever its stage. */
  function forgetRestoreRow(savedId: string) {
    void native.forgetWorkbenchRestore(savedId)
      .then(() => dropRestoreRow(savedId))
      .catch((value) => setActionError(String(value?.message ?? value)));
  }
  /** The session list is the authority on what already runs: a saved record that is live must not
   *  keep a pending row, or it would wait forever for a restore that native deliberately skips. */
  function pruneLiveRestoreRows(sessions: WorkbenchSession[]) {
    const current = restoreRowsRef.current;
    if (!current.length) return;
    const next = current.filter((row) => !savedRecordIsLive(row.saved, sessions));
    if (next.length !== current.length) writeRestoreRows(next);
  }
  /** Replace one pending row with the real session, without waiting for a second list IPC. */
  function applyRestoredSession(savedId: string, snapshot: WorkbenchSession) {
    if (!firstSeenAt.current.has(snapshot.id)) firstSeenAt.current.set(snapshot.id, snapshot.startedAt ?? Date.now());
    pendingRestored.current.set(snapshot.id, snapshot);
    setSessions((current) => {
      const index = current.findIndex((item) => item.id === snapshot.id);
      if (index < 0) return [...current, snapshot];
      const copy = [...current];
      copy[index] = { ...copy[index], ...snapshot };
      return copy;
    });
    dropRestoreRow(savedId);
    setArrangement((current) => remapArrangement(current, { [savedId]: snapshot.id }));
    liveSessionIds.current.add(snapshot.id);
    // The workbench already shows a real session: a restore fills a gap, it never takes the
    // selection from what the user is working in.
    if (liveSessionIds.current.size > 1) return;
    if (restoreSelectionTaken.current && restorePreferred.current !== savedId) return;
    restoreSelectionTaken.current = true;
    setSelectedId(snapshot.id);
  }
  async function applyRestoreReport(report: import('../../types/launch').WorkbenchRestoreReport, selectedRestoreId?: string) {
    // Older preview bridges may not implement restoration.
    if (!report || !report.restored || !Array.isArray(report.failures)) return;
    // A failure keeps its saved record and its own retry; the other rows are untouched.
    for (const failure of report.failures) {
      if (!failure?.session?.id || report.restored[failure.session.id]) continue;
      markRestoreRowFailed(failure.session, failure.detail, Array.isArray(failure.candidates) ? failure.candidates : []);
    }
    if (!Object.keys(report.restored).length) return;
    writeRestoreRows(restoreRowsRef.current.filter((row) => !report.restored[row.saved.id]));
    setArrangement((current) => remapArrangement(current, report.restored));
    // The per-record events already delivered their snapshots. Only a record whose event never
    // arrived (an older bridge) needs one list read as a completeness correction.
    const missing = Object.keys(report.restored).filter((oldId) => !allSessionsRef.current.some((item) => item.id === report.restored[oldId]));
    if (missing.length) applyListedSessions(await native.listWorkbenchSessions());
    setSelectedId((current) => {
      const mapped = (selectedRestoreId && report.restored[selectedRestoreId]) || (current && report.restored[current]);
      if (mapped) return mapped;
      const preferred = restorePreferred.current;
      if (preferred && report.restored[preferred] && !restoreSelectionTaken.current) {
        restoreSelectionTaken.current = true;
        return report.restored[preferred];
      }
      return current ?? null;
    });
  }
  async function restoreLocalSessions() {
    if (restoring) return;
    setRestoring(true);
    setRestoreError('');
    writeRestoreRows(restoreRowsRef.current.map((row) => row.stage === 'failed' ? row : { ...row, stage: 'queued', detail: '' }));
    restoreSelectionTaken.current = false;
    restoreStages.current.clear();
    try {
      const report = await native.restoreWorkbenchSessions();
      await applyRestoreReport(report);
      await settleRestoreRows(report);
    } catch (value) { setRestoreError(formatFailure(value, t('sessions.restoreFailed'), t('sessions.closeNext'))); }
    finally { setRestoring(false); }
  }
  /** The batch has answered: every record is either restored (row gone), failed (row kept with its
   *  retry) or already running (row pruned). Anything else would wait forever, so reconcile the
   *  leftovers against the real list once, then say so instead of leaving a dead row. */
  async function settleRestoreRows(report: import('../../types/launch').WorkbenchRestoreReport | null) {
    const restored = report?.restored ?? {};
    const failed = new Set((report?.failures ?? []).map((item) => item.session?.id));
    const unsettled = () => restoreRowsRef.current.filter((row) => !restored[row.saved.id] && !failed.has(row.saved.id));
    if (!unsettled().length) return;
    const listed = await native.listWorkbenchSessions().catch(() => null);
    const sessions = Array.isArray(listed) ? listed : allSessionsRef.current;
    if (Array.isArray(listed)) applyListedSessions(listed);
    for (const row of unsettled()) {
      if (savedRecordIsLive(row.saved, sessions)) dropRestoreRow(row.saved.id);
      else markRestoreRowFailed(row.saved, t('sessions.restoreOutcomeUnknown'), []);
    }
  }
  /** Retry one saved record on its own: a failure never re-runs the other rows. */
  async function retryRestoreRow(row: RestoreRow, nativeId: string | null = null): Promise<boolean> {
    const savedId = row.saved.id;
    setRestoringIds((current) => new Set(current).add(savedId));
    setRestoreRowStage(savedId, 'starting');
    setRestoreError('');
    try {
      const report = await native.restoreWorkbenchSession(savedId, nativeId);
      await applyRestoreReport(report, savedId);
      if (report?.restored?.[savedId]) return true;
      const failure = report?.failures?.find((item) => item.session?.id === savedId);
      // An older bridge that answers neither keeps the row, but never leaves it spinning.
      if (!failure) markRestoreRowFailed(row.saved, t('sessions.restoreFailed'), []);
      return false;
    } catch (value) {
      markRestoreRowFailed(row.saved, formatFailure(value, t('sessions.restoreFailed'), t('sessions.retryRestore')), row.candidates);
      return false;
    } finally {
      setRestoringIds((current) => { const next = new Set(current); next.delete(savedId); return next; });
    }
  }
  async function restoreChosenCandidate(nativeId: string) {
    const choice = restoreChoice;
    if (!choice || restoring) return;
    const row = restoreRowsRef.current.find((item) => item.saved.id === choice.session.id);
    if (!row) { setRestoreChoice(null); return; }
    setRestoreChoiceError('');
    const done = await retryRestoreRow(row, nativeId);
    if (done) { setRestoreChoice(null); return; }
    const failed = restoreRowsRef.current.find((item) => item.saved.id === choice.session.id);
    setRestoreChoiceError(failed?.detail ?? t('sessions.restoreFailed'));
  }
  async function reconnectLocalSession(session: WorkbenchSession) {
    if (busy || restoring || session.running) return;
    setBusy(`restore:${session.id}`);
    setRestoring(true);
    setActionError('');
    try {
      const report = await native.restoreWorkbenchSession(session.id);
      await applyRestoreReport(report, session.id);
      const failure = report.failures.find(item => item.session.id === session.id);
      if (failure?.candidates.length) {
        setRestoreChoiceError('');
        setRestoreChoice(failure);
      } else if (failure) setActionError(failure.detail);
    } catch (value) {
      setActionError(formatFailure(value, t('sessions.restoreFailed'), t('sessions.retryRestore')));
    } finally { setBusy(''); setRestoring(false); }
  }
  // The saved records arrive beside the in-memory list: the pending rows are on screen before
  // any session has been restored. A bridge that does not answer this read keeps the old batch.
  useEffect(() => {
    if (!active || !nativeAvailable || autoLocalRestoreAttempted.current) return;
    autoLocalRestoreAttempted.current = true;
    let alive = true;
    // The attempt counts only once it has decided: rows shown and the batch started, or
    // nothing to restore. A run torn down earlier (leaving the workbench during startup,
    // StrictMode's double mount) releases the attempt, or its records would never restore.
    let decided = false;
    void native.listWorkbenchRestoreSessions().then((saved) => {
      if (!alive) return;
      if (!Array.isArray(saved)) { decided = true; void restoreLocalSessions(); return; }
      const rows = toRestoreRows(saved.filter((item) => !!item && typeof item.id === 'string'));
      const known = new Set(restoreRowsRef.current.map((row) => row.saved.id));
      // A record whose session is already running is not pending: native skips exactly those
      // records without an event or a failure, so a row for one could never settle.
      const pending = rows.filter((row) => !known.has(row.saved.id) && !savedRecordIsLive(row.saved, allSessionsRef.current));
      if (pending.length) writeRestoreRows([...restoreRowsRef.current, ...pending]);
      // Rows an earlier, torn-down run already showed are still waiting for their batch.
      const savedIds = new Set(rows.map((row) => row.saved.id));
      const ids = new Set(restoreRowsRef.current.filter((row) => row.stage === 'queued' && savedIds.has(row.saved.id)).map((row) => row.saved.id));
      if (!ids.size) { decided = true; return; }
      void sessionListReady.current?.then(() => {
        if (!alive) return;
        decided = true;
        // Every row was healed as already live: there is nothing to restore.
        if (!restoreRowsRef.current.some((row) => ids.has(row.saved.id))) return;
        void restoreLocalSessions();
      });
    }).catch(() => { if (alive) { decided = true; void restoreLocalSessions(); } })
      .finally(() => { if (alive) setRestoreListReady(true); });
    return () => {
      alive = false;
      if (!decided) autoLocalRestoreAttempted.current = false;
    };
  }, [active]);
  // Each saved record publishes its own stages. A restored record becomes a real session at
  // once; a failed one keeps the record and its retry, and never blocks the others.
  useEffect(() => {
    if (!nativeAvailable) return;
    let alive = true;
    let stop: (() => void) | undefined;
    void listen<WorkbenchRestoreEvent>('cliora:workbench-restore', (event) => {
      if (!alive) return;
      const payload = event.payload;
      if (!payload || typeof payload.restoreId !== 'string' || typeof payload.savedSessionId !== 'string') return;
      const rank = RESTORE_STAGE_RANK[payload.stage];
      if (!rank) return;
      const key = payload.restoreId + ':' + payload.savedSessionId;
      const seen = restoreStages.current.get(key) ?? 0;
      // A repeated stage, a step backwards, or anything after the final stage is a late
      // duplicate of a record that already settled.
      if (rank <= seen || seen >= RESTORE_STAGE_RANK.restored) return;
      restoreStages.current.set(key, rank);
      if (restoreStages.current.size > 512) restoreStages.current.clear();
      if (payload.stage === 'restored') {
        if (payload.session && typeof payload.session.id === 'string') applyRestoredSession(payload.savedSessionId, payload.session);
        else dropRestoreRow(payload.savedSessionId);
        return;
      }
      if (payload.stage === 'failed') {
        const row = restoreRowsRef.current.find((item) => item.saved.id === payload.savedSessionId);
        if (row) markRestoreRowFailed(row.saved, payload.detail || t('sessions.restoreFailed'), Array.isArray(payload.candidates) ? payload.candidates : []);
        return;
      }
      setRestoreRowStage(payload.savedSessionId, payload.stage === 'starting' ? 'starting' : 'discovering');
    }).then((unlisten) => { if (alive) stop = unlisten; else unlisten(); }).catch(() => {});
    return () => { alive = false; stop?.(); };
  }, [t]);
  useEffect(() => {
    if (!selectedId || restoring) return;
    try { localStorage.setItem('cliora:workbench-selected', selectedId); } catch { /* optional */ }
  }, [selectedId, restoring]);
  const [clock, setClock] = useState(() => Date.now());
  const writers = useRef(new Map<string, (chunk: OutputChunk) => void>());
  const pending = useRef(new PendingTerminalOutput());
  const handles = useRef(new Map<string, TerminalHandle>());

  const pasteAttachmentPaths = useCallback(async (sessionId: string, paths: string[]) => {
    const session = sessionsRef.current.find((item) => item.id === sessionId);
    const handle = handles.current.get(sessionId);
    if (!session?.running || !handle) throw new Error('Session is no longer available');
    await handle.pasteAttachments(attachmentPastes(uiAdapterFor(session.toolId), paths));
    if (selectedIdRef.current === sessionId) handle.focus();
  }, []);
  const uploads = useSessionUploads({
    onUploaded: pasteAttachmentPaths,
    formatError: (error) => formatFailure(error, t('sessions.pasteFilesFailedTitle'), t('common.nativeError.retry')),
  });
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
  // Refresh the cheap branch hint while visible; enumerate checkouts only in the open menu.
  // A newly created worktree is read on each opening and while that menu remains visible.
  const gitTarget = active && selected && !selected.projectId?.startsWith('remote:') ? selected.id : null;
  const worktreeAnchor = gitTarget && selected
    ? selected.directory || projects.find((item) => item.id === selected.projectId)?.path || null
    : null;
  const selectedReview = gitTarget ? reviewStates.get(gitTarget) : null;
  const returnedReviewId = selectedReview?.status === 'returned' ? selectedReview.reviewId : null;
  const codeStatusNeeded = worktreeMenuOpen || !!returnedReviewId;
  useEffect(() => {
    const ids = new Set(sessions.map((session) => session.id));
    const retain = <T,>(current: Map<string, T>) => {
      if ([...current.keys()].every((id) => ids.has(id))) return current;
      return new Map([...current].filter(([id]) => ids.has(id)));
    };
    setGitContexts(retain);
    setCodeStatuses(retain);
    setCodeStatusUnknown(retain);
    setCodeStatusReviews(retain);
    setReviewStates(retain);
  }, [sessions]);
  useEffect(() => {
    const reviews = new Set([...reviewStates.values()].map((review) => review.reviewId));
    for (const id of announcedReviews.current) {
      if (!reviews.has(id)) announcedReviews.current.delete(id);
    }
  }, [reviewStates]);
  useEffect(() => {
    setGitWorktrees(null);
    setWorktreeListState('idle');
    setWorktreeListError('');
    setWorktreeStatuses(new Map());
  }, [worktreeAnchor]);
  useEffect(() => {
    if (!nativeAvailable || !gitTarget) return;
    let alive = true;
    let requested = false;
    let fallbackRead = false;
    const visible = () => document.visibilityState !== 'hidden';
    const read = async () => {
      if (!visible() || requested) return;
      requested = true;
      // An effect restart (menu/focus/session change) waits for the prior read.
      // Its obsolete queued work is discarded before starting more native I/O.
      await gitReadPending.current;
      if (!alive || !visible()) { requested = false; return; }
      let needsFallback = false;
      const context = native.workbenchGitContext(gitTarget).then((value) => {
        if (!alive) return;
        const next = value && (value.branch || value.commit) ? value : null;
        // A missing/unreadable HEAD must not hide otherwise discoverable worktrees.
        // Probe once for this target, rather than enumerating on every idle tick.
        needsFallback = !next && !fallbackRead;
        if (needsFallback) fallbackRead = true;
        setGitContexts((current) => {
          if (current.has(gitTarget) && JSON.stringify(current.get(gitTarget)) === JSON.stringify(next)) return current;
          const map = new Map(current);
          map.set(gitTarget, next);
          return map;
        });
      }).catch(() => {
        needsFallback = alive && !fallbackRead;
        if (needsFallback) fallbackRead = true;
      });
      const worktrees = context.then(() => {
        if (!alive || !worktreeAnchor || (!worktreeMenuOpen && !needsFallback)) return;
        setWorktreeListState((current) => current === 'loading' ? current : 'loading');
        return native.gitWorktrees(worktreeAnchor).then((list) => {
          if (!alive) return;
          const next = Array.isArray(list) ? list : [];
          setGitWorktrees((current) => {
            if (current?.anchor === worktreeAnchor && JSON.stringify(current.trees) === JSON.stringify(next)) return current;
            return { anchor: worktreeAnchor, trees: next };
          });
          setWorktreeListState('ready');
          setWorktreeListError('');
        }).catch((error) => {
          // A read failure is not an empty repository: keep whatever list was read last
          // and let the menu retry instead of claiming there is nothing to switch to.
          if (!alive) return;
          setWorktreeListState('error');
          setWorktreeListError(formatFailure(error, t('sessions.worktreeListFailed'), t('sessions.failureHint')));
        });
      }).catch(() => {});
      const pending = Promise.all([context, worktrees]);
      gitReadPending.current = pending;
      await pending;
      if (gitReadPending.current === pending) gitReadPending.current = null;
      requested = false;
    };
    read();
    const timer = window.setInterval(read, 15_000);
    window.addEventListener('focus', read);
    document.addEventListener('visibilitychange', read);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener('focus', read); document.removeEventListener('visibilitychange', read); };
  }, [gitTarget, worktreeAnchor, nativeAvailable, gitReadSeq, worktreeMenuOpen]);
  // Full status is needed only in the menu or to verify a returned review.
  // Keep at most one native scan in flight, even across session switches.
  // 迟到响应直接丢弃；读取失败保留上一次可读的值，但明确标成未知并允许重试。
  useEffect(() => {
    if (!nativeAvailable || !gitTarget || !codeStatusNeeded) return;
    let alive = true;
    const markReviewRead = () => {
      if (!returnedReviewId) return;
      setCodeStatusReviews((current) => {
        if (current.get(gitTarget) === returnedReviewId) return current;
        const map = new Map(current);
        map.set(gitTarget, returnedReviewId);
        return map;
      });
    };
    const read = async () => {
      await codeReadPending.current;
      if (!alive) return;
      const pending = native.workbenchCodeStatus(gitTarget).then((value) => {
        if (!alive || !value || value.sessionId !== gitTarget || (value.state !== 'ready' && value.state !== 'unknown')) return;
        setCodeStatuses((current) => { const map = new Map(current); map.set(gitTarget, value); return map; });
        setCodeStatusUnknown((current) => { if (!current.get(gitTarget)) return current; const map = new Map(current); map.delete(gitTarget); return map; });
        markReviewRead();
      }).catch(() => {
        if (!alive) return;
        setCodeStatusUnknown((current) => { if (current.get(gitTarget)) return current; const map = new Map(current); map.set(gitTarget, true); return map; });
        markReviewRead();
      });
      codeReadPending.current = pending;
      await pending;
      if (codeReadPending.current === pending) codeReadPending.current = null;
    };
    void read();
    return () => { alive = false; };
  }, [gitTarget, worktreeAnchor, codeStatusNeeded, returnedReviewId, codeReadSeq, nativeAvailable, focusToken, reviewSignal?.token]);
  // Status is read only for the checkouts the open menu shows, in small batches.
  // Closing the menu or switching repository drops every late answer.
  useEffect(() => {
    if (!nativeAvailable || !worktreeMenuOpen || !worktreeAnchor) return;
    const trees = worktreeAnchor === gitWorktrees?.anchor ? gitWorktrees.trees : [];
    let alive = true;
    // Nothing is known yet: an unread status must never render as "0 changes".
    setWorktreeStatuses(new Map());
    if (!trees.length) return;
    const readOne = async (path: string) => {
      try {
        const value = await native.worktreeStatus(path);
        if (!alive) return;
        const usable = !!value && typeof value === 'object' && (value.state === 'ready' || value.state === 'unknown');
        setWorktreeStatuses((current) => {
          const map = new Map(current);
          map.set(path, usable ? { status: value, error: '' } : { status: null, error: t('sessions.worktreeStatusFailed') });
          return map;
        });
      } catch (error) {
        if (!alive) return;
        setWorktreeStatuses((current) => {
          const map = new Map(current);
          map.set(path, { status: null, error: formatFailure(error, t('sessions.worktreeStatusFailed'), '') });
          return map;
        });
      }
    };
    void (async () => {
      for (let index = 0; index < trees.length && alive; index += 3) {
        await Promise.all(trees.slice(index, index + 3).map((tree) => readOne(tree.path)));
      }
    })();
    return () => { alive = false; };
  }, [worktreeMenuOpen, worktreeAnchor, gitWorktrees, nativeAvailable, worktreeStatusSeq, t]);
  // Real stages of an explicit creation. An event only updates an operation this page
  // started; unknown or late ids are dropped and the command result stays final.
  useEffect(() => {
    if (!nativeAvailable) return;
    let alive = true;
    let stop: (() => void) | undefined;
    void listen<WorktreeLaunchEvent>('cliora:worktree-launch', (event) => {
      if (!alive) return;
      const payload = event.payload;
      if (!payload || typeof payload.operationId !== 'string') return;
      setWorktreeOps((current) => {
        const index = current.findIndex((item) => item.operationId === payload.operationId);
        if (index < 0) return current;
        const operation = current[index];
        // A finished operation is final; a late event must not reopen it.
        if (operation.stage === 'succeeded') return current;
        // A prepare retry reuses an existing worktree, so the planner's leading
        // "creating" must not move the row backwards.
        if (operation.retry && payload.stage === 'creating') return current;
        if (payload.stage !== 'failed' && WORKTREE_STAGE_RANK[payload.stage] < WORKTREE_STAGE_RANK[operation.stage]) return current;
        const copy = [...current];
        copy[index] = {
          ...operation,
          stage: payload.stage,
          worktreePath: payload.worktreePath ?? operation.worktreePath,
          branch: payload.branch ?? operation.branch,
          sessionId: payload.sessionId ?? operation.sessionId,
          error: payload.stage === 'failed' ? payload.error ?? operation.error : operation.error,
          failedAt: payload.stage === 'failed' && operation.stage !== 'failed' ? operation.stage : operation.failedAt,
        };
        return copy;
      });
    }).then((unlisten) => { if (alive) stop = unlisten; else unlisten(); }).catch(() => {});
    return () => { alive = false; stop?.(); };
  }, []);
  // A finished creation is announced once and then leaves the stage on its own.
  useEffect(() => {
    if (!worktreeOps.some((item) => item.stage === 'succeeded')) return;
    const timer = window.setTimeout(() => setWorktreeOps((current) => current.filter((item) => item.stage !== 'succeeded')), 4000);
    return () => window.clearTimeout(timer);
  }, [worktreeOps]);
  // 审查状态由 native 注册表判定，这里只读取最新一条。打开菜单、收到回执和切换会话
  // 都会重读，因此被新链接取代的旧请求不会被迟到的回执改写。
  useEffect(() => {
    if (!nativeAvailable || !gitTarget) return;
    let alive = true;
    void native.twiglaneReviewState(gitTarget).then((value) => {
      if (!alive || !value || typeof value.reviewId !== 'string' || value.sessionId !== gitTarget) return;
      setReviewStates((current) => { const map = new Map(current); map.set(value.sessionId, value); return map; });
      setReviewClock(Date.now());
    }).catch(() => {});
    return () => { alive = false; };
  }, [gitTarget, nativeAvailable, reviewSignal?.token, gitReadSeq, focusToken, focusSessionId]);
  // 10 秒内没有 accepted/rejected 就是"打开结果未知"：系统接受 URL 不等于 Twiglane 已打开。
  useEffect(() => {
    if (!gitTarget) return;
    const review = reviewStates.get(gitTarget);
    if (!review || review.status !== 'opening') return;
    const left = review.createdAt + REVIEW_UNKNOWN_MS - Date.now();
    if (left <= 0) return;
    const timer = window.setTimeout(() => setReviewClock(Date.now()), left + 20);
    return () => window.clearTimeout(timer);
  }, [gitTarget, reviewStates, reviewClock]);
  // 返回结果只在一次新的 returned 到达时说一次；状态还没读到时先不宣布，避免把
  // 待复核声明当成成功。
  useEffect(() => {
    if (!gitTarget) return;
    const review = reviewStates.get(gitTarget);
    if (!review || review.status !== 'returned' || announcedReviews.current.has(review.reviewId)) return;
    if (codeStatusReviews.get(gitTarget) !== review.reviewId) return;
    const status = codeStatuses.get(gitTarget) ?? null;
    const unknownStatus = !!codeStatusUnknown.get(gitTarget);
    if (!status && !unknownStatus) return;
    announcedReviews.current.add(review.reviewId);
    setNotice(describeReview(review, status, unknownStatus).text);
  }, [gitTarget, reviewStates, codeStatuses, codeStatusUnknown, codeStatusReviews]);
  const composerHostId = libraryHostId(selected?.projectId, remoteProjects);
  // The dialog launches on the selected run location, so its prompts come from that host.
  const dialogHostId = newDialogOpen ? (remoteSshEnabled && activeTargetId !== 'local' ? activeTargetId : 'local') : null;
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
  // An empty list is the real empty state only once the saved records are known to be empty:
  // otherwise the pending rows (or one line of them) would flash away and come back.
  const restorePreviewKnown = !nativeAvailable || restoreListReady;
  const showEmpty = !loading && !scopedSessions.length && !restoreRows.length && restorePreviewKnown;
  const runningCount = scopedSessions.filter((item) => item.running).length;
  const endedCount = scopedSessions.filter(sessionConfirmedEnded).length;

  function flashCopied(state: 'path' | 'output' | 'selection' | 'empty' | 'branch') {
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
  // The status bar shows the hovered link's target, so no hint floats over the output.
  const linkHintHostRef = useRef<HTMLSpanElement>(null);
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
    linkHintHost: () => linkHintHostRef.current,
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
      else pending.current.push(sessionId, chunk);
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
    return () => { alive = false; pending.current.clear(); stops.forEach((stop) => { void Promise.resolve(stop()).catch(() => {}); }); };
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
        const write = writers.current.get(session.id);
        if (write) pending.current.drain(session.id).forEach(write);
      }
    }).catch((value) => {
      if (alive) setListError(formatFailure(value, t('sessions.listFailed'), t('sessions.listNext')));
    }).finally(() => {
      if (alive) setLoading(false);
      // Whatever the outcome, the restore batch must not wait on this forever.
      resolveSessionList.current?.();
    });
    void native.listProjects().then((listed) => {
      if (alive) setProjects(Array.isArray(listed) ? listed : []);
    }).catch(() => {});
    void native.getLaunchSettings().then((settings) => {
      if (alive && settings) setLaunchSettings(settings);
    }).catch(() => {});
    void native.listWorktreeLedger().then((rows) => {
      if (alive) setLedger(Array.isArray(rows) ? rows : []);
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
          worktreeIntent: 'given',
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

  function openNewSessionDialog(prefill?: { toolId?: string; projectId?: string; directory?: string; place?: 'worktree' }, targetOverride?: string) {
    setDialogError('');
    // Each opening starts from the saved preference; the dialog decides this launch.
    // An entry that asked for a worktree is an explicit choice, not the preference.
    dialogPlaceTouched.current = !!prefill?.place;
    const placeOf = (settings: LaunchSettings | null) => settings?.worktreeLaunchError ? 'direct' : settings?.worktreeLaunch === 'worktree' ? 'worktree' : 'direct';
    setDialogPlace(prefill?.place ?? placeOf(launchSettings));
    // The preference is edited in Settings, so read it again: an untouched choice follows it.
    if (nativeAvailable) void native.getLaunchSettings().then((settings) => {
      if (!settings) return;
      setLaunchSettings(settings);
      if (!dialogPlaceTouched.current) setDialogPlace(placeOf(settings));
    }).catch(() => {});
    setBaseChoice(null);
    setBaseRef('');
    setBasePreview(null);
    setBaseError('');
    setBaseStale(false);
    setBaseEditing(false);
    setBranchEditing(false);
    // The setup command is read again for each opening; typed edits survive place toggles only.
    setPrepareTarget(null);
    setPrepareSavedCommand(null);
    setBranchDraft('');
    if (targetOverride && targetOverride !== activeTargetId) setActiveTargetId(targetOverride);
    let nextToolId = effectiveLaunchToolId;
    if (prefill?.projectId) {
      const project = projects.find((item) => item.id === prefill.projectId);
      setWorkspaceValue('project:' + prefill.projectId);
      if (project?.preferredTool && terminalTools.some((item) => item.id === project.preferredTool)) nextToolId = project.preferredTool;
    } else if (prefill?.directory) {
      setCustomFolderPath(prefill.directory);
      setWorkspaceValue('custom:' + prefill.directory);
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
        worktreeIntent: 'given',
      });
      if (result.warnings?.length) setNotice(result.warnings.join('\n'));
      const opened = workbenchSessionId(result);
      if (opened) {
        onFailure(null);
        setNewDialogOpen(false);
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

  function mergeRemoteProject(project: RemoteProject) {
    setRemoteProjects((current) => [...current.filter((item) => item.id !== project.id), project]);
  }

  /** The tool-row launch for a host: remembered folder, else the folder picker, then launch. */
  async function quickRemoteLaunch(targetId: string, toolOverride: string | undefined, chooseDirectory: boolean) {
    const toolId = toolOverride ?? effectiveLaunchToolId;
    if (!toolId || newLaunchPending.current || remotePicker.picking) return;
    const remembered = rememberedRemoteDir(targetId, toolId);
    const path = (!chooseDirectory && remembered) || await remotePicker.pick(targetId, { initialPath: remembered || lastRemoteDir(targetId) });
    if (!path) return;
    try {
      const project = await ensureRemoteProject(targetId, path, toolId, remoteProjects);
      mergeRemoteProject(project);
      rememberRemoteDir(targetId, toolId, path);
      await launchRemoteProject(project, toolId);
    } catch (value) {
      setActionError(formatFailure(value, t('sessions.launchFailed'), t('sessions.failureHint')));
    }
  }

  async function pickCustomWorkspaceFolder() {
    if (activeRemoteTarget) {
      const path = await remotePicker.pick(activeRemoteTarget.id, { initialPath: customRemotePath || lastRemoteDir(activeRemoteTarget.id) });
      if (path) {
        setCustomRemotePath(path);
        setWorkspaceValue(`rpath:${path}`);
      }
      return;
    }
    try {
      const picked = await open({ directory: true, multiple: false, title: t('sessions.pickFolder') });
      // Cancelling the dialog resolves null and needs no feedback.
      if (typeof picked === 'string' && picked.trim()) {
        const clean = picked.trim();
        setCustomFolderPath(clean);
        setWorkspaceValue(`custom:${clean}`);
        setDialogError('');
      }
    } catch (value) {
      // The system dialog itself failed. Stay in the dialog with every choice intact.
      setDialogError(formatFailure(value, t('sessions.pickFolderFailed'), t('sessions.pickFolderNext')));
    }
  }

  async function launchFromDialog() {
    if (!effectiveLaunchToolId || newLaunchPending.current) return;
    newLaunchPending.current = true;
    setLaunchingNew(true);
    setDialogError('');
    setActionError('');
    setNotice('');
    try {
      let useWorkbench = launchSettings?.selected === 'workbench';
      if (launchSettings && launchSettings.selected !== 'workbench') {
        const updated = await native.setPreferredTerminal('workbench').catch(() => null);
        if (updated) setLaunchSettings(updated);
        useWorkbench = updated?.selected === 'workbench';
      }
      let projectId = workspaceValue.startsWith('project:') && !activeRemoteTarget
        ? workspaceValue.slice('project:'.length)
        : workspaceValue.startsWith('remote:')
          ? workspaceValue
          : null;
      // On a host, the home entry and a picked folder resolve to that host's project record.
      const remotePath = !activeRemoteTarget ? '' : workspaceValue === '__home' ? remoteHomePath : workspaceValue.startsWith('rpath:') ? workspaceValue.slice('rpath:'.length) : '';
      if (activeRemoteTarget && remotePath) {
        const project = await ensureRemoteProject(activeRemoteTarget.id, remotePath, effectiveLaunchToolId, remoteProjects);
        mergeRemoteProject(project);
        rememberRemoteDir(activeRemoteTarget.id, effectiveLaunchToolId, remotePath);
        projectId = `remote:${project.id}`;
      }
      const directory = !activeRemoteTarget && workspaceValue.startsWith('custom:') ? workspaceValue.slice('custom:'.length) : null;
      const promptText = initialPrompt.trim() || null;
      const remoteLaunch = !!projectId?.startsWith('remote:');
      const resume = !remoteLaunch && resumeLatest && !!selectedLaunchTool?.resumeLatestAvailable;
      const taskLine = firstTaskLine(promptText);
      // The dialog's own choice decides this launch. It only falls back to the
      // saved preference when that preference picked the worktree and no base can
      // be confirmed, which keeps the historical plain-directory behaviour.
      const wantsWorktree = !remoteLaunch && !resume && useWorkbench && dialogPlace === 'worktree';
      const target = wantsWorktree ? dialogPrepareDirectory() : null;
      // The creation always follows the current task text, so a preview left over
      // from an earlier keystroke must not decide this launch: re-read it now.
      let preview = basePreview;
      if (wantsWorktree && target) {
        try {
          const fresh = await native.worktreeBasePreview(target, baseChoice, taskLine);
          preview = fresh && typeof fresh === 'object' ? fresh : null;
          setBasePreview(preview);
          setBaseError('');
        } catch (error) {
          preview = null;
          setBasePreview(null);
          setBaseError(formatFailure(error, t('sessions.worktreeBaseFailed'), t('sessions.failureHint')));
        }
      }
      const confirmed = wantsWorktree && !!target && !!preview?.available;
      // A repository that answered "no usable base" has to be answered by the
      // user, never silently created from HEAD (R2). An unanswered preview means
      // the directory is not a repository, where R1 keeps the historical direct
      // start and the saved preference still decides.
      const preferenceFallback = wantsWorktree && !confirmed
        && (preview === null || !preview.reference)
        && !dialogPlaceTouched.current;
      if (wantsWorktree && !confirmed && !preferenceFallback) {
        setDialogError(!target
          ? t('sessions.worktreeNeedsFolder')
          : baseError || preview?.reason || t('sessions.worktreeBaseUnavailable'));
        return;
      }
      const branchName = branchDraft.trim();
      const baseOf = (preview: WorktreeBasePreview): WorktreeBase => preview.kind === 'reference'
        ? { kind: 'reference', reference: preview.reference ?? '' }
        : { kind: preview.kind === 'head' ? 'head' : 'default' };
      const worktreeIntent: WorktreeLaunchIntent = confirmed ? 'explicit' : preferenceFallback ? 'preference' : 'given';
      // The preference picked the worktree, but no base could be confirmed here: say so
      // instead of either failing the launch or silently pretending the base is known.
      if (preferenceFallback && target) setNotice(t('sessions.worktreePreferenceFallback'));
      const explicitBranch = confirmed && branchName ? branchName : undefined;
      const baseOptions: { base?: WorktreeBase; branch?: string } = confirmed
        ? { ...(preview ? { base: baseOf(preview) } : {}), ...(explicitBranch ? { branch: explicitBranch } : {}) }
        : {};
      const request: LaunchRequest = {
        toolId: effectiveLaunchToolId,
        projectId,
        sessionId: null,
        ...(remoteLaunch ? { remoteIntent: { kind: 'new' as const } } : {}),
        mode: selectedLaunchTool?.yoloAvailable ? launchMode : 'normal',
        directory,
        ...(promptText ? { initialPrompt: promptText } : {}),
        ...(resume ? { resumeLatest: true } : {}),
        worktreeIntent,
        ...(!remoteLaunch && !resume && useWorkbench && taskLine ? { taskText: taskLine } : {}),
      };
      // An explicit creation runs in the background: the dialog closes at once,
      // real stages arrive as events and no other session is blocked.
      if (confirmed) {
        // The setup command is edited where it is used. A change is saved for the
        // repository before the creation, which reads it natively; a failed save
        // keeps the dialog open instead of creating with the old command.
        let setupCommand = target && prepareTarget && sameDirectory(prepareTarget, target) ? prepareCommand : '';
        const setupKnown = prepareSavedCommand !== null;
        if (target && (setupKnown ? setupCommand.trim() !== prepareSavedCommand.trim() : !!setupCommand.trim())) {
          try {
            const saved = await native.saveWorktreePrepare(target, setupCommand);
            setupCommand = saved.command;
            setPrepareCommand(saved.command);
            setPrepareSavedCommand(saved.command);
          } catch (error) {
            setDialogError(formatFailure(error, t('sessions.worktreePrepareFailed'), t('sessions.failureHint')));
            return;
          }
        }
        // An unread command is assumed to exist, so a real setup step is never hidden.
        const prepare = !!setupCommand.trim() || !setupKnown;
        const operationId = newWorktreeOperationId();
        const watched = selectedIdRef.current;
        const tracked: LaunchRequest = { ...request, worktree: { ...baseOptions, operationId } };
        setWorktreeOps((current) => [...current, {
          operationId,
          stage: 'creating',
          worktreePath: null,
          branch: explicitBranch ?? null,
          sessionId: null,
          error: null,
          request: tracked,
          retry: false,
          failedAt: null,
          prepare,
        }]);
        onFailure(null);
        setNewDialogOpen(false);
        setInitialPrompt('');
        setDialogError('');
        void native.launchCli(tracked).then((result) => {
          settleWorktreeOperation(operationId, result, watched);
        }).catch((error) => {
          failWorktreeOperation(operationId, formatFailure(error, t('sessions.worktreeOpCreateFailed'), t('sessions.failureHint')));
        });
        return;
      }
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
    } finally { newLaunchPending.current = false; setLaunchingNew(false); refreshLedger(); }
  }

  /** A creation's command result is final: it converges the row even when no event
   *  arrived, and never steals the selection the user made afterwards. */
  function settleWorktreeOperation(operationId: string, result: LaunchResult, watched: string | null) {
    const opened = workbenchSessionId(result);
    setWorktreeOps((current) => current.map((item) => item.operationId === operationId
      ? { ...item, stage: 'succeeded', sessionId: opened ?? item.sessionId }
      : item));
    if (result.warnings?.length) setNotice(result.warnings.join('\n'));
    // Adopt the new session only if the user has not chosen another one since.
    const adopt = () => { if (opened && selectedIdRef.current === watched) selectPendingSession(opened); };
    void native.listWorkbenchSessions().then((listed) => {
      if (Array.isArray(listed)) applyListedSessions(listed);
      adopt();
    }).catch(adopt);
    refreshLedger();
  }

  function failWorktreeOperation(operationId: string, detail: string) {
    setWorktreeOps((current) => current.map((item) => item.operationId === operationId
      ? (item.stage === 'failed' ? (item.error ? item : { ...item, error: detail }) : { ...item, stage: 'failed', error: detail, failedAt: item.stage })
      : item));
    refreshLedger();
  }

  /** Retry only the environment step of the worktree that already exists: no new
   *  branch or directory is allocated. */
  function retryWorktreePrepare(operation: WorktreeOperation) {
    const directory = operation.worktreePath;
    if (!directory) return;
    const operationId = newWorktreeOperationId();
    const watched = selectedIdRef.current;
    const request: LaunchRequest = {
      ...operation.request,
      worktreeIntent: 'prepareRetry',
      worktree: { ...(operation.request.worktree ?? {}), operationId, retryDirectory: directory },
    };
    setWorktreeOps((current) => [
      ...current.filter((item) => item.operationId !== operation.operationId),
      { ...operation, operationId, stage: 'preparing', error: null, sessionId: null, request, retry: true, failedAt: null },
    ]);
    void native.launchCli(request)
      .then((result) => settleWorktreeOperation(operationId, result, watched))
      .catch((error) => failWorktreeOperation(operationId, formatFailure(error, t('sessions.worktreeOpPrepareFailed'), t('sessions.failureHint'))));
  }

  /** A creation that never produced a worktree starts over, with a fresh operation id. */
  function retryWorktreeCreate(operation: WorktreeOperation) {
    const operationId = newWorktreeOperationId();
    const watched = selectedIdRef.current;
    const request: LaunchRequest = { ...operation.request, worktree: { ...(operation.request.worktree ?? {}), operationId } };
    setWorktreeOps((current) => [
      ...current.filter((item) => item.operationId !== operation.operationId),
      { ...operation, operationId, stage: 'creating', error: null, sessionId: null, request, failedAt: null },
    ]);
    void native.launchCli(request)
      .then((result) => settleWorktreeOperation(operationId, result, watched))
      .catch((error) => failWorktreeOperation(operationId, formatFailure(error, t('sessions.worktreeOpCreateFailed'), t('sessions.failureHint'))));
  }

  function worktreeStageText(operation: WorktreeOperation): string {
    if (operation.stage === 'creating') return t('sessions.worktreeOpCreating');
    if (operation.stage === 'preparing') return operation.prepare ? t('sessions.worktreeOpPreparing') : t('sessions.worktreeOpStarting');
    if (operation.stage === 'starting') return t('sessions.worktreeOpStarting');
    if (operation.stage === 'succeeded') return t('sessions.worktreeOpSucceeded');
    if (!operation.worktreePath) return t('sessions.worktreeOpCreateFailed');
    return worktreeCurrentStep(operation) === 'preparing' ? t('sessions.worktreeOpPrepareFailed') : t('sessions.worktreeOpStartFailed');
  }

  /** The repository a creation belongs to: its project, else the folder it was asked for. */
  function operationRepository(operation: WorktreeOperation): string | null {
    const projectId = operation.request.projectId;
    if (projectId && !projectId.startsWith('remote:')) return availableProjects.find((item) => item.id === projectId)?.path ?? null;
    return operation.request.directory || null;
  }

  async function restartOrCloneSession(session: WorkbenchSession, replaceEnded: boolean, directoryIntent?: 'given' | 'preference') {
    if (busy) return;
    const remote = !!session.projectId?.startsWith('remote:');
    const wantsNew = directoryIntent === 'given' ? false : !replaceEnded && !remote;
    setBusy(replaceEnded ? `restart:${session.id}` : `clone:${session.id}`);
    setActionError('');
    setNotice('');
    try {
      let useWorkbench = launchSettings?.selected === 'workbench';
      if (launchSettings && launchSettings.selected !== 'workbench') {
        const updated = await native.setPreferredTerminal('workbench').catch(() => null);
        if (updated) setLaunchSettings(updated);
        useWorkbench = updated?.selected === 'workbench';
      }
      const intent = wantsNew && useWorkbench ? 'preference' : 'given';
      const taskLine = intent === 'preference' ? firstTaskLine(taskTitle(session)) : null;
      const result = await native.launchCli({
        toolId: session.toolId,
        projectId: session.projectId,
        sessionId: null,
        mode: session.mode,
        directory: session.directory || null,
        worktreeIntent: intent,
        ...(taskLine ? { taskText: taskLine } : {}),
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
    } finally { setBusy(''); refreshLedger(); }
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

  /**
   * Open the same CLI in another checkout. A running CLI cannot be moved: the session runs the
   * CLI itself, not a shell, so typing `cd` would only send the agent a prompt and its own
   * working directory would stay put. A new session in the chosen worktree is the honest move.
   */

  /**
   * One explicit review attempt. Every call (a first try, a retry after a failure or an
   * unanswered attempt) asks native for a new reviewId, so an old result can never be
   * mistaken for this one. Nothing here writes to the repository.
   */
  async function startReview(session: WorkbenchSession) {
    setReviewError('');
    setReviewBusy(true);
    try {
      const state = await native.twiglaneStartReview(session.id);
      setReviewStates((current) => { const map = new Map(current); map.set(state.sessionId, state); return map; });
      setReviewClock(Date.now());
    } catch (error) {
      setReviewError([t('sessions.reviewFailed'), reviewReasonText(t, (error as { code?: string } | null)?.code)].join(' · '));
    } finally {
      setReviewBusy(false);
    }
  }

  /** What the Git menu says about one review; a claim is never shown as a success. */
  function describeReview(review: TwiglaneReviewState | null, status: WorkbenchCodeStatus | null, unknownStatus: boolean) {
    if (!review) return { tone: 'idle', text: t('sessions.reviewIdle') };
    if (review.status === 'opening') {
      return reviewClock - review.createdAt >= REVIEW_UNKNOWN_MS
        ? { tone: 'unknown', text: t('sessions.reviewUnknown') }
        : { tone: 'pending', text: t('sessions.reviewOpening') };
    }
    if (review.status === 'accepted') return { tone: 'accepted', text: t('sessions.reviewAccepted') };
    if (review.status === 'rejected') {
      return { tone: 'rejected', text: [t('sessions.reviewRejected'), reviewReasonText(t, review.reason)].join(' · ') };
    }
    // 返回的 committed/merged 只是待复核声明：OID 必须与基线不同且等于当前 HEAD。
    if (!review.outcome || review.outcome === 'reviewed') {
      return { tone: 'returned', text: t('sessions.reviewReturnedReviewed') };
    }
    const confirmed = !!review.headOid
      && /^[0-9a-f]{40}$/.test(review.headOid)
      && review.headOid !== review.baseline
      && !unknownStatus
      && status?.state === 'ready'
      && status.headOid === review.headOid;
    if (!confirmed) return { tone: 'unconfirmed', text: t('sessions.reviewUnconfirmed') };
    const oid = review.headOid!.slice(0, 7);
    return {
      tone: 'confirmed',
      text: t(review.outcome === 'merged' ? 'sessions.reviewReturnedMerged' : 'sessions.reviewReturnedCommitted', { oid }),
    };
  }

  /** 真实状态读不到时显示"未知"，绝不显示成 0 个文件。 */
  function codeStatusText(status: WorkbenchCodeStatus | null, unknown: boolean): string {
    if (!status || unknown) return t('sessions.reviewStatusUnknown');
    return [
      status.branch ?? t('sessions.reviewDetached'),
      status.headOid ? status.headOid.slice(0, 7) : t('sessions.reviewNoCommit'),
      t('sessions.reviewFiles', { count: status.uncommittedFiles ?? 0 }),
    ].join(' · ');
  }

  /** Start a fresh worktree from this session's repository: the dialog opens with the same
   *  CLI and folder and "New worktree" chosen, so only the task is left to type. */
  function createWorktreeFrom(session: WorkbenchSession) {
    setWorktreeMenuOpen(false);
    const project = session.projectId && !session.projectId.startsWith('remote:')
      ? availableProjects.find((item) => item.id === session.projectId) ?? null
      : null;
    openNewSessionDialog(project
      ? { toolId: session.toolId, projectId: project.id, place: 'worktree' }
      : { toolId: session.toolId, ...(session.directory ? { directory: session.directory } : {}), place: 'worktree' }, 'local');
  }

  async function openInWorktree(session: WorkbenchSession, worktree: WorkbenchWorktree) {
    setWorktreeMenuOpen(false);
    if (worktree.current || !worktree.path) return;
    await restartOrCloneSession({ ...session, directory: worktree.path }, false, 'given');
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
      // Some WebViews expose read() but only permit readText().
      const items = navigator.clipboard.read ? await navigator.clipboard.read().catch(() => null) : null;
      if (items) {
        const files: File[] = [];
        let text = '';
        for (const item of items) {
          if (item.types.includes('text/plain')) text += await (await item.getType('text/plain')).text();
          const type = item.types.find((value) => value.startsWith('image/'));
          if (type) files.push(new File([await item.getType(type)], 'clipboard', { type }));
        }
        if (text) handle.paste(text);
        else handle.pasteFiles(files);
      } else {
        const text = await navigator.clipboard.readText();
        if (text) handle.paste(text);
      }
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
    // Sessions the user never placed keep their natural order after the arranged ones,
    // so a newly started session joins the end of its group instead of jumping to the top.
    rest.sort((a, b) => {
      const ra = rank.get(a.id);
      const rb = rank.get(b.id);
      if (ra === rb) return 0;
      if (ra === undefined) return 1;
      if (rb === undefined) return -1;
      return ra - rb;
    });
    const byId = new Map(filteredSessions.map((session) => [session.id, session]));
    return [...pinned.map((id) => byId.get(id)!), ...rest];
  }, [filteredSessions, arrangement]);

  // Every session holds an explicit rank, not only the ones moved by hand. A restart restores
  // sessions under new ids and maps the ranks across, so the rail comes back in the same order;
  // a session that only restores on a later retry still returns to its old place.
  useEffect(() => {
    setArrangement((current) => {
      const ranked = new Set([...current.order, ...current.pinned]);
      const missing = sessions.filter((session) => !ranked.has(session.id)).map((session) => session.id);
      if (!missing.length) return current;
      const live = new Set(sessions.map((session) => session.id));
      // Ranks of sessions not on screen wait for a restore that may never come; keep the list
      // bounded by dropping those, never a rank that belongs to a session on screen.
      let order = [...current.order, ...missing];
      for (let index = order.length - 1; order.length > RAIL_ORDER_LIMIT && index >= 0; index -= 1) {
        if (!live.has(order[index])) order = [...order.slice(0, index), ...order.slice(index + 1)];
      }
      return { pinned: current.pinned, order };
    });
  }, [sessions]);

  useEffect(() => {
    try { localStorage.setItem(RAIL_ARRANGE_KEY, JSON.stringify(arrangement)); } catch { /* Storage is optional. */ }
  }, [arrangement]);

  const pinnedIds = useMemo(() => new Set(arrangement.pinned), [arrangement]);

  function togglePinSession(id: string) {
    setArrangement((current) => current.pinned.includes(id)
      ? { pinned: current.pinned.filter((item) => item !== id), order: current.order }
      : { pinned: [...current.pinned, id], order: current.order.filter((item) => item !== id) });
  }

  /** A rail group was rearranged by dragging: `ids` is that group's new visible order.
   *  Pinned sessions keep their own list; every other group shares one rank list, and ids
   *  outside the group keep their relative order behind it. */
  function reorderSessions(group: string, ids: string[]) {
    const moved = new Set(ids);
    setArrangement((current) => group === 'pinned'
      ? { pinned: [...ids, ...current.pinned.filter((id) => !moved.has(id))], order: current.order }
      : { pinned: current.pinned, order: [...ids, ...current.order.filter((id) => !moved.has(id))] });
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
    node.querySelector<HTMLButtonElement>(MENU_ITEM)?.focus({ preventScroll: true });
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
    // Worktree setup opens in its own dialog; the ledger is read so its entry stays current.
    refreshLedger();
    setMenu({ kind: 'session', sessionId: session.id, x, y, besideId: previous && previous !== session.id ? previous : null });
  }

  function openTerminalMenu(session: WorkbenchSession, x: number, y: number) {
    setAppearanceOpen(false);
    refreshLedger();
    setMenu({ kind: 'terminal', sessionId: session.id, x, y, hasSelection: !!handles.current.get(session.id)?.hasSelection() });
  }

  function menuNavigate(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = [...menuRef.current?.querySelectorAll<HTMLButtonElement>(MENU_ITEM) ?? []];
    if (!items.length) return;
    if (event.key === 'Tab') { event.preventDefault(); setMenu(null); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }

  /** Items a menu can move focus between: the same set the other menus use. */
  function worktreeMenuItems(): HTMLButtonElement[] {
    return [...worktreeMenuRef.current?.querySelectorAll<HTMLButtonElement>(MENU_ITEM) ?? []];
  }

  function focusWorktreeItem(index: number) {
    const items = worktreeMenuItems();
    if (!items.length) return;
    const target = index < 0 ? items[items.length - 1] : items[Math.min(index, items.length - 1)];
    target.focus();
    // A long list must keep the focused row in view without scrolling the page.
    target.scrollIntoView({ block: 'nearest' });
  }

  // The worktree menu stays open while the pointer travels across it and closes on a
  // press elsewhere, a lost window focus or Escape, like the other popovers.
  useEffect(() => {
    if (!worktreeMenuOpen) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && worktreeSwitchRef.current?.contains(event.target)) return;
      setWorktreeMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || worktreeSwitchRef.current?.contains(document.activeElement)) return;
      setWorktreeMenuOpen(false);
    };
    const close = () => setWorktreeMenuOpen(false);
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [worktreeMenuOpen]);

  /** The worktree menu is keyboard reachable like the other menus: arrows, Home,
   *  End, Enter/Space on the focused item, Escape closes and returns to the chip.
   *  Tab is left alone so it keeps moving out of the menu. */
  function worktreeMenuKeys(event: ReactKeyboardEvent<HTMLSpanElement>) {
    if (event.key === 'Escape' && worktreeMenuOpen) {
      event.preventDefault();
      event.stopPropagation();
      setWorktreeMenuOpen(false);
      gitChipRef.current?.focus();
      return;
    }
    // Modified arrows stay with the workbench shortcuts (Alt+Arrow switches sessions).
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (!worktreeMenuOpen) {
      // Closed: ArrowDown/ArrowUp opens the menu and lands on its first/last item.
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      setGitReadSeq((seq) => seq + 1);
      setWorktreeMenuOpen(true);
      const opening = event.key === 'ArrowUp';
      window.setTimeout(() => focusWorktreeItem(opening ? -1 : 0), 0);
      return;
    }
    if (event.key === 'Tab') return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = worktreeMenuItems();
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : index < 0 ? (event.key === 'ArrowDown' ? 0 : -1)
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    focusWorktreeItem(next);
  }

  /** Open the worktree management dialog. `directory` names the repository whose setup
   *  command is shown; without one only cleanup is offered. */
  function openWorktreeSetup(directory: string | null) {
    setMenu(null);
    setWorktreeMenuOpen(false);
    openLocalPrepare(directory);
    setWorktreeSetup({ directory });
  }

  function refreshLedger() {
    if (!nativeAvailable) return;
    void native.listWorktreeLedger().then((rows) => {
      setLedger(Array.isArray(rows) ? rows : []);
    }).catch(() => {});
  }

  function openLocalPrepare(directory: string | null) {
    const request = ++prepareRequest.current;
    setPrepareError('');
    setCleanupError('');
    refreshLedger();
    setPrepareJustSaved(false);
    setPrepareSavedCommand(null);
    if (!directory) {
      setPrepareTarget(null);
      setPrepareCommand('');
      return;
    }
    setPrepareTarget(directory);
    setPrepareCommand('');
    void native.worktreePrepare(directory).then((value) => {
      if (prepareRequest.current !== request) return;
      const command = typeof value === 'string' ? value : '';
      setPrepareTarget(directory);
      setPrepareCommand(command);
      setPrepareSavedCommand(command);
    }).catch((value) => {
      if (prepareRequest.current !== request) return;
      setPrepareError(formatFailure(value, t('sessions.worktreePrepareFailed'), t('sessions.failureHint')));
    });
  }

  async function savePrepare(directory: string) {
    if (prepareSaving) return;
    setPrepareSaving(true);
    setPrepareError('');
    setPrepareJustSaved(false);
    try {
      const saved = await native.saveWorktreePrepare(directory, prepareCommand);
      setPrepareTarget(directory);
      setPrepareCommand(saved.command);
      setPrepareSavedCommand(saved.command);
      setPrepareJustSaved(true);
    } catch (value) {
      setPrepareError(formatFailure(value, t('sessions.worktreePrepareFailed'), t('sessions.failureHint')));
    } finally { setPrepareSaving(false); }
  }

  async function cleanWorktree(row: WorktreeLedgerEntry) {
    if (cleanupBusy) return;
    // A running local session keeps this checkout in use. Native refuses the same
    // case; saying it here names the one action that unblocks the removal.
    const inUse = worktreeUser(row);
    if (inUse) {
      setCleanupError(t('sessions.worktreeCleanupRunning', { tool: toolName(inUse) }));
      return;
    }
    setCleanupBusy(row.worktreePath);
    setCleanupError('');
    try {
      const preview = await native.cleanupWorktree(row.worktreePath, false);
      if (preview.needsConfirmation) {
        const accepted = await confirmAction(preview.detail || t('sessions.worktreeCleanupConfirmTitle'), () => true, {
          title: t('sessions.worktreeCleanupConfirmTitle'),
          confirmLabel: t('sessions.worktreeCleanupConfirm'),
          destructive: true,
        });
        if (!accepted) return;
        await native.cleanupWorktree(row.worktreePath, true);
      }
      refreshLedger();
    } catch (value) {
      setCleanupError(formatFailure(value, t('sessions.worktreeCleanupFailed'), t('sessions.failureHint')));
    } finally { setCleanupBusy(''); }
  }

  function dialogPrepareDirectory(): string | null {
    if (activeRemoteTarget) return null;
    if (workspaceValue.startsWith('project:')) return availableProjects.find((item) => 'project:' + item.id === workspaceValue)?.path ?? null;
    if (workspaceValue.startsWith('custom:')) return workspaceValue.slice('custom:'.length) || null;
    return null;
  }

  /** The repository a session's setup command belongs to: its project, else its folder. */
  function setupDirectoryOf(session: WorkbenchSession): string | null {
    if (session.projectId?.startsWith('remote:')) return null;
    const project = session.projectId ? availableProjects.find((item) => item.id === session.projectId) : null;
    return project?.path ?? (session.directory || null);
  }

  /** A running local session keeps a checkout in use; cleanup names it instead of failing. */
  function worktreeUser(row: WorktreeLedgerEntry): WorkbenchSession | undefined {
    return sessions.find((session) => session.running
      && !session.projectId?.startsWith('remote:')
      && !!session.directory
      && withinDirectory(row.worktreePath, session.directory));
  }

  /** One dialog to manage worktrees: remove the ones Cliora created, and edit the
   *  repository's setup command. The start preference lives in Settings and the
   *  new-session dialog chooses per launch, so it is not repeated here. */
  function worktreeSetupDialog() {
    const directory = worktreeSetup?.directory ?? null;
    const command = directory && prepareTarget && sameDirectory(prepareTarget, directory) ? prepareCommand : '';
    const prepareLoading = !!directory && prepareSavedCommand === null && !prepareError;
    // Save is offered only for a real change; after a failed read any typed command counts.
    const prepareDirty = prepareSavedCommand === null ? !!prepareError && !!command.trim() : command.trim() !== prepareSavedCommand.trim();
    const repository = directory ? availableProjects.find((item) => item.path && sameDirectory(item.path, directory))?.name ?? null : null;
    const prepareStatus = prepareSaving ? t('sessions.worktreePrepareSaving') : prepareJustSaved && !prepareDirty ? t('sessions.worktreePrepareSaved') : '';
    return <GuideDialog open={!!worktreeSetup} title={t('sessions.worktreeSetupTitle')} hint={t('sessions.worktreeSetupHint')} onClose={() => setWorktreeSetup(null)}>
      <div className={styles.setupForm}>
        <section className={styles.setupSection} aria-labelledby="worktree-setup-cleanup">
          <header className={styles.setupHead}><h3 id="worktree-setup-cleanup">{t('sessions.worktreeCleanup')}{ledger.length > 0 && <em>{ledger.length}</em>}</h3><p>{t('sessions.worktreeCleanupDesc')}</p></header>
          {cleanupError && <p className={styles.setupError} role="alert"><Icon name="alert" size={14} /><span>{cleanupError}</span></p>}
          {ledger.length ? <ul className={styles.setupList}>
            {ledger.map((row) => {
              const removing = cleanupBusy === row.worktreePath;
              const user = worktreeUser(row);
              return <li key={row.worktreePath} className={styles.setupRow} data-busy={removing || undefined} data-in-use={user ? '' : undefined}>
                <span className={styles.setupRowGlyph} aria-hidden="true"><Icon name="gitWorktree" size={14} /></span>
                <span className={styles.cleanupCopy}>
                  <span className={styles.cleanupTitle} title={row.branch}>{row.branch}</span>
                  <small><span className={styles.cleanupPath} title={displayPath(row.worktreePath)}>{shortPath(displayPath(row.worktreePath))}</span>{user && <span className={styles.cleanupInUse}>{t('sessions.worktreeInUse', { tool: toolName(user) })}</span>}</small>
                </span>
                <Button size="sm" variant="ghost" className={styles.setupRemove} aria-label={t('sessions.worktreeCleanupAction', { branch: row.branch })} title={user ? t('sessions.worktreeCleanupRunning', { tool: toolName(user) }) : undefined} disabled={!!cleanupBusy} icon={<Icon name={removing ? 'refresh' : 'trash'} size={13} />} onClick={() => void cleanWorktree(row)}>{removing ? t('sessions.worktreeCleaning') : t('sessions.worktreeCleanupButton')}</Button>
              </li>;
            })}
          </ul> : <p className={styles.setupEmpty}><Icon name="gitWorktree" size={14} /><span>{t('sessions.worktreeCleanupEmpty')}</span></p>}
        </section>
        <section className={styles.setupSection} aria-labelledby="worktree-setup-prepare">
          <header className={styles.setupHead}>
            <h3 id="worktree-setup-prepare">{t('sessions.worktreePrepare')}</h3>
            {directory && <span className={styles.setupRepo} title={displayPath(directory)}><Icon name="folder" size={12} />{repository ? <strong>{repository}</strong> : <code>{shortPath(displayPath(directory))}</code>}</span>}
            <p>{t('sessions.worktreePrepareHint')}</p>
          </header>
          {directory ? <>
            {prepareError && <p className={styles.setupError} role="alert"><Icon name="alert" size={14} /><span>{prepareError}</span></p>}
            <div className={styles.setupCommand}>
              <span className={styles.setupPrompt} aria-hidden="true">$</span>
              <input value={command} placeholder={prepareLoading ? t('sessions.worktreePrepareLoading') : t('sessions.worktreePreparePlaceholder')} aria-label={t('sessions.worktreePrepare')} spellCheck={false} autoComplete="off" disabled={prepareLoading || prepareSaving} onChange={(event) => { setPrepareTarget(directory); setPrepareCommand(event.target.value); setPrepareJustSaved(false); }} onKeyDown={(event) => { if (event.key === 'Enter' && prepareDirty) { event.preventDefault(); void savePrepare(directory); } }} />
              <Button size="sm" variant={prepareDirty ? 'primary' : 'secondary'} data-dialog-save disabled={prepareSaving || prepareLoading || !prepareDirty} onClick={() => void savePrepare(directory)}>{t('sessions.worktreePrepareSave')}</Button>
            </div>
            <p className={styles.setupStatus} role="status" data-tone={prepareJustSaved && !prepareDirty ? 'success' : undefined}>{prepareJustSaved && !prepareDirty && !prepareSaving && <Icon name="check" size={12} />}{prepareStatus}</p>
          </> : <p className={styles.setupEmpty}><Icon name="info" size={14} /><span>{t('sessions.worktreePrepareNeedsRepo')}</span></p>}
        </section>
      </div>
    </GuideDialog>;
  }

  const availableProjects = useMemo(() => projects.filter((item) => item.available && item.path), [projects]);
  const availableRemoteProjects = useMemo(() => activeTargetId === 'local' ? [] : remoteProjects.filter((item) => item.path && item.targetId === activeTargetId).sort((a, b) => b.updatedAt - a.updatedAt), [activeTargetId, remoteProjects]);
  const activeRemoteTarget = remoteSshEnabled && activeTargetId !== 'local' ? remoteTargets.find((target) => target.id === activeTargetId) ?? null : null;
  const remoteHomePath = activeRemoteTarget ? remoteStartPath(activeRemoteTarget) : '';
  // The dialog reads its base from the directory it will really use; the home
  // entry has none, so a worktree cannot be chosen there.
  useEffect(() => {
    if (!newDialogOpen) { setDialogDirectory(null); return; }
    setDialogDirectory(dialogPrepareDirectory());
  }, [newDialogOpen, workspaceValue, availableProjects, activeRemoteTarget]);
  // The branch a creation would allocate follows the task text, so the first line
  // of the prompt is part of the preview request.
  const dialogTaskLine = useMemo(() => firstTaskLine(initialPrompt), [initialPrompt]);
  // The confirmed base, its short commit and the proposed branch are visible before
  // anything is written. A keystroke only re-reads after a short pause, and the
  // previous preview stays on screen meanwhile.
  useEffect(() => {
    if (!nativeAvailable || !newDialogOpen || dialogPlace !== 'worktree' || !dialogDirectory) {
      setBasePreview(null);
      setBaseBusy(false);
      return;
    }
    const request = ++baseRequest.current;
    let cancelled = false;
    setBaseBusy(true);
    setBaseError('');
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      void native.worktreeBasePreview(dialogDirectory, baseChoice, dialogTaskLine).then((value) => {
        if (cancelled || baseRequest.current !== request) return;
        setBasePreview(value && typeof value === 'object' ? value : null);
        setBaseBusy(false);
      }).catch((error) => {
        if (cancelled || baseRequest.current !== request) return;
        setBasePreview(null);
        setBaseBusy(false);
        setBaseError(formatFailure(error, t('sessions.worktreeBaseFailed'), t('sessions.failureHint')));
      });
    }, 240);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [nativeAvailable, newDialogOpen, dialogPlace, dialogDirectory, baseChoice, dialogTaskLine, t]);
  // The repository's setup command is shown and edited in the worktree panel itself,
  // so nothing has to be configured elsewhere before the first creation.
  useEffect(() => {
    if (!nativeAvailable || !newDialogOpen || dialogPlace !== 'worktree' || !dialogDirectory) return;
    if (prepareTarget && sameDirectory(prepareTarget, dialogDirectory) && (prepareSavedCommand !== null || !!prepareError)) return;
    openLocalPrepare(dialogDirectory);
  }, [nativeAvailable, newDialogOpen, dialogPlace, dialogDirectory]);

  function chooseDialogPlace(place: 'direct' | 'worktree') {
    dialogPlaceTouched.current = true;
    setDialogPlace(place);
    setBaseError('');
    setBaseStale(false);
    setDialogError('');
  }

  /** Refresh only the selected remote base. A failure keeps the cached preview on
   *  screen so the user can retry or deliberately continue with it. */
  async function updateBase() {
    if (!dialogDirectory || baseBusy) return;
    const request = ++baseRequest.current;
    setBaseBusy(true);
    setBaseError('');
    try {
      const value = await native.worktreeBaseUpdate(dialogDirectory, baseChoice);
      if (baseRequest.current !== request) return;
      // Only the base is refreshed: the branch proposal stays what the task text
      // asked for, so an update never blanks the name in the dialog.
      setBasePreview((previous) => (value && typeof value === 'object'
        ? { ...value, proposedBranch: value.proposedBranch ?? previous?.proposedBranch ?? null }
        : null));
      setBaseStale(false);
    } catch (error) {
      if (baseRequest.current !== request) return;
      setBaseError(formatFailure(error, t('sessions.worktreeBaseUpdateFailed'), t('sessions.failureHint')));
    } finally {
      if (baseRequest.current === request) setBaseBusy(false);
    }
  }

  /** Commit the typed base. An empty field goes back to the repository default. */
  function applyBaseRef() {
    const reference = baseRef.trim();
    setBaseEditing(false);
    const current = baseChoice?.kind === 'reference' ? baseChoice.reference : '';
    // Leaving the shown default untouched keeps it the default, not a pinned ref.
    if (reference === current || (!baseChoice && reference === (basePreview?.reference ?? ''))) return;
    setBaseError('');
    setBaseStale(false);
    setBaseChoice(reference ? { kind: 'reference', reference } : null);
  }

  /** A name left equal to the proposal stays automatic, so it keeps following the task. */
  function finishBranchEdit() {
    setBranchEditing(false);
    if (branchDraft.trim() && branchDraft.trim() === basePreview?.proposedBranch) setBranchDraft('');
  }

  function editBase() {
    setBaseRef(baseChoice?.kind === 'reference' ? baseChoice.reference : basePreview?.reference ?? '');
    setBaseEditing(true);
  }
  // A picked folder belongs to the host it was picked on.
  useEffect(() => { setCustomRemotePath(''); }, [activeTargetId]);
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
          const handle = handles.current.get(id);
          const droppedPaths = (payload.paths ?? []).filter((path) => path.trim());
          if (!handle || !droppedPaths.length) return;
          setSelectedId(id);
          const session = sessionsRef.current.find((item) => item.id === id);
          const projectId = session?.projectId?.startsWith('remote:') ? session.projectId : null;
          uploads.enqueueUpload(id, projectId, droppedPaths.map((path) => ({ name: uploadDisplayName(path), localPath: path })));
        }
      }).then((unlisten) => { if (alive) stop = unlisten; else unlisten(); }).catch(() => {});
    } catch { /* Browser previews have no native drag events. */ }
    return () => { alive = false; stop?.(); setDropTarget(null); };
  }, [active]);

  function pickLaunchTool(value: string) {
    setLaunchToolId(value);
    const nextTool = terminalTools.find((item) => item.id === value);
    setLaunchMode(preferredLaunchMode(launchSettings, workspaceValue.startsWith('project:') || workspaceValue.startsWith('remote:') ? 'project' : 'cli', !!nextTool?.yoloAvailable));
  }
  const cliSelectOptions = useMemo<FilterSelectOption[]>(() => toolOptions(terminalTools), [terminalTools]);
  const workspaceSelectOptions = useMemo<FilterSelectOption[]>(() => {
    // A host lists its own places only: its home folder, its saved folders and a picked one.
    if (activeRemoteTarget) {
      const list: FilterSelectOption[] = [
        { value: '__home', label: t('sessions.workspaceHome'), detail: `${activeRemoteTarget.name} · ${remoteHomePath}`, icon: <Icon name="home" size={14} /> },
        ...availableRemoteProjects.filter((project) => project.path !== remoteHomePath && project.path !== customRemotePath).map((project) => ({ value: `remote:${project.id}`, label: project.name, detail: project.path, icon: <Icon name="folder" size={14} /> })),
      ];
      if (customRemotePath) list.push({ value: `rpath:${customRemotePath}`, label: remoteBaseName(customRemotePath) || customRemotePath, detail: customRemotePath, icon: <Icon name="folder" size={14} /> });
      return list;
    }
    const list: FilterSelectOption[] = [
      { value: '__home', label: t('sessions.workspaceHome'), icon: <Icon name="home" size={14} /> },
      ...availableProjects.map((project) => ({ value: `project:${project.id}`, label: project.name, detail: project.path ? shortPath(displayPath(project.path)) : undefined, icon: <Icon name="folder" size={14} /> })),
    ];
    if (customFolderPath) list.push({ value: `custom:${customFolderPath}`, label: shortPath(displayPath(customFolderPath)), detail: displayPath(customFolderPath), icon: <Icon name="folder" size={14} /> });
    return list;
  }, [activeRemoteTarget, availableProjects, availableRemoteProjects, customFolderPath, customRemotePath, remoteHomePath, t]);
  // Switching hosts can leave a folder from the other place selected; fall back to home.
  useEffect(() => {
    if (newDialogOpen && !workspaceSelectOptions.some((option) => option.value === workspaceValue)) setWorkspaceValue('__home');
  }, [newDialogOpen, workspaceSelectOptions, workspaceValue]);

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

  const copiedMessage = copiedState === 'branch' ? t('sessions.branchCopied') : copiedState === 'path' ? t('sessions.pathCopied')
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
    }} onNewSession={() => openNewSessionDialog()} onOpenMenu={openRowMenu} onRemove={(session) => void endSession(session)} onClearEnded={() => void clearEndedSessions()} onToggleSlim={toggleRail} onReorder={reorderSessions} />;

  return <div ref={rootRef} className={styles.root} data-focus-mode={focusMode || undefined} data-empty={(showEmpty && !listError) || undefined} data-term-theme={terminalMode} data-narrow={narrowFrame || undefined} data-compact={compactFrame || undefined} data-tight={tightFrame || undefined} data-rail-docked={railDocked || undefined}>
    {(focusMode || (showEmpty && !listError)) && <h1 className={styles.srOnly} tabIndex={-1}>{t('common.pages.sessions.title')}</h1>}
    {listError && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><strong>{t('sessions.listFailed')}</strong><p>{listError}</p></div><Button size="sm" onClick={() => setReload((value) => value + 1)}>{t('sessions.retry')}</Button></div>}

    <div className={styles.layout} data-strip={(!railDocked && showRail) || undefined}>
      {!railDocked && showRail && rail}

      <section ref={stageRef} className={styles.stage} aria-label={t('sessions.stageLabel')}>
        {writeRecoveryNeeded && !stageSession && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><p>{t('common.remoteWrite.unknown')}</p></div><div className={styles.bannerActions}><Button size="sm" onClick={() => requestWriteRecovery(remoteTargetId)}>{t('common.remoteWrite.open')}</Button></div></div>}
        {failure && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><strong>{t('sessions.launchFailed')}</strong><p>{failure.detail}</p><p>{t('sessions.failureHint')}</p></div><div className={styles.bannerActions}><Button variant="primary" size="sm" icon={<Icon name="refresh" size={14} />} onClick={() => void retry()} disabled={retrying}>{retrying ? t('sessions.loading') : t('sessions.retry')}</Button><Button size="sm" onClick={() => onFailure(null)}>{t('sessions.dismissBanner')}</Button></div></div>}
        {actionError && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><p>{actionError}</p></div><IconButton size="sm" icon={<Icon name="close" size={14} />} onClick={() => setActionError('')} aria-label={t('common.dismissError')} /></div>}
        {restoreError && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><p>{restoreError}</p></div><Button size="sm" disabled={restoring} onClick={() => void restoreLocalSessions()}>{t('sessions.retryRestore')}</Button></div>}
        {restoreRows.length > 0 && <div className={styles.restoreQueue} role="group" tabIndex={0} aria-label={t('sessions.restoreQueueLabel')} data-restore-queue={restoreRows.length}>
          <div className={styles.restoreQueueHead}>
            <span>{t('sessions.restoreQueueLabel')}</span>
            {!scopedSessions.length && terminalTools.length > 0 && <Button size="sm" icon={<Icon name="plus" size={13} />} onClick={() => openNewSessionDialog()}>{t('sessions.newSession')}</Button>}
          </div>
          {restoreRows.map((row) => {
            const failed = row.stage === 'failed';
            const rowBusy = restoringIds.has(row.saved.id);
            return <div className={styles.restoreRow} key={row.saved.id} data-restore-row={row.saved.id} data-stage={row.stage}>
              <span className={styles.restoreRowIcon} aria-hidden="true"><ToolIcon toolId={row.saved.toolId} size={18} /></span>
              <div className={styles.restoreRowCopy}>
                <strong>{t('sessions.restorePending', { tool: tools.find(tool => tool.id === row.saved.toolId)?.name ?? row.saved.toolId })}</strong>
                <p className={styles.restoreRowPath} title={row.saved.directory}>{displayPath(row.saved.directory)}</p>
                <p className={styles.restoreRowStage} data-state={failed ? 'failed' : 'pending'} role={failed ? 'alert' : 'status'}>
                  {failed ? row.detail : row.stage === 'starting' ? t('sessions.restoreStarting') : row.stage === 'discovering' ? t('sessions.restoreDiscovering') : t('sessions.restoreQueued')}
                </p>
              </div>
              {failed
                ? <div className={styles.restoreRowActions}>
                  {row.candidates.length > 0 && <Button variant="primary" size="sm" disabled={rowBusy} onClick={() => { setRestoreChoice({ session: row.saved, detail: row.detail, candidates: row.candidates }); setRestoreChoiceError(''); }}>{t('sessions.chooseRestore')}</Button>}
                  <Button size="sm" disabled={rowBusy} icon={<Icon name="refresh" size={13} />} onClick={() => void retryRestoreRow(row)}>{t('sessions.retryRestore')}</Button>
                  <Button size="sm" disabled={rowBusy} onClick={() => forgetRestoreRow(row.saved.id)}>{t('sessions.dismissRestore')}</Button>
                </div>
                // A row that is still waiting keeps a visible exit: a record native never answers
                // for must not become an operation the user cannot cancel.
                : <div className={styles.restoreRowActions}>
                  <span className={styles.restoreRowWait} aria-hidden="true" />
                  <IconButton size="sm" disabled={rowBusy} icon={<Icon name="close" size={13} />} onClick={() => forgetRestoreRow(row.saved.id)} aria-label={t('sessions.dismissRestore')} title={t('sessions.dismissRestore')} />
                </div>}
            </div>;
          })}
        </div>}
        {notice && <div className={styles.banner} data-tone="status" role="status"><div className={styles.bannerCopy}><p>{notice}</p></div><IconButton size="sm" icon={<Icon name="close" size={14} />} onClick={() => setNotice('')} aria-label={t('common.dismissError')} /></div>}
        {worktreeOps.map((operation) => {
          const failed = operation.stage === 'failed';
          const finished = failed || operation.stage === 'succeeded';
          const steps = worktreeSteps(operation);
          const stepLabel = (step: WorktreeStep) => t(step === 'creating' ? 'sessions.worktreeStepCreate' : step === 'preparing' ? 'sessions.worktreeStepPrepare' : 'sessions.worktreeStepStart');
          const setupFailed = failed && !!operation.worktreePath && worktreeCurrentStep(operation) === 'preparing';
          const repository = setupFailed ? operationRepository(operation) : null;
          const dismiss = () => setWorktreeOps((current) => current.filter((item) => item.operationId !== operation.operationId));
          return <div key={operation.operationId} className={styles.banner} data-tone={failed ? undefined : operation.stage === 'succeeded' ? 'success' : 'status'} data-worktree-op={operation.operationId} data-stage={operation.stage} role={failed ? 'alert' : 'status'}>
            <div className={styles.bannerCopy}>
              <div className={styles.worktreeOpHead}>
                <strong className={styles.worktreeOpTitle} title={operation.branch ?? undefined}><Icon name="gitWorktree" size={13} /><span>{operation.branch ?? t('sessions.worktreePlaceNew')}</span></strong>
                {/* The steps are a visual summary of the stage line below, which carries the words. */}
                <ol className={styles.worktreeSteps} aria-hidden="true">
                  {worktreeStepStates(operation).map((state, index) => <li key={steps[index]} data-state={state}>
                    <span className={styles.worktreeStepDot}>{state === 'done' ? <Icon name="check" size={8} /> : state === 'failed' ? <Icon name="close" size={8} /> : null}</span>
                    <span>{stepLabel(steps[index])}</span>
                  </li>)}
                </ol>
              </div>
              <div className={styles.worktreeOpLine}>
                <p>{failed && operation.error ? operation.error : worktreeStageText(operation)}</p>
                {operation.worktreePath && operation.stage !== 'succeeded' && <span className={styles.worktreeOpPath} title={displayPath(operation.worktreePath)}>{shortPath(displayPath(operation.worktreePath))}</span>}
              </div>
            </div>
            <div className={styles.bannerActions}>
              {operation.stage === 'succeeded' && operation.sessionId && operation.sessionId !== selectedId && sessions.some((item) => item.id === operation.sessionId) && <Button variant="primary" size="sm" icon={<Icon name="arrowRight" size={14} />} onClick={() => { const id = operation.sessionId!; dismiss(); selectPendingSession(id); }}>{t('sessions.worktreeOpOpenSession')}</Button>}
              {repository && <Button size="sm" variant="ghost" icon={<Icon name="pencil" size={13} />} onClick={() => openWorktreeSetup(repository)}>{t('sessions.worktreeEditPrepare')}</Button>}
              {failed && operation.worktreePath && <Button variant="primary" size="sm" icon={<Icon name="refresh" size={14} />} onClick={() => retryWorktreePrepare(operation)}>{setupFailed ? t('sessions.worktreeRetryPrepare') : t('sessions.worktreeRetryStart')}</Button>}
              {failed && !operation.worktreePath && <Button variant="primary" size="sm" icon={<Icon name="refresh" size={14} />} onClick={() => retryWorktreeCreate(operation)}>{t('sessions.worktreeRetryCreate')}</Button>}
              {finished && <IconButton size="sm" icon={<Icon name="close" size={14} />} aria-label={t('sessions.dismissBanner')} title={t('sessions.dismissBanner')} onClick={dismiss} />}
            </div>
          </div>;
        })}

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
          const gitTitle = git ? [git.branch ? t('sessions.gitBranch', { name: git.branch }) : t('sessions.gitDetached', { commit: git.commit }), git.worktree ? t('sessions.gitWorktree', { name: git.worktree }) : '', git.repository ? t('sessions.gitRepository', { name: git.repository }) : ''].filter(Boolean).join(' · ') : '';
          const canSplit = splitRoom && scopedSessions.length > 1;
          const splitLabel = split ? t('sessions.splitViewExit') : canSplit ? t('sessions.splitView') : t('sessions.splitNeedsTwo');
          const remote = !!current?.projectId?.startsWith('remote:');
          const remoteProject = remote ? remoteProjects.find((project) => `remote:${project.id}` === current?.projectId) : undefined;
          const remoteHost = remoteProject ? remoteTargets.find((target) => target.id === remoteProject.targetId) : undefined;
          const hostLabel = remote ? remoteHost?.name ?? 'SSH' : t('common.host.local');
          // Offer the worktree menu only when the repository actually has more than one checkout.
          const worktrees = current?.id === gitTarget && worktreeAnchor === gitWorktrees?.anchor ? gitWorktrees?.trees ?? [] : [];
          const canSwitchWorktree = !!current && !remote && worktrees.length > 1;
          // 只有一个 checkout 时菜单没有别的选择，但仍然要提供审查入口和真实状态。
          const canOpenGitMenu = !!current && !remote && (canSwitchWorktree || !!gitLabel);
          const review = current ? reviewStates.get(current.id) ?? null : null;
          const codeStatus = current ? codeStatuses.get(current.id) ?? null : null;
          const codeStatusStale = !!current && (!!codeStatusUnknown.get(current.id) || !codeStatus || codeStatus.state !== 'ready');
          const reviewUnverified = !!current && review?.status === 'returned' && codeStatusReviews.get(current.id) !== review.reviewId;
          const reviewView = describeReview(review, codeStatus, codeStatusStale || reviewUnverified);
          const reviewWaiting = !!review && review.status === 'opening' && reviewClock - review.createdAt < REVIEW_UNKNOWN_MS;
          // 发起中不重复点击；失败、超时或拒绝都可以重新发起，并一定拿到新的 reviewId。
          const reviewRetryable = !!review && !reviewWaiting && (review.status === 'rejected' || review.status === 'opening');
          const gitChipTitle = [gitTitle, t('sessions.gitScopeHint')].filter(Boolean).join('\n');
          return <div className={styles.window} hidden={!current} data-split={split ? 'true' : undefined} data-tone={tone}>
            {current && <header className={styles.stageBar} data-window-titlebar={windowChrome ?? undefined} data-tauri-drag-region={windowChrome ? 'deep' : undefined} onDoubleClick={(event) => {
              // In a browser, double-clicking the bare title bar toggles focus mode. In the desktop
              // window this bar is the window's title bar, where a double-click maximizes instead.
              if (windowChrome) return;
              if (!(event.target instanceof Element) || event.target.closest('button, a, input, [role="toolbar"], [data-stage-icon]')) return;
              setFocusMode((value) => !value);
            }}>
              <div className={styles.stageLead}>
                <span className={styles.stageIcon} data-tone={tone} data-stage-icon="" data-tauri-drag-region="false" title={t('sessions.stageIconHint')} onDoubleClick={(event) => { event.stopPropagation(); toggleRail(); }}><ToolIcon toolId={current.toolId} size={20} /><SessionActivityIcon tone={tone} slot="stage" className={styles.stageIconDot} /></span>
                <div className={styles.identityText}>
                  <div className={styles.identityTitleRow}><h2 title={title ? toolName(current) + ' · ' + stableTitle(title) : toolName(current)}>{title ? <SessionTitle title={title} /> : toolName(current)}</h2><Badge className={styles.statusChip} tone={sessionBadgeTone(tone)} data-state={tone} title={currentStateLabel}><SessionActivityIcon tone={tone} slot="status" className={styles.statusDot} /><span className={styles.statusLabel}><span>{currentStateLabel}</span>{stateReserves.map((label) => <span key={label} aria-hidden="true">{label}</span>)}</span></Badge></div>
                  <div className={styles.identitySub}>
                    {title && <span className={styles.identityTool}>{toolName(current)}</span>}
                    <button type="button" className={styles.pathChip} title={current.directory ? displayPath(current.directory) + ' · ' + t('sessions.copyPath') : placeOf(current)} onClick={() => void copySessionPath(current)}><Icon name={copiedState === 'path' ? 'check' : 'folder'} size={12} /><span>{copiedState === 'path' ? t('sessions.pathCopied') : placeOf(current)}</span></button>
                    {current.mode === 'yolo' && <span className={styles.modeChip} data-mode="yolo" title={t('sessions.modeYoloDesc')}>{modeLabel(current.mode)}</span>}
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
              {captionSlotRef && <span ref={captionSlotRef} className={styles.captionSlot} data-chrome={windowChrome ?? undefined} />}
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
                  const visible = renderActive && pane >= 0;
                  const focused = renderActive && session.id === selectedId;
                  const paneTitle = taskTitle(session);
                  const failed = !session.running && session.exitCode != null && session.exitCode !== 0;
                  const remotePane = session.projectId?.startsWith('remote:') ? session.projectId : undefined;
                  // 适配器只在支持该能力时才带对应端口；缺少 resume 端口不能让整个工作台崩掉。
                  const canResume = !remotePane && tools.some(tool => tool.id === session.toolId && tool.resume?.state === 'available' && tool.history?.state === 'available');
                  // Clipboard files use the same queue; local sessions retain staged files.
                  return <SessionTerminal key={session.id} sessionId={session.id} label={t('sessions.terminalLabel', { tool: toolName(session) })} active={visible} keepRendererWarm={renderActive} focused={focused} pane={split ? pane : undefined} running={session.running} remote={!!remotePane} onFilesPaste={(inputs) => uploads.enqueueUpload(session.id, remotePane || null, inputs)} startedAt={session.startedAt ?? firstSeenAt.current.get(session.id)} fontSize={fontSize} lineHeight={DENSITY_LINE_HEIGHT[density]} theme={terminalMode} cursorBlink={cursorBlink} writers={writers} pending={pending} handles={handles} bridge={bridge}
                    header={split && visible ? <div className={styles.paneHead}>
                      <SessionActivityIcon tone={sessionTone(session)} slot="pane" className={styles.paneDot} label={stateLabel(session, sessionTone(session))} />
                      <ToolIcon toolId={session.toolId} size={14} />
                      <strong>{paneTitle ? <SessionTitle title={paneTitle} /> : toolName(session)}</strong>
                      <span className={styles.panePlace}>{paneTitle ? toolName(session) + ' · ' + placeOf(session) : placeOf(session)}</span>
                      {focused && <span className={styles.paneFocus}>{t('sessions.paneFocused')}</span>}
                      <button type="button" className={styles.paneClose} aria-label={t('sessions.closePane', { name: toolName(session) })} title={t('sessions.closePane', { name: toolName(session) })} onClick={(event) => { event.stopPropagation(); closePane(session.id); }}><Icon name="close" size={12} /></button>
                    </div> : null}
                    overlay={<>
                      {visible && scrolledIds.has(session.id) && <button type="button" className={styles.jumpLatest} aria-label={t('sessions.jumpToBottom')} title={t('sessions.jumpToBottom')} onClick={() => { const handle = handles.current.get(session.id); handle?.scrollToBottom(); handle?.focus(); }}><Icon name="arrowDown" size={14} /><span>{t('sessions.jumpToBottom')}</span></button>}
                      {visible && dropTarget === session.id && <div className={styles.dropOverlay} aria-hidden="true"><div className={styles.dropCard}><span className={styles.dropGlyph}><Icon name="upload" size={22} /></span><strong>{t('sessions.dropHint')}</strong><span>{t('sessions.dropHintDetail', { tool: toolName(session) })}</span></div></div>}
                      {uploads.tasks[session.id] && <SessionUploadNotice task={uploads.tasks[session.id]} progressLabel={t(remotePane ? 'sessions.uploadRunningLabel' : 'sessions.pasteFilesRunningLabel')} progressText={t(remotePane ? 'sessions.uploadProgress' : 'sessions.pasteFilesProgress', { done: uploads.tasks[session.id].uploaded, total: uploads.tasks[session.id].total })} failedTitle={t(remotePane ? 'sessions.uploadFailedTitle' : 'sessions.pasteFilesFailedTitle')} retryLabel={t(remotePane ? 'sessions.uploadRetry' : 'sessions.pasteFilesRetry')} dismissLabel={t('common.dismissError')} onRetry={() => uploads.retryUpload(session.id)} onDismiss={() => uploads.dismissUploadFailure(session.id)} />}
                    </>}
                    footer={visible && !session.running ? <div className={styles.endedBar} data-failed={failed || undefined}>
                      <span className={styles.endedGlyph}><Icon name={failed ? 'alert' : 'info'} size={15} /></span>
                      <span className={styles.endedText}><strong>{session.reattachable ? t(session.connectionState === 'unknown' ? 'sessions.sshUnknown' : 'sessions.sshDisconnectedReattachable') : t('sessions.sessionEndedBanner')}</strong>{session.exitCode != null && <span className={styles.endedCode}>{t('sessions.exitCode', { code: session.exitCode })}</span>}<span className={styles.endedDetail}>{session.reattachable ? t('sessions.reattachNext') : t('sessions.endedHintShort')}</span></span>
                      {canResume && <Button variant="primary" size="sm" className={styles.endedRestart} disabled={!!busy || restoring} title={t('sessions.resumeSessionHint')} onClick={() => void reconnectLocalSession(session)} icon={<Icon name="refresh" size={13} />}><span className={styles.endedRestartLabel}>{busy === 'restore:' + session.id ? t('sessions.resumingSession') : t('sessions.resumeSession')}</span></Button>}
                      <Button variant={canResume ? 'secondary' : 'primary'} size="sm" className={styles.endedRestart} disabled={!!busy || restoring} title={session.reattachable ? t('sessions.reattachRemote') : t('sessions.restartHint')} onClick={() => void (session.reattachable ? reattachSession(session) : restartOrCloneSession(session, true))} icon={<Icon name="refresh" size={13} />}><span className={styles.endedRestartLabel}>{session.reattachable ? t(busy === 'reattach:' + session.id ? 'sessions.reattaching' : 'sessions.reattachShort') : busy === 'restart:' + session.id ? t('sessions.restarting') : t('sessions.restartSession')}</span></Button>
                      {writeRecoveryNeeded && <Button variant="primary" size="sm" className={styles.endedRestart} disabled={!!busy} title={t('common.remoteWrite.unknown')} onClick={() => requestWriteRecovery(remoteTargetId)} icon={<Icon name="alert" size={13} />}><span className={styles.endedRestartLabel}>{t('common.remoteWrite.open')}</span></Button>}
                    </div> : null} />;
                })}
                {copiedState && <div className={styles.toastPill} role="status"><Icon name={copiedState === 'empty' ? 'info' : 'check'} size={14} /><span>{copiedMessage}</span></div>}
              </div>
              {current?.running && composerOpen && <WorkbenchComposer toolId={current.toolId} toolName={toolName(current)} place={placeOf(current)} draft={composerDrafts[current.id] ?? ''} prompts={composerPrompts} promptFeedback={promptFeedback(composerHostId, composerIdentity)} inputRef={composerInputRef} onChange={updateComposerDraft} onSubmit={() => void submitComposer()} onClose={() => toggleComposer(false)} />}
              {current && <footer className={styles.statusBar}>
                <span className={styles.statusItem} data-host={remote ? 'remote' : 'local'} title={`${t('common.host.label')}：${hostLabel}${remoteHost ? ` · ${remoteHost.user}@${remoteHost.host}` : ''}`}><Icon name={remote ? 'server' : 'monitor'} size={12} />{hostLabel}</span>
                {/* Git is one chip: branch name, a worktree glyph when this checkout is a linked worktree,
                    and a caret only when there are other checkouts to open a session in. */}
                {(gitLabel || canOpenGitMenu) && (canOpenGitMenu && current ? <span ref={worktreeSwitchRef} className={styles.worktreeSwitch} onKeyDown={worktreeMenuKeys}>
                  <button ref={gitChipRef} type="button" className={styles.gitChip} data-switch="" aria-haspopup="menu" aria-expanded={worktreeMenuOpen} aria-label={[gitTitle, t('sessions.worktreeMenu'), t('sessions.reviewGroup')].filter(Boolean).join(' · ')} title={gitChipTitle + '\n' + t('sessions.worktreeMenu') + '\n' + t('sessions.reviewGroup')} disabled={!!busy} onClick={() => { if (!worktreeMenuOpen) setGitReadSeq((seq) => seq + 1); setWorktreeMenuOpen(!worktreeMenuOpen); }}><Icon name={git?.worktree ? 'gitWorktree' : 'branch'} size={12} /><span className={styles.gitChipLabel}>{gitLabel || t('sessions.worktreeCount', { count: worktrees.length })}</span><Icon name="chevronDown" size={11} /></button>
                  {worktreeMenuOpen && <div ref={worktreeMenuRef} className={styles.worktreeMenu} role="menu" aria-label={t('sessions.worktreeMenu')}>
                    {/* Where this session is: branch (or detached commit), repository and HEAD. */}
                    <div className={styles.gitMenuHead} role="presentation">
                      <span className={styles.gitMenuGlyph}><Icon name={git?.worktree ? 'gitWorktree' : 'branch'} size={14} /></span>
                      <span className={styles.gitMenuIdentity}>
                        <strong title={gitLabel || undefined}>{git?.branch ?? (git?.commit ? t('sessions.reviewDetached') : gitLabel || t('sessions.reviewStatusUnknown'))}</strong>
                        <small>{[git?.repository ?? '', !git?.branch && git?.commit ? git.commit.slice(0, 7) : '', !codeStatusStale && codeStatus?.headOid ? codeStatus.headOid.slice(0, 7) : ''].filter(Boolean).filter((value, index, list) => list.indexOf(value) === index).join(' · ')}</small>
                      </span>
                      {git?.branch && <button type="button" className={styles.gitMenuCopy} aria-label={t('sessions.copyBranch')} title={t('sessions.copyBranch')} onClick={(event) => { event.stopPropagation(); void writeClipboard(git.branch!).then((ok) => { if (ok) flashCopied('branch'); }); }}><Icon name={copiedState === 'branch' ? 'check' : 'copy'} size={13} /></button>}
                    </div>
                    <div className={styles.worktreeMenuHead} role="presentation"><span>{t('sessions.worktreeSection')}</span>{worktreeListState === 'ready' && <em>{worktrees.length}</em>}</div>
                    {worktreeListState === 'loading' && !gitWorktrees && <p className={styles.menuHint} role="status">{t('sessions.worktreeListLoading')}</p>}
                    {worktreeListState === 'error' && <p className={styles.menuError} role="alert">{worktreeListError}</p>}
                    {worktreeListState === 'ready' && !worktrees.length && <p className={styles.menuHint}>{t('sessions.worktreeListEmpty')}</p>}
                    {worktrees.map((tree) => {
                      // An unread status stays unknown: it is never shown as "no changes".
                      const read = worktreeStatuses.get(tree.path);
                      const status = read?.status ?? null;
                      const ready = status?.state === 'ready' && status.uncommittedFiles != null;
                      const changes = ready
                        ? (status.uncommittedFiles! > 0 ? t('sessions.worktreeStatusUncommitted', { count: status.uncommittedFiles }) : t('sessions.worktreeStatusClean'))
                        : '';
                      const tone = !read ? 'loading' : ready ? (status.uncommittedFiles! > 0 ? 'dirty' : 'clean') : 'unknown';
                      return <button key={tree.path} type="button" role="menuitemradio" aria-checked={tree.current} className={styles.worktreeItem} data-current={tree.current || undefined} data-status={!read ? 'loading' : status ? status.state : 'unknown'} data-environment={status?.environment ?? undefined} disabled={tree.current || !!busy} title={tree.current ? tree.path + ' · ' + t('sessions.worktreeCurrent') : t('sessions.worktreeOpenHint', { tool: toolName(current) }) + '\n' + tree.path} onClick={() => void openInWorktree(current, tree)}>
                        <Icon name={tree.current ? 'check' : 'gitWorktree'} size={13} className={styles.worktreeGlyph} />
                        <span className={styles.worktreeName}>{tree.name}</span>
                        <span className={styles.worktreeChanges} data-tone={tone} title={tone === 'unknown' ? read?.error || status?.reason || undefined : undefined}>{tone === 'loading' ? t('sessions.worktreeStatusLoading') : changes || t('sessions.worktreeStatusUnknown')}</span>
                        <span className={styles.worktreeSub}>
                          {tree.branch && <span className={styles.worktreeBranch}><Icon name="branch" size={10} />{tree.branch}</span>}
                          
                          <span className={styles.worktreePath}>{shortPath(displayPath(tree.path))}</span>
                        </span>
                        <span className={styles.worktreeOpen}>{tree.current ? t('sessions.worktreeCurrent') : <><Icon name="plus" size={11} />{t('sessions.worktreeOpenAction')}</>}</span>
                      </button>;
                    })}
                    {(worktreeListState === 'error' || [...worktreeStatuses.values()].some((entry) => !entry.status)) && <button type="button" role="menuitem" className={styles.floatItem} onClick={() => { setGitReadSeq((seq) => seq + 1); setWorktreeStatusSeq((seq) => seq + 1); }}>
                      <Icon name="refresh" size={13} />
                      <span>{worktreeListState === 'error' ? t('sessions.worktreeListRetry') : t('sessions.worktreeStatusRetry')}</span>
                    </button>}
                    <button type="button" role="menuitem" className={styles.floatItem} data-accent="" disabled={!!busy} title={t('sessions.worktreeCreateNewHint', { tool: toolName(current) })} onClick={() => createWorktreeFrom(current)}>
                      <Icon name="plus" size={13} />
                      <span>{t('sessions.worktreeCreateNew')}</span>
                    </button>
                    <button type="button" role="menuitem" className={styles.floatItem} onClick={() => openWorktreeSetup(setupDirectoryOf(current))}>
                      <Icon name="sliders" size={13} />
                      <span>{t('sessions.worktreeSetupOpen')}</span>
                    </button>
                    <span className={styles.reviewDivider} role="separator" />
                    <div className={styles.reviewGroup} role="group" aria-label={t('sessions.reviewGroup')} onClick={(event) => event.stopPropagation()}>
                      <div className={styles.reviewHead}>
                        <span className={styles.reviewLabel} role="presentation">{t('sessions.reviewGroup')}</span>
                        <button type="button" role="menuitem" className={styles.reviewRefresh} aria-label={t('sessions.reviewStatusRetry')} title={t('sessions.reviewStatusRetry')} disabled={reviewBusy} onClick={() => setCodeReadSeq((seq) => seq + 1)}><Icon name="refresh" size={12} /></button>
                      </div>
                      {reviewError && <p className={styles.reviewError} role="alert">{reviewError}</p>}
                      <p className={styles.reviewState} data-tone={reviewView.tone} role="status">{reviewView.text}</p>
                      <p className={styles.reviewStatusLine} title={codeStatus?.worktreePath ?? undefined}><Icon name="branch" size={12} /><span>{codeStatusText(codeStatus, codeStatusStale)}</span></p>
                      {reviewView.tone === 'unknown' && <p className={styles.reviewHint}>{t('sessions.reviewUnknownHint')}</p>}
                      {reviewView.tone === 'unconfirmed' && <p className={styles.reviewHint}>{t('sessions.reviewUnconfirmedHint')}</p>}
                      {/* The safety note stays one hover away: it explains, it is not an action. */}
                      <button type="button" role="menuitem" className={styles.floatItem} data-accent="" disabled={reviewBusy || !!busy} title={t('sessions.reviewHint')} onClick={() => void startReview(current)}>
                        <Icon name={reviewRetryable ? 'refresh' : 'arrowUpRight'} size={13} />
                        <span>{reviewRetryable ? t('sessions.reviewRetry') : t('sessions.reviewStart')}</span>
                      </button>
                    </div>
                  </div>}
                </span> : <span className={styles.gitChip} title={gitChipTitle} aria-label={gitTitle}><Icon name={git?.worktree ? 'gitWorktree' : 'branch'} size={12} /><span className={styles.gitChipLabel}>{gitLabel}</span></span>)}
                {remote && <Badge className={styles.statusBadge} tone={current.connectionState === 'connected' ? 'success' : current.connectionState === 'disconnected' || current.connectionState === 'unknown' ? 'warning' : 'neutral'} title={current.exitReason === 'connection_lost' ? t('sessions.sshConnectionLostHint') : t('sessions.sshRemoteSession')}>SSH · {t(current.connectionState === 'connected' ? 'sessions.sshConnected' : current.connectionState === 'connecting' ? 'sessions.sshConnecting' : current.connectionState === 'disconnected' ? 'sessions.sshDisconnectedReattachable' : current.connectionState === 'remote_ended' ? 'sessions.sshEnded' : 'sessions.sshUnknown')}{current.remoteSessionId ? ` · ${current.remoteSessionId}` : ''}{current.remoteEndResult && current.remoteEndResult.outcome !== 'confirmed_absent' ? ` · ${t('sessions.sshEndUnconfirmed')}${current.remoteEndResult.exitCode != null ? ` (${current.remoteEndResult.exitCode})` : ''}` : ''}</Badge>}
                <span ref={linkHintHostRef} className={`${styles.statusSpacer} ${styles.statusLinkHost}`} />
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
          {!session.projectId?.startsWith('remote:') && <button role="menuitem" onClick={() => openWorktreeSetup(setupDirectoryOf(session))}><Icon name="gitWorktree" size={14} /><span>{t('sessions.worktreeSetupOpen')}</span>{ledger.length > 0 && <span className={styles.menuCount}>{ledger.length}</span>}</button>}
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
          {/* The short row menu only surfaces worktree settings when there is something to clean up. */}
          {!session.projectId?.startsWith('remote:') && ledger.length > 0 && <button role="menuitem" onClick={() => openWorktreeSetup(setupDirectoryOf(session))}><span>{t('sessions.worktreeSetupOpen')}</span>{ledger.length > 0 && <span className={styles.menuCount}>{ledger.length}</span>}</button>}
          <span className={styles.menuDivider} role="separator" />
          <button role="menuitem" data-danger="true" disabled={!!busy} onClick={() => void endSession(session)}>{session.running ? t('sessions.end') : t('sessions.removeSession')}</button>
        </>}
      </div>, document.body);
    })()}

    <GuideDialog open={!!restoreChoice} title={t('sessions.restoreChoiceTitle')} hint={t('sessions.restoreChoiceHint')} closeDisabled={restoring} onClose={() => { setRestoreChoice(null); setRestoreChoiceError(''); }}>
      <div className={styles.restoreCandidates}>
        {restoreChoiceError && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><p>{restoreChoiceError}</p></div></div>}
        {restoreChoice?.candidates.map(candidate => {
          const timestamp = candidate.updatedAt ?? candidate.startedAt;
          return <button type="button" className={styles.restoreCandidate} key={candidate.nativeId} disabled={restoring} onClick={() => void restoreChosenCandidate(candidate.nativeId)}>
            <span className={styles.restoreCandidateCopy}><strong>{candidate.title || t('records.page.untitled')}</strong><time dateTime={timestamp === null ? undefined : new Date(timestamp).toISOString()}>{timestamp === null ? t('records.format.timeUnknown') : new Date(timestamp).toLocaleString()}</time></span>
            <code title={candidate.nativeId}>{candidate.nativeId}</code><Icon name="arrowRight" size={16} />
          </button>;
        })}
      </div>
    </GuideDialog>
    <GuideDialog open={newDialogOpen} title={t('sessions.newSessionDialogTitle')} hint={t('sessions.newSessionDialogHint')} wide onClose={() => setNewDialogOpen(false)}>
      <div className={styles.dialogForm}>
        {dialogError && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><p>{dialogError}</p></div></div>}
        <div className={styles.dialogPrimaryGrid}>
          <div className={styles.dialogField}><span className={styles.fieldLabel}>{t('sessions.pickToolLabel')}</span><FilterSelect label={t('sessions.pickToolLabel')} value={effectiveLaunchToolId} options={cliSelectOptions} placeholder={t('home.launcher.pickTool')} searchLabel={t('sessions.searchCliTool')} onChange={pickLaunchTool} />
            {/* One click for the CLIs used most; the list above still reaches every tool. */}
            {terminalTools.length > 1 && <div className={styles.toolPicks} role="radiogroup" aria-label={t('sessions.quickPickTools')}>{terminalTools.slice(0, DIALOG_QUICK_TOOLS).map((tool) => <button key={tool.id} type="button" role="radio" aria-checked={effectiveLaunchToolId === tool.id} aria-label={tool.name} title={tool.name} className={styles.toolPick} onClick={() => pickLaunchTool(tool.id)}><ToolIcon toolId={tool.id} size={16} /></button>)}</div>}
          </div>
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
        {!activeRemoteTarget && !resumeLatest && (() => {
          const repoDirectory = dialogPrepareDirectory();
          const baseLoading = baseBusy && !basePreview;
          const branchExplicit = !!branchDraft.trim();
          const branchShown = branchDraft.trim() || basePreview?.proposedBranch || t('sessions.worktreeBranchUnknown');
          const setupCommand = repoDirectory && prepareTarget && sameDirectory(prepareTarget, repoDirectory) ? prepareCommand : '';
          const setupLoading = !!repoDirectory && prepareSavedCommand === null && !prepareError;
          const place = (value: 'direct' | 'worktree', icon: 'folder' | 'gitWorktree', label: string, detail: string) => <button type="button" role="radio" aria-checked={dialogPlace === value} className={styles.placeOption} title={detail} onClick={() => chooseDialogPlace(value)}><Icon name={icon} size={14} /><span>{label}</span><span className="sr-only">{detail}</span></button>;
          return <div className={styles.dialogField}>
            <div className={styles.placeRow}>
              <span className={styles.fieldLabel}>{t('sessions.worktreePlace')}</span>
              <div className={styles.placeSwitch} role="radiogroup" aria-label={t('sessions.worktreePlace')}>
                {place('direct', 'folder', t('sessions.worktreePlaceDirect'), t('sessions.worktreePlaceDirectDesc'))}
                {place('worktree', 'gitWorktree', t('sessions.worktreePlaceNew'), t('sessions.worktreePlaceNewDesc'))}
              </div>
            </div>
            {dialogPlace === 'worktree' && !repoDirectory && <p className={styles.baseNotice} role="status"><Icon name="info" size={14} /><span>{t('sessions.worktreeNeedsFolder')}</span></p>}
            {dialogPlace === 'worktree' && !!repoDirectory && <div className={styles.basePanel} data-busy={baseBusy || undefined}>
              {/* Base: the repository default and its real short commit, changed in place. */}
              <div className={styles.baseRow}>
                <span className={styles.baseLabel}>{t('sessions.worktreeBase')}</span>
                {baseEditing ? <span className={styles.baseEdit}>
                  <input autoFocus value={baseRef} placeholder={t('sessions.worktreeRefPlaceholder')} aria-label={t('sessions.worktreeRef')} spellCheck={false} autoComplete="off" onChange={(event) => setBaseRef(event.target.value)} onBlur={applyBaseRef} onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); applyBaseRef(); }
                    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setBaseEditing(false); }
                  }} />
                </span> : <span className={styles.baseValue}>
                  <code className={styles.baseRef} data-loading={baseLoading ? '' : undefined} title={basePreview?.reference ?? undefined}>{baseLoading ? t('sessions.worktreeBaseLoading') : basePreview?.available ? basePreview.reference ?? '' : '—'}</code>
                  {basePreview?.available && basePreview.shortCommit && <code className={styles.baseOid} title={basePreview.commit ?? undefined}>{t('sessions.worktreeBaseOid', { short: basePreview.shortCommit })}</code>}
                </span>}
                {!baseEditing && <span className={styles.baseAside}>
                  {basePreview?.available && basePreview.remote && <IconButton size="sm" disabled={baseBusy} icon={<Icon name="refresh" size={13} className={baseBusy ? styles.spinning : undefined} />} aria-label={baseBusy ? t('sessions.worktreeBaseUpdating') : t('sessions.worktreeBaseUpdate')} title={t('sessions.worktreeBaseUpdateHint')} onClick={() => void updateBase()} />}
                  <IconButton size="sm" icon={<Icon name="pencil" size={13} />} aria-label={t('sessions.worktreeBaseEdit')} title={t('sessions.worktreeBaseEdit')} onClick={editBase} />
                </span>}
              </div>
              {basePreview?.degraded && <p className={styles.baseHint}>{basePreview.degraded}</p>}
              {baseStale && <p className={styles.baseHint} role="status">{t('sessions.worktreeBaseStale')}</p>}
              {basePreview && !basePreview.available && <p className={styles.baseError} role="alert">{basePreview.reason || t('sessions.worktreeBaseUnavailable')}</p>}
              {baseError && <div className={styles.baseError} role="alert"><span>{baseError}</span><span className={styles.baseActions}><Button size="sm" disabled={baseBusy} onClick={() => void updateBase()}>{t('sessions.worktreeBaseRetry')}</Button>{basePreview && <Button size="sm" onClick={() => { setBaseError(''); setBaseStale(true); }}>{t('sessions.worktreeBaseUseCache')}</Button>}</span></div>}
              {!!basePreview?.candidates.length && <div className={styles.baseCandidates} role="group" aria-label={t('sessions.worktreeBaseCandidates')}>{basePreview.candidates.map((candidate) => <button key={candidate} type="button" className={styles.baseCandidate} aria-pressed={baseChoice?.kind === 'reference' && baseChoice.reference === candidate} onClick={() => { setBaseRef(candidate); setBaseEditing(false); setBaseChoice({ kind: 'reference', reference: candidate }); setBaseError(''); }}>{candidate}</button>)}</div>}
              {/* Branch: what Git will receive. It follows the task text until a name is typed. */}
              <div className={styles.baseRow}>
                <span className={styles.baseLabel}>{t('sessions.worktreeBranchLabel')}</span>
                {branchEditing ? <span className={styles.baseEdit}>
                  <input autoFocus value={branchDraft} placeholder={basePreview?.proposedBranch || t('sessions.worktreeBranchPlaceholder')} aria-label={t('sessions.worktreeBranch')} spellCheck={false} autoComplete="off" onChange={(event) => setBranchDraft(event.target.value)} onBlur={finishBranchEdit} onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); finishBranchEdit(); }
                    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setBranchEditing(false); }
                  }} />
                </span> : <span className={styles.baseValue}>
                  <code className={styles.baseBranch} data-source={branchExplicit ? 'explicit' : 'proposed'} title={branchExplicit ? t('sessions.worktreeBranchExplicitHint') : t('sessions.worktreeBranchProposedHint')}>{branchShown}</code>
                  <small className={styles.baseSource}>{branchExplicit ? t('sessions.worktreeBranchSourceExplicit') : dialogTaskLine ? t('sessions.worktreeBranchSourceTask') : t('sessions.worktreeBranchSourceRepo')}</small>
                </span>}
                {!branchEditing && <span className={styles.baseAside}>
                  {branchExplicit && <IconButton size="sm" icon={<Icon name="refresh" size={13} />} aria-label={t('sessions.worktreeBranchReset')} title={t('sessions.worktreeBranchReset')} onClick={() => setBranchDraft('')} />}
                  <IconButton size="sm" icon={<Icon name="pencil" size={13} />} aria-label={t('sessions.worktreeBranchEdit')} title={t('sessions.worktreeBranchEdit')} onClick={() => { if (!branchDraft.trim() && basePreview?.proposedBranch) setBranchDraft(basePreview.proposedBranch); setBranchEditing(true); }} />
                </span>}
              </div>
              {/* Setup: one optional command for this repository, saved when the session starts. */}
              <div className={styles.baseRow}>
                <label className={styles.baseLabel} htmlFor="worktree-setup-command">{t('sessions.worktreeStepPrepare')}</label>
                <span className={styles.baseEdit} data-prompt="">
                  <input id="worktree-setup-command" value={setupCommand} placeholder={setupLoading ? t('sessions.worktreePrepareLoading') : t('sessions.worktreePreparePlaceholder')} aria-label={t('sessions.worktreePrepare')} title={t('sessions.worktreePrepareHint')} spellCheck={false} autoComplete="off" disabled={setupLoading} onChange={(event) => { setPrepareTarget(repoDirectory); setPrepareCommand(event.target.value); setPrepareJustSaved(false); }} />
                </span>
              </div>
              {prepareError && <p className={styles.baseHint} role="alert">{prepareError}</p>}
            </div>}
          </div>;
        })()}
        <div className={styles.dialogField}><span className={styles.fieldLabel}>{t('sessions.launchModeLabel')}</span><div className={styles.modeCards} role="radiogroup" aria-label={t('sessions.launchModeLabel')}>
          <button type="button" role="radio" aria-checked={launchMode === 'normal'} className={styles.modeCard} onClick={() => setLaunchMode('normal')}><span className={styles.modeCardGlyph} aria-hidden="true"><Icon name="shield" size={16} /></span><span className={styles.modeCardCopy}><strong>{t('sessions.modeNormal')}</strong><small>{t('sessions.modeNormalDesc')}</small></span><span className={styles.modeCardCheck}><Icon name="check" size={12} /></span></button>
          <button type="button" role="radio" aria-checked={launchMode === 'yolo'} disabled={!selectedLaunchTool?.yoloAvailable} title={!selectedLaunchTool?.yoloAvailable ? t('sessions.yoloUnsupported') : undefined} className={styles.modeCard} onClick={() => setLaunchMode('yolo')}><span className={styles.modeCardGlyph} aria-hidden="true"><Icon name="sparkle" size={16} /></span><span className={styles.modeCardCopy}><strong>{t('sessions.modeYolo')}</strong><small>{selectedLaunchTool?.yoloAvailable ? t('sessions.modeYoloDesc') : t('sessions.yoloUnsupported')}</small></span><span className={styles.modeCardCheck}><Icon name="check" size={12} /></span></button>
        </div>{selectedLaunchTool?.resumeLatestAvailable && !activeRemoteTarget && <label className={styles.checkboxRow}><input type="checkbox" checked={resumeLatest} onChange={(event) => setResumeLatest(event.target.checked)} /><span>{t('sessions.resumeLatest')}</span></label>}</div>
        <div className={styles.dialogField}><span className={styles.fieldLabel}>{t('sessions.initialPromptLabel')}</span><textarea rows={3} className={styles.dialogTextarea} value={initialPrompt} placeholder={t('sessions.initialPromptPlaceholder')} aria-label={t('sessions.initialPromptLabel')} onChange={(event) => setInitialPrompt(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing && !launchingNew && effectiveLaunchToolId) { event.preventDefault(); void launchFromDialog(); } }} /><PromptPicker className={styles.dialogPrompts} labelClassName={styles.dialogPromptLabel} prompts={dialogPrompts} onPick={(prompt) => setInitialPrompt(prompt.body)} />{promptFeedback(dialogHostId, dialogIdentity)}</div>
        <div className={styles.dialogSummary}>{effectiveLaunchToolId && <span className={styles.dialogSummaryIcon}><ToolIcon toolId={effectiveLaunchToolId} size={20} /></span>}<span>{(() => {
          const place = workspaceValue.startsWith('project:') ? availableProjects.find((item) => 'project:' + item.id === workspaceValue)?.name ?? t('sessions.workspaceHome') : workspaceValue.startsWith('remote:') ? availableRemoteProjects.find((item) => 'remote:' + item.id === workspaceValue)?.name ?? t('sessions.workspaceHome') : workspaceValue.startsWith('custom:') ? shortPath(displayPath(workspaceValue.slice('custom:'.length))) : workspaceValue.startsWith('rpath:') ? remoteBaseName(workspaceValue.slice('rpath:'.length)) || workspaceValue.slice('rpath:'.length) : t('sessions.workspaceHome');
          const values = { tool: selectedLaunchTool?.name ?? '', place, mode: modeLabel(launchMode) };
          // The summary names the worktree only once its base is confirmed, so it never
          // promises a creation the launch would refuse.
          const inWorktree = !activeRemoteTarget && !resumeLatest && dialogPlace === 'worktree' && !!dialogPrepareDirectory() && !!basePreview?.available && !!basePreview.reference;
          if (!inWorktree) return t('sessions.launchSummary', values);
          const branch = branchDraft.trim() || basePreview.proposedBranch;
          return branch
            ? t('sessions.launchSummaryWorktree', { ...values, branch, base: basePreview.reference })
            : t('sessions.launchSummaryWorktreeNoBranch', { ...values, base: basePreview.reference });
        })()}</span><Icon name="terminal" size={16} /></div>
        <div className={styles.dialogActions}><Button onClick={() => setNewDialogOpen(false)}>{t('common.dialog.cancel')}</Button><Button variant="primary" className={styles.dialogPrimary} data-dialog-save disabled={launchingNew || !effectiveLaunchToolId} onClick={() => void launchFromDialog()} icon={<Icon name="play" size={14} />}>{launchingNew ? t('sessions.startingSession') : t('sessions.startInWorkbench')}</Button></div>
      </div>
    </GuideDialog>
    {worktreeSetupDialog()}
    {remotePicker.element}
    <GuideDialog open={hostManagerOpen} title={t('sessions.manageHosts')} hint={t('settings.remoteSsh.description')} onClose={() => { setHostManagerOpen(false); setReload((value) => value + 1); }}><RemoteSshSettings enabled={remoteSshEnabled} busy={false} onChange={() => {}} showHosts showToggle={false} /></GuideDialog>
  </div>;
}
