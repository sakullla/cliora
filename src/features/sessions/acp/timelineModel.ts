import type { AcpSessionSnapshot, AcpTimelineItem, AcpToolCall, AcpToolKind, AcpTurnReason } from '../../../types/acp';

export type AcpToolItem = Extract<AcpTimelineItem, { kind: 'tool' }>;
export type AcpMessageItem = Extract<AcpTimelineItem, { kind: 'message' }>;
/** What a work process holds: thoughts, interim agent text, tool calls and quiet notices. */
export type ProcessItem = Extract<AcpTimelineItem, { kind: 'message' | 'tool' | 'notice' }>;

export type ToolGroupKindCount = {
  kind: AcpToolKind;
  count: number;
};

/** One entry of a process summary: a tool kind, or the turn's thoughts. */
export type ProcessKindCount = {
  kind: AcpToolKind | 'thought';
  count: number;
};

export type ProcessSummary = {
  /** Tool calls plus thoughts; interim text and notices are not steps. */
  steps: number;
  /** Tool kinds in first-seen order, then thoughts. */
  kinds: ProcessKindCount[];
  failed: number;
  /** Distinct files a diff or an edit/delete/move call touched. */
  files: number;
};

/** What the open turn is doing now, told on the last line of its process. */
export type ProcessActivity =
  | { kind: 'waiting' }
  | { kind: 'replying' }
  | { kind: 'thinking' }
  | { kind: 'running'; title: string }
  | { kind: 'working' };

export type TimelineSegment =
  | { kind: 'item'; item: AcpTimelineItem }
  | {
      kind: 'toolGroup';
      /** Stable across appends to the same consecutive run (keyed by the first tool id). */
      id: string;
      turnId: string;
      subagent: string | null;
      items: AcpToolItem[];
      /** Counts per tool kind in first-seen order within this group. */
      kindCounts: ToolGroupKindCount[];
    }
  | {
      /** Agent messages that arrived before the first prompt (R4). */
      kind: 'startup';
      /** Keyed by the first message id, so it is stable while more arrive. */
      id: string;
      items: AcpMessageItem[];
    }
  | {
      /** A turn's work between the prompt and its last tool call (R14). */
      kind: 'process';
      /** Keyed by the first item id, so it is stable while the turn grows. */
      id: string;
      turnId: string;
      items: ProcessItem[];
      /** The turn has ended (or can no longer continue). */
      ended: boolean;
      /** Ended by a stop or a lost connection, or with a call still running: stays open. */
      interrupted: boolean;
      reason: AcpTurnReason | '';
      /** The last process of its turn: it carries the turn's current activity. */
      tail: boolean;
      /** Set on the tail of an open turn only. */
      activity: ProcessActivity | null;
      summary: ProcessSummary;
    };

export type SegmentOptions = {
  /** A turn is in flight, so the last round has not ended yet. */
  turnOpen?: boolean;
  /** Request ids still waiting for an answer; a tool call that waits stays outside its process. */
  pending?: Iterable<string>;
};

/** Read-only / lookup tool kinds eligible for consecutive completed grouping (R3). */
export const GROUPABLE_TOOL_KINDS: ReadonlySet<AcpToolKind> = new Set([
  'read',
  'search',
  'fetch',
  'think',
  'other',
]);

/**
 * Whether a single tool call can be folded into a consecutive lightweight step group:
 * must be completed, have a lightweight read/lookup kind, carry no authorization
 * request, and contain neither file diffs nor embedded terminals.
 */
export function isGroupableTool(call: AcpToolCall): boolean {
  if (call.status !== 'completed') return false;
  if (!GROUPABLE_TOOL_KINDS.has(call.toolKind)) return false;
  if (call.permission !== null && call.permission !== undefined) return false;
  const content = call.content ?? [];
  for (const piece of content) {
    if (piece.type === 'diff' || piece.type === 'terminal') return false;
  }
  return true;
}

