import type { IconName } from '../../../components/Icon';
import type { AcpAccess, AcpAccessDecision, AcpAccessKind, AcpPlanEntry, AcpSessionSnapshot, AcpSubagent, AcpTimelineItem, AcpToolCall, AcpToolKind } from '../../../types/acp';

/** The ten tool kinds the protocol names, each with its own glyph and word. A
 *  kind this view does not know reads as 'other', the generic glyph. */
const TOOL_KINDS: Record<AcpToolKind, { icon: IconName; key: string }> = {
  read: { icon: 'file', key: 'sessions.acpKindRead' },
  edit: { icon: 'pencil', key: 'sessions.acpKindEdit' },
  delete: { icon: 'trash', key: 'sessions.acpKindDelete' },
  move: { icon: 'migration', key: 'sessions.acpKindMove' },
  search: { icon: 'search', key: 'sessions.acpKindSearch' },
  execute: { icon: 'terminal', key: 'sessions.acpKindExecute' },
  think: { icon: 'sparkle', key: 'sessions.acpKindThink' },
  fetch: { icon: 'globe', key: 'sessions.acpKindFetch' },
  switch_mode: { icon: 'sliders', key: 'sessions.acpKindSwitchMode' },
  other: { icon: 'plug', key: 'sessions.acpKindOther' },
};

export function toolKindOf(call: Pick<AcpToolCall, 'toolKind'>): AcpToolKind {
  return Object.hasOwn(TOOL_KINDS, call.toolKind ?? '') ? call.toolKind : 'other';
}

export function toolKindView(kind: AcpToolKind) {
  return TOOL_KINDS[kind] ?? TOOL_KINDS.other;
}

export function toolStatusKey(status: AcpToolCall['status']): string {
  switch (status) {
    case 'in_progress': return 'sessions.acpToolRunning';
    case 'completed': return 'sessions.acpToolDone';
    case 'failed': return 'sessions.acpToolFailed';
    default: return 'sessions.acpToolPending';
  }
}

export function toolStatusIcon(status: AcpToolCall['status']): IconName {
  switch (status) {
    case 'in_progress': return 'refresh';
    case 'completed': return 'check';
    case 'failed': return 'alert';
    default: return 'clock';
  }
}

export function planStatusKey(status: AcpPlanEntry['status']): string {
  switch (status) {
    case 'in_progress': return 'sessions.acpPlanRunning';
    case 'completed': return 'sessions.acpPlanDone';
    default: return 'sessions.acpPlanPending';
  }
}

export function planStatusIcon(status: AcpPlanEntry['status']): IconName {
  switch (status) {
    case 'in_progress': return 'play';
    case 'completed': return 'check';
    default: return 'clock';
  }
}

export function planPriorityKey(priority: AcpPlanEntry['priority']): string {
  switch (priority) {
    case 'high': return 'sessions.acpPlanPriorityHigh';
    case 'low': return 'sessions.acpPlanPriorityLow';
    default: return 'sessions.acpPlanPriorityMedium';
  }
}

export function subagentStateKey(state: AcpSubagent['state']): string {
  switch (state) {
    case 'running': return 'sessions.acpSubagentRunning';
    case 'idle': return 'sessions.acpSubagentIdle';
    case 'requires_action': return 'sessions.acpSubagentAction';
    default: return 'sessions.acpSubagentUnknown';
  }
}

export function accessKindKey(kind: AcpAccessKind): string {
  switch (kind) {
    case 'write': return 'sessions.acpAccessKindWrite';
    case 'execute': return 'sessions.acpAccessKindExecute';
    default: return 'sessions.acpAccessKindRead';
  }
}

export function accessTitleKey(kind: AcpAccessKind): string {
  switch (kind) {
    case 'write': return 'sessions.acpAccessTitleWrite';
    case 'execute': return 'sessions.acpAccessTitleExecute';
    default: return 'sessions.acpAccessTitleRead';
  }
}

