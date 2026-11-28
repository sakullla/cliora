import type { AcpAccess, AcpElicitation, AcpSessionSnapshot, AcpTerminal, AcpTimelineItem, AcpToolCall } from '../../../types/acp';
import { buildSegments, groupIdByItem, segmentOptions } from './timelineModel.ts';
import { locationTarget, terminalText, visibleControls } from './acpView.ts';

/** Safety ceiling so a 1-letter query in a massive log cannot stall the UI thread. */
const MAX_MATCHES = 10_000;

export type AcpFindMatch = {
  itemId: string;
  /** Zero-based occurrence index within `itemId`. */
  occurrence: number;
  /** The folded segment (startup, work process or tool group) that holds the item, if any. */
  groupId?: string;
};

export type TextMatchRun = {
  text: string;
  hit: boolean;
};

/**
 * Collect searchable text slices from a diff without double-counting unchanged
 * lines that appear in both `oldText` and `newText`, running in O(N) time.
 */
function diffSearchTexts(path: string, oldText: string | null, newText: string, includePath: boolean): string[] {
  const parts: string[] = [];
  if (includePath && path) parts.push(visibleControls(path));
  if (oldText == null) {
    if (newText) parts.push(visibleControls(newText));
    return parts;
  }
  if (oldText === newText) {
    if (newText) parts.push(visibleControls(newText));
    return parts;
  }
  const newCounts = new Map<string, number>();
  for (const line of newText.split('\n')) {
    newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
  }
  const removedOnly: string[] = [];
  for (const line of oldText.split('\n')) {
    const remaining = newCounts.get(line) ?? 0;
    if (remaining > 0) newCounts.set(line, remaining - 1);
    else removedOnly.push(line);
  }
  if (removedOnly.length) parts.push(visibleControls(removedOnly.join('\n')));
  if (newText) parts.push(visibleControls(newText));
  return parts;
}

export type SearchVisibilityContext = {
  live: boolean;
  pendingSet: ReadonlySet<string>;
};

function toolSearchTexts(
  call: AcpToolCall,
  terminalsById: ReadonlyMap<string, AcpTerminal>,
  visibility?: SearchVisibilityContext,
): string[] {
  const parts: string[] = [];
  const title = call.title || call.callId;
  if (title) parts.push(visibleControls(title));
  if (call.rawInput) parts.push(visibleControls(call.rawInput));
  for (const piece of call.content ?? []) {
    switch (piece.type) {
      case 'text':
        if (piece.text) parts.push(visibleControls(piece.text));
        break;
      case 'diff':
        parts.push(...diffSearchTexts(piece.path, piece.oldText, piece.newText, true));
        break;
      case 'terminal': {
        // Without its record the card shows only whether output is expected, never
        // the terminal id, so there is nothing to find.
        const terminal = terminalsById.get(piece.terminalId);
        if (terminal) {
          if (terminal.command) parts.push(visibleControls(terminal.command));
          if (terminal.output) parts.push(terminalText(terminal.output));
        }
        break;
      }
      case 'image':
        if (piece.mimeType) parts.push(visibleControls(piece.mimeType));
        break;
      case 'session':
        if (piece.sessionId) parts.push(visibleControls(piece.sessionId));
        break;
    }
  }
  for (const location of call.locations ?? []) {
    const target = locationTarget(location.path, location.line);
    if (target) parts.push(visibleControls(target));
  }
  const permissionVisible = !!call.permission
    && (!visibility || (visibility.live && visibility.pendingSet.has(call.permission.requestId)));
  if (permissionVisible) {
    for (const option of call.permission?.options ?? []) {
      if (option.name) parts.push(visibleControls(option.name));
    }
  }
  return parts;
}

function accessSearchTexts(access: AcpAccess): string[] {
  const parts: string[] = [];
  if (access.path) parts.push(visibleControls(access.path));
  if (access.detail) parts.push(visibleControls(access.detail));
  if (access.diff) {
    parts.push(...diffSearchTexts(access.diff.path, access.diff.oldText, access.diff.newText, access.diff.path !== access.path));
  }
  return parts;
}