/** Count tool calls by `toolKind`, preserving first-seen order. */
export function summarizeToolGroupKinds(items: readonly AcpToolCall[]): ToolGroupKindCount[] {
  const counts = new Map<AcpToolKind, number>();
  for (const item of items) {
    const kind: AcpToolKind = item.toolKind ?? 'other';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const summary: ToolGroupKindCount[] = [];
  for (const [kind, count] of counts) summary.push({ kind, count });
  return summary;
}

/**
 * View-layer grouping of consecutive completed lightweight tools within the same
 * turn and subagent. A run of >= 2 matching tools collapses into a `toolGroup`;
 * singletons and all active, failed, mutating, executing, diff-bearing,
 * terminal-bearing, or permission-bearing tools remain standalone items.
 */
export function groupTimelineItems(items: readonly AcpTimelineItem[]): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let run: AcpToolItem[] = [];

  const flush = () => {
    if (!run.length) return;
    if (run.length === 1) {
      segments.push({ kind: 'item', item: run[0] });
    } else {
      const first = run[0];
      segments.push({
        kind: 'toolGroup',
        id: `tool-group:${first.id}`,
        turnId: first.turnId,
        subagent: first.subagent ?? null,
        items: run,
        kindCounts: summarizeToolGroupKinds(run),
      });
    }
    run = [];
  };

  for (const item of items) {
    if (item.kind === 'tool' && isGroupableTool(item)) {
      const prev = run[run.length - 1];
      if (prev && (prev.turnId !== item.turnId || (prev.subagent ?? null) !== (item.subagent ?? null))) {
        flush();
      }
      run.push(item);
    } else {
      flush();
      segments.push({ kind: 'item', item });
    }
  }
  flush();

  return segments;
}

/** Map each grouped tool item's `id` to its enclosing `toolGroup` segment `id`. */
export function toolGroupIdByItem(segments: readonly TimelineSegment[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const segment of segments) {
    if (segment.kind !== 'toolGroup') continue;
    for (const item of segment.items) map.set(item.id, segment.id);
  }
  return map;
}

/** How a snapshot's state shapes its segments: whether a turn runs, and which requests wait. */
export function segmentOptions(snapshot: Pick<AcpSessionSnapshot, 'state' | 'pending'>): SegmentOptions {
  const live = snapshot.state !== 'closed' && snapshot.state !== 'failed';
  return {
    turnOpen: snapshot.state === 'running' || snapshot.state === 'stopping' || snapshot.state === 'waiting_permission',
    pending: live ? snapshot.pending ?? [] : [],
  };
}

/** The conversation's own prompt: it starts a round. A subagent's prompt does not. */
function startsRound(item: AcpTimelineItem): boolean {
  return item.kind === 'message' && item.role === 'user' && item.subagent == null;
}

function ownSubagent(item: AcpTimelineItem): string | null {
  return 'subagent' in item ? item.subagent ?? null : null;
}

function toolActive(call: Pick<AcpToolCall, 'status'>): boolean {
  return call.status === 'pending' || call.status === 'in_progress';
}

function waitingRequest(item: AcpTimelineItem): string | null {
  switch (item.kind) {
    case 'tool': return item.permission?.requestId ?? null;
    case 'access': return item.decision === 'pending' ? item.requestId : null;
    case 'elicitation': return item.decision === 'pending' ? item.requestId : null;
    default: return null;
  }
}

const KNOWN_KINDS: ReadonlySet<string> = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']);
const FILE_KINDS: ReadonlySet<string> = new Set(['edit', 'delete', 'move']);

/** Count a process: steps by kind (tools first-seen, then thoughts), failures and changed files. */
export function summarizeProcess(items: readonly ProcessItem[]): ProcessSummary {
  const tools = new Map<AcpToolKind, number>();
  const files = new Set<string>();
  let thoughts = 0;
  let failed = 0;
  for (const item of items) {
    if (item.kind === 'message') {
      if (item.role === 'thought') thoughts += 1;
      continue;
    }
    if (item.kind !== 'tool') continue;
    const kind: AcpToolKind = KNOWN_KINDS.has(item.toolKind ?? '') ? item.toolKind : 'other';
    tools.set(kind, (tools.get(kind) ?? 0) + 1);
    if (item.status === 'failed') failed += 1;
    for (const piece of item.content ?? []) {
      if (piece.type === 'diff' && piece.path) files.add(piece.path);
    }
    if (FILE_KINDS.has(kind)) {
      for (const location of item.locations ?? []) if (location.path) files.add(location.path);
    }
  }
  const kinds: ProcessKindCount[] = [];
  let steps = thoughts;
  for (const [kind, count] of tools) {
    kinds.push({ kind, count });
    steps += count;
  }
  if (thoughts) kinds.push({ kind: 'thought', count: thoughts });
  return { steps, kinds, failed, files: files.size };
}

type Round = {
  turnId: string;
  ended: boolean;
  interrupted: boolean;
  reason: AcpTurnReason | '';
  activity: ProcessActivity | null;
};