export function accessDecisionKey(decision: AcpAccessDecision): string {
  switch (decision) {
    case 'allowed_once': return 'sessions.acpAccessAllowedOnce';
    case 'allowed_session': return 'sessions.acpAccessAllowedSession';
    case 'granted': return 'sessions.acpAccessGranted';
    case 'yolo': return 'sessions.acpAccessYolo';
    case 'inside': return 'sessions.acpAccessInside';
    case 'denied': return 'sessions.acpAccessDenied';
    case 'withdrawn': return 'sessions.acpAccessWithdrawn';
    default: return 'sessions.acpAccessPending';
  }
}

/** Approved without asking: YOLO or an earlier "allow for this session". */
export function accessAutomatic(access: Pick<AcpAccess, 'decision'>): boolean {
  return access.decision === 'yolo' || access.decision === 'granted';
}

/**
 * Control characters other than line breaks and tabs, shown as their Unicode
 * control pictures. Agent text is displayed, never interpreted: an escape or an
 * OSC sequence reads as visible text instead of reaching anything that acts on it.
 */
export function visibleControls(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (char) => {
    const code = char.charCodeAt(0);
    return String.fromCharCode(code === 0x7f ? 0x2421 : 0x2400 + code);
  });
}

/** Terminal output as plain text: color (CSI) sequences are dropped, every other
 *  control character stays visible as text and is never acted on. */
export function terminalText(output: string): string {
  return visibleControls(output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n/g, '\n'));
}

function windowsLike(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\');
}

/** Split a path into its segments with `.` and `..` folded; null when `..` climbs
 *  above the start. */
function segments(path: string): string[] | null {
  const parts: string[] = [];
  for (const part of path.split(/[\\/]+/)) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts;
}

/**
 * Whether a location the agent named lies inside the session directory, judged
 * on the text alone. Only these are offered as links; the host resolves the path
 * again (and still refuses device or stream paths) when one is opened. A path that
 * climbs out with `..` or names another root is outside.
 */
export function insideDirectory(directory: string, path: string): boolean {
  if (!directory || !path) return false;
  const value = path.startsWith('file://') ? decodeFileUrl(path) : path;
  if (value === null) return false;
  const absolute = /^[\\/]/.test(value) || /^[a-z]:/i.test(value);
  if (!absolute) return segments(value) !== null;
  const caseless = windowsLike(directory) || windowsLike(value);
  const root = segments(directory.replace(/^[\\/]+(?=[a-z]:)/i, ''));
  const target = segments(value.replace(/^[\\/]+(?=[a-z]:)/i, ''));
  if (!root || !target || target.length < root.length) return false;
  const same = (a: string, b: string) => (caseless ? a.toLowerCase() === b.toLowerCase() : a === b);
  return root.every((part, index) => same(part, target[index]));
}

function decodeFileUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.host) return null;
    return decodeURIComponent(url.pathname);
  } catch { return null; }
}

/** `path:line` as the host's path opener reads it. */
export function locationTarget(path: string, line: number | null): string {
  return line != null ? `${path}:${line}` : path;
}

/** The timeline item that carries each pending request, in timeline order. */
export function pendingItems(snapshot: AcpSessionSnapshot): string[] {
  if (snapshot.state === 'closed' || snapshot.state === 'failed') return [];
  const pending = new Set(snapshot.pending);
  if (!pending.size) return [];
  const ids: string[] = [];
  for (const item of snapshot.timeline) {
    const request = pendingRequest(item);
    if (request && pending.has(request)) ids.push(item.id);
  }
  return ids;
}

/** The request id an item waits on, if it is a card or a form. */
export function pendingRequest(item: AcpTimelineItem): string | null {
  switch (item.kind) {
    case 'tool': return item.permission?.requestId ?? null;
    case 'access': return item.decision === 'pending' ? item.requestId : null;
    case 'elicitation': return item.decision === 'pending' ? item.requestId : null;
    default: return null;
  }
}

/** Large numbers in a compact, locale-aware form. */
export function compactNumber(value: number, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  } catch { return String(value); }
}