function elicitationSearchTexts(item: AcpElicitation, visibility?: SearchVisibilityContext): string[] {
  const parts: string[] = [];
  if (item.message) parts.push(visibleControls(item.message));
  const formVisible = item.decision === 'pending'
    && !!item.requestId
    && (!visibility || (visibility.live && visibility.pendingSet.has(item.requestId)));
  if (formVisible) {
    const properties = item.requestedSchema?.properties ?? {};
    for (const [name, field] of Object.entries(properties)) {
      const label = field.title || name;
      if (label) parts.push(visibleControls(label));
      if (field.description) parts.push(visibleControls(field.description));
    }
  }
  return parts;
}

/** Extract all visible text slices of one timeline item in display order. */
export function extractItemSearchTexts(
  item: AcpTimelineItem,
  terminalsById: ReadonlyMap<string, AcpTerminal>,
  visibility?: SearchVisibilityContext,
): string[] {
  switch (item.kind) {
    case 'message': {
      const parts: string[] = [];
      if (item.text) parts.push(visibleControls(item.text));
      for (const attachment of item.attachments ?? []) {
        if (attachment.name) parts.push(visibleControls(attachment.name));
      }
      return parts;
    }
    case 'tool':
      return toolSearchTexts(item, terminalsById, visibility);
    case 'access':
      return accessSearchTexts(item);
    case 'notice':
      // A `trimmed` notice renders localized copy instead of raw `item.text`.
      if (item.code === 'trimmed') return [];
      return item.text ? [visibleControls(item.text)] : [];
    case 'subagent': {
      const parts: string[] = [];
      if (item.title) parts.push(visibleControls(item.title));
      if (item.description) parts.push(visibleControls(item.description));
      if (item.summary) parts.push(visibleControls(item.summary));
      if (item.stopReason) parts.push(visibleControls(item.stopReason));
      return parts;
    }
    case 'elicitation':
      return elicitationSearchTexts(item, visibility);
    case 'turn':
    default:
      return [];
  }
}

/**
 * Split visible text into safe plain-text runs with hit markers for React
 * rendering (never HTML interpolation).
 */
export function splitMatchRuns(text: string, query: string, caseSensitive = false): TextMatchRun[] {
  if (!text) return [];
  const trimmed = query.trim();
  if (!trimmed) return [{ text, hit: false }];
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? trimmed : trimmed.toLowerCase();
  if (!needle || haystack.length !== text.length) return [{ text, hit: false }];

  const runs: TextMatchRun[] = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) break;
    if (index > cursor) runs.push({ text: text.slice(cursor, index), hit: false });
    runs.push({ text: text.slice(index, index + needle.length), hit: true });
    cursor = index + needle.length;
  }
  if (!runs.length) return [{ text, hit: false }];
  if (cursor < text.length) runs.push({ text: text.slice(cursor), hit: false });
  return runs;
}

/**
 * Search visible ACP timeline content in arrival/render order.
 * Returns stable item ids, per-item occurrence indices, and the enclosing folded
 * segment (startup, work process, tool group) so the UI can open it on navigation.
 */
export function searchAcpTimeline(snapshot: AcpSessionSnapshot, query: string, caseSensitive = false): AcpFindMatch[] {
  const trimmed = query.trim();
  const needle = caseSensitive ? trimmed : trimmed.toLowerCase();
  if (!needle) return [];

  const timeline = snapshot.timeline ?? [];
  if (!timeline.length) return [];

  const groupByItem = groupIdByItem(buildSegments(timeline, segmentOptions(snapshot)));
  const terminalsById = new Map<string, AcpTerminal>();
  for (const terminal of snapshot.terminals ?? []) {
    terminalsById.set(terminal.terminalId, terminal);
  }

  const visibility: SearchVisibilityContext = {
    live: snapshot.state !== 'closed' && snapshot.state !== 'failed',
    pendingSet: new Set(snapshot.pending ?? []),
  };

  const matches: AcpFindMatch[] = [];
  for (const item of timeline) {
    const texts = extractItemSearchTexts(item, terminalsById, visibility);
    if (!texts.length) continue;
    const groupId = groupByItem.get(item.id);
    let occurrence = 0;
    for (const raw of texts) {
      const haystack = caseSensitive ? raw : raw.toLowerCase();
      let start = 0;
      while (start <= haystack.length - needle.length) {
        const index = haystack.indexOf(needle, start);
        if (index < 0) break;
        matches.push(groupId ? { itemId: item.id, occurrence, groupId } : { itemId: item.id, occurrence });
        if (matches.length >= MAX_MATCHES) return matches;
        occurrence += 1;
        start = index + needle.length;
      }
    }
  }

  return matches;
}