/**
 * The view's segments, in timeline order (R4, R14). Nothing is reordered or dropped:
 *
 * - startup: the agent's own messages before the first prompt (turn '' and no
 *   subagent) fold into one entry. Without any prompt nothing folds.
 * - process: within a round (a prompt and what follows it in the same turn), the
 *   thoughts, interim agent text, tool calls and quiet notices from the prompt up to
 *   the turn's last tool call. A card that waits for an answer (approval, form, a
 *   tool's authorization), a subagent, an error notice or anything from another turn
 *   splits it, staying in its own place. A round without tool calls has no process;
 *   what follows its last tool call is the reply.
 * - toolGroup: outside a process (subagents, items without a round), consecutive
 *   completed lightweight tool calls still fold as before.
 */
export function buildSegments(timeline: readonly AcpTimelineItem[], options: SegmentOptions = {}): TimelineSegment[] {
  const turnOpen = options.turnOpen ?? false;
  const pending = new Set(options.pending ?? []);
  const count = timeline.length;
  const starts: number[] = [];
  for (let index = 0; index < count; index += 1) if (startsRound(timeline[index])) starts.push(index);

  const startup = new Set<number>();
  if (starts.length) {
    for (let index = 0; index < starts[0]; index += 1) {
      const item = timeline[index];
      if (item.kind === 'message' && item.subagent == null && item.turnId === '' && (item.role === 'agent' || item.role === 'thought')) startup.add(index);
    }
  }

  // Which round's process each index belongs to (-1: none).
  const processOf = new Array<number>(count).fill(-1);
  const rounds: Round[] = [];
  for (let round = 0; round < starts.length; round += 1) {
    const start = starts[round];
    const end = round + 1 < starts.length ? starts[round + 1] : count;
    const turnId = timeline[start].turnId;
    const member = (item: AcpTimelineItem) => item.turnId === turnId && ownSubagent(item) == null;
    let lastTool = -1;
    let reason: AcpTurnReason | '' = '';
    let ended = round + 1 < starts.length || !turnOpen;
    let waiting = false;
    for (let index = start + 1; index < end; index += 1) {
      const item = timeline[index];
      const request = waitingRequest(item);
      if (request && pending.has(request)) waiting = true;
      if (!member(item)) continue;
      if (item.kind === 'tool') lastTool = index;
      if (item.kind === 'turn') { reason = item.reason; ended = true; }
    }
    const last = lastTool >= 0 ? timeline[lastTool] : null;
    const interrupted = ended && (reason === 'cancelled' || reason === 'disconnected' || (last?.kind === 'tool' && toolActive(last)));

    let lastProcessed: ProcessItem | null = null;
    for (let index = start + 1; index <= lastTool; index += 1) {
      const item = timeline[index];
      if (!member(item)) continue;
      const processable = (item.kind === 'message' && (item.role === 'agent' || item.role === 'thought'))
        || (item.kind === 'tool' && !(item.permission && pending.has(item.permission.requestId)))
        || (item.kind === 'notice' && item.level !== 'error');
      if (!processable) continue;
      processOf[index] = round;
      lastProcessed = item as ProcessItem;
    }

    let activity: ProcessActivity | null = null;
    if (!ended && lastTool >= 0) {
      let after: 'agent' | 'thought' | null = null;
      for (let index = lastTool + 1; index < end; index += 1) {
        const item = timeline[index];
        if (!member(item) || item.kind !== 'message') continue;
        if (item.role === 'agent') after = 'agent';
        else if (item.role === 'thought' && after !== 'agent') after = 'thought';
      }
      if (waiting) activity = { kind: 'waiting' };
      else if (after === 'agent') activity = { kind: 'replying' };
      else if (after === 'thought') activity = { kind: 'thinking' };
      else if (lastProcessed?.kind === 'tool' && toolActive(lastProcessed)) activity = { kind: 'running', title: lastProcessed.title || lastProcessed.callId };
      else if (lastProcessed?.kind === 'message' && lastProcessed.role === 'thought') activity = { kind: 'thinking' };
      else activity = { kind: 'working' };
    }
    rounds.push({ turnId, ended, interrupted, reason, activity });
  }

  const segments: TimelineSegment[] = [];
  const tails = new Map<number, number>();
  let run: AcpToolItem[] = [];
  let chunk: ProcessItem[] = [];
  let chunkRound = -1;
  let opening: AcpMessageItem[] = [];

  const flushRun = () => {
    if (!run.length) return;
    if (run.length === 1) {
      segments.push({ kind: 'item', item: run[0] });
    } else {
      const first = run[0];
      segments.push({
        kind: 'toolGroup',
        id: `tool-group:${first.id}`,
        turnId: first.turnId,
        subagent: first.subagent ?? null,
        items: run,
        kindCounts: summarizeToolGroupKinds(run),
      });
    }
    run = [];
  };
  const flushChunk = () => {
    if (!chunk.length) return;
    const round = rounds[chunkRound];
    tails.set(chunkRound, segments.length);
    segments.push({
      kind: 'process',
      id: `process:${chunk[0].id}`,
      turnId: round.turnId,
      items: chunk,
      ended: round.ended,
      interrupted: round.interrupted,
      reason: round.reason,
      tail: false,
      activity: null,
      summary: summarizeProcess(chunk),
    });
    chunk = [];
    chunkRound = -1;
  };
  const flushOpening = () => {
    if (!opening.length) return;
    segments.push({ kind: 'startup', id: `startup:${opening[0].id}`, items: opening });
    opening = [];
  };

  for (let index = 0; index < count; index += 1) {
    const item = timeline[index];
    if (startup.has(index)) {
      flushRun();
      flushChunk();
      opening.push(item as AcpMessageItem);
      continue;
    }
    flushOpening();
    const round = processOf[index];
    if (round >= 0) {
      flushRun();
      if (chunkRound !== round) flushChunk();
      chunk.push(item as ProcessItem);
      chunkRound = round;
      continue;
    }
    flushChunk();
    if (item.kind === 'tool' && isGroupableTool(item)) {
      const prev = run[run.length - 1];
      if (prev && (prev.turnId !== item.turnId || (prev.subagent ?? null) !== (item.subagent ?? null))) flushRun();
      run.push(item);
    } else {
      flushRun();
      segments.push({ kind: 'item', item });
    }
  }
  flushOpening();
  flushChunk();
  flushRun();

  for (const [round, index] of tails) {
    const segment = segments[index];
    if (segment.kind !== 'process') continue;
    segments[index] = { ...segment, tail: true, activity: rounds[round].activity };
  }
  return segments;
}

