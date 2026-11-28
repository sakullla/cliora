import type { AcpTurnReason } from '../../../types/acp';
import type { ComposerAttachment } from './composerModel';

/**
 * The prompts waiting to be sent to one conversation while its turn runs (R11). The
 * host still runs one turn at a time and never receives two prompts at once: the queue
 * lives here, in front-end memory, one per session, and is dropped when the session is
 * closed. It does not survive a restart.
 */

/** One waiting prompt with the attachments it was queued with (images already read). */
export type QueuedPrompt = {
  id: string;
  text: string;
  attachments: ComposerAttachment[];
  /** "Send now": the running turn is being stopped so this prompt goes next. */
  immediate?: boolean;
};

export type AcpQueueState = {
  items: readonly QueuedPrompt[];
  /** Nothing is sent automatically until the person continues. */
  paused: boolean;
  /** Why the head could not be sent, if a send failed. */
  error: string;
};

export const EMPTY_QUEUE: AcpQueueState = Object.freeze({ items: Object.freeze([]) as readonly QueuedPrompt[], paused: false, error: '' });

export type QueueAction =
  | { kind: 'send' }
  | { kind: 'pause'; reason: AcpTurnReason | 'login' }
  | { kind: 'none' };

/**
 * What the queue does now. `turnEnd` is the newest turn end the queue has not handled
 * yet; it is handled once the session is idle.
 *
 * - A turn that ended normally sends the head (unless paused).
 * - A cancelled turn sends the head only when it is the prompt the person asked to send
 *   now; a stop the person made otherwise pauses the queue.
 * - A turn that failed, was refused, hit a limit, was disconnected or ended for an
 *   unknown reason pauses the queue, even while a sent prompt is still in flight: the
 *   reason a turn ended is never lost to a send the host has not answered yet.
 * - A login pauses the queue: it waits for "continue" afterwards.
 * - Nothing is sent while a sent prompt has not reached its turn yet.
 * - Idle and not paused, the head goes out: there is never a queue that is neither
 *   paused nor about to be sent.
 */
export function nextQueueAction(input: {
  items: readonly Pick<QueuedPrompt, 'immediate'>[];
  paused: boolean;
  turnEnd: AcpTurnReason | null;
  /** No turn is running and the session accepts a prompt. */
  idle: boolean;
  /** A prompt was sent and its turn has not been seen yet. */
  inFlight: boolean;
  login: boolean;
  live: boolean;
}): QueueAction {
  const { items, paused, turnEnd, idle, inFlight, login, live } = input;
  if (!items.length || !live) return { kind: 'none' };
  if (login) return paused ? { kind: 'none' } : { kind: 'pause', reason: 'login' };
  const immediate = !!items[0].immediate;
  // A pausing end applies first: a send still in flight must not swallow it.
  if (turnEnd != null && turnEnd !== 'end_turn' && !(turnEnd === 'cancelled' && immediate)) {
    return paused ? { kind: 'none' } : { kind: 'pause', reason: turnEnd };
  }
  if (inFlight || !idle) return { kind: 'none' };
  return paused && !immediate ? { kind: 'none' } : { kind: 'send' };
}

/** One turn end as the scheduler sees it, in timeline order. */
export type AcpTurnEnd = { id: string; reason: AcpTurnReason };

/** What the session shows the scheduler at one moment. */
export type AcpQueueView = {
  /** Every turn end of the timeline, in order. */
  turns: readonly AcpTurnEnd[];
  /** A turn runs (or waits on the person). */
  turnBusy: boolean;
  /** The session accepts a prompt. */
  canSend: boolean;
  login: boolean;
  live: boolean;
};

/**
 * The scheduling memory of one session, kept here and not in a view: a pane that is
 * hidden, unmounted or mounted again neither misses a turn end nor acts on one twice.
 */
export type AcpQueueSchedule = {
  /** The newest turn end already acted on; null when there was none. */
  handledTurnId: string | null;
  /** A prompt was handed to the host after this turn end (null: before any) and its
   *  turn has not been seen running or ended yet: nothing else goes out meanwhile. */
  inFlight: { after: string | null } | null;
  /** The host has not answered a send yet. */
  sending: boolean;
};

/** The turn ends after `id`. One no longer in the timeline was trimmed with everything
 *  before it, so every remaining end is newer. */
export function turnEndsAfter<T extends { id: string }>(turns: readonly T[], id: string | null): T[] {
  if (id == null) return [...turns];
  const index = turns.findIndex((turn) => turn.id === id);
  return turns.slice(index + 1);
}

