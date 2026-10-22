import type { ChildSession, HistoryMessage } from '../../types/history';

type ChildSummary = { at: number | null; ask: string; reply: string };
// IPC snapshots are immutable. Weak keys release summaries with their transcripts;
// replacing a transcript on refresh naturally computes a fresh summary.
const summaries = new WeakMap<readonly HistoryMessage[], ChildSummary>();

function clip(text: string) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 180 ? `${flat.slice(0, 180)}…` : flat;
}

/** Scan each transcript once for its timeline position and card preview. */
export function childSummary(child: ChildSession): ChildSummary {
  const cached = summaries.get(child.messages);
  if (cached) return cached;
  let at: number | null = null;
  let ask: string | undefined;
  let reply = '';
  for (const message of child.messages) {
    if (message.timestamp !== null && (at === null || message.timestamp < at)) at = message.timestamp;
    if (ask === undefined && message.role === 'user' && message.kind !== 'project_context' && message.kind !== 'environment_context') ask = message.text;
    if (message.role === 'assistant' && message.text.trim()) reply = message.text;
  }
  const summary = { at, ask: clip(ask ?? ''), reply: clip(reply) };
  summaries.set(child.messages, summary);
  return summary;
}

export type TimelineRow = { kind: 'message'; item: HistoryMessage; at: number | null } | { kind: 'child'; child: ChildSession; at: number | null };

/** Direct children land at their first message, then the parent's own turns continue. */
export function timelineRows(messages: readonly HistoryMessage[], children: readonly ChildSession[]): TimelineRow[] {
  const pending = children.map((child) => ({ kind: 'child' as const, child, at: childSummary(child).at }))
    .sort((left, right) => (left.at ?? Number.POSITIVE_INFINITY) - (right.at ?? Number.POSITIVE_INFINITY));
  const rows: TimelineRow[] = [];
  let next = 0;
  for (const item of messages) {
    while (next < pending.length && pending[next].at !== null && item.timestamp !== null && pending[next].at! <= item.timestamp) {
      rows.push(pending[next++]);
    }
    rows.push({ kind: 'message', item, at: item.timestamp });
  }
  while (next < pending.length) rows.push(pending[next++]);
  return rows;
}
