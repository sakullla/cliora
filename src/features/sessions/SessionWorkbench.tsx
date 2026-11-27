import { changedWorkspace, repositoryPlaces, WORKSPACES_CHANGED } from '../workspaces/WorkspaceBrowser';
import { FOCUS_REFRESH_INTERVAL } from '../../lib/workspaceEvents';
import { describeReturnedReview } from './TwiglaneReviewResult';
import type { BusinessWorkspace, WorkspaceSelection, WorkspaceSessionContext } from '../../types/workspaces';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import { acp, localSessionPrompt, native, nativeAvailable, onAcpEvent, onLaunchSettingsChange } from '../../lib/native';
import type { WindowChrome } from '../../components/WindowControls';
import { formatFailure } from '../../lib/feedback';
import { displayPath, shortPath } from '../../lib/paths';
import { writeClipboard } from '../../lib/clipboard';
import { uiAdapterFor } from '../../adapters';
import { attachmentPastes } from '../../adapters/attachments';
import { confirmAction } from '../../lib/confirm';
import { modAria, modLabel } from '../../lib/shortcut';
import { FilterSelect, type FilterSelectOption } from '../../components/FilterSelect';
import { GuideDialog } from '../../components/GuideDialog';
import { Icon } from '../../components/Icon';
import { Badge, Button, IconButton } from '../../components/ui';
import rowMenuStyles from '../../components/RowMenu.module.css';
import { ToolIcon, toolOptions } from '../../components/ToolIcon';
import type { LaunchMode, LaunchRequest, LaunchResult, LaunchSettings, Project, SavedWorkbenchSession, TwiglaneFeedbackPreview, TwiglaneReviewSignal, TwiglaneReviewState, WorkbenchCodeStatus, WorkbenchExit, WorkbenchGitContext, WorkbenchWorktree, WorkbenchOutput, WorkbenchRestoreCandidate, WorkbenchRestoreEvent, WorkbenchRestoreStage, WorkbenchSession, WorktreeBase, WorktreeBasePreview, WorktreeLaunchEvent, WorktreeLaunchIntent, WorktreeLaunchStage, WorktreeLedgerEntry, WorktreeMenuStatus } from '../../types/launch';
import { preferredLaunchMode } from '../../types/launch';
import type { PromptContext } from '../../types/prompts';
import { inferWorkspaceScope } from '../../lib/workspaceScope';
import { launchYoloSupport, type AdapterDescriptor } from '../../types/native';
import type { TerminalSemantics } from '../../adapters/contract';
import type { RemoteProject, RemoteTarget } from '../../types/remote';
import { SessionTitle, stableTitle } from './SessionTitle';
import { SessionTerminal, cleanTerminalTitle, encodeBase64, popupOwnsFocus, type OutputChunk, type TerminalBridge, type TerminalHandle, type TerminalMatch } from './SessionTerminal';
import { PendingTerminalOutput } from './pendingOutput';
import { SessionActivityIcon, sessionBadgeTone } from './SessionActivityIcon';
import type { TerminalTheme } from './terminalTheme';
import { TERMINAL_FONT_SIZE_DEFAULT, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN, TERMINAL_LINE_HEIGHT, getTerminalPreferences, setTerminalCursorBlink, setTerminalDensity, setTerminalFontSize, setTerminalScrollSpeed, setTerminalSoundEnabled, setTerminalThemePreference, useTerminalPreferences, type TerminalDensity, type TerminalScrollSpeed, type TerminalThemePreference } from '../../lib/terminalPreferences';
import { commandActivityTone, commandReplacesTask, PlaceLabel, SessionRail, type RailSession, type SessionCommand, type SessionTone } from './SessionRail';
import { remoteSessionMayExist, sessionConfirmedEnded } from './sessionState';
import { reviewEvidenceVerified, taskBucketFor, taskStateFor, taskStateHintKey, taskStateLabelKey, type TaskEvidence, type TaskState } from './sessionTaskState';
import { commandHint, type TerminalCommandState } from './terminalCommandState';
import { placeParts, railPlace, railTaskTitle } from './railTitle';
import { uploadDisplayName, useSessionUploads, type SessionUploadTask } from './sessionUploads';
import uploadStyles from './sessionUploads.module.css';
import { AcpConversation } from './AcpConversation';
import { applyAcpEvent, acpIsLive, acpPendingCount, acpRow, type AcpConversation as AcpConversationState } from './acpSession';
import type { AcpEvent, AcpSessionSnapshot } from '../../types/acp';
import { WorkbenchComposer } from './WorkbenchComposer';
import { PromptPicker } from './PromptPicker';
import { TerminalAppearance } from './TerminalAppearance';
import { WorkbenchEmpty } from './WorkbenchEmpty';
import { WorkbenchShortcuts } from './WorkbenchShortcuts';
import { ensureRemoteProject, lastRemoteDir, missingRemoteProjects, rememberRemoteDir, rememberedRemoteDir, remoteBaseName, remoteStartPath, useRemoteFolderPicker } from '../remote/remoteLaunch';
import { requestWriteRecovery, useWriteRecoveryNeeded } from '../remote/writeReceipts';
import { RemoteSshSettings } from '../settings/GeneralSettings';
import styles from './SessionWorkbench.module.css';

import { isAcpLaunch, workbenchSessionId, type WorkbenchFailure, type RemoteWorkbenchIntent } from './workbenchLaunch';

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
/** A title this short always fits, so the title bar need not reserve room for it to shrink into. */
const SHORT_STAGE_TITLE = 10;
const DEFAULT_RAIL_WIDTH = 272;
const MIN_RAIL_WIDTH = 232;
const MAX_RAIL_WIDTH = 392;
const MAC = /Mac/i.test(navigator.platform || navigator.userAgent);

function readStoredRailWidth(): number {
  try {
    const raw = Number(localStorage.getItem('cliora:workbench-rail-width'));
    if (Number.isFinite(raw) && raw >= MIN_RAIL_WIDTH && raw <= MAX_RAIL_WIDTH) return Math.round(raw);
  } catch { /* Storage is optional. */ }
  return DEFAULT_RAIL_WIDTH;
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

/**
 * The session that takes the selection when `closed` leave the list, the way closing a tab
 * hands focus to its neighbour: the next one in list order, else the previous one. A list
 * filtered down to nothing falls back to the remaining sessions, a running one first.
 */
function selectionAfterClose(current: string | null, closed: ReadonlySet<string>, order: readonly string[], remaining: readonly WorkbenchSession[]): string | null {
  if (current && !closed.has(current)) return current;
  const index = current ? order.indexOf(current) : -1;
  if (index >= 0) {
    for (let next = index + 1; next < order.length; next += 1) if (!closed.has(order[next])) return order[next];
    for (let previous = index - 1; previous >= 0; previous -= 1) if (!closed.has(order[previous])) return order[previous];
  }
  const rest = remaining.filter((item) => !closed.has(item.id));
  return rest.find((item) => item.running)?.id ?? rest[0]?.id ?? null;
}

const LAST_TOOL_KEY = 'cliora:workbench-last-tool';
/** The CLI the last dialog launch used: the next opening starts there instead of the first tool. */
function readLastLaunchTool(): string {
  try { return localStorage.getItem(LAST_TOOL_KEY) ?? ''; } catch { return ''; }
}
function rememberLaunchTool(toolId: string) {
  try { localStorage.setItem(LAST_TOOL_KEY, toolId); } catch { /* The choice still holds for this window. */ }
}

/** Rail display preferences. Only ids and states: never a prompt, a path or a review body. */
type RailArrangement = {
  pinned: string[];
  order: string[];
  /** Sessions moved out of the active list; they keep their process, restore record and state. */
  collapsed: string[];
  /** Rounds the user marked as worth reviewing. A display mark, never a process or Git fact. */
  reviewMarks: string[];
};
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
  return { ...current, pinned: remap(current.pinned), order: remap(current.order), collapsed: remap(current.collapsed), reviewMarks: remap(current.reviewMarks) };
}

/** The session the user last had selected; a restore maps it to its new id. */
function readStoredSelection(targetId = 'local'): string | null {
  try {
    return localStorage.getItem(`cliora:workbench-selected:${encodeURIComponent(targetId)}`)
      ?? (targetId === 'local' ? localStorage.getItem('cliora:workbench-selected') : null);
  } catch { return null; }
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
      const ids = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
      return {
        pinned: raw.pinned.filter((id) => typeof id === 'string'),
        order: raw.order.filter((id) => typeof id === 'string'),
        // An older record has no collapsed or marked ids: nothing was hidden or marked then.
        collapsed: ids((raw as { collapsed?: unknown }).collapsed),
        reviewMarks: ids((raw as { reviewMarks?: unknown }).reviewMarks),
      };
    }
  } catch { /* Storage is optional. */ }
  return { pinned: [], order: [], collapsed: [], reviewMarks: [] };
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

type MenuState = (
  | { kind: 'session'; sessionId: string; x: number; y: number; besideId: string | null }
  | { kind: 'terminal'; sessionId: string; x: number; y: number; hasSelection: boolean; selection: string; surface: boolean }
) & {
  /** The control the menu was opened from, when it had one. Closing the menu gives the
   *  keyboard back to it, the same way a popup returns focus to its trigger. */
  trigger: HTMLElement | null;
};

const MENU_ITEM = '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)';
/** A repository can carry hundreds of worktrees. The menu filters once the list is long, renders a
 *  bounded slice and reads Git status only for the rows it shows; the dialog pages its list. */
const WORKTREE_FILTER_MIN = 8;
const WORKTREE_MENU_LIMIT = 30;
const LEDGER_FILTER_MIN = 6;
const LEDGER_PAGE = 60;

/** Every whitespace-separated term must appear in one of the fields (case-insensitive). */
function matchesQuery(query: string, ...fields: Array<string | null | undefined>): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = fields.filter(Boolean).join('\n').toLowerCase().replace(/\\/g, '/');
  return terms.every((term) => haystack.includes(term.replace(/\\/g, '/')));
}

/** The current checkout first, then the rest in Git's order; filtered, then bounded. */
/** `hits` counts real matches only; the current checkout is kept on top even when it does not match. */
function menuWorktrees(trees: WorkbenchWorktree[], query: string): { shown: WorkbenchWorktree[]; matched: number; hits: number } {
  const ordered = [...trees.filter((tree) => tree.current), ...trees.filter((tree) => !tree.current)];
  const matched = ordered.filter((tree) => tree.current || matchesQuery(query, tree.name, tree.branch, tree.path));
  const hits = matched.filter((tree) => matchesQuery(query, tree.name, tree.branch, tree.path)).length;
  return { shown: matched.slice(0, WORKTREE_MENU_LIMIT), matched: matched.length, hits };
}

/** Last path segment, used to name a repository in the worktree dialog. */
/**
 * A directory label that gives way from the left: the parent folders fold first, then the shared
 * head of the folder name, so the end that tells sibling checkouts apart stays readable.
 */
function PathLabel({ text }: { text: string }) {
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) + 1;
  const name = text.slice(cut);
  if (!cut || !name) return <PlaceLabel text={text} parts={placeParts([text]).get(text)} />;
  return <><span className={styles.pathParent}>{text.slice(0, cut)}</span><span className={styles.pathName}><PlaceLabel text={name} parts={placeParts([name]).get(name)} /></span></>;
}

