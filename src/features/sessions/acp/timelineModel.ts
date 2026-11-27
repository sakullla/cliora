import type { AcpTimelineItem, AcpToolCall, AcpToolKind } from '../../../types/acp';

export type AcpToolItem = Extract<AcpTimelineItem, { kind: 'tool' }>;

export type ToolGroupKindCount = {
  kind: AcpToolKind;
  count: number;
};

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