const schedules = new Map<string, AcpQueueSchedule>();

export function readAcpQueueSchedule(sessionId: string): AcpQueueSchedule | null {
  return schedules.get(sessionId) ?? null;
}

/** Whether a send of this session waits for the host (the same in every view). */
export function acpQueueSending(sessionId: string): boolean {
  return !!schedules.get(sessionId)?.sending;
}

function setSchedule(sessionId: string, next: AcpQueueSchedule, notify: boolean) {
  const current = schedules.get(sessionId);
  schedules.set(sessionId, next);
  if (notify && current?.sending !== next.sending) emit(sessionId);
}

/**
 * Starts remembering a session the first time a view shows it: the turn ends it already
 * has are history, not news. Remembered sessions keep what they had, so a pane mounted
 * again judges by the record and still acts on an end that arrived while it was away.
 */
export function trackAcpQueue(sessionId: string, turns: readonly AcpTurnEnd[]): AcpQueueSchedule {
  const current = schedules.get(sessionId);
  if (current) return current;
  const created: AcpQueueSchedule = { handledTurnId: turns.at(-1)?.id ?? null, inFlight: null, sending: false };
  schedules.set(sessionId, created);
  return created;
}

/**
 * One step of the scheduler: takes the turn ends not handled yet (once the session is
 * idle, waits on a login or ended), applies the queue's rule and records what it
 * handled. A pause is applied here; a `send` is up to the caller (see beginAcpSend).
 */
export function stepAcpQueue(sessionId: string, view: AcpQueueView): QueueAction {
  // An ended session first seen now (or one closed meanwhile) has nothing to schedule.
  if (!view.live && !schedules.has(sessionId)) return { kind: 'none' };
  const schedule = trackAcpQueue(sessionId, view.turns);
  const { turns, turnBusy, canSend, login, live } = view;
  let { inFlight, handledTurnId } = schedule;
  if (inFlight && (turnBusy || turnEndsAfter(turns, inFlight.after).length)) inFlight = null;
  const idle = canSend && !turnBusy;
  let turnEnd: AcpTurnReason | null = null;
  const fresh = turnEndsAfter(turns, handledTurnId);
  if (fresh.length && (idle || login || !live)) {
    const last = fresh[fresh.length - 1];
    handledTurnId = last.id;
    turnEnd = last.reason;
  }
  if (inFlight !== schedule.inFlight || handledTurnId !== schedule.handledTurnId) {
    setSchedule(sessionId, { ...schedule, inFlight, handledTurnId }, false);
  }
  const queue = readAcpQueue(sessionId);
  const action = nextQueueAction({
    items: queue.items, paused: queue.paused, turnEnd, idle, login, live,
    inFlight: !!inFlight || schedule.sending,
  });
  if (action.kind === 'pause') pauseAcpQueue(sessionId);
  return action;
}

/**
 * A prompt is handed to the host (the queue's head or one typed when idle): nothing else
 * goes out until the host answers and the prompt's turn is seen. False while another
 * send of this session still waits.
 */
export function beginAcpSend(sessionId: string, turns: readonly AcpTurnEnd[]): boolean {
  const schedule = trackAcpQueue(sessionId, turns);
  if (schedule.sending) return false;
  setSchedule(sessionId, { ...schedule, sending: true, inFlight: { after: turns.at(-1)?.id ?? null } }, true);
  return true;
}

/** The host answered a send; a refused prompt has no turn to wait for. */
export function endAcpSend(sessionId: string, accepted: boolean) {
  const schedule = schedules.get(sessionId);
  if (!schedule) return;
  setSchedule(sessionId, { ...schedule, sending: false, inFlight: accepted ? schedule.inFlight : null }, true);
}

/**
 * Sends the queue's head through `deliver`; a refusal puts it back first, paused, with
 * the reason. Nothing happens while another send of the session waits.
 */
export async function dispatchAcpHead(
  sessionId: string,
  turns: readonly AcpTurnEnd[],
  deliver: (entry: QueuedPrompt) => Promise<void>,
  reason: (error: unknown) => string,
): Promise<boolean> {
  const head = readAcpQueue(sessionId).items[0];
  if (!head || !beginAcpSend(sessionId, turns)) return false;
  takeAcpEntry(sessionId, head.id);
  try {
    await deliver(head);
  } catch (error) {
    failAcpEntry(sessionId, head, reason(error));
    endAcpSend(sessionId, false);
    return false;
  }
  endAcpSend(sessionId, true);
  return true;
}