function folderName(path: string): string {
  const parts = displayPath(path).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
/** 等不到 accepted/rejected 的期限：超过它只能显示"打开结果未知"。 */
const REVIEW_UNKNOWN_MS = 10_000;
/** 协议里的稳定错误码到界面文案。未知码回退到通用说明，不显示后端原始文本。 */
const REVIEW_REASON_KEYS: Record<string, string> = {
  session_unknown: 'sessions.reviewCodeSessionUnknown',
  target_changed: 'sessions.reviewTargetChanged',
  remote_review_restart: 'sessions.reviewRemoteRestart',
  cancelled: 'sessions.reviewCancelled',
  busy: 'sessions.reviewRemoteBusy',
  invalid_baseline: 'sessions.reviewInvalidBaseline',
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

function reviewResultKey(review: TwiglaneReviewState): string {
  return `${review.reviewId}:${review.resultRevision ?? 0}`;
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

export function SessionWorkbench({ active, tools, remoteSshEnabled = false, remoteTargetId = 'local', syncedRemoteTargets = [], onRemoteTargetChange, focusSessionId, focusToken, reviewSignal = null, feedback = null, onFeedbackChange, failure, onFailure, onOpenHome, remoteIntent, railHost = null, railSlim = false, onToggleRailSlim, onRailLayout, onLiveCountChange, railToggleRef, windowChrome = null, captionSlotRef }: {
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
  onLiveCountChange?: (count: number) => void;
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
  /** One received feedback-v1 batch, already validated and staged by native. Preview only. */
  feedback?: TwiglaneFeedbackPreview | null;
  /** Replaces or clears the preview after a send, a cancel or an expiry. */
  onFeedbackChange?: (feedback: TwiglaneFeedbackPreview | null) => void;
  failure: WorkbenchFailure | null;
  onFailure: (failure: WorkbenchFailure | null) => void;
  onOpenHome: () => void;
}) {
  const { t } = useTranslation();
  const writeRecoveryNeeded = useWriteRecoveryNeeded(remoteTargetId);
  const windowVisible = useSyncExternalStore(subscribeVisibility, documentVisible);
  const renderActive = active && windowVisible;
  const [sessions, setSessions] = useState<WorkbenchSession[]>([]);
  /** ACP conversations this window holds. They are not PTY sessions, so they keep
   *  their own ordered snapshot map instead of the listed session rows. */
  const [conversations, setConversations] = useState<Map<string, AcpConversationState>>(() => new Map());
  /** A conversation the user closed: a later list read must not put its row back. */
  const retiredConversations = useRef(new Set<string>());
  const sessionStateUpdates = useRef(new Map<string, WorkbenchSession>());
  /** A restored snapshot can arrive before any list contains it. It survives the list reads
   *  that have not seen it yet; once the native list names that id, the list is authoritative. */
  const pendingRestored = useRef(new Map<string, WorkbenchSession>());
  /** Ids the workbench has listed or restored. Kept in step with every list, so a restore can tell
   *  whether a real session is already on screen without waiting for a render. */
  const liveSessionIds = useRef(new Set<string>());
  // A list read started before a close/restore may still contain a retired id.
  const retiredSessionIds = useRef(new Set<string>());
  function applyListedSessions(listed: WorkbenchSession[]) {
    listed = listed.filter((item) => !retiredSessionIds.current.has(item.id));
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
  /** Registers a native conversation snapshot. A snapshot the window already holds with a
   *  newer sequence is kept: an older read must not undo output that already arrived. */
  function registerConversation(snapshot: AcpSessionSnapshot | null | undefined) {
    if (!snapshot || typeof snapshot.id !== 'string' || retiredConversations.current.has(snapshot.id)) return;
    setConversations((current) => {
      const existing = current.get(snapshot.id);
      if (existing && existing.snapshot.seq > snapshot.seq) return current;
      const next = new Map(current);
      next.set(snapshot.id, { snapshot });
      return next;
    });
  }
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  /** The native conversation of a session id, or null for a terminal session. */
  function conversationOf(id: string): AcpSessionSnapshot | null {
    return conversations.get(id)?.snapshot ?? null;
  }
  const allSessionsRef = useRef(sessions);
  allSessionsRef.current = sessions;
  const [projects, setProjects] = useState<Project[]>([]);
  const [businessWorkspaces, setBusinessWorkspaces] = useState<BusinessWorkspace[]>([]);
  const [businessContexts, setBusinessContexts] = useState<WorkspaceSessionContext[]>([]);
  const [businessSelection, setBusinessSelection] = useState<WorkspaceSelection | null>(null);
  const businessSessionKey = sessions.map(item => item.id).join('|');
  useEffect(() => {
    if (!active || !nativeAvailable) return;
    let live = true;
    let generation = 0;
    const reload = () => {
      const request = ++generation;
      void Promise.allSettled([native.listBusinessWorkspaces(), native.listWorkspaceSessionContexts()]).then(([workspaces, contexts]) => {
        if (!live || request !== generation) return;
        if (workspaces.status === 'fulfilled') setBusinessWorkspaces(Array.isArray(workspaces.value) ? workspaces.value : []);
        // Projects only add choices to the new-session picker and a label to a session; a failed
        // read keeps the previous values instead of interrupting the workbench with a banner.
        if (contexts.status === 'fulfilled') setBusinessContexts(Array.isArray(contexts.value) ? contexts.value : []);
      });
    };
    // A change that carries its project patches that one; anything else lists again.
    const changed = (event: Event) => {
      const workspace = changedWorkspace(event).workspace;
      if (!workspace) { reload(); return; }
      setBusinessWorkspaces(previous => previous.some(item => item.id === workspace.id) ? previous.map(item => item.id === workspace.id ? workspace : item) : previous);
    };
    // Twiglane edits the same shared projects; coming back to the window lists them again.
    let loadedAt = Date.now();
    const focused = () => { if (Date.now() - loadedAt >= FOCUS_REFRESH_INTERVAL) { loadedAt = Date.now(); reload(); } };
    reload(); window.addEventListener(WORKSPACES_CHANGED, changed); window.addEventListener('focus', focused);
    return () => { live = false; generation++; window.removeEventListener(WORKSPACES_CHANGED, changed); window.removeEventListener('focus', focused); };
  }, [active, businessSessionKey]);
  const [remoteProjects, setRemoteProjects] = useState<RemoteProject[]>([]);
  const [loadedRemoteTargets, setLoadedRemoteTargets] = useState<RemoteTarget[] | null>(null);
  const remoteTargets = loadedRemoteTargets ?? syncedRemoteTargets;
  const [activeTargetId, setActiveTargetId] = useState(remoteTargetId);
  const [hostManagerOpen, setHostManagerOpen] = useState(false);
  const [launchSettings, setLaunchSettings] = useState<LaunchSettings | null>(null);
  /** How the next local session talks to its CLI. A stored value that cannot be
   *  recognized reads as the terminal, exactly as the settings row does. */
  const savedInteraction: 'terminal' | 'acp' = launchSettings?.interactionError ? 'terminal' : launchSettings?.interaction === 'acp' ? 'acp' : 'terminal';
  const [selectedId, setSelectedId] = useState<string | null>(focusSessionId);
  const pendingSelectionId = useRef<string | null>(focusSessionId);
  const selectionTarget = useRef(activeTargetId);
  const selectedByTarget = useRef(new Map<string, string>());
  function rememberSelection(targetId: string, id: string) {
    if (selectedByTarget.current.get(targetId) === id) return;
    selectedByTarget.current.delete(targetId);
    selectedByTarget.current.set(targetId, id);
    if (selectedByTarget.current.size > 64) selectedByTarget.current.delete(selectedByTarget.current.keys().next().value!);
    try {
      localStorage.setItem(`cliora:workbench-selected:${encodeURIComponent(targetId)}`, id);
      // Keep the legacy local restore preference; a remote selection must not replace it.
      if (targetId === 'local') localStorage.setItem('cliora:workbench-selected', id);
    } catch { /* Host switching still remembers the selection without storage. */ }
  }
  function remapLocalSelection(restored: Record<string, string>) {
    const previous = selectedByTarget.current.get('local') ?? readStoredSelection();
    if (previous && restored[previous]) rememberSelection('local', restored[previous]);
  }
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
  const terminalPrefs = useTerminalPreferences();
  const { fontSize, soundEnabled, cursorBlink, density, scrollSpeed } = terminalPrefs;
  const themePreference = terminalPrefs.theme;
  const [appTheme, setAppTheme] = useState<TerminalTheme>(currentAppTheme);
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
  const [worktreeQuery, setWorktreeQuery] = useState('');
  const statusRequested = useRef(new Set<string>());
  const [gitReadSeq, setGitReadSeq] = useState(0);
  // 审查状态只在 native 注册表里判定；这里是它的展示副本，按 sessionId 索引。
  const [reviewStates, setReviewStates] = useState<Map<string, TwiglaneReviewState>>(() => new Map());
  const [reviewBusy, setReviewBusy] = useState<string | null>(null);
  /** One feedback batch at a time: sending is a single explicit action, never retried on its own. */
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackError, setFeedbackError] = useState('');
  /** The latest batch, read by restore callbacks that run after the render that started them. */
  const feedbackRef = useRef<TwiglaneFeedbackPreview | null>(feedback);
  useEffect(() => { feedbackRef.current = feedback; }, [feedback]);
  const [reviewError, setReviewError] = useState('');
  const [codeStatuses, setCodeStatuses] = useState<Map<string, WorkbenchCodeStatus>>(() => new Map());
  const [codeStatusUnknown, setCodeStatusUnknown] = useState<Map<string, boolean>>(() => new Map());
  /** Review keys a real Git re-read confirmed: the only input of the "verified" label. */
  const [codeStatusReviews, setCodeStatusReviews] = useState<Map<string, string>>(() => new Map());
  /** Review keys whose status read finished; evidence that a read ran, never that it passed. */
  const [reviewReadKeys, setReviewReadKeys] = useState<Map<string, string>>(() => new Map());
  const [codeReadSeq, setCodeReadSeq] = useState(0);
  const [reviewClock, setReviewClock] = useState(() => Date.now());
  const announcedReviews = useRef(new Set<string>());
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [findCase, setFindCase] = useState(false);
  const terminalMode: TerminalTheme = themePreference === 'auto' ? appTheme : themePreference;

  const [attentionIds, setAttentionIds] = useState<Set<string>>(() => new Set());
  // 每个会话当前屏幕的适配器证据；shared 工作台从不按 CLI ID 解析屏幕。
  const [semanticsById, setSemanticsById] = useState<Map<string, TerminalSemantics | null>>(() => new Map());
  // 终端自己上报的命令阶段与程序进度（OSC 133 / 9;4）。它们描述命令，不参与 AI 任务状态。
  const [commandById, setCommandById] = useState<Map<string, TerminalCommandState | null>>(() => new Map());
  const [collapsedOpen, setCollapsedOpen] = useState(false);
  const [activeOutputIds, setActiveOutputIds] = useState<Set<string>>(() => new Set());
  const [scrolledIds, setScrolledIds] = useState<Set<string>>(() => new Set());
  const [titles, setTitles] = useState<Map<string, string>>(() => new Map());
  const [menu, setMenu] = useState<MenuState | null>(null);
  // A temporary look covers the current terminal. It is not a selection or a split pane.
  const [peekSessionId, setPeekSessionId] = useState<string | null>(null);
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
  const [ledgerQuery, setLedgerQuery] = useState('');
  const [ledgerScope, setLedgerScope] = useState<'repo' | 'all'>('repo');
  const [ledgerLimit, setLedgerLimit] = useState(LEDGER_PAGE);
  const [cleanupError, setCleanupError] = useState('');
  const [cleanupBusy, setCleanupBusy] = useState('');
  const prepareRequest = useRef(0);
  // The per-launch worktree choice; the saved preference only seeds it.
  const [dialogPlace, setDialogPlace] = useState<'direct' | 'worktree'>('direct');
  const dialogPlaceTouched = useRef(false);
  const [baseChoice, setBaseChoice] = useState<WorktreeBase | null>(null);
  const basePreviewContext = useRef('');
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
  const [launchToolId, setLaunchToolId] = useState(readLastLaunchTool);
  const [workspaceValue, setWorkspaceValue] = useState('__home');
  // The last name each workspace value had while it was still offered, so a vanished choice
  // can still be named when the user has to fix it.
  const workspaceLabels = useRef(new Map<string, string>());
  // Each place belongs to one host. The dialog keeps the last place per host, so switching
  // hosts brings back that host's own choice instead of carrying a local project to SSH.
  const workspaceOwner = useRef(activeTargetId);
  const workspaceByTarget = useRef(new Map<string, { value: string; remotePath: string }>());
  const [customFolderPath, setCustomFolderPath] = useState('');
  const [launchMode, setLaunchMode] = useState<LaunchMode>('normal');
  // The dialog's mode follows the saved default until the user picks one for this launch.
  const launchModeTouched = useRef(false);
  const launchModeBasis = useRef<{ target: 'cli' | 'project'; toolId: string }>({ target: 'cli', toolId: '' });
  const [resumeLatest, setResumeLatest] = useState(false);
  // Advanced options start folded on every opening; the drafts they hold are dialog state.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [initialPrompt, setInitialPrompt] = useState('');
  const [launchingNew, setLaunchingNew] = useState(false);
  const newLaunchPending = useRef(false);
  const [dialogError, setDialogError] = useState('');
  const [customRemotePath, setCustomRemotePath] = useState('');
  // Saved folders the selected host reported as gone, keyed by host so a switch never borrows another host's answer.
  const [goneRemote, setGoneRemote] = useState<{ targetId: string; ids: Set<string> } | null>(null);
  const [pruningRemote, setPruningRemote] = useState(false);
  const remotePicker = useRemoteFolderPicker();

  /** The rail rows of this window's conversations. They join the same list as the
   *  terminal sessions, so selection, ordering, splitting and the attention entry treat
   *  both kinds the same way. The ACP host runs on this machine, so remote hosts never
   *  list one. */
  const conversationRows = useMemo<WorkbenchSession[]>(
    () => (activeTargetId !== 'local' ? [] : [...conversations.values()].map((item) => acpRow(item.snapshot))),
    [activeTargetId, conversations],
  );
  const scopedSessions = useMemo(() => {
    if (activeTargetId === 'local') return [...sessions.filter((item) => !item.projectId?.startsWith('remote:')), ...conversationRows];
    const remoteProjectIds = new Set(remoteProjects.filter((item) => item.targetId === activeTargetId).map((item) => `remote:${item.id}`));
    return sessions.filter((item) => !!item.projectId && remoteProjectIds.has(item.projectId));
  }, [activeTargetId, remoteProjects, sessions, conversationRows]);
  useEffect(() => {
    const targetChanged = selectionTarget.current !== activeTargetId;
    selectionTarget.current = activeTargetId;
    if (targetChanged) pendingSelectionId.current = null;
    setSelectedId((current) => {
      if (!targetChanged && current && scopedSessions.some((item) => item.id === current)) {
        if (pendingSelectionId.current === current) pendingSelectionId.current = null;
        return current;
      }
      if (current && pendingSelectionId.current === current) return current;
      const remembered = selectedByTarget.current.get(activeTargetId) ?? readStoredSelection(activeTargetId);
      if (remembered && scopedSessions.some((item) => item.id === remembered)) return remembered;
      return scopedSessions.find((item) => item.running)?.id ?? scopedSessions[0]?.id ?? null;
    });
    setSplit((current) => current && current.every((id) => scopedSessions.some((item) => item.id === id)) ? current : null);
  }, [activeTargetId, scopedSessions]);
  const peekSessionIdRef = useRef(peekSessionId);
  peekSessionIdRef.current = peekSessionId;
  // The looked-at session leaving the list closes the cover. A list error does not,
  // and neither does keeping the original selection. Split replaces the cover.
  useEffect(() => {
    if (!peekSessionId) return;
    if (split || peekSessionId === selectedId || !scopedSessions.some((item) => item.id === peekSessionId)) setPeekSessionId(null);
  }, [peekSessionId, selectedId, scopedSessions, split]);
  useEffect(() => {
    if (!peekSessionId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      closePeek();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [peekSessionId]);

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
  const composerSending = useRef(new Set<string>());
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const node = composerInputRef.current;
    if (node) node.disabled = !!peekSessionId;
  }, [peekSessionId, composerOpen, selectedId]);
  const [copiedState, setCopiedState] = useState<'path' | 'output' | 'selection' | 'empty' | 'branch' | null>(null);
  const copyTimerRef = useRef<number>(0);
  const linkErrorTimer = useRef<number>(0);

  const firstSeenAt = useRef(new Map<string, number>());
  // Running time stops when the process does. A session that was already over when it was first
  // listed has no known end, so it shows no duration instead of the time since it started.
  const seenRunning = useRef(new Set<string>());
  const endedSeenAt = useRef(new Map<string, number>());
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
  /** Forgets every failed row at once; rows still waiting keep their own exit. */
  function forgetFailedRestoreRows() {
    const failed = restoreRowsRef.current.filter((row) => row.stage === 'failed' && !restoringIds.has(row.saved.id));
    void Promise.allSettled(failed.map((row) => native.forgetWorkbenchRestore(row.saved.id).then(() => dropRestoreRow(row.saved.id))))
      .then((results) => {
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (rejected) setActionError(String(rejected.reason?.message ?? rejected.reason));
      });
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
    if (retiredSessionIds.current.has(snapshot.id)) return;
    remapLocalSelection({ [savedId]: snapshot.id });
    if (savedId !== snapshot.id) { forgetSession(savedId); rebindFeedback({ [savedId]: snapshot.id }); }
    if (!firstSeenAt.current.has(snapshot.id)) firstSeenAt.current.set(snapshot.id, snapshot.startedAt ?? Date.now());
    pendingRestored.current.set(snapshot.id, snapshot);
    setSessions((current) => {
      const copy = current.filter((item) => item.id !== savedId || savedId === snapshot.id);
      const index = copy.findIndex((item) => item.id === snapshot.id);
      if (index < 0) return [...copy, snapshot];
      copy[index] = { ...copy[index], ...snapshot };
      return copy;
    });
    dropRestoreRow(savedId);
    setArrangement((current) => remapArrangement(current, { [savedId]: snapshot.id }));
    liveSessionIds.current.add(snapshot.id);
    setSelectedId((current) => current === savedId ? snapshot.id : current);
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
    remapLocalSelection(report.restored);
    // 恢复后的会话是新 id：这批意见跟着新会话继续显示，是否再发仍要用户确认。
    rebindFeedback(report.restored);
    // Reports also replace old tabs when the progress event was not delivered.
    const replaced = new Set(Object.keys(report.restored).filter((id) => id !== report.restored[id]));
    for (const id of replaced) forgetSession(id);
    setSessions((current) => current.filter((item) => !replaced.has(item.id)));
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
  /**
   * Conversations live in the shared native host, not in this component. The list read
   * hydrates what is already running (another window, a previous mount) and the ordered
   * event stream keeps it current. Events are folded by sequence, so a remount, a
   * split or a switch never replays a reply into the wrong conversation.
   */
  useEffect(() => {
    if (!active || !nativeAvailable) return;
    let alive = true;
    let stop: (() => void) | undefined;
    void acp.list().then((listed) => {
      if (!alive || !Array.isArray(listed)) return;
      for (const snapshot of listed) registerConversation(snapshot);
    }).catch(() => { /* A missing list read leaves the event stream as the only source. */ });
    void onAcpEvent((event: AcpEvent) => {
      if (!alive || !event || typeof event.sessionId !== 'string') return;
      if (retiredConversations.current.has(event.sessionId)) return;
      const known = conversationsRef.current.has(event.sessionId);
      setConversations((current) => {
        const updated = applyAcpEvent(current.get(event.sessionId), event);
        if (!updated || updated === current.get(event.sessionId)) return current;
        const next = new Map(current);
        next.set(event.sessionId, updated);
        return next;
      });
      // A conversation this window has not seen yet (another window started it): read the
      // full snapshot rather than rendering a fragment of its event stream.
      if (!known) void acp.session(event.sessionId).then(registerConversation).catch(() => {});
    }).then((unlisten) => { if (alive) stop = unlisten; else unlisten(); }).catch(() => {});
    return () => { alive = false; stop?.(); };
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
        // A restored conversation is not a PTY session: it publishes its own snapshot.
        else if (payload.acpSession && typeof payload.acpSession.id === 'string') {
          registerConversation(payload.acpSession);
          remapLocalSelection({ [payload.savedSessionId]: payload.acpSession.id });
          dropRestoreRow(payload.savedSessionId);
        }
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
    // On a host-change render selectedId can still name the previous host.
    // An empty/loading scope must not overwrite that host's remembered choice.
    if (!selectedId || restoring || !scopedSessions.some(item => item.id === selectedId)) return;
    rememberSelection(activeTargetId, selectedId);
  }, [activeTargetId, selectedId, scopedSessions, restoring]);
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
  // and most recently selected terminal bounds WebView memory. Re-selecting remounts from replay.
  const MOUNTED_ENDED_LIMIT = 1;
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
      const captionReserve = windowChrome === 'windows' ? 146 : windowChrome === 'linux' ? 120 : 0;
      const barWidth = Math.max(0, stageWidth - captionReserve);
      setNarrowFrame((current) => current === width <= 720 ? current : width <= 720);
      setCompactFrame((current) => current === width <= 620 ? current : width <= 620);
      // The header lives in the stage column, so its room depends on the usable stage bar width
      // after subtracting desktop caption buttons, not the outer window width.
      setTightFrame((current) => current === barWidth <= 760 ? current : barWidth <= 760);
      setSplitRoom((current) => current === width >= 860 ? current : width >= 860);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    if (stageRef.current) observer.observe(stageRef.current);
    if (sidebar) observer.observe(sidebar);
    return () => observer.disconnect();
  }, [railHost, windowChrome]);

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
  /**
   * The selected tool's own ACP declaration, read from the adapter catalog instead of
   * assumed from the global start mode: a tool without a declared entry cannot hold a
   * conversation, and "declared" is not the same evidence as "verified".
   */
  const launchAcp = useMemo(() => {
    const capability = selectedLaunchTool?.acp ?? null;
    const state = capability?.state ?? 'unsupported';
    return {
      capability,
      state,
      usable: state !== 'unsupported',
      reason: capability?.reason?.trim() ?? '',
    };
  }, [selectedLaunchTool]);
  /** The saved start mode is a conversation this tool cannot open; the dialog says so
   *  and offers the terminal instead of sending a launch the host would refuse. */
  const acpUnavailable = savedInteraction === 'acp' && !launchAcp.usable;
  /** YOLO for this launch: a conversation reads the ACP entry's own YOLO declaration
   *  (every registered entry approves on the client side), a terminal the adapter's
   *  YOLO arguments. */
  const dialogYolo = useMemo(() => launchYoloSupport(selectedLaunchTool, savedInteraction), [selectedLaunchTool, savedInteraction]);
  const selected = scopedSessions.find((item) => item.id === selectedId) ?? null;
  // Refresh the cheap branch hint while visible; enumerate checkouts only in the open menu.
  // A newly created worktree is read on each opening and while that menu remains visible.
  const gitTarget = active && selected && !selected.projectId?.startsWith('remote:') ? selected.id : null;
  const worktreeAnchor = gitTarget && selected
    ? selected.directory || projects.find((item) => item.id === selected.projectId)?.path || null
    : null;
  const reviewTarget = active && selected ? selected.id : null;
  const selectedReview = reviewTarget ? reviewStates.get(reviewTarget) : null;
  const returnedReviewId = selectedReview?.status === 'returned' ? reviewResultKey(selectedReview) : null;
  const codeStatusNeeded = worktreeMenuOpen || (!!gitTarget && !!returnedReviewId);
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
    setReviewReadKeys(retain);
    setReviewStates(retain);
  }, [sessions]);
  useEffect(() => {
    const reviews = new Set([...reviewStates.values()].map(reviewResultKey));
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
    if (!nativeAvailable || !reviewTarget || !codeStatusNeeded) return;
    let alive = true;
    // A read settling is not a review passing: only a ready state records the review key.
    const markReadSettled = () => {
      if (!returnedReviewId) return;
      setReviewReadKeys((current) => {
        if (current.get(reviewTarget) === returnedReviewId) return current;
        const map = new Map(current);
        map.set(reviewTarget, returnedReviewId);
        return map;
      });
    };
    // The verified key is written only after workbench_code_status answered state=ready.
    const markReviewVerified = () => {
      if (!returnedReviewId) return;
      setCodeStatusReviews((current) => {
        if (current.get(reviewTarget) === returnedReviewId) return current;
        const map = new Map(current);
        map.set(reviewTarget, returnedReviewId);
        return map;
      });
    };
    const read = async () => {
      await codeReadPending.current;
      if (!alive) return;
      const pending = native.workbenchCodeStatus(reviewTarget).then((value) => {
        if (!alive || !value || value.sessionId !== reviewTarget || (value.state !== 'ready' && value.state !== 'unknown')) return;
        setCodeStatuses((current) => { const map = new Map(current); map.set(reviewTarget, value); return map; });
        if (value.state === 'ready') {
          setCodeStatusUnknown((current) => { if (!current.get(reviewTarget)) return current; const map = new Map(current); map.delete(reviewTarget); return map; });
          markReviewVerified();
        } else {
          // An unknown state leaves the review unverified and the retry available.
          setCodeStatusUnknown((current) => { if (current.get(reviewTarget)) return current; const map = new Map(current); map.set(reviewTarget, true); return map; });
        }
        markReadSettled();
      }).catch(() => {
        if (!alive) return;
        // A failed read is unknown, never a confirmed review or "no changes".
        setCodeStatusUnknown((current) => { if (current.get(reviewTarget)) return current; const map = new Map(current); map.set(reviewTarget, true); return map; });
        markReadSettled();
      });
      codeReadPending.current = pending;
      await pending;
      if (codeReadPending.current === pending) codeReadPending.current = null;
    };
    void read();
    return () => { alive = false; };
  }, [reviewTarget, worktreeAnchor, codeStatusNeeded, returnedReviewId, codeReadSeq, nativeAvailable, focusToken, reviewSignal?.token]);
  // A fresh menu (or repository, list or retry) starts from nothing known: an unread status
  // must never render as "0 changes". The filter alone keeps what was already read.
  useEffect(() => {
    setWorktreeStatuses(new Map());
    statusRequested.current = new Set();
    if (!worktreeMenuOpen) setWorktreeQuery('');
  }, [worktreeMenuOpen, worktreeAnchor, gitWorktrees, worktreeStatusSeq]);
  const shownWorktreeKey = worktreeMenuOpen && worktreeAnchor && worktreeAnchor === gitWorktrees?.anchor
    ? menuWorktrees(gitWorktrees.trees, worktreeQuery).shown.map((tree) => tree.path).join('\n') : '';
  // Status is read only for the checkouts the open menu shows, in small batches, so a repository
  // with hundreds of worktrees costs a screenful of reads. Closing the menu or switching
  // repository drops every late answer.
  useEffect(() => {
    if (!nativeAvailable || !shownWorktreeKey) return;
    let alive = true;
    const paths = shownWorktreeKey.split('\n').filter((path) => !statusRequested.current.has(path));
    if (!paths.length) return;
    const done = new Set<string>();
    for (const path of paths) statusRequested.current.add(path);
    const readOne = async (path: string) => {
      try {
        const value = await native.worktreeStatus(path);
        if (!alive) return;
        done.add(path);
        const usable = !!value && typeof value === 'object' && (value.state === 'ready' || value.state === 'unknown');
        setWorktreeStatuses((current) => {
          const map = new Map(current);
          map.set(path, usable ? { status: value, error: '' } : { status: null, error: t('sessions.worktreeStatusFailed') });
          return map;
        });
      } catch (error) {
        if (!alive) return;
        done.add(path);
        setWorktreeStatuses((current) => {
          const map = new Map(current);
          map.set(path, { status: null, error: formatFailure(error, t('sessions.worktreeStatusFailed'), '') });
          return map;
        });
      }
    };
    void (async () => {
      for (let index = 0; index < paths.length && alive; index += 3) {
        await Promise.all(paths.slice(index, index + 3).map(readOne));
      }
    })();
    // Reads cut short by a new filter are asked again if their rows are still shown.
    const requested = statusRequested.current;
    return () => { alive = false; for (const path of paths) if (!done.has(path)) requested.delete(path); };
  }, [shownWorktreeKey, worktreeMenuOpen, worktreeAnchor, gitWorktrees, nativeAvailable, worktreeStatusSeq, t]);
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
    if (!nativeAvailable || !reviewTarget) return;
    let alive = true;
    void native.twiglaneReviewState(reviewTarget).then((value) => {
      if (!alive || !value || typeof value.reviewId !== 'string' || value.sessionId !== reviewTarget) return;
      setReviewStates((current) => { const map = new Map(current); map.set(value.sessionId, value); return map; });
      setReviewClock(Date.now());
    }).catch(() => {});
    return () => { alive = false; };
  }, [reviewTarget, nativeAvailable, reviewSignal?.token, gitReadSeq, focusToken, focusSessionId]);
  // 10 秒内没有 accepted/rejected 就是"打开结果未知"：系统接受 URL 不等于 Twiglane 已打开。
  useEffect(() => {
    if (!reviewTarget) return;
    const review = reviewStates.get(reviewTarget);
    if (!review || review.status !== 'opening') return;
    const left = review.createdAt + REVIEW_UNKNOWN_MS - Date.now();
    if (left <= 0) return;
    const timer = window.setTimeout(() => setReviewClock(Date.now()), left + 20);
    return () => window.clearTimeout(timer);
  }, [reviewTarget, reviewStates, reviewClock]);
  // 返回结果只在一次新的 returned 到达时说一次；状态还没读到时先不宣布，避免把
  // 待复核声明当成成功。
  useEffect(() => {
    if (!reviewTarget) return;
    const review = reviewStates.get(reviewTarget);
    if (!review || review.status !== 'returned' || announcedReviews.current.has(reviewResultKey(review))) return;
    if (review.protocolVersion === 1) {
      if (!review.remoteCheck) return;
      announcedReviews.current.add(reviewResultKey(review));
      setNotice(describeReview(review, review.remoteCheck, false).text);
      return;
    }
    // The notice may report an unconfirmed result, so a settled read is enough here;
    // the verified label itself is still written only by a ready state.
    if (reviewReadKeys.get(reviewTarget) !== reviewResultKey(review)) return;
    const status = codeStatuses.get(reviewTarget) ?? null;
    const unknownStatus = !!codeStatusUnknown.get(reviewTarget);
    if (!status && !unknownStatus) return;
    announcedReviews.current.add(reviewResultKey(review));
    setNotice(describeReview(review, status, unknownStatus).text);
  }, [reviewTarget, reviewStates, codeStatuses, codeStatusUnknown, reviewReadKeys]);
  function sessionPromptContext(session: WorkbenchSession): PromptContext | null {
    const host = libraryHostId(session.projectId, remoteProjects);
    if (!host) return null;
    // The binding saved at launch wins while its project still has that repository. A session continued
    // from 记录 or restored by an older build has none, so a local one falls back to its directory.
    const saved = businessContexts.find(item => item.sessionId === session.id);
    const valid = saved && businessWorkspaces.some(workspace => workspace.id === saved.workspaceId && workspace.repositories.some(repository => repository.id === saved.repositoryId)) ? saved : null;
    // Until the project list has loaded, a saved binding is kept as-is rather than judged stale.
    const scope = valid ?? (host === 'local' ? inferWorkspaceScope(session, businessWorkspaces) : null) ?? (businessWorkspaces.length ? null : saved);
    return { targetId: host === 'local' ? null : host, workspaceId: scope?.workspaceId ?? null, repositoryId: scope?.repositoryId ?? null };
  }
  const dialogPromptContext: PromptContext = {
    targetId: activeTargetId === 'local' ? null : activeTargetId,
    workspaceId: activeTargetId === 'local' ? businessSelection?.workspaceId ?? null : null,
    repositoryId: activeTargetId === 'local' ? businessSelection?.repositoryId ?? null : null,
  };
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

  const updateFontSize = useCallback((nextSize: number) => setTerminalFontSize(nextSize), []);

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
    semantics: (id, value) => {
      setSemanticsById((current) => {
        if (current.has(id) && current.get(id) === value) return current;
        const next = new Map(current);
        if (value) next.set(id, value); else next.delete(id);
        return next;
      });
    },
    command: (id, value) => {
      setCommandById((current) => {
        if (current.has(id) && current.get(id) === value) return current;
        const next = new Map(current);
        if (value) next.set(id, value); else next.delete(id);
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
      else if (action === 'zoomReset') updateFontSize(TERMINAL_FONT_SIZE_DEFAULT);
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
        // Only the scoped selection effect may choose a fallback. The global
        // list can arrive before remote projects and must not pick another host.
        return null;
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
    // The Settings modal edits launch preferences while the workbench stays mounted.
    const offLaunchSettings = onLaunchSettingsChange((settings) => {
      if (alive && settings) setLaunchSettings(settings);
    });
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
    return () => { alive = false; offLaunchSettings(); };
  }, [active, focusToken, focusSessionId, reload, remoteSshEnabled, t]);

  useEffect(() => {
    // The dialog keeps only a YOLO choice this launch can express: a conversation's entry
    // must declare a YOLO form, a terminal launch needs the adapter's YOLO arguments.
    if (!dialogYolo.available && launchMode === 'yolo') setLaunchMode('normal');
    if (!selectedLaunchTool?.resumeLatestAvailable && resumeLatest) setResumeLatest(false);
    if (savedInteraction === 'acp' && resumeLatest) setResumeLatest(false);
  }, [selectedLaunchTool, launchMode, resumeLatest, savedInteraction, dialogYolo]);

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
    setPeekSessionId(null);
    setSplit([current, partner]);
  }

  function closePane(id: string) {
    const other = split?.find((item) => item !== id) ?? null;
    setSplit(null);
    if (other && selectedIdRef.current === id) setSelectedId(other);
  }

  const updateDensity = useCallback((next: TerminalDensity) => setTerminalDensity(next), []);
  const updateScrollSpeed = useCallback((next: TerminalScrollSpeed) => setTerminalScrollSpeed(next), []);

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
    const next = !getTerminalPreferences().soundEnabled;
    setTerminalSoundEnabled(next);
    if (next) playWorkbenchChime('bell');
  }, []);

  const toggleCursorBlink = useCallback(() => {
    setTerminalCursorBlink(!getTerminalPreferences().cursorBlink);
  }, []);

  const setTerminalTheme = useCallback((next: TerminalThemePreference) => setTerminalThemePreference(next), []);

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
    // Sessions are named by where they run; business projects are a management grouping only.
    const project = session.projectId ? projects.find((item) => item.id === session.projectId) : undefined;
    if (project?.name) return project.name;
    if (session.directory) return shortPath(displayPath(session.directory));
    return t('sessions.placeUnknown');
  }

  function toolName(session: WorkbenchSession): string {
    return tools.find((item) => item.id === session.toolId)?.name ?? session.toolId;
  }

  function cliTitle(session: WorkbenchSession): string {
    const project = session.projectId ? projects.find((item) => item.id === session.projectId) : undefined;
    // A CLI in a linked worktree may append the repository's name instead of the checkout folder.
    const git = gitContexts.get(session.id);
    return railTaskTitle(titles.get(session.id) ?? '', toolName(session), [project?.name ?? '', session.directory ?? '', git?.repository ?? '', git?.worktree ?? '']);
  }

  /** What a remote session reads as without its id: the CLI title, else its project or directory. */
  function remoteBaseTitle(session: WorkbenchSession): string {
    const remoteProject = remoteProjects.find((item) => `remote:${item.id}` === session.projectId);
    return cliTitle(session) || remoteProject?.name || shortPath(displayPath(session.directory)) || toolName(session);
  }

  function elapsedOf(session: WorkbenchSession): string {
    const startedAt = session.startedAt ?? firstSeenAt.current.get(session.id);
    if (session.running) {
      seenRunning.current.add(session.id);
      endedSeenAt.current.delete(session.id);
      return formatDuration(startedAt, clock);
    }
    if (!seenRunning.current.has(session.id)) return '';
    if (!endedSeenAt.current.has(session.id)) endedSeenAt.current.set(session.id, Date.now());
    return formatDuration(startedAt, endedSeenAt.current.get(session.id) ?? clock);
  }

  function taskTitle(session: WorkbenchSession): string {
    const title = cliTitle(session);
    if (!session.projectId?.startsWith('remote:')) return title;
    // The id suffix only tells apart remote sessions that would otherwise read the same. A lone
    // session without a CLI title reads like a local one: the tool as its name, the project below.
    const base = remoteBaseTitle(session);
    const twin = sessions.some((other) => other.id !== session.id && !!other.projectId?.startsWith('remote:') && other.toolId === session.toolId && remoteBaseTitle(other) === base);
    return twin ? `${base} · ${(session.remoteSessionId || session.id).slice(-8)}` : title;
  }

  function railPlaceOf(session: WorkbenchSession): string {
    const project = session.projectId ? projects.find((item) => item.id === session.projectId) : undefined;
    return railPlace(project?.name, session.directory) || placeOf(session);
  }

  function modeLabel(mode: LaunchMode): string {
    return mode === 'yolo' ? t('sessions.modeYolo') : t('sessions.modeNormal');
  }

  function sessionTone(session: WorkbenchSession): SessionTone {
    const conversation = conversationOf(session.id);
    if (conversation) {
      if (conversation.state === 'failed') return 'error';
      if (conversation.state === 'waiting_permission') return 'bell';
      if (conversation.state === 'running' || conversation.state === 'starting' || conversation.state === 'stopping') return 'live';
      return acpIsLive(conversation) ? 'idle' : 'ended';
    }
    if (!session.running && remoteSessionMayExist(session)) return 'ended';
    if (!session.running) return session.exitCode != null && session.exitCode !== 0 ? 'error' : 'ended';
    if (attentionIds.has(session.id)) return 'bell';
    if (activeOutputIds.has(session.id)) return 'live';
    return 'idle';
  }

  /**
   * Everything the shared task state may consult for one session. The terminal's own adapter
   * publishes the screen evidence; this function only assembles facts it did not invent.
   */
  function taskEvidenceOf(session: WorkbenchSession): TaskEvidence {
    // A conversation's evidence is its own protocol state: a pending request is the
    // only thing that asks for a person, and only a running turn is work.
    const conversation = conversationOf(session.id);
    if (conversation) {
      return {
        running: acpIsLive(conversation),
        exitCode: null,
        remoteUnconfirmed: false,
        attention: acpPendingCount(conversation) > 0 ? 'approval' : null,
        bell: false,
        outputActive: conversation.state === 'running',
        resting: conversation.state === 'ready',
        marked: arrangement.reviewMarks.includes(session.id),
        verified: false,
        unread: unreadIds.has(session.id),
      };
    }
    const semantics = semanticsById.get(session.id) ?? null;
    const review = reviewStates.get(session.id) ?? null;
    return {
      running: session.running,
      exitCode: session.exitCode,
      // A remote transport that may still hold the session says nothing about the CLI task.
      remoteUnconfirmed: !session.running && remoteSessionMayExist(session),
      attention: semantics?.attention ?? null,
      bell: attentionIds.has(session.id),
      outputActive: activeOutputIds.has(session.id),
      resting: semantics?.inputReady === true,
      marked: arrangement.reviewMarks.includes(session.id),
      // A returned result counts only after a real Git re-read recorded its own key.
      verified: !!review && review.status === 'returned' && reviewEvidenceVerified(reviewResultKey(review), codeStatusReviews.get(session.id)),
      unread: unreadIds.has(session.id),
    };
  }
  function taskStateOf(session: WorkbenchSession): TaskState {
    return taskStateFor(taskEvidenceOf(session));
  }
  function taskLabelOf(session: WorkbenchSession): string {
    const evidence = taskEvidenceOf(session);
    return t(taskStateLabelKey(taskStateFor(evidence), evidence));
  }
  function taskHintOf(session: WorkbenchSession): string | null {
    const evidence = taskEvidenceOf(session);
    const key = taskStateHintKey(taskStateFor(evidence), evidence);
    return key ? t(key) : null;
  }
  /**
   * What the terminal's own program reported, worded for the rail, the stage title and assistive
   * tech. It stays outside `taskStateFor`: a command exit, a full bar or a progress error never
   * makes the AI task look delivered, crashed or waiting for approval.
   */
  function commandOf(session: WorkbenchSession): SessionCommand | null {
    const state = commandById.get(session.id);
    if (!state) return null;
    // An ended session keeps its last result but has no live program: no bar survives its process.
    // A remote transport that may still hold the session reports the connection, not a progress bar.
    if (!session.running && remoteSessionMayExist(session)) return null;
    const hint = commandHint(session.running ? state : { ...state, progress: null });
    return hint ? { tone: hint.tone, label: t(hint.key, hint.params), activityTone: commandActivityTone(hint.tone) } : null;
  }

  /** 收起只是列表动作：不调用 close、不清恢复记录、不停止本地或远程进程。 */
  function toggleCollapseSession(id: string) {
    setArrangement((current) => ({
      ...current,
      collapsed: current.collapsed.includes(id) ? current.collapsed.filter((item) => item !== id) : [...current.collapsed, id],
    }));
  }

  /** 显式待审阅标记只改变任务展示，不改写进程、Git 或审阅结果。 */
  function toggleReviewMark(id: string) {
    setArrangement((current) => ({
      ...current,
      reviewMarks: current.reviewMarks.includes(id) ? current.reviewMarks.filter((item) => item !== id) : [...current.reviewMarks, id],
    }));
  }

  function forgetSession(id: string) {
    retiredSessionIds.current.add(id);
    pendingRestored.current.delete(id);
    liveSessionIds.current.delete(id);
    sessionStateUpdates.current.delete(id);
    firstSeenAt.current.delete(id);
    seenRunning.current.delete(id);
    endedSeenAt.current.delete(id);
    setTitles((current) => { if (!current.has(id)) return current; const next = new Map(current); next.delete(id); return next; });
    setActiveOutputIds((current) => { if (!current.has(id)) return current; const next = new Set(current); next.delete(id); return next; });
    setScrolledIds((current) => { if (!current.has(id)) return current; const next = new Set(current); next.delete(id); return next; });
    setAttentionIds((current) => { if (!current.has(id)) return current; const next = new Set(current); next.delete(id); return next; });
    setSemanticsById((current) => { if (!current.has(id)) return current; const next = new Map(current); next.delete(id); return next; });
    setArrangement((current) => (current.collapsed.includes(id) || current.reviewMarks.includes(id))
      ? { ...current, collapsed: current.collapsed.filter((item) => item !== id), reviewMarks: current.reviewMarks.filter((item) => item !== id) }
      : current);
    setUnreadIds((current) => toggleInSet(current, id, false));
    setGitContexts((current) => { if (!current.has(id)) return current; const next = new Map(current); next.delete(id); return next; });
    setReviewStates((current) => { if (!current.has(id)) return current; const next = new Map(current); next.delete(id); return next; });
    setCodeStatuses((current) => { if (!current.has(id)) return current; const next = new Map(current); next.delete(id); return next; });
    setCodeStatusUnknown((current) => { if (!current.has(id)) return current; const next = new Map(current); next.delete(id); return next; });
    setCodeStatusReviews((current) => { if (!current.has(id)) return current; const next = new Map(current); next.delete(id); return next; });
    setReviewReadKeys((current) => { if (!current.has(id)) return current; const next = new Map(current); next.delete(id); return next; });
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
    // A conversation ends by closing its host session, not by a terminal close or a kill.
    if (conversationOf(session.id)) {
      const accepted = session.running
        ? await confirmAction(
          t('sessions.endConfirmMessage', { tool: toolName(session), place: placeOf(session) }),
          () => sessionsRef.current.some((item) => item.id === session.id),
          { title: t('sessions.endConfirmTitle'), confirmLabel: t('sessions.endConfirmAction'), destructive: true },
        )
        : true;
      if (!accepted) return;
      await closeConversation(session);
      return;
    }
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
    // The list order is read now: closing hands the selection to the row the user saw beside it.
    const order = arrangedSessions.map((item) => item.id);
    try {
      await native.closeWorkbenchSession(session.id);
      forgetSession(session.id);
      const closed = new Set([session.id]);
      const rest = sessionsRef.current.filter((item) => item.id !== session.id);
      setSessions((current) => current.filter((item) => item.id !== session.id));
      setSelectedId((current) => selectionAfterClose(current, closed, order, rest));
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
    const all = scopedSessions.filter(sessionConfirmedEnded);
    const ended = all.filter((session) => !conversationOf(session.id));
    const endedConversations = all.filter((session) => !!conversationOf(session.id));
    if (!all.length || busy) return;
    if (!ended.length) {
      // Only conversations are left: each is closed on its own host session.
      setBusy('__clear_ended');
      try {
        for (const session of endedConversations) await closeConversationNow(session.id).catch((value) => { setActionError(formatFailure(value, t('sessions.closeFailed'), t('sessions.closeNext'))); });
      } finally { setBusy(''); }
      return;
    }
    setBusy('__clear_ended');
    setActionError('');
    const order = arrangedSessions.map((item) => item.id);
    const closedIds = new Set<string>();
    try {
      for (const session of ended) {
        await native.closeWorkbenchSession(session.id);
        closedIds.add(session.id);
        forgetSession(session.id);
      }
    } catch (value) {
      setActionError(formatFailure(value, t('sessions.closeFailed'), t('sessions.closeNext')));
    } finally {
      // A failure part-way keeps the sessions it could not close; the ones already closed
      // natively must still leave the list instead of lingering as dead rows.
      if (closedIds.size) {
        const rest = scopedSessions.filter((item) => !closedIds.has(item.id));
        setSessions((current) => current.filter((item) => !closedIds.has(item.id)));
        setSelectedId((current) => selectionAfterClose(current, closedIds, order, rest));
      }
      // Ended conversations share the same action; each is closed on its own host session.
      for (const session of endedConversations) {
        await closeConversationNow(session.id).catch((value) => { setActionError(formatFailure(value, t('sessions.closeFailed'), t('sessions.closeNext'))); });
      }
      setBusy('');
    }
  }

  async function retry() {
    if (!failure || retrying) return;
    setRetrying(true);
    setNotice('');
    setActionError('');
    try {
      const result = failure.retry.kind === 'launch' ? await native.launchCli(failure.retry.request) : await native.resumeHistorySession(failure.retry.id, failure.retry.mode);
      if (result.warnings?.length) setNotice(result.warnings.join('\n'));
      const opened = await adoptLaunchResult(result);
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

  /** Projects, remote projects and business repositories use the project default; anything else the CLI default. */
  function dialogModeTarget(value: string): 'cli' | 'project' {
    return value.startsWith('project:') || value.startsWith('remote:') || businessRepositoryOptions.some((option) => option.value === value) ? 'project' : 'cli';
  }
  function applyPreferredMode(settings: LaunchSettings | null, target: 'cli' | 'project', toolId: string) {
    launchModeBasis.current = { target, toolId };
    const tool = terminalTools.find((item) => item.id === toolId);
    const interaction = settings?.interactionError ? 'terminal' : settings?.interaction === 'acp' ? 'acp' : 'terminal';
    setLaunchMode(preferredLaunchMode(settings, target, launchYoloSupport(tool, interaction).available));
  }

  /**
   * Make the dialog's place belong to `targetId`: the current place is kept for its own host
   * and the place last used on `targetId` comes back (that host's home the first time).
   * A remembered place that has since disappeared is still named, never replaced.
   */
  function adoptWorkspaceTarget(targetId: string): string {
    const owner = workspaceOwner.current;
    if (owner === targetId) return workspaceValue;
    workspaceByTarget.current.set(owner, { value: workspaceValue, remotePath: customRemotePath });
    const saved = workspaceByTarget.current.get(targetId);
    workspaceOwner.current = targetId;
    const value = saved?.value ?? '__home';
    setWorkspaceValue(value);
    setCustomRemotePath(saved?.remotePath ?? '');
    return value;
  }

  function openNewSessionDialog(prefill?: { toolId?: string; projectId?: string; remoteProjectId?: string; directory?: string; place?: 'worktree' }, targetOverride?: string) {
    setDialogError('');
    const dialogTarget = targetOverride || activeTargetId;
    const inheritedValue = adoptWorkspaceTarget(dialogTarget);
    // A repository chosen last time keeps its project scope (prompts, worktree base).
    setBusinessSelection(dialogTarget === 'local' ? businessRepositoryOptions.find((option) => option.value === inheritedValue)?.selection ?? null : null);
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
      if (!launchModeTouched.current) applyPreferredMode(settings, launchModeBasis.current.target, launchModeBasis.current.toolId);
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
      const repoOption = project?.workspaceBacked ? businessRepositoryOptions.find((option) => !option.worktree && option.selection.projectId === prefill.projectId) : undefined;
      if (repoOption) {
        setWorkspaceValue(repoOption.value);
        setBusinessSelection(repoOption.selection);
        setDialogPlace('direct');
        dialogPlaceTouched.current = true;
      } else {
        setWorkspaceValue('project:' + prefill.projectId);
      }
      if (project?.preferredTool && terminalTools.some((item) => item.id === project.preferredTool)) nextToolId = project.preferredTool;
    } else if (prefill?.remoteProjectId) {
      const project = remoteProjects.find((item) => item.id === prefill.remoteProjectId);
      setWorkspaceValue('remote:' + prefill.remoteProjectId);
      if (project?.preferredTool && terminalTools.some((item) => item.id === project.preferredTool)) nextToolId = project.preferredTool;
    } else if (prefill?.directory) {
      setCustomFolderPath(prefill.directory);
      setWorkspaceValue('custom:' + prefill.directory);
    }
    if (prefill?.toolId && terminalTools.some((item) => item.id === prefill.toolId)) nextToolId = prefill.toolId;
    if (prefill) setLaunchToolId(nextToolId);
    // Each opening starts from the saved default mode, not the previous dialog's choice.
    launchModeTouched.current = false;
    applyPreferredMode(launchSettings, prefill ? (prefill.projectId || prefill.remoteProjectId ? 'project' : 'cli') : dialogModeTarget(inheritedValue), nextToolId);
    setAdvancedOpen(false);
    setNewDialogOpen(true);
  }

  /** Forget saved folders the host says are gone; folders an open session still names are kept. */
  async function pruneGoneRemoteFolders(ids: string[]) {
    const used = new Set(allSessionsRef.current.map((session) => session.projectId));
    const removable = ids.filter((id) => !used.has(`remote:${id}`));
    if (!removable.length || pruningRemote) return;
    setPruningRemote(true);
    setDialogError('');
    const results = await Promise.allSettled(removable.map((id) => native.deleteRemoteProject(id)));
    const removed = new Set(removable.filter((_, index) => results[index].status === 'fulfilled'));
    setRemoteProjects((current) => current.filter((item) => !removed.has(item.id)));
    if (removed.has(workspaceValue.slice('remote:'.length)) && workspaceValue.startsWith('remote:')) setWorkspaceValue('__home');
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) setDialogError(formatFailure(failed.reason, t('sessions.remoteGonePruneFailed'), t('sessions.failureHint')));
    setPruningRemote(false);
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
      const opened = await adoptLaunchResult(result);
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
        setBusinessSelection(null);
        setCustomFolderPath(clean);
        setWorkspaceValue(`custom:${clean}`);
        setDialogError('');
      }
    } catch (value) {
      // The system dialog itself failed. Stay in the dialog with every choice intact.
      setDialogError(formatFailure(value, t('sessions.pickFolderFailed'), t('sessions.pickFolderNext')));
    }
  }

  /** `fallback` retries the same launch as an explicit terminal start in the same
   *  directory, which is the documented recovery when a conversation cannot start. */
  async function launchFromDialog(fallback?: 'terminal') {
    if (workspaceUnavailable) {
      // The inherited place is gone: ask for a fix instead of choosing another one.
      setDialogError(t('sessions.workspaceUnavailable', { path: workspaceValueLabel(workspaceValue) }));
      return;
    }
    if (!effectiveLaunchToolId || newLaunchPending.current) return;
    if (!fallback && acpUnavailable) {
      // The stored start mode is a conversation and this tool publishes no entry for it.
      // Nothing is sent: the reason is shown in the dialog and the terminal stays available.
      setDialogError(launchAcp.reason || t('sessions.launchAcpUnavailable', { tool: selectedLaunchTool?.name ?? '' }));
      return;
    }
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
      // The secondary path opens a terminal with no task: no prompt, no generated title or branch.
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
      rememberLaunchTool(effectiveLaunchToolId);
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
        ...(businessSelection && !remoteLaunch ? { workspaceId: businessSelection.workspaceId, repositoryId: businessSelection.repositoryId } : {}),
        toolId: effectiveLaunchToolId,
        projectId,
        sessionId: null,
        ...(remoteLaunch ? { remoteIntent: { kind: 'new' as const } } : {}),
        // A terminal retry or a remote project uses the terminal's YOLO arguments; a
        // conversation uses its entry's declaration.
        mode: (fallback === 'terminal' || remoteLaunch ? !!selectedLaunchTool?.yoloAvailable : dialogYolo.available) ? launchMode : 'normal',
        directory,
        ...(promptText ? { initialPrompt: promptText } : {}),
        ...(resume ? { resumeLatest: true } : {}),
        worktreeIntent,
        // Only an ACP conversation or a retry that explicitly fell back to a terminal
        // needs the field: a plain terminal launch keeps its historical request shape.
        ...(fallback || savedInteraction === 'acp' ? { interaction: fallback ?? savedInteraction } : {}),
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
          void settleWorktreeOperation(operationId, result, watched);
        }).catch((error) => {
          failWorktreeOperation(operationId, formatFailure(error, t('sessions.worktreeOpCreateFailed'), t('sessions.failureHint')));
        });
        return;
      }
      const result = await native.launchCli(request);
      if (result.warnings?.length) setNotice(result.warnings.join('\n'));
      const opened = await adoptLaunchResult(result);
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
  async function settleWorktreeOperation(operationId: string, result: LaunchResult, watched: string | null) {
    const opened = await adoptLaunchResult(result);
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

  /**
   * A launch answer becomes a session the workbench can show. A conversation is read
   * from the shared host so the panel renders the real snapshot, not a guess built from
   * the launch request; a terminal session is already in the native list.
   */
  async function adoptLaunchResult(result: LaunchResult): Promise<string | null> {
    const opened = workbenchSessionId(result);
    if (opened && isAcpLaunch(result)) registerConversation(await acp.session(opened).catch(() => null));
    return opened;
  }

  /** One prompt in an existing conversation. The launch's own first prompt was already
   *  submitted by the native host, so nothing here resends it. */
  async function promptConversation(sessionId: string, text: string) {
    await acp.prompt(sessionId, text);
  }

  /** Withdraw the turn: pending authorizations are withdrawn by the host until the turn
   *  reports its own result, so the panel keeps reading "stopping" until then. */
  async function stopConversation(sessionId: string) {
    await acp.cancel(sessionId);
  }

  /** Answer exactly the request the card was rendered for. */
  async function answerConversation(sessionId: string, requestId: string, optionId: string | null) {
    await acp.respondPermission(sessionId, requestId, optionId);
  }

  /** Closing a conversation is a native close plus a local row removal: the host may still
   *  report its own exit, and a later list read must not put the row back. */
  async function closeConversationNow(sessionId: string) {
    const order = arrangedSessions.map((item) => item.id);
    await acp.close(sessionId);
    retiredConversations.current.add(sessionId);
    setConversations((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });
    forgetSession(sessionId);
    const rest = sessionsRef.current.filter((item) => item.id !== sessionId);
    setSelectedId((current) => selectionAfterClose(current, new Set([sessionId]), order, rest));
  }

  async function closeConversation(session: WorkbenchSession) {
    if (busy) return;
    setBusy(session.id);
    setActionError('');
    try { await closeConversationNow(session.id); }
    catch (value) { setActionError(formatFailure(value, t('sessions.closeFailed'), t('sessions.closeNext'))); }
    finally { setBusy(''); }
  }

  /**
   * The two documented recoveries in the same working directory: a new conversation
   * (a fresh native session, nothing replayed) or an explicit terminal start that reuses
   * the directory and project configuration an earlier attempt created.
   */
  async function launchInDirectory(session: WorkbenchSession, interaction: 'acp' | 'terminal') {
    if (busy) return;
    setBusy(session.id);
    setActionError('');
    setNotice('');
    try {
      const result = await native.launchCli({
        toolId: session.toolId,
        projectId: session.projectId,
        sessionId: null,
        mode: session.mode,
        directory: session.directory || null,
        worktreeIntent: 'given',
        initialPrompt: null,
        resumeLatest: false,
        interaction,
      });
      if (result.warnings?.length) setNotice(result.warnings.join('\n'));
      const opened = await adoptLaunchResult(result);
      if (opened) { onFailure(null); selectPendingSession(opened); return; }
      setNotice(result.status === 'desktop_requested' ? t('sessions.desktopOpened') : t('sessions.externalOpened'));
    } catch (value) {
      setActionError(formatFailure(value, t('sessions.launchFailed'), t('sessions.failureHint')));
    } finally { setBusy(''); refreshLedger(); }
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
      const opened = await adoptLaunchResult(result);
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
    // A conversation receives a prompt message, never PTY bytes: the shared composer and the
    // interrupt control route by session kind instead of writing into a terminal that is absent.
    if (conversationOf(session.id)) {
      const text = rawText.replace(/[\r\n]+$/, '');
      // A control byte is not text: with no composer text there is nothing to send.
      if (!text.replace(/[\u0000-\u001f]/g, '').trim()) return false;
      try {
        await acp.prompt(session.id, text);
        return true;
      } catch (error) {
        setActionError(formatFailure(error, t('sessions.acpRetryFailed'), t('sessions.failureHint')));
        return false;
      }
    }
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

  /**
   * 只有当前屏幕版本被适配器判定为可输入时才允许写入：通用/未知界面、问题或批准界面都
   * 只提供复制意见，不把「PTY 可写」当成「发送安全」。远程会话不在本机 PTY 里，只走复制。
   */
  function feedbackCanSend(preview: TwiglaneFeedbackPreview, session: WorkbenchSession): boolean {
    if (preview.state !== 'prepared' || !session.running) return false;
    if (session.projectId?.startsWith('remote:')) return false;
    const semantics = semanticsById.get(session.id) ?? null;
    return semantics?.inputReady === true && semantics.attention == null;
  }

  /**
   * 会话横幅里「恢复会话」按钮的真实条件：适配器同时发布了 resume 与 history 端口，并且这不是
   * 远程会话（远程会话的进程在另一台机器上，本机没有可恢复记录）。提示文案复用同一判断，
   * 这样界面不会把用户指向一个不存在的按钮。
   */
  function sessionResumable(session: WorkbenchSession): boolean {
    if (session.projectId?.startsWith('remote:')) return false;
    // A conversation restores through the ACP host, never through a terminal resume command.
    if (conversationOf(session.id)) return false;
    return tools.some((tool) => tool.id === session.toolId && tool.resume?.state === 'available' && tool.history?.state === 'available');
  }

  /** 已结束或已离开工作台的会话仍保留预览与复制；是否可写由 feedbackCanSend 单独判定。 */
  function feedbackHint(preview: TwiglaneFeedbackPreview, session: WorkbenchSession | null, onTarget: boolean): string {
    // 目标会话已经不在工作台里（可能已关闭或属于别的窗口）：此时连 CLI 都查不到，不指向任何
    // 按钮，只说这批意见能做什么。
    if (!session) return t('sessions.feedbackDetached');
    // 远程会话不在本机 PTY 里，原因是远程而不是"界面不可输入"。
    if (session.projectId?.startsWith('remote:')) return t('sessions.feedbackRemoteCopy');
    if (!onTarget) return t('sessions.feedbackOtherWindow');
    // 已结束：只有真的能恢复时才提恢复入口；否则让用户回原任务手动继续。
    if (!session.running) {
      return sessionResumable(session)
        ? t('sessions.feedbackNeedsRestore')
        : t('sessions.feedbackEndedNoResume', { tool: toolName(session) });
    }
    return feedbackCanSend(preview, session) ? '' : t('sessions.feedbackNeedsReady');
  }

  function feedbackText(preview: TwiglaneFeedbackPreview): string {
    const head = t('sessions.feedbackCopyHeader', { count: preview.commentCount });
    const items = preview.comments.map((comment) => comment.path + ':' + (comment.newNo ?? comment.oldNo ?? '-') + ' (' + comment.kind + ')\n' + comment.body);
    return [head, ...items].join('\n\n');
  }

  function copyFeedback(preview: TwiglaneFeedbackPreview) {
    void writeClipboard(feedbackText(preview)).then((copied) => setNotice(copied ? t('sessions.feedbackCopied') : t('sessions.feedbackCopyFailed')));
  }

  /**
   * 一次性发送：原生在 store 锁里把批次切成发送中，所以同一批只会写一次。成功才显示「已写入
   * 终端」；失败或结果未知都记成不确定，面板此后只保留复制入口，不自动重试。
   */
  async function sendFeedback(preview: TwiglaneFeedbackPreview, session: WorkbenchSession) {
    if (feedbackBusy || preview.state !== 'prepared') return;
    setFeedbackError('');
    setFeedbackBusy(true);
    try {
      const outcome = await native.twiglaneFeedbackSend(preview.feedbackId, session.id);
      // 原生解析出的目标会话可能是恢复出来的新 id，面板跟着它走。
      onFeedbackChange?.({ ...preview, sessionId: outcome.sessionId, state: outcome.state });
      setNotice(t('sessions.feedbackSent'));
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      const state = code === 'feedback_already_sent'
        ? 'written'
        : code === 'feedback_write_failed' || code === 'feedback_send_uncertain' ? 'uncertain' : null;
      if (state) onFeedbackChange?.({ ...preview, state });
      setFeedbackError(formatFailure(error, t('sessions.feedbackSendFailed'), t('sessions.feedbackSendFailedAction')));
    } finally {
      setFeedbackBusy(false);
    }
  }

  /** 恢复把旧会话 id 换成新 id：同一批意见仍属于同一个工作树，面板跟着新会话，仍要用户再确认。 */
  function rebindFeedback(restored: Record<string, string>) {
    const batch = feedbackRef.current;
    if (!batch) return;
    const next = restored[batch.sessionId];
    if (!next || next === batch.sessionId) return;
    onFeedbackChange?.({ ...batch, sessionId: next });
  }

  /** 取消只清掉这次预览与运行期暂存；不写终端、不写 Git。 */
  async function dismissFeedback(preview: TwiglaneFeedbackPreview) {
    try {
      await native.twiglaneFeedbackDismiss(preview.feedbackId);
    } catch { /* 预览仍然可以本地关闭 */ }
    setFeedbackError('');
    onFeedbackChange?.(null);
  }

  async function startReview(session: WorkbenchSession) {
    setReviewError('');
    setReviewBusy(session.id);
    try {
      const state = await native.twiglaneStartReview(session.id);
      setReviewStates((current) => { const map = new Map(current); map.set(state.sessionId, state); return map; });
      setReviewClock(Date.now());
    } catch (error) {
      setReviewError([t('sessions.reviewFailed'), reviewReasonText(t, (error as { code?: string } | null)?.code)].join(' · '));
    } finally {
      setReviewBusy(null);
    }
  }

  /** What the Git menu says about one review; a claim is never shown as a success. */
  function describeReview(review: TwiglaneReviewState | null, status: WorkbenchCodeStatus | null, unknownStatus: boolean) {
    if (!review) return { tone: 'idle', text: t('sessions.reviewIdle') };
    if (review.status === 'preparing') return { tone: 'pending', text: t('sessions.reviewRemotePreparing') };
    if (review.status === 'opening' && review.protocolVersion === 1 && reviewClock - review.createdAt >= REVIEW_UNKNOWN_MS) {
      return { tone: 'pending', text: t('sessions.reviewRemoteWaiting') };
    }
    if (review.status === 'opening') {
      return reviewClock - review.createdAt >= REVIEW_UNKNOWN_MS
        ? { tone: 'unknown', text: t('sessions.reviewUnknown') }
        : { tone: 'pending', text: t('sessions.reviewOpening') };
    }
    if (review.status === 'accepted') return { tone: 'accepted', text: t('sessions.reviewAccepted') };
    if (review.status === 'rejected') {
      return { tone: 'rejected', text: [t('sessions.reviewRejected'), reviewReasonText(t, review.reason)].join(' · ') };
    }
    return describeReturnedReview(t, review, status, unknownStatus);
  }

  /** 真实状态读不到时显示"未知"，绝不显示成 0 个文件。 */
  function codeStatusText(status: WorkbenchCodeStatus | null, unknown: boolean): string {
    if (!status || unknown) return t('sessions.reviewStatusUnknown');
    return [
      status.branch ?? t('sessions.reviewDetached'),
      status.headOid ? status.headOid.slice(0, 7) : t('sessions.reviewNoCommit'),
      status.sessionFiles != null
        ? (status.sessionFiles > 0 ? t('sessions.reviewSessionFiles', { count: status.sessionFiles }) : t('sessions.reviewSessionClean'))
        : t('sessions.reviewFiles', { count: status.uncommittedFiles ?? 0 }),
    ].join(' · ');
  }

  /** Where the session count starts, with the whole-checkout total one hover away. */
  function codeStatusHint(status: WorkbenchCodeStatus | null, unknown: boolean): string | undefined {
    if (!status || unknown || status.sessionFiles == null) return status?.worktreePath ?? undefined;
    return [status.worktreePath ?? '', t('sessions.reviewSessionHint', { base: status.sessionBase?.slice(0, 7) ?? t('sessions.reviewNoCommit'), total: status.uncommittedFiles ?? 0 })].filter(Boolean).join('\n');
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
    if (peekSessionIdRef.current) return;
    if (!selected || !selected.running || composerSending.current.has(selected.id)) return;
    const text = composerDrafts[selected.id] ?? '';
    composerSending.current.add(selected.id);
    try {
      // A conversation sends plain text to the host: there is no PTY to prepare secret
      // references for and no bracketed paste to wrap.
      const conversation = !!conversationOf(selected.id);
      const local = !conversation && !selected.remoteSessionId && !selected.projectId?.startsWith('remote:');
      const outgoing = local ? await localSessionPrompt(text) : text;
      if (selectedIdRef.current !== selected.id || peekSessionIdRef.current) return;
      const input = !conversation && outgoing.includes('\n') && handles.current.get(selected.id)?.bracketedPaste
        ? `\x1b[200~${outgoing.replace(/\x1b/g, '')}\x1b[201~` : outgoing;
      if (!await sendToSession(selected, input + '\r')) return;
      if (text) setComposerDrafts((current) => current[selected.id] === text ? { ...current, [selected.id]: '' } : current);
      if (selectedIdRef.current === selected.id) requestAnimationFrame(() => composerInputRef.current?.focus());
    } catch (error) {
      bridge.current.writeError(error);
    } finally {
      composerSending.current.delete(selected.id);
    }
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
      return { ...current, order };
    });
  }, [sessions]);

  useEffect(() => {
    try { localStorage.setItem(RAIL_ARRANGE_KEY, JSON.stringify(arrangement)); } catch { /* Storage is optional. */ }
  }, [arrangement]);

  const pinnedIds = useMemo(() => new Set(arrangement.pinned), [arrangement]);

  function togglePinSession(id: string) {
    setArrangement((current) => current.pinned.includes(id)
      ? { ...current, pinned: current.pinned.filter((item) => item !== id) }
      : { ...current, pinned: [...current.pinned, id], order: current.order.filter((item) => item !== id) });
  }

  /** A rail group was rearranged by dragging: `ids` is that group's new visible order.
   *  Pinned sessions keep their own list; every other group shares one rank list, and ids
   *  outside the group keep their relative order behind it. */
  function reorderSessions(group: string, ids: string[]) {
    const moved = new Set(ids);
    setArrangement((current) => group === 'pinned'
      ? { ...current, pinned: [...ids, ...current.pinned.filter((id) => !moved.has(id))] }
      : { ...current, order: [...ids, ...current.order.filter((id) => !moved.has(id))] });
  }

  function stepSession(step: 1 | -1) {
    if (arrangedSessions.length < 2) return;
    setSelectedId((current) => {
      const index = arrangedSessions.findIndex((item) => item.id === current);
      return arrangedSessions[(index + step + arrangedSessions.length) % arrangedSessions.length].id;
    });
  }

  useEffect(() => { if (!menu) setMenuBox(null); }, [menu]);
  // A menu that simply closes would leave focus on the body, one keypress away from nothing.
  // Hand it back to the control that opened it; an item that moved focus itself (copy, clear,
  // paste) keeps it.
  const closedMenuRef = useRef<MenuState | null>(null);
  if (menu) closedMenuRef.current = menu;
  useEffect(() => {
    if (menu) return;
    const previous = closedMenuRef.current;
    closedMenuRef.current = null;
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected;
    if (!lost || !document.hasFocus() || !previous?.trigger?.isConnected) return;
    previous.trigger.focus({ preventScroll: true });
  }, [menu]);
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
      // The control that opened the menu gets the keyboard back; a menu opened from the
      // terminal itself (a right-click or the ContextMenu key) returns to that session.
      if (current.trigger?.isConnected) {
        current.trigger.focus({ preventScroll: true });
        return;
      }
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

  function openRowMenu(session: WorkbenchSession, x: number, y: number, trigger: HTMLElement | null = null) {
    const previous = selectedIdRef.current;
    // The row stays unselected. Selecting it would fit its PTY and drop its unread mark.
    setAppearanceOpen(false);
    setShortcutsOpen(false);
    // Worktree setup opens in its own dialog; the ledger is read so its entry stays current.
    refreshLedger();
    setMenu({ kind: 'session', sessionId: session.id, x, y, trigger, besideId: previous && previous !== session.id ? previous : null });
  }

  /** `surface` is a right-click or context key on the terminal itself; the title-bar button opens the session menu. */
  function openTerminalMenu(session: WorkbenchSession, x: number, y: number, trigger: HTMLElement | null = null, surface = false) {
    setAppearanceOpen(false);
    refreshLedger();
    // A conversation holds no terminal text: its menu is the session menu, never the
    // selection/copy menu (which would address a terminal that does not exist).
    if (conversationOf(session.id)) {
      setMenu({ kind: 'session', sessionId: session.id, x, y, trigger, besideId: null });
      return;
    }
    const handle = handles.current.get(session.id);
    const hasSelection = !!handle?.hasSelection();
    // The first selected line seeds find; a selection read here survives the menu taking focus.
    const selection = surface && hasSelection ? (handle?.readOutput() ?? '').split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 120) ?? '' : '';
    setMenu({ kind: 'terminal', sessionId: session.id, x, y, trigger, hasSelection, selection, surface });
  }

  /** Shift+F10 and the ContextMenu key reach the same menu a right-click opens. The terminal
   *  would otherwise swallow both as CLI input, so the pane handles them in the capture phase. */
  function menuKey(event: ReactKeyboardEvent<HTMLElement>): boolean {
    return event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
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
    setLedgerQuery('');
    setLedgerScope(directory ? 'repo' : 'all');
    setLedgerLimit(LEDGER_PAGE);
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
      await removeLedgerRow(row);
      refreshLedger();
    } catch (value) {
      setCleanupError(formatFailure(value, t('sessions.worktreeCleanupFailed'), t('sessions.failureHint')));
    } finally { setCleanupBusy(''); }
  }

  /** Remove one row; unmerged commits or uncommitted work still ask first. */
  async function removeLedgerRow(row: WorktreeLedgerEntry): Promise<boolean> {
    const preview = await native.cleanupWorktree(row.worktreePath, false);
    if (!preview.needsConfirmation) return preview.removed;
    const accepted = await confirmAction(preview.detail || t('sessions.worktreeCleanupConfirmTitle'), () => true, {
      title: t('sessions.worktreeCleanupConfirmTitle'),
      confirmLabel: t('sessions.worktreeCleanupConfirm'),
      destructive: true,
    });
    if (!accepted) return false;
    await native.cleanupWorktree(row.worktreePath, true);
    return true;
  }

  /** Forget every listed worktree whose folder another tool already deleted. */
  async function forgetMissing(rows: WorktreeLedgerEntry[]) {
    if (cleanupBusy) return;
    setCleanupError('');
    try {
      for (const row of rows) {
        if (worktreeUser(row)) continue;
        setCleanupBusy(row.worktreePath);
        await removeLedgerRow(row);
      }
    } catch (value) {
      setCleanupError(formatFailure(value, t('sessions.worktreeCleanupFailed'), t('sessions.failureHint')));
    } finally {
      setCleanupBusy('');
      refreshLedger();
    }
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
    // The dialog opens on the current project's worktrees: the repository is the main checkout of
    // the worktree the session runs in, else the session's own folder. "All projects" stays one
    // click away, grouped by repository.
    const repositoryRoot = directory ? ledger.find((row) => withinDirectory(row.worktreePath, directory))?.mainCheckout ?? directory : null;
    const inRepository = (row: WorktreeLedgerEntry) => !!repositoryRoot && (sameDirectory(row.mainCheckout, repositoryRoot) || withinDirectory(row.mainCheckout, repositoryRoot) || withinDirectory(repositoryRoot, row.mainCheckout));
    const repositoryRows = repositoryRoot ? ledger.filter(inRepository) : ledger;
    const scope = repositoryRoot ? ledgerScope : 'all';
    const scopedRows = scope === 'repo' ? repositoryRows : ledger;
    const query = ledgerQuery.trim();
    const matchedRows = query ? scopedRows.filter((row) => matchesQuery(query, row.branch, row.worktreePath, folderName(row.mainCheckout))) : scopedRows;
    const shownRows = matchedRows.slice(0, ledgerLimit);
    // "All projects" groups rows by repository, in first-seen order.
    const groups = new Map<string, WorktreeLedgerEntry[]>();
    for (const row of shownRows) {
      const key = scope === 'all' ? displayPath(row.mainCheckout) : '';
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const showFilter = scopedRows.length >= LEDGER_FILTER_MIN || !!ledgerQuery;
    const missingRows = scopedRows.filter((row) => row.missing);
    const projectName = repositoryRoot ? availableProjects.find((item) => item.path && sameDirectory(item.path, repositoryRoot))?.name ?? folderName(repositoryRoot) : '';
    return <GuideDialog open={!!worktreeSetup} title={t('sessions.worktreeSetupTitle')} hint={t('sessions.worktreeSetupHint')} onClose={() => setWorktreeSetup(null)}>
      <div className={styles.setupForm}>
        <section className={styles.setupSection} aria-labelledby="worktree-setup-cleanup">
          <header className={styles.setupHead}>
            <h3 id="worktree-setup-cleanup">{t('sessions.worktreeCleanup')}{scopedRows.length > 0 && <em>{scopedRows.length}</em>}</h3>
            {repositoryRoot && ledger.length > repositoryRows.length && <div className={styles.setupScope} role="radiogroup" aria-label={t('sessions.worktreeScopeLabel')}>
              {(['repo', 'all'] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={scope === value} title={value === 'repo' ? displayPath(repositoryRoot) : undefined} onClick={() => { setLedgerScope(value); setLedgerLimit(LEDGER_PAGE); }}>
                <span>{value === 'repo' ? projectName || t('sessions.worktreeScopeRepo') : t('sessions.worktreeScopeAll')}</span><em>{value === 'repo' ? repositoryRows.length : ledger.length}</em>
              </button>)}
            </div>}
            <p>{t('sessions.worktreeCleanupDesc')}</p>
            {missingRows.length > 1 && <Button size="sm" variant="ghost" className={styles.setupForgetAll} disabled={!!cleanupBusy} icon={<Icon name="trash" size={13} />} onClick={() => void forgetMissing(missingRows)}>{t('sessions.worktreeForgetMissing', { count: missingRows.length })}</Button>}
          </header>
          {cleanupError && <p className={styles.setupError} role="alert"><Icon name="alert" size={14} /><span>{cleanupError}</span></p>}
          {showFilter && <div className={styles.setupFilter} data-field-frame="">
            <Icon name="search" size={14} />
            <input type="search" value={ledgerQuery} placeholder={t('sessions.worktreeFilterPlaceholder')} aria-label={t('sessions.worktreeFilterLabel')} spellCheck={false} autoComplete="off" onChange={(event) => { setLedgerQuery(event.target.value); setLedgerLimit(LEDGER_PAGE); }} onKeyDown={(event) => { if (event.key === 'Escape' && ledgerQuery) { event.preventDefault(); event.stopPropagation(); setLedgerQuery(''); } }} />
            {query && <span className={styles.setupFilterCount}>{matchedRows.length}</span>}
          </div>}
          {shownRows.length ? <ul className={styles.setupList}>
            {[...groups.entries()].map(([repository, rows]) => <Fragment key={repository || 'repo'}>
              {repository && <li className={styles.setupGroup} role="presentation" title={repository}><Icon name="folder" size={12} /><strong>{folderName(repository)}</strong><code>{shortPath(repository)}</code><em>{rows.length}</em></li>}
              {rows.map((row) => {
              const removing = cleanupBusy === row.worktreePath;
              const user = worktreeUser(row);
              const missing = !!row.missing;
              return <li key={row.worktreePath} className={styles.setupRow} data-busy={removing || undefined} data-in-use={user ? '' : undefined} data-missing={missing || undefined}>
                <span className={styles.setupRowGlyph} aria-hidden="true"><Icon name="gitWorktree" size={14} /></span>
                <span className={styles.cleanupCopy}>
                  <span className={styles.cleanupTitle} title={row.branch}>{row.branch}</span>
                  <small><span className={styles.cleanupPath} title={displayPath(row.worktreePath)}>{shortPath(displayPath(row.worktreePath))}</span>{missing && <span className={styles.cleanupMissing} title={t('sessions.worktreeMissingHint')}>{t('sessions.worktreeMissing')}</span>}{user && <span className={styles.cleanupInUse}>{t('sessions.worktreeInUse', { tool: toolName(user) })}</span>}</small>
                </span>
                {/* A running session blocks cleanup; the way out is that session, one click away. */}
                {user && scopedSessions.some((item) => item.id === user.id) && <Button size="sm" variant="ghost" className={styles.setupJump} title={t('sessions.worktreeGoToSessionHint', { tool: toolName(user) })} icon={<Icon name="arrowUpRight" size={13} />} onClick={() => { setWorktreeSetup(null); setSelectedId(user.id); requestAnimationFrame(() => { if (selectedIdRef.current === user.id) handles.current.get(user.id)?.focus(); }); }}>{t('sessions.worktreeGoToSession')}</Button>}
                <Button size="sm" variant="ghost" className={styles.setupRemove} aria-label={t('sessions.worktreeCleanupAction', { branch: row.branch })} title={user ? t('sessions.worktreeCleanupRunning', { tool: toolName(user) }) : missing ? t('sessions.worktreeMissingHint') : undefined} disabled={!!cleanupBusy} icon={<Icon name={removing ? 'refresh' : missing ? 'close' : 'trash'} size={13} />} onClick={() => void cleanWorktree(row)}>{removing ? t('sessions.worktreeCleaning') : missing ? t('sessions.worktreeForgetButton') : t('sessions.worktreeCleanupButton')}</Button>
              </li>;
            })}
            </Fragment>)}
            {matchedRows.length > shownRows.length && <li className={styles.setupMore} role="presentation"><Button size="sm" variant="ghost" onClick={() => setLedgerLimit((value) => value + LEDGER_PAGE)}>{t('sessions.worktreeShowMore', { count: Math.min(LEDGER_PAGE, matchedRows.length - shownRows.length) })}</Button><span>{shownRows.length} / {matchedRows.length}</span></li>}
          </ul> : <p className={styles.setupEmpty}><Icon name={query ? 'search' : 'gitWorktree'} size={14} /><span>{query ? t('sessions.worktreeFilterEmpty', { query }) : scope === 'repo' && ledger.length ? t('sessions.worktreeCleanupEmptyRepo') : t('sessions.worktreeCleanupEmpty')}</span></p>}
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
  const availableRemoteProjects = useMemo(() => !newDialogOpen || activeTargetId === 'local' ? [] : remoteProjects.filter((item) => item.path && item.targetId === activeTargetId).sort((a, b) => b.updatedAt - a.updatedAt), [newDialogOpen, activeTargetId, remoteProjects]);
  const activeRemoteTarget = remoteSshEnabled && activeTargetId !== 'local' ? remoteTargets.find((target) => target.id === activeTargetId) ?? null : null;
  const remoteHomePath = activeRemoteTarget ? remoteStartPath(activeRemoteTarget) : '';
  const goneRemoteIds = activeRemoteTarget && goneRemote?.targetId === activeRemoteTarget.id ? goneRemote.ids : null;
  // A folder a session still names stays listed; only the rest are offered for removal.
  const goneRemovable = goneRemoteIds ? [...goneRemoteIds].filter((id) => !sessions.some((session) => session.projectId === `remote:${id}`)) : [];
  // Saved folders are history, not proof: a host can be re-pointed or a folder deleted. Ask the host once per opening.
  const savedRemoteKey = availableRemoteProjects.map((item) => `${item.id}=${item.path}`).join('|');
  useEffect(() => {
    if (!nativeAvailable || !newDialogOpen || !activeRemoteTarget || !availableRemoteProjects.length) return;
    let alive = true;
    const targetId = activeRemoteTarget.id;
    void missingRemoteProjects(targetId, availableRemoteProjects).then((ids) => { if (alive) setGoneRemote({ targetId, ids }); }).catch(() => {});
    return () => { alive = false; };
  }, [newDialogOpen, activeRemoteTarget?.id, savedRemoteKey]);
  // The dialog reads its base from the directory it will really use; the home
  // entry has none, so a worktree cannot be chosen there.
  const dialogDirectory = newDialogOpen ? dialogPrepareDirectory() : null;
  // The branch a creation would allocate follows the task text, so the first line
  // of the prompt is part of the preview request.
  const dialogTaskLine = useMemo(() => firstTaskLine(initialPrompt), [initialPrompt]);
  // The confirmed base, its short commit and the proposed branch are visible before
  // anything is written. Initial selection reads immediately; typing re-reads after
  // a short pause while keeping the previous preview on screen.
  useEffect(() => {
    if (!nativeAvailable || !newDialogOpen || dialogPlace !== 'worktree' || !dialogDirectory) {
      basePreviewContext.current = '';
      setBasePreview(null);
      setBaseBusy(false);
      return;
    }
    const request = ++baseRequest.current;
    let cancelled = false;
    setBaseBusy(true);
    setBaseError('');
    const contextKey = `${dialogDirectory}\n${JSON.stringify(baseChoice ?? null)}`;
    const immediate = basePreviewContext.current !== contextKey;
    basePreviewContext.current = contextKey;
    const runPreview = () => {
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
    };
    if (immediate) {
      runPreview();
      return () => { cancelled = true; };
    }
    const timer = window.setTimeout(runPreview, 240);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [nativeAvailable, newDialogOpen, dialogPlace, dialogDirectory, baseChoice, dialogTaskLine]);
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
      // Option+N on macOS reports a dead key, so match the physical key as well.
      if ((event.key.toLowerCase() === 'n' || event.code === 'KeyN') && terminalTools.length > 0) {
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
    applyPreferredMode(launchSettings, dialogModeTarget(workspaceValue), value);
  }
  const businessRepositoryOptions = useMemo(() => {
    const options: Array<{ value: string; label: string; detail: string; worktree: boolean; workspaceId: string; workspaceName: string; selection: WorkspaceSelection }> = [];
    // Hundreds of repositories with their worktrees: a set keeps de-duplication linear.
    const seen = new Set<string>();
    for (const workspace of businessWorkspaces) {
      const repositories = [...workspace.repositories].sort((a, b) => Number(b.favorite) - Number(a.favorite));
      for (const repository of repositories) {
        const location = repository.locations.find(item => item.available && item.path);
        if (!location) continue;
        for (const [path, place] of repositoryPlaces(repository, t('workspaces.mainCheckout'), t('workspaces.worktreeKind'))) {
          if (seen.has(path)) continue;
          seen.add(path);
          options.push({
            value: `custom:${path}`,
            label: place.main ? repository.name : `${repository.name} · ${place.label}`,
            detail: shortPath(displayPath(path)),
            worktree: !place.main,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            selection: { workspaceId: workspace.id, repositoryId: repository.id, directory: path, projectId: location.projectId, label: `${workspace.name} / ${repository.name}` },
          });
        }
      }
    }
    return options;
  }, [businessWorkspaces, t]);
  const cliSelectOptions = useMemo<FilterSelectOption[]>(() => toolOptions(terminalTools), [terminalTools]);
  const workspaceSelectOptions = useMemo<FilterSelectOption[]>(() => {
    if (!newDialogOpen) return [];
    // A host lists its own places only: its home folder, its saved folders and a picked one.
    if (activeRemoteTarget) {
      const list: FilterSelectOption[] = [
        { value: '__home', label: t('sessions.workspaceHome'), detail: `${activeRemoteTarget.name} · ${remoteHomePath}`, icon: <Icon name="home" size={14} /> },
        // Folders this host reported as gone sink to the end and cannot be chosen.
        ...availableRemoteProjects.filter((project) => project.path !== remoteHomePath && project.path !== customRemotePath)
          .map((project) => ({ project, gone: !!goneRemoteIds?.has(project.id) }))
          .sort((a, b) => Number(a.gone) - Number(b.gone))
          .map(({ project, gone }) => ({ value: `remote:${project.id}`, label: project.name, detail: project.path, note: gone ? t('sessions.remoteFolderGone') : undefined, disabled: gone, icon: <Icon name="folder" size={14} /> })),
      ];
      if (customRemotePath) list.push({ value: `rpath:${customRemotePath}`, label: remoteBaseName(customRemotePath) || customRemotePath, detail: customRemotePath, icon: <Icon name="folder" size={14} /> });
      return list;
    }
    const list: FilterSelectOption[] = [
      { value: '__home', label: t('sessions.workspaceHome'), icon: <Icon name="home" size={14} /> },
      // Project repositories (main checkout and attached worktrees) fold under their project, so dozens of
      // projects with hundreds of repositories stay one short list; a search finds any of them by name.
      ...businessRepositoryOptions.flatMap(({ value, label, detail, worktree, workspaceId, workspaceName }, index, all) => [
        ...(index === 0 || all[index - 1].workspaceId !== workspaceId ? [{ value: `group:${workspaceId}`, label: workspaceName, group: true, icon: <Icon name="package" size={14} /> }] : []),
        { value, label, detail, parent: `group:${workspaceId}`, keywords: workspaceName, triggerLabel: label === workspaceName ? undefined : `${workspaceName} / ${label}`, icon: <Icon name={worktree ? 'gitWorktree' : 'branch'} size={14} /> },
      ]),
      // A directory that only backs a business-project repository is offered under that project.
      ...availableProjects.filter((project) => !project.workspaceBacked || workspaceValue === `project:${project.id}`).map((project) => ({ value: `project:${project.id}`, label: project.name, detail: project.path ? shortPath(displayPath(project.path)) : undefined, icon: <Icon name="folder" size={14} /> })),
    ];
    if (customFolderPath && !businessRepositoryOptions.some(option => option.value === `custom:${customFolderPath}`)) list.push({ value: `custom:${customFolderPath}`, label: shortPath(displayPath(customFolderPath)), detail: displayPath(customFolderPath), icon: <Icon name="folder" size={14} /> });
    return list;
  }, [newDialogOpen, activeRemoteTarget, availableProjects, availableRemoteProjects, businessRepositoryOptions, customFolderPath, customRemotePath, goneRemoteIds, remoteHomePath, workspaceValue, t]);
  /**
   * A stored workspace that is no longer offered keeps its value and says why: switching hosts
   * or removing a project must not silently launch somewhere else.
   */
  const workspaceUnavailable = newDialogOpen && !workspaceSelectOptions.some((option) => option.value === workspaceValue && !option.disabled);
  useEffect(() => {
    const option = workspaceSelectOptions.find((item) => item.value === workspaceValue);
    if (option) workspaceLabels.current.set(workspaceValue, option.label);
  }, [workspaceSelectOptions, workspaceValue]);

  /** Readable name of a stored workspace value, including one that is no longer offered. */
  function workspaceValueLabel(value: string): string {
    const remembered = workspaceLabels.current.get(value);
    if (remembered) return remembered;
    if (value.startsWith('project:')) return availableProjects.find((item) => 'project:' + item.id === value)?.name ?? value.slice('project:'.length);
    if (value.startsWith('remote:')) return availableRemoteProjects.find((item) => 'remote:' + item.id === value)?.name ?? value.slice('remote:'.length);
    if (value.startsWith('custom:')) return displayPath(value.slice('custom:'.length));
    if (value.startsWith('rpath:')) return value.slice('rpath:'.length);
    return value === '__home' ? t('sessions.workspaceHome') : value;
  }

  const collapsedIds = useMemo(() => new Set(arrangement.collapsed), [arrangement.collapsed]);
  /** One shared task state per session; the rail, the title bar, the panes and the jump read it. */
  const railSessions: RailSession[] = arrangedSessions.map((session) => {
    const evidence = taskEvidenceOf(session);
    const task = taskStateFor(evidence);
    return {
      session,
      name: toolName(session),
      title: taskTitle(session),
      place: railPlaceOf(session),
      directory: session.directory ? displayPath(session.directory) : '',
      elapsed: elapsedOf(session),
      tone: sessionTone(session),
      pinned: pinnedIds.has(session.id),
      attention: attentionIds.has(session.id),
      unread: unreadIds.has(session.id),
      task,
      bucket: taskBucketFor(task, evidence),
      taskLabel: t(taskStateLabelKey(task, evidence)),
      taskHint: taskHintOf(session),
      command: commandOf(session),
      collapsed: collapsedIds.has(session.id),
      marked: arrangement.reviewMarks.includes(session.id),
      pane: split ? (split.indexOf(session.id) >= 0 ? split.indexOf(session.id) : null) : null,
    };
  });
  // A collapsed row hidden by the search filter still counts: the section never claims to be empty.
  const collapsedCount = arrangement.collapsed.filter((id) => scopedSessions.some((session) => session.id === id)).length;

  const copiedMessage = copiedState === 'branch' ? t('sessions.branchCopied') : copiedState === 'path' ? t('sessions.pathCopied')
    : copiedState === 'output' ? t('sessions.outputCopied')
      : copiedState === 'selection' ? t('sessions.selectionCopied') : t('sessions.outputEmpty');

  /** The one task wording of a session: title bar, panes and the peek cover all read it. */
  function stateLabel(session: WorkbenchSession, tone: SessionTone): string {
    void tone;
    return taskLabelOf(session);
  }

  // Every live terminal stays mounted, including other hosts' sessions: a remount replays history
  // into a fresh xterm. Ended ones are mounted only while on screen or recently viewed.
  // A temporary look keeps its own terminal mounted without putting it in visibleIds.
  const scopedSessionIds = useMemo(() => new Set(scopedSessions.map(session => session.id)), [scopedSessions]);
  /** The pane head shared by both session kinds, so a split reads the same way. */
  function paneHeader(session: WorkbenchSession) {
    // Focus follows the same rule the terminal pane uses: on screen and selected.
    const focused = renderActive && session.id === selectedId;
    return <div className={styles.paneHead}>
                      <SessionActivityIcon tone={sessionTone(session)} slot="pane" className={styles.paneDot} label={stateLabel(session, sessionTone(session))} />
                      <ToolIcon toolId={session.toolId} size={14} />
                      <strong>{taskTitle(session) ? <SessionTitle title={taskTitle(session)} /> : toolName(session)}</strong>
                      <span className={styles.panePlace}>{placeOf(session)}</span>
                      {focused && <span className={styles.paneFocus}>{t('sessions.paneFocused')}</span>}
                      <button type="button" className={styles.paneClose} aria-label={t('sessions.closePane', { name: toolName(session) })} title={t('sessions.closePane', { name: toolName(session) })} onClick={(event) => { event.stopPropagation(); closePane(session.id); }}><Icon name="close" size={12} /></button>
                    </div>;
  }

  // Conversations join the same mount set: a live one stays mounted so its stream keeps
  // arriving while another session is selected.
  const mountedSessions = [...sessions, ...conversationRows].filter((session) => session.running || visibleIds.includes(session.id) || recentSessionIds.includes(session.id) || session.id === peekSessionId || session.id === menu?.sessionId);
  // A pending selection has no input target until that identity has been listed.
  const stageSession = selected;

  const railDocked = !!railHost;
  const showRail = !focusMode && !(showEmpty && !listError);
  const railShown = railDocked && showRail;
  const liveScopedCount = useMemo(() => scopedSessions.filter((item) => item.running).length, [scopedSessions]);
  useEffect(() => {
    onLiveCountChange?.(liveScopedCount);
  }, [onLiveCountChange, liveScopedCount]);
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
  // The rail draws this jump only while docked and expanded. Focus mode, a slim rail and the
  // undocked strip cover that button, so the stage repeats the same filtered waiting list.
  const stageAttention = showRail && railDocked && !railSlim
    ? []
    : railSessions.filter((item) => item.bucket === 'attention' && item.session.id !== selectedId);
  const stageAttentionTarget = stageAttention[0];
  const peekOffered = !listError && !split && railSessions.length > 1;
  const peekSession = peekSessionId ? scopedSessions.find((item) => item.id === peekSessionId) ?? null : null;
  const peekTitle = peekSession ? taskTitle(peekSession) : '';
  const peekTool = peekSession ? toolName(peekSession) : '';
  function openPeek(id: string) {
    if (!peekOffered || !id || id === selectedIdRef.current) return;
    if (!scopedSessions.some((item) => item.id === id)) return;
    setPeekSessionId(id);
  }
  // A deliberate close hands the keyboard back to the session the cover was hiding. Every other
  // way the cover ends (a jump, split, or removal) leaves focus with that action instead.
  function closePeek() {
    setPeekSessionId(null);
    requestAnimationFrame(() => {
      const id = selectedIdRef.current;
      if (id && !popupOwnsFocus()) handles.current.get(id)?.focus();
    });
  }
  function selectSession(id: string, focusTerminal = true) {
    setPeekSessionId(null);
    setSelectedId(id);
    if (focusTerminal) requestAnimationFrame(() => {
      // The frame can run after a menu or dialog has taken the keyboard; it must not take it back.
      if (selectedIdRef.current === id && !popupOwnsFocus()) handles.current.get(id)?.focus();
    });
  }
  const rail = <SessionRail sessions={railSessions} total={scopedSessions.length} running={runningCount} ended={endedCount} search={railSearch} selectedId={selectedId} narrow={!railDocked} slim={railDocked && railSlim} docked={railDocked} busy={!!busy} canLaunch={terminalTools.length > 0}
    endedCollapsed={endedCollapsed} collapsedOpen={collapsedOpen} collapsedCount={collapsedCount} onToggleCollapsedOpen={() => setCollapsedOpen((value) => !value)}
    onToggleEnded={toggleEndedCollapsed} onSearch={setRailSearch} onSelect={selectSession} onNewSession={() => openNewSessionDialog()} onOpenMenu={openRowMenu} onRemove={(session) => void endSession(session)} onClearEnded={() => void clearEndedSessions()} onToggleSlim={toggleRail} onReorder={reorderSessions} />;

  return <div ref={rootRef} className={styles.root} data-focus-mode={focusMode || undefined} data-empty={(showEmpty && !listError) || undefined} data-term-theme={terminalMode} data-narrow={narrowFrame || undefined} data-compact={compactFrame || undefined} data-tight={tightFrame || undefined} data-rail-docked={railDocked || undefined}>
    {(focusMode || (showEmpty && !listError)) && <h1 className={styles.srOnly} tabIndex={-1}>{t('common.pages.sessions.title')}</h1>}
    {listError && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><strong>{t('sessions.listFailed')}</strong><p>{listError}</p></div><Button size="sm" onClick={() => setReload((value) => value + 1)}>{t('sessions.retry')}</Button></div>}

    <div className={styles.layout} data-strip={(!railDocked && showRail) || undefined}>
      {!railDocked && showRail && rail}

      {/* The composer textarea follows the terminal font preference via this inherited custom property. */}
      <section ref={stageRef} className={styles.stage} style={{ '--term-font-size': `${fontSize}px` } as CSSProperties} aria-label={t('sessions.stageLabel')}>
        {writeRecoveryNeeded && !stageSession && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><p>{t('common.remoteWrite.unknown')}</p></div><div className={styles.bannerActions}><Button size="sm" onClick={() => requestWriteRecovery(remoteTargetId)}>{t('common.remoteWrite.open')}</Button></div></div>}
        {failure && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><strong>{t('sessions.launchFailed')}</strong><p>{failure.detail}</p><p>{t('sessions.failureHint')}</p></div><div className={styles.bannerActions}><Button variant="primary" size="sm" icon={<Icon name="refresh" size={14} />} onClick={() => void retry()} disabled={retrying}>{retrying ? t('sessions.loading') : t('sessions.retry')}</Button><Button size="sm" onClick={() => onFailure(null)}>{t('sessions.dismissBanner')}</Button></div></div>}
        {actionError && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><p>{actionError}</p></div><IconButton size="sm" icon={<Icon name="close" size={14} />} onClick={() => setActionError('')} aria-label={t('common.dismissError')} /></div>}
        {restoreError && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><p>{restoreError}</p></div><Button size="sm" disabled={restoring} onClick={() => void restoreLocalSessions()}>{t('sessions.retryRestore')}</Button></div>}
        {restoreRows.length > 0 && <div className={styles.restoreQueue} role="group" tabIndex={0} aria-label={t('sessions.restoreQueueLabel')} data-restore-queue={restoreRows.length}>
          <div className={styles.restoreQueueHead}>
            <span>{t('sessions.restoreQueueLabel')}<span className={styles.restoreQueueCount}>{restoreRows.length}</span></span>
            <span className={styles.restoreQueueTools}>
              {restoreRows.filter((row) => row.stage === 'failed').length > 1 && <Button size="sm" variant="ghost" onClick={forgetFailedRestoreRows}>{t('sessions.dismissFailedRestores', { count: restoreRows.filter((row) => row.stage === 'failed').length })}</Button>}
              {!scopedSessions.length && terminalTools.length > 0 && <Button size="sm" icon={<Icon name="plus" size={13} />} onClick={() => openNewSessionDialog()}>{t('sessions.newSession')}</Button>}
            </span>
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
          const elapsed = current ? elapsedOf(current) : '';
          const currentStateLabel = current ? stateLabel(current, tone) : '';
          // A command fact takes the status slot itself while the task is neutral: progress is the
          // session's state then, not an extra chip beside it. Waiting for a person, a review, a
          // failure and an ended session keep their own wording and icon.
          const currentCommand = current ? commandOf(current) : null;
          const currentTask = current ? taskStateOf(current) : 'unknown';
          const shownCommand = currentCommand && commandReplacesTask(currentTask) ? currentCommand : null;
          const badgeLabel = shownCommand ? shownCommand.label : currentStateLabel;
          const badgeTone: SessionTone = shownCommand ? shownCommand.activityTone : tone;
          // The task state stays readable in the tooltip, so replacing the text never hides it.
          const badgeTitle = shownCommand ? `${shownCommand.label} · ${currentStateLabel}` : currentStateLabel;
          // Only the common states reserve room: a chip that grows for a rare "needs you"
          // is clearer than one that is always as wide as its longest possible wording.
          const stateReserves = [
            t('sessions.stateIdle'),
            t('sessions.stateStreaming'),
            t('sessions.bellBadge'),
            t('sessions.stateError'),
            t('sessions.taskEnded'),
          ].filter((label) => label !== badgeLabel);
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
          const stagePlace = current ? placeOf(current) : '';
          // Offer the worktree menu only when the repository actually has more than one checkout.
          const worktrees = current?.id === gitTarget && worktreeAnchor === gitWorktrees?.anchor ? gitWorktrees?.trees ?? [] : [];
          const canSwitchWorktree = !!current && !remote && worktrees.length > 1;
          const { shown: shownTrees, matched: matchedTrees, hits: worktreeHits } = menuWorktrees(worktrees, worktreeQuery);
          // 只有一个 checkout 时菜单没有别的选择，但仍然要提供审查入口和真实状态。
          const canOpenGitMenu = !!current && (remote || canSwitchWorktree || !!gitLabel);
          const review = current ? reviewStates.get(current.id) ?? null : null;
          const codeStatus = review?.remoteCheck ?? (current ? codeStatuses.get(current.id) ?? null : null);
          const codeStatusStale = !!current && (!!codeStatusUnknown.get(current.id) || !codeStatus || codeStatus.state !== 'ready');
          const reviewUnverified = !!current && review?.status === 'returned' && codeStatusReviews.get(current.id) !== reviewResultKey(review);
          const reviewView = remote && reviewBusy === current?.id ? { tone: 'pending', text: t('sessions.reviewRemoteChecking') } : remote && !review ? { tone: 'idle', text: t('sessions.reviewRemoteIdle') } : describeReview(review, codeStatus, codeStatusStale || reviewUnverified);
          const reviewWaiting = !!review && review.status === 'opening' && reviewClock - review.createdAt < REVIEW_UNKNOWN_MS;
          // 发起中不重复点击；失败、超时或拒绝都可以重新发起，并一定拿到新的 reviewId。
          const reviewRetryable = !!review && !reviewWaiting && (review.status === 'rejected' || review.status === 'opening');
          const gitChipTitle = [gitTitle, t('sessions.gitScopeHint')].filter(Boolean).join('\n');
          // 反馈面板归属：属于本窗口列表里的会话时只在选中它时出现；属于别的主机（远程会话）
          // 或已经离开工作台的会话时保留只读副本，否则一次切换就把意见正文弄丢了。
          const feedbackPanelTarget = feedback ? sessions.find((item) => item.id === feedback.sessionId) ?? null : null;
          const feedbackPanelHere = !!feedback && (current?.id === feedback.sessionId || !scopedSessions.some((item) => item.id === feedback.sessionId));
          return <div className={styles.window} hidden={!current && !feedbackPanelHere} data-split={split ? 'true' : undefined} data-tone={tone}>
            {current && <header className={styles.stageBar} data-window-titlebar={windowChrome ?? undefined} data-tauri-drag-region={windowChrome ? 'deep' : undefined} onDoubleClick={(event) => {
              // In a browser, double-clicking the bare title bar toggles focus mode. In the desktop
              // window this bar is the window's title bar, where a double-click maximizes instead.
              if (windowChrome) return;
              if (!(event.target instanceof Element) || event.target.closest('button, a, input, [role="toolbar"], [data-stage-icon]')) return;
              setFocusMode((value) => !value);
            }}>
              <div className={styles.stageLead}>
                <span className={styles.stageIcon} role="img" aria-label={toolName(current)} data-tone={shownCommand ? badgeTone : tone} data-stage-icon="" data-tauri-drag-region="false" title={toolName(current) + ' · ' + t('sessions.stageIconHint')} onDoubleClick={(event) => { event.stopPropagation(); toggleRail(); }}><ToolIcon toolId={current.toolId} size={20} /><SessionActivityIcon tone={shownCommand ? badgeTone : tone} slot="stage" className={styles.stageIconDot} /></span>
                <div className={styles.identityText}>
                  <div className={styles.identityTitleRow} data-short={(title ? stableTitle(title) : toolName(current)).length <= SHORT_STAGE_TITLE || undefined}><h2 title={title ? toolName(current) + ' · ' + stableTitle(title) : toolName(current)}>{title ? <SessionTitle title={title} /> : toolName(current)}</h2><Badge className={styles.statusChip} tone={sessionBadgeTone(badgeTone)} data-state={badgeTone} data-task={current ? currentTask : undefined} data-command={shownCommand?.tone} title={badgeTitle}><SessionActivityIcon tone={badgeTone} slot="status" className={styles.statusDot} /><span className={styles.statusLabel}><span>{badgeLabel}</span>{stateReserves.map((label) => <span key={label} aria-hidden="true">{label}</span>)}</span></Badge></div>
                  {/* The stage icon already names the CLI; the running time leads the context instead and
                      stays visible while the directory chip gives way. */}
                  {elapsed && <span className={styles.sessionElapsed} title={t('sessions.elapsedTitle', { time: elapsed })}><Icon name="clock" size={12} /><span className={styles.elapsedLabel}><span>{elapsed}</span></span></span>}
                  <div className={styles.identitySub}>
                    {/* A first flex item never wraps; this empty one takes that place so every real chip can. */}
                    <span className={styles.identitySubAnchor} aria-hidden="true" />
                    <button type="button" className={styles.pathChip} title={current.directory ? displayPath(current.directory) + ' · ' + t('sessions.copyPath') : placeOf(current)} onClick={() => void copySessionPath(current)}><Icon name={copiedState === 'path' ? 'check' : 'folder'} size={12} /><span>{copiedState === 'path' ? t('sessions.pathCopied') : <PathLabel text={stagePlace} />}</span></button>
                    {current.mode === 'yolo' && <span className={styles.modeChip} data-mode="yolo" title={t('sessions.modeYoloDesc')}>{modeLabel(current.mode)}</span>}
                    {/* A remote session that may still run reports the SSH transport's code, not the CLI's: the
                        connection banner explains it, so the title bar does not show it as a failure. */}
                    {/* A clean exit is already said by the ended status and the banner below; only a failure earns room here. */}
                    {!current.running && current.exitCode != null && current.exitCode !== 0 && !remoteSessionMayExist(current) && <span className={styles.exitCode} data-failed>{t('sessions.exitCode', { code: current.exitCode })}</span>}
                  </div>
                </div>
              </div>
              <div className={styles.stageTail}>
                <div className={styles.terminalActions} role="toolbar" aria-label={t('sessions.terminalMenu')}>
                  {/* Waiting and the temporary look stay in their own group: both are about another
                      session, while the groups after them act on the terminal in front of the user. */}
                  {/* A compact bell + count: the full sentence lives in the accessible name and tooltip, so
                      the waiting jump never pushes the terminal's own tools off the bar. */}
                  {stageAttentionTarget && <span className={styles.actionGroup}>
                    <button type="button" className={styles.stageAttention} aria-label={t('sessions.attentionJump', { count: stageAttention.length })} title={stageAttention.map((item) => item.title || item.name).join('\n')} onClick={() => { if (stageAttentionTarget) selectSession(stageAttentionTarget.session.id); }}>
                      <SessionActivityIcon tone="bell" slot="stage" className={styles.stageAttentionIcon} />
                      <span className={styles.stageAttentionCount}>{stageAttention.length}</span>
                    </button>
                  </span>}
                  <span className={`${styles.actionGroup} ${styles.runningActions}`} data-running={current.running || undefined} aria-hidden={current.running ? undefined : true}>
                    <Button variant="ghost" size="sm" className={`${styles.toolButton} ${styles.composerTrigger}`} aria-label={t('sessions.composerShort')} aria-pressed={composerOpen} title={t('sessions.composerShort') + ` (${modLabel}+Shift+M)`} disabled={!current.running} onClick={() => toggleComposer()} icon={<Icon name="pencil" size={14} />}><span className={styles.toolLabel}>{t('sessions.composerShort')}</span></Button>
                    <Button variant="ghost" size="sm" className={`${styles.toolButton} ${styles.interruptBtn}`} aria-label={t('sessions.sendInterrupt')} title={t('sessions.sendInterrupt')} disabled={!current.running} onClick={() => void (conversationOf(current.id) ? stopConversation(current.id).catch(() => {}) : sendToSession(current, '\x03'))} icon={<Icon name="ban" size={14} />}><span className={styles.toolLabel}>{t('sessions.interruptShort')}</span></Button>
                  </span>
                  {/* An ended session's banner owns its recovery actions (continue, write recovery); the toolbar
                      repeats none of them. A live session still reaches write recovery from here. */}
                  {current.running && writeRecoveryNeeded && <span className={styles.actionGroup}><Button variant="ghost" size="sm" className={`${styles.toolButton} ${styles.reattachBtn}`} aria-label={t('common.remoteWrite.open')} title={t('common.remoteWrite.unknown')} disabled={!!busy} onClick={() => requestWriteRecovery(remoteTargetId)} icon={<Icon name="alert" size={14} />}><span className={styles.toolLabel}>{t('common.remoteWrite.open')}</span></Button></span>}
                  <span className={styles.actionGroup}>
                    <IconButton size="sm" className={styles.toolButton} aria-label={t('sessions.findOutput')} aria-pressed={findOpen} title={t('sessions.findOutput') + ` (${modLabel}+Shift+F)`} onClick={openFind} icon={<Icon name="search" size={15} />} />
                    {splitRoom && <IconButton size="sm" className={styles.toolButton} data-tool="split" aria-label={t('sessions.splitView')} aria-pressed={!!split} disabled={!split && !canSplit} title={splitLabel + ` (${modLabel}+Shift+D)`} onClick={toggleSplit} icon={<Icon name="columns" size={15} />} />}
                    <IconButton size="sm" className={`${styles.toolButton} ${styles.focusBtn}`} aria-pressed={focusMode} aria-label={focusMode ? t('sessions.exitFocusMode') : t('sessions.focusMode')} title={(focusMode ? t('sessions.exitFocusMode') : t('sessions.focusMode')) + ' · ' + t('sessions.focusHint')} onClick={() => setFocusMode((value) => !value)} icon={<Icon name={focusMode ? 'minimize' : 'maximize'} size={15} />} />
                    <IconButton size="sm" className={styles.toolButton} aria-label={t('sessions.moreActions')} aria-haspopup="menu" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); openTerminalMenu(current, rect.right, rect.bottom + 6, event.currentTarget); }} onKeyDown={(event) => { if (!menuKey(event)) return; event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openTerminalMenu(current, rect.right, rect.bottom + 6, event.currentTarget); }} icon={<Icon name="more" size={15} />} />
                  </span>
                </div>
                <Button size="sm" className={styles.endBtn} data-running={current.running || undefined} onClick={() => void endSession(current)} disabled={!!busy} aria-label={current.running || remoteSessionMayExist(current) ? t('sessions.end') : t('sessions.closeTab')} title={current.running || remoteSessionMayExist(current) ? t('sessions.end') : t('sessions.closeTab')} icon={<span className={styles.endIcon}><Icon name={current.running || remoteSessionMayExist(current) ? 'square' : 'close'} size={current.running || remoteSessionMayExist(current) ? 11 : 13} /></span>}><span className={styles.statusLabel}><span>{endLabel}</span>{endReserves.map((label) => <span key={label} aria-hidden="true">{label}</span>)}</span></Button>
              </div>
              {captionSlotRef && <span ref={captionSlotRef} className={styles.captionSlot} data-chrome={windowChrome ?? undefined} />}
            </header>}

            <div className={styles.screen}>
              {/* 收到的一批审阅意见先只读展示；写入终端必须由用户在目标会话里再次确认。
                  面板绑定批次所属的会话：恢复换了会话 id 后面板跟着新会话；原会话已经不在工作台时
                  仍然保留预览与复制，避免一次恢复就把意见正文弄丢。 */}
              {feedback && feedbackPanelHere && (() => {
                const target = feedbackPanelTarget;
                // 只有看着这个会话（并且它还在本窗口）时才允许原生写入；别的主机或已离开的
                // 会话只保留只读正文与复制入口。
                const onTarget = !!current && current.id === feedback.sessionId;
                const canSend = onTarget && !!target && feedbackCanSend(feedback, target);
                const hint = feedback.state === 'prepared' ? feedbackHint(feedback, target, onTarget) : '';
                return <section className={styles.feedbackPanel} aria-label={t('sessions.feedbackTitle')} data-state={feedback.state}>
                  <header className={styles.feedbackHead}>
                    <div className={styles.feedbackIdentity}>
                      <strong className={styles.feedbackTitle}>{t('sessions.feedbackTitle')}</strong>
                      <span className={styles.feedbackMeta}>{t('sessions.feedbackSource', { review: feedback.reviewId.slice(0, 8), revision: feedback.resultRevision, count: feedback.commentCount })}</span>
                      <span className={styles.feedbackMeta} title={feedback.worktreePath}>{displayPath(feedback.worktreePath)}</span>
                    </div>
                    <div className={styles.feedbackActions}>
                      {feedback.state === 'prepared' && canSend && target
                        ? <Button size="sm" variant="primary" disabled={feedbackBusy} aria-label={t('sessions.feedbackSend')} onClick={() => void sendFeedback(feedback, target)}>{t('sessions.feedbackSend')}</Button>
                        : feedback.state === 'prepared'
                          ? <Button size="sm" disabled={feedbackBusy} aria-label={t('sessions.feedbackCopy')} onClick={() => copyFeedback(feedback)}>{t('sessions.feedbackCopy')}</Button>
                          : null}
                      {/* 界面本身不产生 sending（原生在锁内占用批次），所以进行中的提示跟随本地 busy：
                          它只说明这次请求还没回来，不声称停在哪一步。 */}
                      {feedbackBusy && <span className={styles.feedbackHint} role="status">{t('sessions.feedbackSending')}</span>}
                      {feedback.state === 'written' && <span className={styles.feedbackHint} role="status">{t('sessions.feedbackSentHint')}</span>}
                      {feedback.state === 'uncertain' && <span className={styles.feedbackHint} role="status">{t('sessions.feedbackSendUncertain')}</span>}
                      {(feedback.state === 'written' || feedback.state === 'uncertain') && <Button size="sm" variant="ghost" aria-label={t('sessions.feedbackCopy')} onClick={() => copyFeedback(feedback)}>{t('sessions.feedbackCopy')}</Button>}
                      {/* 请求在飞时不能取消暂存：条目已经被原生占用，删除会让结果无法落地。 */}
                      <Button size="sm" variant="ghost" disabled={feedbackBusy} aria-label={t('sessions.feedbackClose')} onClick={() => void dismissFeedback(feedback)}>{t('sessions.feedbackClose')}</Button>
                    </div>
                  </header>
                  {feedback.state === 'prepared' && hint && <p className={styles.feedbackHint}>{hint}</p>}
                  {feedbackError && <p className={styles.feedbackError} role="alert">{feedbackError}</p>}
                  <ol className={styles.feedbackList}>
                    {feedback.comments.map((comment, index) => <li key={comment.path + ':' + index} className={styles.feedbackItem}>
                      <span className={styles.feedbackPath}>{comment.path}:{comment.newNo ?? comment.oldNo ?? '-'} <em>{comment.kind}</em></span>
                      <pre className={styles.feedbackBody}>{comment.body}</pre>
                    </li>)}
                  </ol>
                </section>;
              })()}
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

              <div ref={canvasRef} className={styles.canvas} data-split={split ? 'true' : undefined} data-peek={peekSession ? '' : undefined}
                onKeyDownCapture={(event) => {
                  if (!menuKey(event)) return;
                  // The keyboard path opens the same menu a right-click does, anchored on the pane it
                  // acts on. Captured before xterm so the key never reaches the running CLI.
                  const host = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-pane-session]') : null;
                  const target = scopedSessions.find((item) => item.id === (host?.dataset.paneSession ?? selectedId)) ?? current;
                  event.preventDefault();
                  event.stopPropagation();
                  if (!target) return;
                  const rect = (host ?? canvasRef.current)?.getBoundingClientRect();
                  openTerminalMenu(target, rect ? rect.left + 24 : 0, rect ? rect.top + 24 : 0, null, true);
                }}
                onPointerDownCapture={(event) => {
                  const id = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-pane-session]')?.dataset.paneSession : undefined;
                  if (id && id !== selectedIdRef.current && visibleIdsRef.current.includes(id)) setSelectedId(id);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  const id = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-pane-session]')?.dataset.paneSession : undefined;
                  const target = scopedSessions.find((item) => item.id === id) ?? current;
                  if (target) openTerminalMenu(target, event.clientX, event.clientY, null, true);
                }}>
                {mountedSessions.map((session) => {
                  const pane = visibleIds.indexOf(session.id);
                  const visible = renderActive && pane >= 0;
                  const focused = renderActive && session.id === selectedId;
                  const failed = !session.running && session.exitCode != null && session.exitCode !== 0;
                  const remotePane = session.projectId?.startsWith('remote:') ? session.projectId : undefined;
                  // 适配器只在支持该能力时才带对应端口；缺少 resume 端口不能让整个工作台崩掉。
                  const canResume = sessionResumable(session);
                  // Clipboard files use the same queue; local sessions retain staged files.
                  const peeking = peekSessionId === session.id;
                  // A conversation renders its own panel: its content never reaches an xterm,
                  // and a terminal never receives conversation text.
                  const conversation = conversations.get(session.id);
                  if (conversation) return <AcpConversation key={session.id} conversation={conversation} toolName={toolName(session)} active={visible} focused={focused} pane={split ? pane : undefined} header={split && visible ? paneHeader(session) : null} onSend={(text) => promptConversation(session.id, text)} onStop={() => stopConversation(session.id)} onAnswer={(requestId, optionId) => answerConversation(session.id, requestId, optionId)} onClose={() => endSession(session)} />;
                  return <SessionTerminal key={session.id} sessionId={session.id} toolId={session.toolId} label={t('sessions.terminalLabel', { tool: toolName(session) })} active={visible} suspendInput={!!peekSession && session.id === selectedId} peeking={peeking} keepRendererWarm={renderActive && scopedSessionIds.has(session.id)} focused={focused} pane={split ? pane : undefined} running={session.running} remote={!!remotePane} onFilesPaste={(inputs) => uploads.enqueueUpload(session.id, remotePane || null, inputs)} startedAt={session.startedAt ?? firstSeenAt.current.get(session.id)} fontSize={fontSize} lineHeight={TERMINAL_LINE_HEIGHT[density]} scrollSpeed={scrollSpeed} theme={terminalMode} cursorBlink={cursorBlink} writers={writers} pending={pending} handles={handles} bridge={bridge}
                    header={split && visible ? paneHeader(session) : null}
                    overlay={<>
                      {visible && scrolledIds.has(session.id) && <button type="button" className={styles.jumpLatest} aria-label={t('sessions.jumpToBottom')} title={t('sessions.jumpToBottom')} onClick={() => { const handle = handles.current.get(session.id); handle?.scrollToBottom(); handle?.focus(); }}><Icon name="arrowDown" size={14} /><span>{t('sessions.jumpToBottom')}</span></button>}
                      {visible && dropTarget === session.id && <div className={styles.dropOverlay} aria-hidden="true"><div className={styles.dropCard}><span className={styles.dropGlyph}><Icon name="upload" size={22} /></span><strong>{t('sessions.dropHint')}</strong><span>{t('sessions.dropHintDetail', { tool: toolName(session) })}</span></div></div>}
                      {uploads.tasks[session.id] && <SessionUploadNotice task={uploads.tasks[session.id]} progressLabel={t(remotePane ? 'sessions.uploadRunningLabel' : 'sessions.pasteFilesRunningLabel')} progressText={t(remotePane ? 'sessions.uploadProgress' : 'sessions.pasteFilesProgress', { done: uploads.tasks[session.id].uploaded, total: uploads.tasks[session.id].total })} failedTitle={t(remotePane ? 'sessions.uploadFailedTitle' : 'sessions.pasteFilesFailedTitle')} retryLabel={t(remotePane ? 'sessions.uploadRetry' : 'sessions.pasteFilesRetry')} dismissLabel={t('common.dismissError')} onRetry={() => uploads.retryUpload(session.id)} onDismiss={() => uploads.dismissUploadFailure(session.id)} />}
                    </>}
                    footer={(visible || peeking) && !session.running ? <div className={styles.endedBar} data-failed={(failed && !session.reattachable) || undefined} data-connection={session.reattachable || undefined}>
                      {/* A lost SSH link is a connection state to resume, not a CLI failure. */}
                      <span className={styles.endedGlyph}><Icon name={session.reattachable ? 'server' : failed ? 'alert' : 'info'} size={15} /></span>
                      <span className={styles.endedText}><strong>{session.reattachable ? t(session.connectionState === 'unknown' ? 'sessions.sshUnknown' : 'sessions.sshDisconnectedReattachable') : t('sessions.sessionEndedBanner')}</strong>{session.exitCode != null && !session.reattachable && <span className={styles.endedCode}>{t('sessions.exitCode', { code: session.exitCode })}</span>}<span className={styles.endedDetail} title={session.reattachable && session.exitCode != null ? t('sessions.sshExitCodeHint', { code: session.exitCode }) : undefined}>{session.reattachable ? t('sessions.reattachNext') : t('sessions.endedHintShort')}</span></span>
                      {canResume && <Button variant="primary" size="sm" className={styles.endedRestart} disabled={!!busy || restoring} title={t('sessions.resumeSessionHint')} onClick={() => void reconnectLocalSession(session)} icon={<Icon name="refresh" size={13} />}><span className={styles.endedRestartLabel}>{busy === 'restore:' + session.id ? t('sessions.resumingSession') : t('sessions.resumeSession')}</span></Button>}
                      <Button variant={canResume ? 'secondary' : 'primary'} size="sm" className={styles.endedRestart} disabled={!!busy || restoring} title={session.reattachable ? t('sessions.reattachRemote') : t('sessions.restartHint')} onClick={() => void (session.reattachable ? reattachSession(session) : restartOrCloneSession(session, true))} icon={<Icon name="refresh" size={13} />}><span className={styles.endedRestartLabel}>{session.reattachable ? t(busy === 'reattach:' + session.id ? 'sessions.reattaching' : 'sessions.reattachShort') : busy === 'restart:' + session.id ? t('sessions.restarting') : t('sessions.restartSession')}</span></Button>
                      {writeRecoveryNeeded && <Button variant="primary" size="sm" className={styles.endedRestart} disabled={!!busy} title={t('common.remoteWrite.unknown')} onClick={() => requestWriteRecovery(remoteTargetId)} icon={<Icon name="alert" size={13} />}><span className={styles.endedRestartLabel}>{t('common.remoteWrite.open')}</span></Button>}
                    </div> : null} />;
                })}
                {copiedState && <div className={styles.toastPill} role="status"><Icon name={copiedState === 'empty' ? 'info' : 'check'} size={14} /><span>{copiedMessage}</span></div>}
                {peekSession && <div className={styles.peekOverlay} role="dialog" aria-label={t('sessions.peekSession')}>
                  <div className={styles.peekBar}>
                    <span className={styles.stageIcon} role="img" aria-label={toolName(peekSession)} data-tone={sessionTone(peekSession)} data-peek-icon=""><ToolIcon toolId={peekSession.toolId} size={18} /><SessionActivityIcon tone={sessionTone(peekSession)} slot="stage" className={styles.stageIconDot} /></span>
                    <h2 className={styles.peekTitle} title={peekTitle ? peekTool + ' · ' + stableTitle(peekTitle) : peekTool}>{peekTitle ? <SessionTitle title={peekTitle} /> : peekTool}</h2>
                    {/* The icon names the CLI for assistive tech; a session with its own title also
                        says it visibly, so the cover names the same CLI the stage would. */}
                    {peekTitle && <span className={styles.peekTool}>{peekTool}</span>}
                    <span className={styles.peekState}>{stateLabel(peekSession, sessionTone(peekSession))}</span>
                    <div className={styles.peekActions}>
                      <Button size="sm" variant="primary" onClick={() => selectSession(peekSession.id)}>{t('sessions.peekOpen')}</Button>
                      <Button size="sm" onClick={() => closePeek()}>{t('sessions.peekClose')}</Button>
                    </div>
                  </div>
                  <div className={styles.peekBody} />
                </div>}
              </div>
              {current?.running && composerOpen && <WorkbenchComposer active={active} toolId={current.toolId} toolName={toolName(current)} place={placeOf(current)} draft={composerDrafts[current.id] ?? ''} promptContext={sessionPromptContext(current)} promptSourceKey={current.id} workspaces={businessWorkspaces} inputRef={composerInputRef} onChange={updateComposerDraft} onFilesPaste={(files) => handles.current.get(current.id)?.pasteFiles(files)} onSubmit={() => void submitComposer()} onClose={() => toggleComposer(false)} />}
              {current && <footer className={styles.statusBar}>
                <span className={styles.statusItem} data-host={remote ? 'remote' : 'local'} title={`${t('common.host.label')}：${hostLabel}${remoteHost ? ` · ${remoteHost.user}@${remoteHost.host}` : ''}`}><Icon name={remote ? 'server' : 'monitor'} size={12} />{hostLabel}</span>
                {/* Git is one chip: branch name, a worktree glyph when this checkout is a linked worktree,
                    and a caret only when there are other checkouts to open a session in. */}
                {(gitLabel || canOpenGitMenu) && (canOpenGitMenu && current ? <span ref={worktreeSwitchRef} className={styles.worktreeSwitch} onKeyDown={worktreeMenuKeys}>
                  <button ref={gitChipRef} type="button" className={styles.gitChip} data-switch="" aria-haspopup="menu" aria-expanded={worktreeMenuOpen} aria-label={remote ? t('sessions.reviewGroup') : [gitTitle, t('sessions.worktreeMenu'), t('sessions.reviewGroup')].filter(Boolean).join(' · ')} title={gitChipTitle + '\n' + t('sessions.worktreeMenu') + '\n' + t('sessions.reviewGroup')} disabled={!!busy} onClick={() => { if (!worktreeMenuOpen) setGitReadSeq((seq) => seq + 1); setWorktreeMenuOpen(!worktreeMenuOpen); }}><Icon name={git?.worktree ? 'gitWorktree' : 'branch'} size={12} /><span className={styles.gitChipLabel}>{remote ? t('sessions.reviewGroup') : gitLabel || t('sessions.worktreeCount', { count: worktrees.length })}</span><Icon name="chevronDown" size={11} /></button>
                  {worktreeMenuOpen && <div ref={worktreeMenuRef} className={styles.worktreeMenu} role="menu" aria-label={remote ? t('sessions.reviewGroup') : t('sessions.worktreeMenu')}>
                    {!remote && <>
                    {/* Where this session is: branch (or detached commit), repository and HEAD. */}
                    <div className={styles.gitMenuHead} role="presentation">
                      <span className={styles.gitMenuGlyph}><Icon name={git?.worktree ? 'gitWorktree' : 'branch'} size={14} /></span>
                      <span className={styles.gitMenuIdentity}>
                        <strong title={gitLabel || undefined}>{git?.branch ?? (git?.commit ? t('sessions.reviewDetached') : gitLabel || t('sessions.reviewStatusUnknown'))}</strong>
                        <small>{[git?.repository ?? '', !git?.branch && git?.commit ? git.commit.slice(0, 7) : '', !codeStatusStale && codeStatus?.headOid ? codeStatus.headOid.slice(0, 7) : ''].filter(Boolean).filter((value, index, list) => list.indexOf(value) === index).join(' · ')}</small>
                      </span>
                      {git?.branch && <button type="button" className={styles.gitMenuCopy} aria-label={t('sessions.copyBranch')} title={t('sessions.copyBranch')} onClick={(event) => { event.stopPropagation(); void writeClipboard(git.branch!).then((ok) => { if (ok) flashCopied('branch'); }); }}><Icon name={copiedState === 'branch' ? 'check' : 'copy'} size={13} /></button>}
                    </div>
                    <div className={styles.worktreeMenuHead} role="presentation"><span>{t('sessions.worktreeSection')}</span>{worktreeListState === 'ready' && <em title={worktreeQuery.trim() ? t('sessions.worktreeMatchedTitle', { matched: worktreeHits, total: worktrees.length }) : undefined}>{worktreeQuery.trim() ? `${worktreeHits} / ${worktrees.length}` : worktrees.length}</em>}</div>
                    {worktreeListState === 'loading' && !gitWorktrees && <p className={styles.menuHint} role="status">{t('sessions.worktreeListLoading')}</p>}
                    {worktreeListState === 'error' && <p className={styles.menuError} role="alert">{worktreeListError}</p>}
                    {worktreeListState === 'ready' && !worktrees.length && <p className={styles.menuHint}>{t('sessions.worktreeListEmpty')}</p>}
                    {(worktrees.length >= WORKTREE_FILTER_MIN || !!worktreeQuery) && <div className={styles.worktreeFilter} role="presentation">
                      <Icon name="search" size={13} />
                      <input type="search" value={worktreeQuery} placeholder={t('sessions.worktreeFilterPlaceholder')} aria-label={t('sessions.worktreeFilterLabel')} spellCheck={false} autoComplete="off" onChange={(event) => setWorktreeQuery(event.target.value)} onKeyDown={(event) => {
                        // Escape clears a typed filter first; Home/End stay in the field.
                        if (event.key === 'Escape' && worktreeQuery) { event.preventDefault(); event.stopPropagation(); setWorktreeQuery(''); }
                        if (event.key === 'Home' || event.key === 'End') event.stopPropagation();
                        if (event.key === 'Enter') { event.preventDefault(); focusWorktreeItem(0); }
                      }} />
                    </div>}
                    {/* Rows scroll on their own; the actions and the review group below stay reachable. */}
                    <div className={styles.worktreeList} role="presentation">
                    {worktreeQuery.trim() && !shownTrees.some((tree) => !tree.current) && <p className={styles.menuHint}>{t('sessions.worktreeFilterEmpty', { query: worktreeQuery.trim() })}</p>}
                    {shownTrees.map((tree) => {
                      // An unread status stays unknown: it is never shown as "no changes".
                      const read = worktreeStatuses.get(tree.path);
                      const status = read?.status ?? null;
                      const ready = status?.state === 'ready' && status.uncommittedFiles != null;
                      // The session's own checkout counts what this session changed since it started.
                      const sessionCount = tree.current && !codeStatusStale && codeStatus?.sessionFiles != null ? codeStatus.sessionFiles : null;
                      const changes = sessionCount != null
                        ? (sessionCount > 0 ? t('sessions.worktreeStatusSession', { count: sessionCount }) : t('sessions.worktreeStatusSessionClean'))
                        : ready
                          ? (status.uncommittedFiles! > 0 ? t('sessions.worktreeStatusUncommitted', { count: status.uncommittedFiles }) : t('sessions.worktreeStatusClean'))
                          : '';
                      const tone = sessionCount != null ? (sessionCount > 0 ? 'dirty' : 'clean') : !read ? 'loading' : ready ? (status.uncommittedFiles! > 0 ? 'dirty' : 'clean') : 'unknown';
                      return <button key={tree.path} type="button" role="menuitemradio" aria-checked={tree.current} className={styles.worktreeItem} data-current={tree.current || undefined} data-status={!read ? 'loading' : status ? status.state : 'unknown'} data-environment={status?.environment ?? undefined} disabled={tree.current || !!busy} title={tree.current ? tree.path + ' · ' + t('sessions.worktreeCurrent') : t('sessions.worktreeOpenHint', { tool: toolName(current) }) + '\n' + tree.path} onClick={() => void openInWorktree(current, tree)}>
                        <Icon name={tree.current ? 'check' : 'gitWorktree'} size={13} className={styles.worktreeGlyph} />
                        <span className={styles.worktreeName}>{tree.name}</span>
                        <span className={styles.worktreeChanges} data-tone={tone} title={tone === 'unknown' ? read?.error || status?.reason || undefined : sessionCount != null ? codeStatusHint(codeStatus, false) : tone === 'clean' ? changes : undefined}><span className={styles.worktreeChangesText}>{tone === 'loading' ? t('sessions.worktreeStatusLoading') : changes || t('sessions.worktreeStatusUnknown')}</span></span>
                        <span className={styles.worktreeSub}>
                          {tree.branch && <span className={styles.worktreeBranch}><Icon name="branch" size={10} /><span>{tree.branch}</span></span>}
                          <span className={styles.worktreePath}>{shortPath(displayPath(tree.path))}</span>
                        </span>
                        <span className={styles.worktreeOpen}>{tree.current ? t('sessions.worktreeCurrent') : <><Icon name="plus" size={11} />{t('sessions.worktreeOpenAction')}</>}</span>
                      </button>;
                    })}
                    {matchedTrees > shownTrees.length && <p className={styles.menuHint} role="status">{t('sessions.worktreeMoreHidden', { count: matchedTrees - shownTrees.length })}</p>}
                    </div>
                    <div className={styles.worktreeActions} role="presentation">
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
                    </div>
                    <span className={styles.reviewDivider} role="separator" /></>}
                    <div className={styles.reviewGroup} role="group" aria-label={t('sessions.reviewGroup')} onClick={(event) => event.stopPropagation()}>
                      <div className={styles.reviewHead}>
                        <span className={styles.reviewLabel} role="presentation">{t('sessions.reviewGroup')}</span>
                        <button type="button" role="menuitem" className={styles.reviewRefresh} aria-label={t('sessions.reviewStatusRetry')} title={t('sessions.reviewStatusRetry')} disabled={!!reviewBusy} onClick={() => setCodeReadSeq((seq) => seq + 1)}><Icon name="refresh" size={12} /></button>
                      </div>
                      {remote && <p className={styles.reviewStatusLine}>{hostLabel} · {review?.worktreePath ?? current.directory}</p>}
                      {remote && review && !review.baseline && <p className={styles.reviewHint}>{t('sessions.reviewRemoteCurrent')}</p>}
                      {reviewError && <p className={styles.reviewError} role="alert">{reviewError}</p>}
                      <p className={styles.reviewState} data-tone={reviewView.tone} role="status">{reviewView.text}</p>
                      <p className={styles.reviewStatusLine} title={codeStatusHint(codeStatus, codeStatusStale)}><Icon name="branch" size={12} /><span>{codeStatusText(codeStatus, codeStatusStale)}</span></p>
                      {reviewView.tone === 'unknown' && <p className={styles.reviewHint}>{t('sessions.reviewUnknownHint')}</p>}
                      {reviewView.tone === 'unconfirmed' && <p className={styles.reviewHint}>{t('sessions.reviewUnconfirmedHint')}</p>}
                      {/* The safety note stays one hover away: it explains, it is not an action. */}
                      <button type="button" role="menuitem" className={styles.floatItem} data-accent="" disabled={!!reviewBusy || !!busy} title={t('sessions.reviewHint')} onClick={() => void startReview(current)}>
                        <Icon name={reviewRetryable ? 'refresh' : 'arrowUpRight'} size={13} />
                        <span>{reviewRetryable ? t('sessions.reviewRetry') : t('sessions.reviewStart')}</span>
                      </button>
                    </div>
                  </div>}
                </span> : <span className={styles.gitChip} title={gitChipTitle} aria-label={gitTitle}><Icon name={git?.worktree ? 'gitWorktree' : 'branch'} size={12} /><span className={styles.gitChipLabel}>{gitLabel}</span></span>)}
                {remote && <Badge className={styles.statusBadge} tone={current.connectionState === 'connected' ? 'success' : current.connectionState === 'disconnected' || current.connectionState === 'unknown' ? 'warning' : 'neutral'} title={[current.exitReason === 'connection_lost' ? t('sessions.sshConnectionLostHint') : t('sessions.sshRemoteSession'), current.connectionState === 'unknown' ? t('sessions.sshUnknown') : '', !current.running && current.exitCode != null && remoteSessionMayExist(current) ? t('sessions.sshExitCodeHint', { code: current.exitCode }) : '', current.remoteSessionId ? t('sessions.sshRemoteSessionId', { id: current.remoteSessionId }) : ''].filter(Boolean).join('\n')}>SSH · {t(current.connectionState === 'connected' ? 'sessions.sshConnected' : current.connectionState === 'connecting' ? 'sessions.sshConnecting' : current.connectionState === 'disconnected' ? 'sessions.sshDisconnectedReattachable' : current.connectionState === 'remote_ended' ? 'sessions.sshEnded' : 'sessions.sshUnknownShort')}{current.remoteEndResult && current.remoteEndResult.outcome !== 'confirmed_absent' ? ` · ${t('sessions.sshEndUnconfirmed')}${current.remoteEndResult.exitCode != null ? ` (${current.remoteEndResult.exitCode})` : ''}` : ''}</Badge>}
                <span ref={linkHintHostRef} className={`${styles.statusSpacer} ${styles.statusLinkHost}`} />
                {scrolledIds.has(current.id) && <Badge className={styles.statusBadge} tone="warning"><Icon name="arrowUp" size={12} />{t('sessions.scrolledBack')}</Badge>}
                {split && <span className={styles.statusItem} data-tone="accent"><Icon name="columns" size={12} />{t('sessions.splitView')}</span>}
                <span className={styles.statusTools}>
                  <TerminalAppearance open={appearanceOpen} theme={themePreference} fontSize={fontSize} defaultFontSize={TERMINAL_FONT_SIZE_DEFAULT} minFontSize={TERMINAL_FONT_SIZE_MIN} maxFontSize={TERMINAL_FONT_SIZE_MAX} density={density} scrollSpeed={scrollSpeed} cursorBlink={cursorBlink} soundEnabled={soundEnabled} onToggle={() => { setMenu(null); setShortcutsOpen(false); setAppearanceOpen((value) => !value); }} onClose={closeAppearance} onTheme={setTerminalTheme} onFontSize={updateFontSize} onDensity={updateDensity} onScrollSpeed={updateScrollSpeed} onCursorBlink={toggleCursorBlink} onSound={toggleSound} />
                  <WorkbenchShortcuts open={shortcutsOpen} onToggle={() => { setAppearanceOpen(false); setShortcutsOpen((value) => !value); }} onClose={closeShortcuts} />
                </span>
              </footer>}
            </div>
          </div>;
        })()}

        {((loading && !scopedSessions.length) || (selectedId && !selected)) && <div className={styles.loading} role="status"><span className={styles.loadingMark} aria-hidden="true" /><p>{t('sessions.loading')}</p></div>}
        {showEmpty && !listError && <WorkbenchEmpty tools={terminalTools} projects={availableProjects} remoteProjects={remoteProjects} remoteTargets={remoteTargets.filter((target) => target.enabled)} remoteEnabled={remoteSshEnabled} activeTargetId={activeTargetId} onTargetChange={(targetId) => { setActiveTargetId(targetId); onRemoteTargetChange?.(targetId); }} onManageHosts={() => setHostManagerOpen(true)} onNewSession={openNewSessionDialog} onOpenHome={onOpenHome} />}
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
      const session = scopedSessions.find((item) => item.id === menu.sessionId);
      if (!session) return null;
      const name = toolName(session);
      const handle = handles.current.get(session.id);
      // A conversation has no terminal text and no CLI restart command: its own entries
      // replace the terminal-only ones, and the terminal fallback stays explicit.
      const conversation = conversationOf(session.id);
      return createPortal(<div ref={menuRef} className={`${rowMenuStyles.rowMenuList} ${styles.contextMenu}`} role="menu" aria-label={menu.kind === 'session' ? t('sessions.sessionMenu', { name }) : t('sessions.terminalMenu')} style={menuBox ?? { top: 0, left: -10000 }} onKeyDown={menuNavigate} onContextMenu={(event) => event.preventDefault()} onClick={() => setMenu(null)}>
        {menu.kind === 'terminal' && menu.surface ? <>
          {/* Right-click on the terminal: only what acts on its text. Session actions stay on the
              title-bar menu, so a click while selecting can never end, restart or move the session. */}
          {menu.selection ? <>
            <button role="menuitem" onClick={() => { handle?.copySelection(); handle?.focus(); }}><Icon name="copy" size={14} /><span>{t('sessions.copySelection')}</span><kbd>{modLabel}+C</kbd></button>
            <button role="menuitem" onClick={() => { setFindQuery(menu.selection); openFind(); }}><Icon name="search" size={14} /><span className={styles.menuEllipsis}>{t('sessions.findSelection', { text: menu.selection })}</span></button>
            {session.running && <button role="menuitem" onClick={() => { const text = menu.selection; handle?.copySelection(); setComposerDrafts((current) => ({ ...current, [session.id]: current[session.id] ? `${current[session.id]}\n${text}` : text })); toggleComposer(true); }}><Icon name="pencil" size={14} /><span>{t('sessions.quoteSelection')}</span></button>}
          </> : <button role="menuitem" onClick={() => handle?.selectAll()}><Icon name="check" size={14} /><span>{t('sessions.selectAll')}</span></button>}
          {session.running && <button role="menuitem" onClick={() => void pasteIntoSession(session)}><Icon name="clipboard" size={14} /><span>{t('sessions.pasteClipboard')}</span><kbd>{modLabel}+V</kbd></button>}
          <span className={styles.menuDivider} role="separator" />
          {!menu.selection && <button role="menuitem" onClick={openFind}><Icon name="search" size={14} /><span>{t('sessions.findOutput')}</span><kbd>{modLabel}+Shift+F</kbd></button>}
          <button role="menuitem" onClick={() => void copyTerminalOutput(session)}><Icon name="clipboard" size={14} /><span>{t('sessions.copyOutput')}</span></button>
          <button role="menuitem" title={t('sessions.clearViewHint')} onClick={() => { handle?.clear(); handle?.focus(); }}><Icon name="trash" size={14} /><span>{t('sessions.clearView')}</span></button>
          <span className={styles.menuDivider} role="separator" />
          <button role="menuitem" onClick={(event) => { event.stopPropagation(); refreshLedger(); setMenu({ kind: 'terminal', sessionId: session.id, x: menu.x, y: menu.y, trigger: null, hasSelection: false, selection: '', surface: false }); }}><Icon name="more" size={14} /><span>{t('sessions.moreSessionActions')}</span></button>
        </> : menu.kind === 'terminal' ? <>
          {/* Title-bar menu: the next step for this session. Text actions live on right-click,
              list arrangement on the session list, the interrupt and display on the toolbar. */}
          {session.directory && !conversation && <button role="menuitem" disabled={!!reviewBusy || !!busy} title={t('sessions.reviewHint')} onClick={() => { selectSession(session.id, false); void startReview(session); }}><Icon name="branch" size={14} /><span>{t('sessions.taskChanges')}</span></button>}
          {session.projectId && !session.projectId.startsWith('remote:') && <button role="menuitem" onClick={() => void native.openProjectDirectory(session.projectId!).catch(() => {})}><Icon name="arrowUpRight" size={14} /><span>{t('sessions.openFolder')}</span></button>}
          {session.directory && <button role="menuitem" onClick={() => void copySessionPath(session)}><Icon name="folder" size={14} /><span>{t('sessions.copyPath')}</span></button>}
          <span className={styles.menuDivider} role="separator" />
          {conversation
            ? <button role="menuitem" disabled={!!busy} onClick={() => void launchInDirectory(session, 'acp')}><Icon name="refresh" size={14} /><span>{t('sessions.acpNewConversation')}</span></button>
            : <button role="menuitem" disabled={!!busy} title={!session.running ? t('sessions.restartHint') : undefined} onClick={() => void restartOrCloneSession(session, !session.running)}><Icon name={session.running ? 'plus' : 'refresh'} size={14} /><span>{session.running ? t('sessions.cloneSession') : t('sessions.restartSession')}</span></button>}
          {conversation && <button role="menuitem" disabled={!!busy} onClick={() => void launchInDirectory(session, 'terminal')}><Icon name="terminal" size={14} /><span>{t('sessions.acpFallbackTerminal')}</span></button>}
          {!session.projectId?.startsWith('remote:') && <button role="menuitem" onClick={() => openWorktreeSetup(setupDirectoryOf(session))}><Icon name="gitWorktree" size={14} /><span>{t('sessions.worktreeSetupOpen')}</span>{ledger.length > 0 && <span className={styles.menuCount}>{ledger.length}</span>}</button>}
          <span className={styles.menuDivider} role="separator" />
          <button role="menuitem" data-danger="true" disabled={!!busy} onClick={() => void endSession(session)}><Icon name="close" size={14} /><span>{session.running ? t('sessions.end') : t('sessions.closeTab')}</span></button>
        </> : <>
          <button role="menuitem" aria-pressed={pinnedIds.has(session.id)} onClick={() => togglePinSession(session.id)}><Icon name="pin" size={14} /><span>{pinnedIds.has(session.id) ? t('sessions.unpinSession') : t('sessions.pinSession')}</span>{pinnedIds.has(session.id) && <span className={styles.menuCheck}><Icon name="check" size={14} /></span>}</button>
          <button role="menuitem" aria-pressed={arrangement.reviewMarks.includes(session.id)} title={arrangement.reviewMarks.includes(session.id) ? t('sessions.taskClearReviewHint') : t('sessions.taskMarkReviewHint')} onClick={() => toggleReviewMark(session.id)}><Icon name="eye" size={14} /><span>{arrangement.reviewMarks.includes(session.id) ? t('sessions.taskClearReview') : t('sessions.taskMarkReview')}</span>{arrangement.reviewMarks.includes(session.id) && <span className={styles.menuCheck}><Icon name="check" size={14} /></span>}</button>
          <button role="menuitem" title={collapsedIds.has(session.id) ? undefined : t('sessions.taskCollapseHint')} onClick={() => toggleCollapseSession(session.id)}><Icon name="archive" size={14} /><span>{collapsedIds.has(session.id) ? t('sessions.taskRestore') : t('sessions.taskCollapse')}</span></button>
          {peekOffered && session.id !== selectedId && <button role="menuitem" onClick={() => openPeek(session.id)}><Icon name="eye" size={14} /><span>{t('sessions.peekSession')}</span></button>}
          {splitRoom && menu.besideId && sessions.some((item) => item.id === menu.besideId) && <button role="menuitem" onClick={() => { setPeekSessionId(null); setSelectedId(session.id); setSplit([menu.besideId!, session.id]); }}><Icon name="columns" size={14} /><span>{t('sessions.openBeside', { name: toolName(sessions.find((item) => item.id === menu.besideId)!) })}</span></button>}
          <span className={styles.menuDivider} role="separator" />
          {conversation
            ? <button role="menuitem" disabled={!!busy} onClick={() => void launchInDirectory(session, 'acp')}><Icon name="refresh" size={14} /><span>{t('sessions.acpNewConversation')}</span></button>
            : <button role="menuitem" disabled={!!busy} onClick={() => void restartOrCloneSession(session, !session.running)}><Icon name={session.running ? 'plus' : 'refresh'} size={14} /><span>{session.running ? t('sessions.cloneSession') : t('sessions.restartSession')}</span></button>}
          {conversation && <button role="menuitem" disabled={!!busy} onClick={() => void launchInDirectory(session, 'terminal')}><Icon name="terminal" size={14} /><span>{t('sessions.acpFallbackTerminal')}</span></button>}
          {session.directory && <button role="menuitem" onClick={() => void copySessionPath(session)}><Icon name="folder" size={14} /><span>{t('sessions.copyPath')}</span></button>}
          {session.projectId && !session.projectId.startsWith('remote:') && <button role="menuitem" onClick={() => void native.openProjectDirectory(session.projectId!).catch(() => {})}><Icon name="arrowUpRight" size={14} /><span>{t('sessions.openFolder')}</span></button>}
          {/* The short row menu only surfaces worktree settings when there is something to clean up. */}
          {!session.projectId?.startsWith('remote:') && ledger.length > 0 && <button role="menuitem" onClick={() => openWorktreeSetup(setupDirectoryOf(session))}><Icon name="gitWorktree" size={14} /><span>{t('sessions.worktreeSetupOpen')}</span>{ledger.length > 0 && <span className={styles.menuCount}>{ledger.length}</span>}</button>}
          <span className={styles.menuDivider} role="separator" />
          <button role="menuitem" data-danger="true" disabled={!!busy} onClick={() => void endSession(session)}><Icon name="close" size={14} /><span>{session.running ? t('sessions.end') : t('sessions.removeSession')}</span></button>
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
    {newDialogOpen && <GuideDialog open title={t('sessions.newSessionDialogTitle')} hint={t('sessions.newSessionDialogHint')} wide onClose={() => setNewDialogOpen(false)}>
      {/* Mod+Enter starts the session from any field, not only the task text: the dialog's
          defaults are usually right, so the fastest path is open, check, start. */}
      <div className={styles.dialogForm} onKeyDown={(event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key !== 'Enter' || event.nativeEvent.isComposing || event.defaultPrevented) return;
        event.preventDefault();
        if (!event.repeat && !launchingNew && effectiveLaunchToolId && !workspaceUnavailable && !acpUnavailable) void launchFromDialog();
      }}>
        {dialogError && <div className={styles.banner} role="alert"><div className={styles.bannerCopy}><p>{dialogError}</p></div></div>}
        {dialogError && savedInteraction === 'acp' && <div className={styles.dialogField}><Button size="sm" variant="secondary" disabled={launchingNew} onClick={() => void launchFromDialog('terminal')} icon={<Icon name="terminal" size={13} />}>{t('sessions.acpFallbackTerminal')}</Button></div>}
        <div className={styles.dialogPrimaryGrid}>
          <div className={styles.dialogField}><span className={styles.fieldLabel}>{t('sessions.pickToolLabel')}</span><FilterSelect label={t('sessions.pickToolLabel')} value={effectiveLaunchToolId} options={cliSelectOptions} placeholder={t('home.launcher.pickTool')} searchLabel={t('sessions.searchCliTool')} onChange={pickLaunchTool} />
            {/* One click for the CLIs used most; the list above still reaches every tool. */}
            {terminalTools.length > 1 && <div className={styles.toolPicks} role="radiogroup" aria-label={t('sessions.quickPickTools')}>{terminalTools.slice(0, DIALOG_QUICK_TOOLS).map((tool) => <button key={tool.id} type="button" role="radio" aria-checked={effectiveLaunchToolId === tool.id} aria-label={tool.name} title={tool.name} className={styles.toolPick} onClick={() => pickLaunchTool(tool.id)}><ToolIcon toolId={tool.id} size={16} /></button>)}</div>}
          </div>
          <div className={styles.dialogField}><span className={styles.fieldLabel}>{t('sessions.pickWorkspaceLabel')}</span><FilterSelect label={t('sessions.pickWorkspaceLabel')} value={workspaceValue} options={workspaceUnavailable && !workspaceSelectOptions.some((option) => option.value === workspaceValue) ? [...workspaceSelectOptions, { value: workspaceValue, label: workspaceValueLabel(workspaceValue), note: t('sessions.workspaceUnavailableFix'), disabled: true }] : workspaceSelectOptions} searchable searchLabel={t('sessions.searchWorkspace')} onPickFolder={() => void pickCustomWorkspaceFolder()} pickFolderLabel={t('sessions.pickFolder')} onChange={(value) => {
            setWorkspaceValue(value);
            const repository = activeRemoteTarget ? undefined : businessRepositoryOptions.find(option => option.value === value);
            setBusinessSelection(repository?.selection ?? null);
            if (repository) { setDialogPlace('direct'); dialogPlaceTouched.current = true; setDialogError(''); }
            let nextToolId = effectiveLaunchToolId;
            if (value.startsWith('project:')) {
              const project = availableProjects.find((item) => 'project:' + item.id === value);
              if (project?.preferredTool && terminalTools.some((item) => item.id === project.preferredTool)) { setLaunchToolId(project.preferredTool); nextToolId = project.preferredTool; }
            } else if (value.startsWith('remote:')) {
              const project = availableRemoteProjects.find((item) => 'remote:' + item.id === value);
              if (project?.preferredTool && terminalTools.some((item) => item.id === project.preferredTool)) { setLaunchToolId(project.preferredTool); nextToolId = project.preferredTool; }
            }
            if (!launchModeTouched.current) applyPreferredMode(launchSettings, dialogModeTarget(value), nextToolId);
          }} />
          {goneRemovable.length > 0 && activeRemoteTarget && <p className={styles.goneNotice} role="status" data-remote-gone="">
            <Icon name="info" size={13} />
            <span>{t('sessions.remoteGoneSummary', { count: goneRemovable.length, host: activeRemoteTarget.name })}</span>
            <button type="button" className={styles.goneAction} disabled={pruningRemote} onClick={() => void pruneGoneRemoteFolders(goneRemovable)}>{pruningRemote ? t('sessions.remoteGonePruning') : t('sessions.remoteGonePrune')}</button>
          </p>}
          </div>
        </div>
        {workspaceUnavailable && <div className={styles.workspaceMissing} role="alert" data-workspace-unavailable="">
          <Icon name="alert" size={14} />
          <span className={styles.workspaceMissingCopy}><strong>{t('sessions.workspaceUnavailable', { path: workspaceValueLabel(workspaceValue) })}</strong><small>{t('sessions.workspaceUnavailableFix')}</small></span>
          <span className={styles.workspaceMissingActions}>
            <Button size="sm" icon={<Icon name="home" size={13} />} onClick={() => { setWorkspaceValue('__home'); setBusinessSelection(null); setDialogError(''); }}>{activeRemoteTarget ? t('sessions.workspaceUseHostHome', { host: activeRemoteTarget.name }) : t('sessions.workspaceUseHome')}</Button>
            <Button size="sm" variant="ghost" icon={<Icon name="folder" size={13} />} onClick={() => void pickCustomWorkspaceFolder()}>{t('sessions.pickFolder')}</Button>
          </span>
        </div>}
        {/* The task is optional, so it follows the choices that every launch needs. */}
        <div className={styles.dialogField} data-task-field="">
          <span className={styles.fieldLabel}>{t('sessions.initialPromptLabel')}</span>
          <textarea rows={2} autoFocus className={styles.dialogTextarea} value={initialPrompt} placeholder={t('sessions.newSessionTaskPlaceholder')} aria-label={t('sessions.initialPromptLabel')} onChange={(event) => setInitialPrompt(event.target.value)} />
          <PromptPicker active={active && newDialogOpen} className={styles.dialogPrompts} labelClassName={styles.dialogPromptLabel} context={dialogPromptContext} sourceKey={`new:${workspaceValue}:${activeTargetId}`} workspaces={businessWorkspaces} onPick={(prompt) => setInitialPrompt(previous => previous ? `${previous}\n${prompt.body}` : prompt.body)} />
        </div>
        {/* Where this launch runs belongs to the summary; only its details fold away. */}
        {!activeRemoteTarget && !resumeLatest && <div className={styles.dialogField} data-place-field="">
          <div className={styles.placeRow}>
            <span className={styles.fieldLabel}>{t('sessions.worktreePlace')}</span>
            <div className={styles.placeSwitch} role="radiogroup" aria-label={t('sessions.worktreePlace')}>
              <button type="button" role="radio" aria-checked={dialogPlace === 'direct'} className={styles.placeOption} title={t('sessions.worktreePlaceDirectDesc')} onClick={() => chooseDialogPlace('direct')}><Icon name="folder" size={14} /><span>{t('sessions.worktreePlaceDirect')}</span><span className="sr-only">{t('sessions.worktreePlaceDirectDesc')}</span></button>
              <button type="button" role="radio" aria-checked={dialogPlace === 'worktree'} className={styles.placeOption} title={t('sessions.worktreePlaceNewDesc')} onClick={() => chooseDialogPlace('worktree')}><Icon name="gitWorktree" size={14} /><span>{t('sessions.worktreePlaceNew')}</span><span className="sr-only">{t('sessions.worktreePlaceNewDesc')}</span></button>
            </div>
          </div>
          {dialogPlace === 'worktree' && !dialogPrepareDirectory() && <p className={styles.baseNotice} role="status"><Icon name="info" size={14} /><span>{t('sessions.worktreeNeedsFolder')}</span></p>}
          {/* Folding never hides what a launch depends on: the base and its error stay here. */}
          {dialogPlace === 'worktree' && !advancedOpen && !!dialogPrepareDirectory() && <div className={styles.baseSummary} data-busy={baseBusy || undefined} role="status">
            <span className={styles.baseLabel}>{t('sessions.worktreeBase')}</span>
            <code className={styles.baseRef} data-loading={baseBusy && !basePreview ? '' : undefined} title={basePreview?.reference ?? undefined}>{baseBusy && !basePreview ? t('sessions.worktreeBaseLoading') : basePreview?.available ? basePreview.reference ?? '' : '—'}</code>
            {basePreview?.available && basePreview.shortCommit && <code className={styles.baseOid} title={basePreview.commit ?? undefined}>{t('sessions.worktreeBaseOid', { short: basePreview.shortCommit })}</code>}
            {basePreview && !basePreview.available && <p className={styles.baseError} role="alert">{basePreview.reason || t('sessions.worktreeBaseUnavailable')}</p>}
            {baseError && <span className={styles.baseError} role="alert"><span>{baseError}</span><Button size="sm" disabled={baseBusy} onClick={() => void updateBase()}>{t('sessions.worktreeBaseRetry')}</Button></span>}
            {baseStale && <span className={styles.baseHint} role="status">{t('sessions.worktreeBaseStale')}</span>}
          </div>}
        </div>}
        {savedInteraction === 'acp' && <div className={styles.baseSummary} role={launchAcp.usable ? 'status' : 'alert'} data-acp-launch="" data-acp-state={launchAcp.state}>
          <span className={styles.baseLabel}>{t('sessions.launchInteractionLabel')}</span>
          <strong>{launchAcp.usable
            ? t('sessions.launchInteractionAcp', { tool: selectedLaunchTool?.name ?? '' })
            : t('sessions.launchInteractionAcpUnavailable', { tool: selectedLaunchTool?.name ?? '' })}</strong>
          {/* The reason comes from the adapter's own declaration; a tool that publishes no
              entry still gets a sentence instead of an unexplained disabled button. */}
          <span className={styles.baseHint} data-acp-reason="">{launchAcp.usable
            ? t('sessions.launchInteractionAcpPlace', { place: workspaceValueLabel(workspaceValue) })
            : launchAcp.reason || t('sessions.launchAcpUnavailable', { tool: selectedLaunchTool?.name ?? '' })}</span>
          {launchAcp.state === 'unverified' && <span className={styles.baseHint} data-acp-unverified="">{t('sessions.launchInteractionAcpUnverified')}</span>}
          {launchAcp.capability?.entry?.dependency && <span className={styles.baseHint} data-acp-dependency="">{t('sessions.launchInteractionAcpDependency', { name: launchAcp.capability.entry.dependency.name, hint: launchAcp.capability.entry.dependency.installHint })}</span>}
          {!launchAcp.usable && <span className={styles.workspaceMissingActions}>
            <Button size="sm" variant="secondary" disabled={launchingNew} onClick={() => void launchFromDialog('terminal')} icon={<Icon name="terminal" size={13} />}>{t('sessions.launchInteractionAcpTerminal')}</Button>
          </span>}
        </div>}
        <div className={styles.dialogField}><span className={styles.fieldLabel}>{t('sessions.launchModeLabel')}</span><div className={styles.modeCards} role="radiogroup" aria-label={t('sessions.launchModeLabel')}>
          <button type="button" role="radio" aria-checked={launchMode === 'normal'} className={styles.modeCard} onClick={() => { launchModeTouched.current = true; setLaunchMode('normal'); }}><span className={styles.modeCardGlyph} aria-hidden="true"><Icon name="shield" size={16} /></span><span className={styles.modeCardCopy}><strong>{t('sessions.modeNormal')}</strong><small>{t('sessions.modeNormalDesc')}</small></span><span className={styles.modeCardCheck}><Icon name="check" size={12} /></span></button>
          {(() => {
            // A remote project never becomes a conversation: it keeps the terminal's YOLO.
            const yolo = activeRemoteTarget ? launchYoloSupport(selectedLaunchTool, 'terminal') : dialogYolo;
            const conversation = !activeRemoteTarget && savedInteraction === 'acp';
            const unavailable = yolo.reason === 'acp' ? t('sessions.yoloUnsupportedAcp') : t('sessions.yoloUnsupported');
            return <button type="button" role="radio" aria-checked={launchMode === 'yolo'} disabled={!yolo.available} title={yolo.available ? undefined : unavailable} data-yolo-route={conversation ? 'acp' : 'terminal'} className={styles.modeCard} onClick={() => { launchModeTouched.current = true; setLaunchMode('yolo'); }}><span className={styles.modeCardGlyph} aria-hidden="true"><Icon name="sparkle" size={16} /></span><span className={styles.modeCardCopy}><strong>{t('sessions.modeYolo')}</strong><small>{!yolo.available ? unavailable : conversation ? t('sessions.modeYoloAcpDesc') : t('sessions.modeYoloDesc')}</small></span><span className={styles.modeCardCheck}><Icon name="check" size={12} /></span></button>;
          })()}
        </div></div>
        {/* Advanced options fold away; every edited value stays in the dialog's own state. */}
        {/* Only offer the fold when it holds something for this launch. */}
        {(() => {
          const worktreeOptions = !activeRemoteTarget && !resumeLatest && dialogPlace === 'worktree' && !!dialogPrepareDirectory();
          const resumeOption = !!selectedLaunchTool?.resumeLatestAvailable && !activeRemoteTarget;
          if (!worktreeOptions && !resumeOption) return null;
          return <div className={styles.advancedRow}>
            <button type="button" className={styles.advancedToggle} aria-expanded={advancedOpen} aria-controls="new-session-advanced" onClick={() => setAdvancedOpen((value) => !value)}>
              <Icon name={advancedOpen ? 'chevronDown' : 'chevronRight'} size={12} />
              <span>{t('sessions.newSessionAdvanced')}</span>
              <small>{worktreeOptions ? t('sessions.newSessionAdvancedHint') : t('sessions.resumeLatest')}</small>
            </button>
          </div>;
        })()}
        {advancedOpen && (!activeRemoteTarget && (!!selectedLaunchTool?.resumeLatestAvailable || (!resumeLatest && dialogPlace === 'worktree' && !!dialogPrepareDirectory()))) && <div id="new-session-advanced" className={styles.advancedPanel}>
          {!activeRemoteTarget && !resumeLatest && dialogPlace === 'worktree' && (() => {
            const repoDirectory = dialogPrepareDirectory();
            if (!repoDirectory) return null;
            const baseLoading = baseBusy && !basePreview;
            const branchExplicit = !!branchDraft.trim();
            const branchShown = branchDraft.trim() || basePreview?.proposedBranch || t('sessions.worktreeBranchUnknown');
            const setupCommand = prepareTarget && sameDirectory(prepareTarget, repoDirectory) ? prepareCommand : '';
            const setupLoading = prepareSavedCommand === null && !prepareError;
            return <div className={styles.basePanel} data-busy={baseBusy || undefined}>
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
            </div>;
          })()}
          {selectedLaunchTool?.resumeLatestAvailable && !activeRemoteTarget && <label className={styles.checkboxRow}><input type="checkbox" checked={resumeLatest} onChange={(event) => setResumeLatest(event.target.checked)} /><span>{t('sessions.resumeLatest')}</span></label>}
        </div>}
        <div className={styles.dialogActions}><Button onClick={() => setNewDialogOpen(false)}>{t('common.dialog.cancel')}</Button><Button variant="primary" className={styles.dialogPrimary} data-dialog-save disabled={launchingNew || !effectiveLaunchToolId || workspaceUnavailable || acpUnavailable} title={acpUnavailable ? launchAcp.reason || t('sessions.launchAcpUnavailable', { tool: selectedLaunchTool?.name ?? '' }) : `${t('sessions.startInWorkbench')} (${modLabel}+Enter)`} aria-keyshortcuts={`${modAria}+Enter`} onClick={() => void launchFromDialog()} icon={<Icon name="play" size={14} />}>{launchingNew ? t('sessions.startingSession') : <>{t('sessions.startInWorkbench')}<kbd className={styles.dialogPrimaryKbd} aria-hidden="true">{modLabel}↵</kbd></>}</Button></div>
      </div>
    </GuideDialog>}
    {worktreeSetupDialog()}
    {remotePicker.element}
    <GuideDialog open={hostManagerOpen} title={t('sessions.manageHosts')} hint={t('settings.remoteSsh.description')} onClose={() => { setHostManagerOpen(false); setReload((value) => value + 1); }}><RemoteSshSettings enabled={remoteSshEnabled} busy={false} onChange={() => {}} showHosts showToggle={false} /></GuideDialog>
  </div>;
}
