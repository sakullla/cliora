export type LaunchMode = 'normal' | 'yolo';
export type TerminalId = 'auto' | 'workbench' | 'windows_terminal' | 'pwsh' | 'power_shell' | 'cmd' | 'mac_terminal' | 'custom' | 'gnome_terminal' | 'konsole' | 'xterm' | 'desktop';

export type TerminalOption = { id: TerminalId; label: string; available: boolean };
export type CustomTerminal = { program: string; args: string[] };
export type TerminalPreset = { id: string; label: string; program: string; args: string[] };
export type WorktreeLaunchMode = 'direct' | 'worktree';
export type LaunchSettings = { selected: TerminalId; terminals: TerminalOption[]; presets?: TerminalPreset[]; custom?: CustomTerminal | null; cliMode?: LaunchMode; projectMode?: LaunchMode; worktreeLaunch?: WorktreeLaunchMode | null; worktreeLaunchError?: string | null };

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
};

export type RemoteLaunchIntent = { kind: 'new' } | { kind: 'reattach'; remoteSessionId: string };
export type LaunchRequest = { toolId: string; projectId: string | null; sessionId: string | null; mode: LaunchMode; directory?: string | null; initialPrompt?: string | null; resumeLatest?: boolean; remoteIntent?: RemoteLaunchIntent; worktreeIntent?: WorktreeLaunchIntent; taskText?: string | null; worktree?: WorktreeLaunchOptions };
export type LaunchResult = { toolId: string; projectId: string | null; mode: LaunchMode; terminal: TerminalId; status: 'terminal_requested' | 'desktop_requested' | 'session_started'; sessionId?: string | null; remoteSessionId?: string | null; warnings?: string[] };
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
export type WorktreeLedgerEntry = { mainCheckout: string; worktreePath: string; branch: string; environment: string };
export type WorktreePrepareCommand = { mainCheckout: string; command: string };
export type WorktreeCleanupReport = { removed: boolean; needsConfirmation: boolean; detail: string };
export type RemoteSessionEndResult = { outcome: 'confirmed_absent' | 'failed' | 'unknown'; stage: string; exitCode: number | null };
export type WorkbenchSession = { id: string; toolId: string; projectId: string | null; directory: string; mode: LaunchMode; running: boolean; exitCode: number | null; startedAt?: number; connectionState?: 'connecting' | 'connected' | 'disconnected' | 'remote_ended' | 'unknown' | 'closed'; exitReason?: 'running' | 'process_exit' | 'connection_lost' | 'remote_ended' | 'unknown'; reattachable?: boolean; remoteSessionId?: string | null; remoteEndResult?: RemoteSessionEndResult | null; stateRevision?: number };
export type SavedWorkbenchSession = { id: string; toolId: string; projectId: string | null; directory: string; mode: LaunchMode; startedAt: number; stoppedAt: number | null; nativeId: string | null; accountId: string | null; contextId: string | null };
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
  /** The real session, once this record is restored. */
  session: WorkbenchSession | null;
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
export type TwiglaneReviewStatus = 'opening' | 'accepted' | 'rejected' | 'returned';
export type TwiglaneReviewOutcome = 'reviewed' | 'committed' | 'merged';
export type TwiglaneReviewState = {
  reviewId: string;
  sessionId: string;
  worktreePath: string;
  /** HEAD when the review was sent; null for an empty repository. */
  baseline: string | null;
  status: TwiglaneReviewStatus;
  reason: string | null;
  outcome: TwiglaneReviewOutcome | null;
  headOid: string | null;
  /** Unix milliseconds of the attempt, used for the 10 second unknown deadline. */
  createdAt: number;
};
/** The native result of one inbound cliora://review link. */
export type TwiglaneLinkOutcome = {
  kind: 'accepted' | 'rejected' | 'returned' | 'ignored';
  sessionId: string | null;
  reviewId: string | null;
  outcome: TwiglaneReviewOutcome | null;
  headOid: string | null;
  reason: string | null;
};
/** Real branch, HEAD and full uncommitted count of a session's own worktree. */
export type WorkbenchCodeStatus = {
  sessionId: string;
  worktreePath: string | null;
  branch: string | null;
  headOid: string | null;
  uncommittedFiles: number | null;
  state: 'ready' | 'unknown';
  reason: string | null;
};

/** A routed receipt for a pending review; the workbench re-reads that session. */
export type TwiglaneReviewSignal = { sessionId: string; token: number };