/** A one-line preview of a queued prompt. */
export function queuePreview(text: string, max = 120): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Every queued prompt's text, separated by a blank line (the "copy all" action). */
export function queueCopyText(items: readonly Pick<QueuedPrompt, 'text'>[]): string {
  return items.map((item) => item.text).join('\n\n');
}

let queueSeq = 0;
const nextQueueId = () => `queued-${Date.now().toString(36)}-${(queueSeq += 1)}`;

const queues = new Map<string, AcpQueueState>();
const listeners = new Map<string, Set<() => void>>();

function emit(sessionId: string) {
  const set = listeners.get(sessionId);
  if (set) for (const listener of [...set]) listener();
}

/** An emptied queue starts over: nothing is left to pause or to explain. */
function write(sessionId: string, next: AcpQueueState) {
  if (!next.items.length) queues.delete(sessionId);
  else queues.set(sessionId, next);
  emit(sessionId);
}

function update(sessionId: string, change: (current: AcpQueueState) => AcpQueueState) {
  const current = readAcpQueue(sessionId);
  const next = change(current);
  if (next !== current) write(sessionId, next);
}

export function readAcpQueue(sessionId: string): AcpQueueState {
  return queues.get(sessionId) ?? EMPTY_QUEUE;
}

export function subscribeAcpQueue(sessionId: string, listener: () => void): () => void {
  let set = listeners.get(sessionId);
  if (!set) listeners.set(sessionId, set = new Set());
  set.add(listener);
  return () => {
    const current = listeners.get(sessionId);
    if (!current) return;
    current.delete(listener);
    if (!current.size) listeners.delete(sessionId);
  };
}

/** Adds a prompt at the end, or, sent now, at the front (the only "now" prompt). */
export function enqueueAcpPrompt(sessionId: string, prompt: { text: string; attachments: ComposerAttachment[] }, immediate = false): QueuedPrompt {
  const entry: QueuedPrompt = { id: nextQueueId(), text: prompt.text, attachments: prompt.attachments, ...(immediate ? { immediate: true } : {}) };
  update(sessionId, (current) => ({
    ...current,
    items: immediate ? [entry, ...current.items.map(withoutImmediate)] : [...current.items, entry],
  }));
  return entry;
}

function withoutImmediate(item: QueuedPrompt): QueuedPrompt {
  if (!item.immediate) return item;
  const rest = { ...item };
  delete rest.immediate;
  return rest;
}

/** Moves an entry to the front as the prompt to send once the running turn stops. */
export function sendAcpEntryNext(sessionId: string, entryId: string) {
  update(sessionId, (current) => {
    const entry = current.items.find((item) => item.id === entryId);
    if (!entry) return current;
    return { ...current, items: [{ ...entry, immediate: true }, ...current.items.filter((item) => item.id !== entryId).map(withoutImmediate)] };
  });
}

/** Takes an entry out of the queue (to edit, delete or send it). */
export function takeAcpEntry(sessionId: string, entryId: string): QueuedPrompt | null {
  const entry = readAcpQueue(sessionId).items.find((item) => item.id === entryId) ?? null;
  if (entry) update(sessionId, (current) => ({ ...current, items: current.items.filter((item) => item.id !== entryId) }));
  return entry;
}

/** Puts a prompt whose send failed back at the front, paused with the reason. */
export function failAcpEntry(sessionId: string, entry: QueuedPrompt, reason: string) {
  update(sessionId, (current) => ({
    items: [withoutImmediate(entry), ...current.items.filter((item) => item.id !== entry.id).map(withoutImmediate)],
    paused: true,
    error: reason,
  }));
}

export function pauseAcpQueue(sessionId: string) {
  update(sessionId, (current) => (current.paused && !current.items.some((item) => item.immediate)
    ? current
    : { ...current, paused: true, items: current.items.map(withoutImmediate) }));
}

/** "Continue sending": the queue runs again and its error is cleared. */
export function resumeAcpQueue(sessionId: string) {
  update(sessionId, (current) => (!current.paused && !current.error ? current : { ...current, paused: false, error: '' }));
}

/** The session was closed: its queue and its scheduling memory go with it. */
export function clearAcpQueue(sessionId: string) {
  schedules.delete(sessionId);
  if (!queues.has(sessionId)) return;
  write(sessionId, EMPTY_QUEUE);
}