/** A step's folded summary (its first location or diff path), unless the title already
 *  says it: an edit titled with its path, or a read titled with the file it read, shows
 *  the path once. */
export function stepSummaryShown(call: Pick<AcpToolCall, 'title' | 'callId' | 'locations' | 'content'>, summary: string): string {
  if (!summary) return '';
  const title = call.title || call.callId;
  if (title.includes(summary)) return '';
  const location = call.locations[0];
  const diff = call.content.find((content) => content.type === 'diff');
  const path = location?.path ?? (diff && diff.type === 'diff' ? diff.path : '');
  return path && title.includes(path) ? '' : summary;
}

/** The key the view renders a segment under. */
export function segmentKey(segment: TimelineSegment): string {
  return segment.kind === 'item' ? segment.item.id : segment.id;
}

function sameItems(a: readonly AcpTimelineItem[], b: readonly AcpTimelineItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

function sameActivity(a: ProcessActivity | null, b: ProcessActivity | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind !== 'running' || (b.kind === 'running' && a.title === b.title);
}

/** Two segments render the same: same kind and key, the very same item objects and the
 *  same turn state. Counts and summaries derive from the items, so they match too. */
export function sameSegment(a: TimelineSegment, b: TimelineSegment): boolean {
  if (a === b) return true;
  switch (a.kind) {
    case 'item': return b.kind === 'item' && a.item === b.item;
    case 'toolGroup': return b.kind === 'toolGroup' && a.id === b.id && a.turnId === b.turnId && a.subagent === b.subagent && sameItems(a.items, b.items);
    case 'startup': return b.kind === 'startup' && a.id === b.id && sameItems(a.items, b.items);
    case 'process': return b.kind === 'process' && a.id === b.id && a.turnId === b.turnId && a.ended === b.ended
      && a.interrupted === b.interrupted && a.reason === b.reason && a.tail === b.tail
      && sameActivity(a.activity, b.activity) && sameItems(a.items, b.items);
    default: return false;
  }
}

/** Builds the segments of one growing timeline, reusing what has not changed. */
export type SegmentBuilder = (timeline: readonly AcpTimelineItem[], options?: SegmentOptions) => TimelineSegment[];

/**
 * An incremental `buildSegments` for one view (R13). The result always equals
 * `buildSegments(timeline, options)`, but:
 *
 * - everything before the last round's prompt (when an earlier prompt exists) depends
 *   only on those items and the pending requests, never on a running turn, so it is
 *   rebuilt only when one of those item objects changed. A streamed chunk or a merged
 *   tool update in the last round recomputes that round alone.
 * - every segment that renders the same as before (same items by reference, same turn
 *   state) is the previous object, and an unchanged result is the previous array, so
 *   memoized rows and derived maps skip their work.
 *
 * The host replaces item objects only when they change, and a snapshot (a trim, a
 * replay) brings new objects, which simply misses the cache.
 */
export function createSegmentBuilder(): SegmentBuilder {
  let lastTimeline: readonly AcpTimelineItem[] | null = null;
  let lastPendingKey = '';
  let lastTurnOpen = false;
  let result: TimelineSegment[] = [];
  let prefix: { split: number; items: readonly AcpTimelineItem[]; pendingKey: string; segments: TimelineSegment[] } | null = null;

  function prefixValid(timeline: readonly AcpTimelineItem[], split: number, pendingKey: string): boolean {
    if (!prefix || prefix.split !== split || prefix.pendingKey !== pendingKey) return false;
    const items = prefix.items;
    for (let index = 0; index < split; index += 1) if (timeline[index] !== items[index]) return false;
    return true;
  }

  return (timeline, options = {}) => {
    const pendingList = [...(options.pending ?? [])];
    const pendingKey = pendingList.join('\u0000');
    const turnOpen = options.turnOpen ?? false;
    if (timeline === lastTimeline && pendingKey === lastPendingKey && turnOpen === lastTurnOpen) return result;

    let split = -1;
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      if (!startsRound(timeline[index])) continue;
      split = index;
      break;
    }
    let earlier = false;
    for (let index = split - 1; index >= 0; index -= 1) {
      if (startsRound(timeline[index])) { earlier = true; break; }
    }

    let next: TimelineSegment[];
    if (split > 0 && earlier) {
      if (!prefixValid(timeline, split, pendingKey)) {
        const items = timeline.slice(0, split);
        prefix = { split, items, pendingKey, segments: buildSegments(items, { turnOpen: false, pending: pendingList }) };
      }
      next = [...prefix!.segments, ...buildSegments(timeline.slice(split), { turnOpen, pending: pendingList })];
    } else {
      prefix = null;
      next = buildSegments(timeline, { turnOpen, pending: pendingList });
    }

    const previous = new Map<string, TimelineSegment>();
    for (const segment of result) previous.set(segmentKey(segment), segment);
    let unchanged = next.length === result.length;
    for (let index = 0; index < next.length; index += 1) {
      const old = previous.get(segmentKey(next[index]));
      if (old && sameSegment(old, next[index])) next[index] = old;
      if (next[index] !== result[index]) unchanged = false;
    }
    // The cached prefix keeps the reused objects, so the next hit needs no reconciling.
    if (prefix) prefix.segments = next.slice(0, prefix.segments.length);
    lastTimeline = timeline;
    lastPendingKey = pendingKey;
    lastTurnOpen = turnOpen;
    if (!unchanged) result = next;
    return result;
  };
}

