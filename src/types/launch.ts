import type { AcpSessionSnapshot } from './acp';

export type LaunchMode = 'normal' | 'yolo';
export type TerminalId = 'auto' | 'workbench' | 'windows_terminal' | 'pwsh' | 'power_shell' | 'cmd' | 'mac_terminal' | 'custom' | 'gnome_terminal' | 'konsole' | 'xterm' | 'desktop';

export type TerminalOption = { id: TerminalId; label: string; available: boolean };
export type CustomTerminal = { program: string; args: string[] };
export type TerminalPreset = { id: string; label: string; program: string; args: string[] };
export type WorktreeLaunchMode = 'direct' | 'worktree';
/** How a local new session talks to its CLI: an interactive terminal or an ACP conversation. */
export type InteractionMode = 'terminal' | 'acp';

export type LaunchSettings = { selected: TerminalId; terminals: TerminalOption[]; presets?: TerminalPreset[]; custom?: CustomTerminal | null; cliMode?: LaunchMode; projectMode?: LaunchMode; /** Independent of the terminal type, of normal/YOLO and of the worktree preference. A stored value from before this field reads as the terminal. */ interaction?: InteractionMode; /** Set only when the stored value cannot be recognized; the row is left unchanged. */ interactionError?: string | null; worktreeLaunch?: WorktreeLaunchMode | null; worktreeLaunchError?: string | null };

/** Whether a launch may create a worktree. Only an explicit creation reports stages. */
export type WorktreeLaunchIntent = 'given' | 'preference' | 'explicit' | 'prepareRetry';

/** Which commit a new worktree starts from; `default` follows the repository's own trunk. */
export type WorktreeBase =
  | { kind: 'default' }
  | { kind: 'head' }
  | { kind: 'reference'; reference: string };

/** What a creation will really start from, resolved by native Git before anything is written. */
export type WorktreeBasePreview = {
  kind: 'default' | 'head' | 'reference';
  reference: string | null;
  commit: string | null;
  shortCommit: string | null;
  /** Remote name when the base is a remote-tracking branch; the 更新 action targets it. */
  remote: string | null;
  branch: string | null;
  /** The branch the creation would allocate for the current task text; `null` when
   *  the existing branches could not be read, so the name stays unknown. */
  proposedBranch: string | null;
  /** Visible reason when the repository default could not be used unchanged. */
  degraded: string | null;
  /** Bases the user has to choose from when no default is identifiable. */
  candidates: string[];
  available: boolean;
  reason: string | null;
};

/** Ledger environment plus real Git status of one checkout the menu shows. A missing
 *  value is unknown, never zero changes or "prepared". */
export type WorktreeMenuStatus = {
  worktreePath: string | null;
  managed: boolean;
  environment: 'prepared' | 'unprepared' | null;
  branch: string | null;
  headOid: string | null;
  uncommittedFiles: number | null;
  state: 'ready' | 'unknown';
  reason: string | null;
};

export type WorktreeLaunchStage = 'creating' | 'preparing' | 'starting' | 'succeeded' | 'failed';

/** `cliora:worktree-launch` payload: only an explicit creation or a prepare retry sends it. */
export type WorktreeLaunchEvent = {
  operationId: string;
  stage: WorktreeLaunchStage;
  /** The worktree directory, once it exists. */
  worktreePath: string | null;
  branch: string | null;
  sessionId: string | null;
  error: string | null;
};

/** Options only an explicit creation or a prepare retry carries. */
export type WorktreeLaunchOptions = {
  base?: WorktreeBase;
  /** An explicit branch name; a taken name is an error, never silently renamed. */
  branch?: string;
  operationId?: string;
  /** The directory an earlier attempt created, for a prepare retry. */
  retryDirectory?: string;
};

/** A new local workbench session may follow the saved worktree preference. */
export function worktreeIntentForNewWorkbench(settings: LaunchSettings | null | undefined, options?: { desktop?: boolean; remote?: boolean; resume?: boolean }): 'given' | 'preference' {
  if (options?.desktop || options?.remote || options?.resume || settings?.selected !== 'workbench') return 'given';
  return 'preference';
}

export function preferredLaunchMode(settings: LaunchSettings | null, target: 'cli' | 'project', yoloAvailable: boolean): LaunchMode {
  const preferred = target === 'cli' ? settings?.cliMode : settings?.projectMode;
  return preferred === 'yolo' && yoloAvailable ? 'yolo' : 'normal';
}

/** Adapter-declared install range `[since, before)`. No range means not version-shaped. */
export function versionInRange(version: string | null | undefined, since?: string | null, before?: string | null): boolean {
  if (!since && !before) return true;
  const line = (value: string) => {
    const [major, minor = '0'] = value.trim().replace(/^v/, '').split('.');
    const a = Number(major), b = Number(minor);
    return Number.isInteger(a) && Number.isInteger(b) ? [a, b] as const : null;
  };
  const current = version ? line(version) : null;
  if (!current) return false;
  const start = since ? line(since) : null;
  const end = before ? line(before) : null;
  if ((since && !start) || (before && !end)) return false;
  if (start && (current[0] < start[0] || (current[0] === start[0] && current[1] < start[1]))) return false;
  if (end && (current[0] > end[0] || (current[0] === end[0] && current[1] >= end[1]))) return false;
  return true;
}

