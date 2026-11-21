import type { TerminalSemantics } from '../../adapters/contract';

/**
 * What the user has to do next with a session, as opposed to whether its process runs.
 *
 * Every surface (rail, stage title, split pane, attention entry) reads this one result, so a
 * session never reads as "working" in one place and "done" in another. Evidence only ever
 * `needsYou`, `readyReview` or `working` when something concrete supports it: a bell, an
 * adapter-recognized interface, a verified review result or an explicit user mark. An idle
 * prompt is not a result, an exit is not a delivery, and a disconnect is not a task failure.
 */
export type TaskState = 'needsYou' | 'readyReview' | 'working' | 'ended' | 'error' | 'unknown';

/** Where a task row belongs in the rail's short list. */
export type TaskBucket = 'attention' | 'review' | 'working' | 'ended' | 'unknown';

/** Everything the state layer is allowed to look at. Process and transport facts stay apart. */
export type TaskEvidence = {
  /** Native process fact: the PTY still runs. */
  running: boolean;
  /** Native exit fact; `null`/undefined means the code is not known. */
  exitCode?: number | null;
  /** A remote transport may still hold the session, so nothing about the CLI task is known. */
  remoteUnconfirmed?: boolean;
  /** Positive interface evidence from this CLI's own screen reader. */
  attention?: TerminalSemantics['attention'];
  /** A bell only supports "look at this", never a specific kind of request. */
  bell?: boolean;
  /** Shared activity evidence: this CLI is producing a turn right now. */
  outputActive?: boolean;
  /** The adapter recognized a resting screen (its composer at a prompt): it is not working. */
  resting?: boolean;
  /** The newest screen evidence is older than the last observed output. */
  stale?: boolean;
  /** The user marked this round as something to review. */
  marked?: boolean;
  /** A returned review that a real Git re-read confirmed. */
  verified?: boolean;
  /** A failure the user has not looked at yet. */
  unread?: boolean;
};

function failedExit(evidence: TaskEvidence): boolean {
  return !evidence.running && evidence.exitCode != null && evidence.exitCode !== 0;
}

/**
 * The one task state of a session. A running session that is neither waiting for a person nor
 * producing output is `unknown`: it suggests no next step, and calling it ended or delivered
 * would be a claim the evidence does not carry.
 */
export function taskStateFor(evidence: TaskEvidence): TaskState {
  if (evidence.remoteUnconfirmed) return 'unknown';
  if (!evidence.running) {
    if (failedExit(evidence)) return 'error';
    // Ended is a process fact. Only an explicit mark or a verified result claims a review.
    return evidence.marked || evidence.verified ? 'readyReview' : 'ended';
  }
  if (evidence.attention || evidence.bell) return 'needsYou';
  // A mark or a verified result outranks an idle screen, but not a turn that is producing output:
  // resumed work invalidates the "round is ready" premise on its own.
  if ((evidence.marked || evidence.verified) && !evidence.outputActive) return 'readyReview';
  if (evidence.stale) return 'unknown';
  if (evidence.outputActive) return 'working';
  return 'unknown';
}

/** The bucket a task row belongs to; an unread failure joins the attention list. */
export function taskBucketFor(state: TaskState, evidence: Pick<TaskEvidence, 'unread'> = {}): TaskBucket {
  if (state === 'needsYou') return 'attention';
  if (state === 'error' && evidence.unread) return 'attention';
  if (state === 'readyReview') return 'review';
  if (state === 'working') return 'working';
  if (state === 'unknown') return 'unknown';
  return 'ended';
}

/**
 * The i18n key naming the state. A running session the adapter could not describe keeps the
 * generic "waiting for input" wording instead of claiming an unknown outcome for a plain prompt.
 */
export function taskStateLabelKey(state: TaskState, evidence: TaskEvidence): string {
  if (state === 'needsYou') {
    if (evidence.bell && !evidence.attention) return 'sessions.bellBadge';
    return evidence.attention === 'approval' ? 'sessions.taskNeedsApproval' : 'sessions.taskNeedsAnswer';
  }
  if (state === 'readyReview') return 'sessions.taskReadyReview';
  if (state === 'working') return 'sessions.stateStreaming';
  if (state === 'error') return 'sessions.stateError';
  if (state === 'ended') return evidence.remoteUnconfirmed ? 'sessions.activityUnknown' : 'sessions.taskEnded';
  // A remote transport that may still run says the activity is unknown, not that a task failed.
  if (evidence.remoteUnconfirmed) return 'sessions.activityUnknown';
  // A running session says what its own screen shows; an ended unknown one says it is unknown.
  return evidence.running ? 'sessions.stateIdle' : 'sessions.taskUnknown';
}

/** Short suffix for a row that can say more than the state name. */
export function taskStateHintKey(state: TaskState, evidence: TaskEvidence): string | null {
  if (state === 'needsYou' && evidence.bell && !evidence.attention) return 'sessions.taskBellHint';
  if (state === 'readyReview' && evidence.verified) return 'sessions.taskReviewVerified';
  if (state === 'readyReview' && evidence.marked) return 'sessions.taskReviewMarked';
  if (state === 'unknown' && evidence.remoteUnconfirmed) return 'sessions.sshUnknownShort';
  if (state === 'unknown' && evidence.stale) return 'sessions.taskStale';
  return null;
}

/** Attention, review, working, ended and unknown in one stable order. */
export const TASK_BUCKET_ORDER: readonly TaskBucket[] = ['attention', 'review', 'working', 'ended', 'unknown'];

/**
 * Collapsed rows leave the active list but keep their own state: collapsing is display only and
 * never clears a mark, closes a process, drops a restore record or claims a review passed.
 */
export function partitionCollapsed<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  collapsed: ReadonlySet<string>,
): { active: T[]; collapsed: T[] } {
  const active: T[] = [];
  const hidden: T[] = [];
  for (const item of items) (collapsed.has(idOf(item)) ? hidden : active).push(item);
  return { active, collapsed: hidden };
}

/** True only when a returned review's own key was already re-read against real Git. */
export function reviewEvidenceVerified(reviewKey: string | null, readKey: string | null | undefined): boolean {
  return !!reviewKey && reviewKey === readKey;
}

/** Ids that stay ordered by their previous rank while new ones join the end. */
export function withRankedIds(current: readonly string[], incoming: readonly string[], limit = 200): string[] {
  const next = [...current];
  for (const id of incoming) if (!next.includes(id)) next.push(id);
  return next.slice(Math.max(0, next.length - limit));
}
