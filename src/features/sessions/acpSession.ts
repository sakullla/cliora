import type { AcpEvent, AcpMessage, AcpPermissionCard, AcpSessionSnapshot, AcpToolCall } from '../../types/acp';
import type { WorkbenchSession } from '../../types/launch';

/** A bounded, redacted protocol notice for one conversation. A notice is not a
 *  message: it never enters the snapshot the native host keeps. */
export type AcpNotice = { seq: number; level: 'info' | 'warning' | 'error'; text: string };

/** One conversation as the workbench renders it: the native snapshot plus the
 *  notices this window received. Two sessions never share one of these. */
export type AcpConversation = { snapshot: AcpSessionSnapshot; notices: AcpNotice[] };

export const ACP_NOTICE_LIMIT = 20;

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

function upsertMessage(messages: AcpMessage[], id: string, role: AcpMessage['role'], text: string, truncated: boolean): AcpMessage[] {
  const index = messages.findIndex((message) => message.id === id);
  if (index < 0) return [...messages, { id, role, text, truncated }];
  const next = [...messages];
  const current = next[index];
  next[index] = { ...current, text: current.text + text, truncated: current.truncated || truncated };
  return next;
}

function upsertTool(tools: AcpToolCall[], call: AcpToolCall): AcpToolCall[] {
  const index = tools.findIndex((item) => item.callId === call.callId);
  if (index < 0) return [...tools, call];
  const next = [...tools];
  next[index] = { ...next[index], ...call };
  return next;
}

function upsertCard(cards: AcpPermissionCard[], card: AcpPermissionCard): AcpPermissionCard[] {
  const index = cards.findIndex((item) => item.requestId === card.requestId);
  if (index < 0) return [...cards, card];
  const next = [...cards];
  next[index] = card;
  return next;
}

/**
 * Fold one ordered event into a conversation. A snapshot replaces the whole state
 * (it is what a view that mounts late reads); a chunk appends to exactly one message
 * id; a tool update merges by its call id. An event the view already applied, or an
 * older one that arrived after a newer snapshot, is ignored instead of replayed, so a
 * remount or a switching pane never duplicates a reply.
 */
export function applyAcpEvent(current: AcpConversation | undefined, event: AcpEvent): AcpConversation | null {
  if (!event || typeof event.sessionId !== 'string' || typeof event.seq !== 'number') return null;
  if (event.kind === 'snapshot') {
    const snapshot = event.snapshot;
    if (!snapshot || snapshot.id !== event.sessionId) return null;
    const notices = current ? current.notices : [];
    return { snapshot, notices };
  }
  if (!current) return null;
  const snapshot = current.snapshot;
  if (event.seq <= snapshot.seq) return current;
  const base = { ...snapshot, seq: event.seq };
  switch (event.kind) {
    case 'chunk': {
      if (typeof event.messageId !== 'string' || typeof event.text !== 'string') return current;
      const role = event.role ?? 'agent';
      return { snapshot: { ...base, messages: upsertMessage(snapshot.messages, event.messageId, role, event.text, !!event.truncated) }, notices: current.notices };
    }
    case 'tool': {
      if (!event.call || typeof event.call.callId !== 'string') return current;
      return { snapshot: { ...base, tools: upsertTool(snapshot.tools, event.call) }, notices: current.notices };
    }
    case 'permission': {
      if (!event.card || typeof event.card.requestId !== 'string') return current;
      return { snapshot: { ...base, permissions: upsertCard(snapshot.permissions, event.card) }, notices: current.notices };
    }
    case 'permissionClosed': {
      if (typeof event.requestId !== 'string') return current;
      // A withdrawn request is no longer answerable; the turn state stays whatever
      // the host last reported, so a stop still reads as stopping until it answers.
      const permissions = snapshot.permissions.filter((card) => card.requestId !== event.requestId);
      return { snapshot: { ...base, permissions }, notices: current.notices };
    }
    case 'notice': {
      if (typeof event.text !== 'string') return current;
      const level: AcpNotice['level'] = event.level === 'warning' || event.level === 'error' ? event.level : 'info';
      const notices = [...current.notices, { seq: event.seq, level, text: event.text }].slice(-ACP_NOTICE_LIMIT);
      return { snapshot: base, notices };
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

/** The card is answered once: while a reply is in flight every option is disabled. */
export function acpCardAnswerable(snapshot: AcpSessionSnapshot, requestId: string): boolean {
  return snapshot.permissions.some((card) => card.requestId === requestId) && snapshot.state !== 'closed' && snapshot.state !== 'failed';
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