export type Project = {
  id: string;
  name: string;
  path: string | null;
  available: boolean;
  preferredTool: string | null;
  lastOpened: number;
  modelOverrides: Record<string, string>;
  selectedProfiles: Record<string, string>;
  appliedProfiles: Record<string, string>;
  reapplyProfiles: Record<string, string>;
  /** Created only as the launch context of a business-project repository; listed under that project. */
  workspaceBacked?: boolean;
};

export type RemoteLaunchIntent = { kind: 'new' } | { kind: 'reattach'; remoteSessionId: string };
export type LaunchRequest = { workspaceId?: string; repositoryId?: string; toolId: string; projectId: string | null; sessionId: string | null; mode: LaunchMode; directory?: string | null; initialPrompt?: string | null; resumeLatest?: boolean; remoteIntent?: RemoteLaunchIntent; worktreeIntent?: WorktreeLaunchIntent; taskText?: string | null; worktree?: WorktreeLaunchOptions; /** Native agent roster selection for a new session; only CLIs that publish `agentLaunchAvailable` honor it. */ agent?: string | null; /** Session-only parameter values validated against the adapter's published options for the resolved installation; absent adds no arguments. */ sessionOptions?: Record<string, string> | null; /** Explicit interaction for this launch only. Absent follows the stored preference; 'terminal' is how a failed ACP start retries in the same directory. */ interaction?: InteractionMode | null; /** The agent's own session (an acp_native_sessions entry) a new ACP conversation continues: session/resume when declared, else session/load. Implies interaction 'acp'; never with sessionId, resumeLatest or a new worktree. A resume that does not happen starts a new session and does not send initialPrompt. */ resumeNativeId?: string | null };
/** Which host actually owns the session: the terminal PTY or the shared ACP host. */
export type LaunchResult = { toolId: string; projectId: string | null; mode: LaunchMode; terminal: TerminalId; interaction: InteractionMode; status: 'terminal_requested' | 'desktop_requested' | 'session_started' | 'acp_started'; sessionId?: string | null; remoteSessionId?: string | null; warnings?: string[] };
/** Recent session output: a mode prelude plus the retained bytes, ending at stream offset `endOffset`. */
export type WorkbenchReplay = { dataBase64: string; endOffset: number; cols: number; rows: number };
export type WorkbenchTerminalSize = { cols: number; rows: number };
/** `cliora:session-output` payload. `offset` numbers the first byte within the session stream. */
export type WorkbenchOutput = { sessionId: string; dataBase64: string; offset?: number };
export type WorkbenchExit = { sessionId: string; exitCode: number | null; stateRevision?: number };
/** Best-effort Git hint for a local session directory. */
export type WorkbenchGitContext = { branch: string | null; commit: string | null; worktree: string | null; repository: string | null };
/** One checkout of the repository a local session sits in (main or linked worktree). */
export type WorkbenchWorktree = { name: string; branch: string | null; path: string; current: boolean };
/** `missing`: the directory is gone (usually removed by another tool); removing only forgets it. */
export type WorktreeLedgerEntry = { mainCheckout: string; worktreePath: string; branch: string; environment: string; missing?: boolean };
export type WorktreePrepareCommand = { mainCheckout: string; command: string };
export type WorktreeCleanupReport = { removed: boolean; needsConfirmation: boolean; detail: string };
export type RemoteSessionEndResult = { outcome: 'confirmed_absent' | 'failed' | 'unknown'; stage: string; exitCode: number | null };
export type WorkbenchSession = { id: string; toolId: string; projectId: string | null; directory: string; mode: LaunchMode; running: boolean; exitCode: number | null; startedAt?: number; connectionState?: 'connecting' | 'connected' | 'disconnected' | 'remote_ended' | 'unknown' | 'closed'; exitReason?: 'running' | 'process_exit' | 'connection_lost' | 'remote_ended' | 'unknown'; reattachable?: boolean; remoteSessionId?: string | null; remoteEndResult?: RemoteSessionEndResult | null; stateRevision?: number };
export type SavedWorkbenchSession = { id: string; toolId: string; projectId: string | null; directory: string; mode: LaunchMode; /** Absent on a record written before the field existed; that tab was a terminal. */ interaction?: InteractionMode; startedAt: number; stoppedAt: number | null; nativeId: string | null; accountId: string | null; contextId: string | null };
export type WorkbenchRestoreCandidate = { nativeId: string; title: string; startedAt: number | null; updatedAt: number | null };
export type WorkbenchRestoreReport = { restored: Record<string, string>; failures: Array<{ session: SavedWorkbenchSession; detail: string; candidates: WorkbenchRestoreCandidate[] }> };
export type WorkbenchRestoreStage = 'discovering' | 'starting' | 'restored' | 'failed';
/** `cliora:workbench-restore` payload: one saved record's own progress, sent per record. */
export type WorkbenchRestoreEvent = {
  /** One restore call shares one id; a retry or a manual restore gets its own. */
  restoreId: string;
  savedSessionId: string;
  stage: WorkbenchRestoreStage;
  detail: string | null;
  candidates: WorkbenchRestoreCandidate[];
  /** The real terminal session, once this record is restored. */
  session: WorkbenchSession | null;
  /** The live conversation, once an ACP record is restored: a conversation is
   *  not a PTY session, so it publishes its own snapshot. */
  acpSession?: AcpSessionSnapshot | null;
};
export type TrayStatus = { available: boolean; error: string | null };