function agentContent(segment: TimelineSegment): boolean {
  switch (segment.kind) {
    case 'process': return true;
    case 'toolGroup': return segment.subagent == null;
    case 'item': {
      const item = segment.item;
      if (item.kind === 'message') return item.subagent == null && (item.role === 'agent' || item.role === 'thought');
      return item.kind === 'tool' && item.subagent == null;
    }
    default: return false;
  }
}

/**
 * The segments that carry the agent's name: the first piece of agent content (a
 * thought, a reply, a tool call or a process) after each prompt, and the first one
 * before any prompt. A prompt starts the next round (R4).
 */
export function agentHeadIds(segments: readonly TimelineSegment[]): Set<string> {
  const heads = new Set<string>();
  let named = false;
  for (const segment of segments) {
    if (segment.kind === 'item' && startsRound(segment.item)) {
      named = false;
      continue;
    }
    if (named || !agentContent(segment)) continue;
    heads.add(segmentKey(segment));
    named = true;
  }
  return heads;
}

/** Map every folded item (startup, process, tool group) to the segment that holds it. */
export function groupIdByItem(segments: readonly TimelineSegment[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const segment of segments) {
    if (segment.kind === 'item') continue;
    for (const item of segment.items) map.set(item.id, segment.id);
  }
  return map;
}
