import type { AcpEvent, AcpSessionSnapshot, AcpTerminal, AcpTimelineItem, AcpUpdate } from '../../types/acp';
import type { WorkbenchSession } from '../../types/launch';

/** One conversation as the workbench renders it: the native snapshot, folded
 *  forward by the ordered events this window received. Two sessions never share
 *  one of these. Notices live in the snapshot's own timeline. */
export type AcpConversation = { snapshot: AcpSessionSnapshot };

/** A conversation the host still owns: it can accept a prompt or report a turn. */
export function acpIsLive(snapshot: AcpSessionSnapshot): boolean {
  return snapshot.state !== 'closed' && snapshot.state !== 'failed';
}

/** A turn is in flight: the composer waits instead of queueing a second prompt. */
export function acpTurnActive(snapshot: AcpSessionSnapshot): boolean {
  return snapshot.state === 'starting' || snapshot.state === 'running' || snapshot.state === 'stopping';
}

/** The rail row of a conversation. Only the fields the shared rail reads are set;
 *  a conversation has no exit code, so an ended one reports none instead of 0. */
export function acpRow(snapshot: AcpSessionSnapshot): WorkbenchSession {
  return {
    id: snapshot.id,
    toolId: snapshot.toolId,
    projectId: snapshot.projectId,
    directory: snapshot.directory,
    mode: snapshot.mode,
    running: acpIsLive(snapshot),
    exitCode: null,
  };
}

/** Insert an item at the end, or replace the item with the same id where it stands:
 *  an item's place in the timeline is fixed when it first appears. */
function upsertItem(timeline: AcpTimelineItem[], item: AcpTimelineItem): AcpTimelineItem[] {
  const index = timeline.findIndex((entry) => entry.id === item.id);
  if (index < 0) return [...timeline, item];
  const next = [...timeline];
  next[index] = item;
  return next;
}

type ChunkUpdate = Extract<AcpUpdate, { kind: 'chunk' }>;

/** Append a chunk to exactly one message. A message id the view does not hold yet
 *  starts a new message at the end, exactly where the host placed it. */
function appendChunk(timeline: AcpTimelineItem[], chunk: ChunkUpdate): AcpTimelineItem[] {
  const index = timeline.findIndex((entry) => entry.id === chunk.messageId);
  if (index < 0) {
    return [...timeline, {
      kind: 'message', id: chunk.messageId, role: chunk.role, text: chunk.text, truncated: !!chunk.truncated,
      turnId: typeof chunk.turnId === 'string' ? chunk.turnId : '', subagent: chunk.subagent ?? null,
    }];
  }
  const current = timeline[index];
  if (current.kind !== 'message') return timeline;
  const next = [...timeline];
  next[index] = { ...current, text: current.text + chunk.text, truncated: current.truncated || !!chunk.truncated };
  return next;
}

type TerminalOutputUpdate = Extract<AcpUpdate, { kind: 'terminalOutput' }>;

/** Insert a terminal, or replace the one with the same id where it stands. */
function upsertTerminal(terminals: AcpTerminal[], terminal: AcpTerminal): AcpTerminal[] {
  const index = terminals.findIndex((entry) => entry.terminalId === terminal.terminalId);
  if (index < 0) return [...terminals, terminal];
  const next = [...terminals];
  next[index] = terminal;
  return next;
}

/** Append a terminal's output exactly as the host did: the appended text goes on
 *  the end, then `dropped` UTF-16 code units leave the head so the view keeps the
 *  same bounded tail. Exit and release ride on the same event. */
function applyTerminalOutput(terminals: AcpTerminal[], update: TerminalOutputUpdate): AcpTerminal[] | null {
  const index = terminals.findIndex((entry) => entry.terminalId === update.terminalId);
  if (index < 0) return null;
  const current = terminals[index];
  const joined = current.output + (typeof update.text === 'string' ? update.text : '');
  const dropped = Number.isFinite(update.dropped) && update.dropped > 0 ? update.dropped : 0;
  const next = [...terminals];
  next[index] = {
    ...current,
    output: dropped ? joined.slice(dropped) : joined,
    truncated: current.truncated || !!update.truncated,
    exitStatus: update.exitStatus ?? current.exitStatus,
    released: current.released || !!update.released,
  };
  return next;
}

function validItem(item: unknown): item is AcpTimelineItem {
  return !!item && typeof (item as { id?: unknown }).id === 'string' && typeof (item as { kind?: unknown }).kind === 'string';
}

/**
 * Fold one ordered event into a conversation. A snapshot replaces the whole state
 * (it is what a view that mounts late reads); a chunk appends to exactly one message
 * id; a tool or item update replaces that one timeline entry in place; plan, commands,
 * config, info and pending replace their own field. An event the view already
 * applied, or an older one that arrived after a newer snapshot, is ignored instead of
 * replayed, so a remount or a switching pane never duplicates a reply.
 */