export type TrayRepairTarget = {
  page: 'home' | 'connections' | 'settings';
  resourceView?: 'config' | 'mcp' | 'skills' | null;
  toolId: string | null;
  scope: 'global' | 'project' | null;
  projectId: string | null;
  projectPath: string | null;
  profileId: string | null;
  sequence: number;
};

export type RemoteSessionIndexEntry = { remoteSessionId: string; projectId: string; targetId: string; toolId: string; directory: string; mode: LaunchMode; startedAt: number; lastSeenAt: number };

/** One review cliora asked Twiglane to open; only the native registry owns this state. */
export type TwiglaneReviewStatus = 'opening' | 'preparing' | 'accepted' | 'rejected' | 'returned';
/** Git work actually done in Twiglane; `reviewed` means no commit or merge, not "only looked". */
export type TwiglaneReviewOutcome = 'reviewed' | 'committed' | 'merged';
/** Twiglane's claim about the worktree when it returned; always re-checked against real Git. */
export type TwiglaneWorktreeState = 'clean' | 'dirty' | 'unknown';
export type TwiglaneReviewState = {
  resultRevision: number;
  protocolVersion: 1 | 2 | 3;
  remoteCheck?: WorkbenchCodeStatus;
  workspaceId: string | null;
  repositoryId: string | null;
  workspaceName: string | null;
  reviewId: string;
  sessionId: string;
  worktreePath: string;
  /** HEAD when the review was sent; null for an empty repository. */
  baseline: string | null;
  status: TwiglaneReviewStatus;
  reason: string | null;
  outcome: TwiglaneReviewOutcome | null;
  headOid: string | null;
  /** The returned worktree claim (protocol v2); null before a return. */
  worktreeState: TwiglaneWorktreeState | null;
  /** Bounded descriptive metadata from the return, keyed `namespace.name`; never drives a verdict. */
  meta: Record<string, string>;
  /** Unix milliseconds of the attempt, used for the 10 second unknown deadline. */
  createdAt: number;
};
/** The native result of one inbound cliora://review link. */
export type TwiglaneLinkOutcome = {
  kind: 'opening' | 'accepted' | 'rejected' | 'returned' | 'ignored';
  remoteTargetId?: string;
  sessionId: string | null;
  reviewId: string | null;
  outcome: TwiglaneReviewOutcome | null;
  headOid: string | null;
  worktreeState: TwiglaneWorktreeState | null;
  reason: string | null;
};
/** Real branch, HEAD and full uncommitted count of a session's own worktree. */
export type WorkbenchCodeStatus = {
  sessionId: string;
  worktreePath: string | null;
  branch: string | null;
  headOid: string | null;
  uncommittedFiles: number | null;
  /** Files this session changed since it started here; null without a start record. */
  sessionFiles?: number | null;
  /** HEAD when the session started in this worktree. */
  sessionBase?: string | null;
  state: 'ready' | 'unknown';
  reason: string | null;
};

/** A routed receipt for a pending review; the workbench re-reads that session. */
export type TwiglaneReviewSignal = { sessionId: string; token: number };

/** One prepared line-anchored comment from Twiglane feedback-v1; read-only until the user confirms. */
export type TwiglaneFeedbackComment = {
  path: string;
  kind: 'add' | 'del' | 'context';
  oldNo: number | null;
  newNo: number | null;
  body: string;
};

/**
 * A batch of review comments received through cliora://review-feedback. Receiving only produces
 * this preview: no CLI launch, no PTY write and no Git. `written` means the batch was written to
 * the terminal once, never that the agent accepted it.
 */
export type TwiglaneFeedbackPreview = {
  feedbackId: string;
  reviewId: string;
  sessionId: string;
  resultRevision: number;
  worktreePath: string;
  rangeVersion: string;
  commentCount: number;
  comments: TwiglaneFeedbackComment[];
  /**
   * `prepared`: nothing written yet. `sending`: one write is in flight. `written`: written to the
   * terminal once. `uncertain`: a write was attempted with an unknown result, so the batch can only
   * be copied from then on and never sent again.
   */
  state: 'prepared' | 'sending' | 'written' | 'uncertain';
};

/** The result of one confirmed send; `written` is a PTY fact, not an agent acceptance. */
export type TwiglaneFeedbackSendOutcome = { feedbackId: string; sessionId: string; state: 'written' | 'uncertain' };