export function applyAcpEvent(current: AcpConversation | undefined, event: AcpEvent): AcpConversation | null {
  if (!event || typeof event.sessionId !== 'string' || typeof event.seq !== 'number') return null;
  if (event.kind === 'snapshot') {
    const snapshot = event.snapshot;
    if (!snapshot || snapshot.id !== event.sessionId) return null;
    return { snapshot };
  }
  if (!current) return null;
  const snapshot = current.snapshot;
  if (event.seq <= snapshot.seq) return current;
  const base = { ...snapshot, seq: event.seq };
  switch (event.kind) {
    case 'chunk': {
      if (typeof event.messageId !== 'string' || typeof event.text !== 'string') return current;
      const role = event.role ?? 'agent';
      return { snapshot: { ...base, timeline: appendChunk(snapshot.timeline, { ...event, role }) } };
    }
    case 'tool': {
      if (!event.call || typeof event.call.id !== 'string') return current;
      return { snapshot: { ...base, timeline: upsertItem(snapshot.timeline, { kind: 'tool', ...event.call }) } };
    }
    case 'item': {
      if (!validItem(event.item)) return current;
      return { snapshot: { ...base, timeline: upsertItem(snapshot.timeline, event.item) } };
    }
    case 'plan': {
      if (!Array.isArray(event.entries)) return current;
      return { snapshot: { ...base, plan: event.entries } };
    }
    case 'commands': {
      if (!Array.isArray(event.commands)) return current;
      return { snapshot: { ...base, commands: event.commands } };
    }
    case 'config': {
      if (!event.config || !Array.isArray(event.config.options)) return current;
      return { snapshot: { ...base, config: event.config } };
    }
    case 'info': {
      if (!event.info) return current;
      return { snapshot: { ...base, info: event.info } };
    }
    case 'pending': {
      if (!Array.isArray(event.pending)) return current;
      // A withdrawn request is no longer answerable; the turn state stays whatever
      // the host last reported, so a stop still reads as stopping until it answers.
      return { snapshot: { ...base, pending: event.pending } };
    }
    case 'terminal': {
      if (!event.terminal || typeof event.terminal.terminalId !== 'string') return current;
      return { snapshot: { ...base, terminals: upsertTerminal(snapshot.terminals ?? [], event.terminal) } };
    }
    case 'terminalOutput': {
      if (typeof event.terminalId !== 'string') return current;
      // Output for a terminal the view never saw cannot be placed; the next snapshot
      // carries it whole.
      const terminals = applyTerminalOutput(snapshot.terminals ?? [], event);
      return terminals ? { snapshot: { ...base, terminals } } : { snapshot: base };
    }
    default:
      return current;
  }
}

/** Fold an ordered batch; used when several events arrived before one render. */
export function applyAcpEvents(current: AcpConversation | undefined, events: AcpEvent[]): AcpConversation | null {
  let next = current ?? null;
  for (const event of events) next = applyAcpEvent(next ?? undefined, event) ?? next;
  return next;
}

/** Requests still waiting for this person. A closed conversation asks nothing. */
export function acpPendingCount(snapshot: AcpSessionSnapshot): number {
  return acpIsLive(snapshot) ? snapshot.pending.length : 0;
}

/** The open out-of-directory approval cards, in timeline order. */
export function acpOpenAccesses(snapshot: AcpSessionSnapshot) {
  return snapshot.timeline.filter((item): item is Extract<AcpTimelineItem, { kind: 'access' }> =>
    item.kind === 'access' && item.decision === 'pending' && !!item.requestId && snapshot.pending.includes(item.requestId));
}

/** The terminal a tool call's terminal content names, if the view holds it. */
export function acpTerminal(snapshot: AcpSessionSnapshot, terminalId: string): AcpTerminal | null {
  return (snapshot.terminals ?? []).find((terminal) => terminal.terminalId === terminalId) ?? null;
}

/** The card is answered once: while a reply is in flight every option is disabled. */
export function acpCardAnswerable(snapshot: AcpSessionSnapshot, requestId: string): boolean {
  return snapshot.pending.includes(requestId) && acpIsLive(snapshot);
}

/** The end of a turn, worded from the closed set the host reports. Empty means no
 *  turn has ended yet, so there is nothing to say. */
export function acpTurnKey(reason: AcpSessionSnapshot['lastTurnReason']): string | null {
  switch (reason) {
    case 'end_turn': return 'sessions.acpTurnEnd';
    case 'limit': return 'sessions.acpTurnLimit';
    case 'refusal': return 'sessions.acpTurnRefusal';
    case 'cancelled': return 'sessions.acpTurnCancelled';
    case 'disconnected': return 'sessions.acpTurnDisconnected';
    case 'failed': return 'sessions.acpTurnFailed';
    case 'unknown': return 'sessions.acpTurnUnknown';
    default: return null;
  }
}

/** The conversation's own state, worded for the pane head and assistive tech. */
export function acpStateKey(state: AcpSessionSnapshot['state']): string {
  switch (state) {
    case 'starting': return 'sessions.acpStateStarting';
    case 'ready': return 'sessions.acpStateReady';
    case 'running': return 'sessions.acpStateRunning';
    case 'stopping': return 'sessions.acpStateStopping';
    case 'waiting_permission': return 'sessions.acpStateWaiting';
    case 'closed': return 'sessions.acpStateClosed';
    default: return 'sessions.acpStateFailed';
  }
}

/** A restored conversation reports its own resume outcome; none of it is a claim
 *  the host has not made. */
export function acpResumeKey(resume: AcpSessionSnapshot['resume']): string | null {
  switch (resume) {
    case 'loaded': return 'sessions.acpResumeLoaded';
    case 'failed': return 'sessions.acpResumeFailed';
    case 'unsupported': return 'sessions.acpResumeUnsupported';
    default: return null;
  }
}
