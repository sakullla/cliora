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
 *   unknown reason pauses the queue.
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
  if (inFlight || !idle) return { kind: 'none' };
  const immediate = !!items[0].immediate;
  if (turnEnd != null) {
    if (turnEnd === 'end_turn') return paused && !immediate ? { kind: 'none' } : { kind: 'send' };
    if (turnEnd === 'cancelled') {
      if (immediate) return { kind: 'send' };
      return paused ? { kind: 'none' } : { kind: 'pause', reason: turnEnd };
    }
    return paused ? { kind: 'none' } : { kind: 'pause', reason: turnEnd };
  }
  return paused && !immediate ? { kind: 'none' } : { kind: 'send' };
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

/** An emptied queue starts over: nothing is left to pause or to explain. */
function write(sessionId: string, next: AcpQueueState) {
  if (!next.items.length) queues.delete(sessionId);
  else queues.set(sessionId, next);
  const set = listeners.get(sessionId);
  if (set) for (const listener of [...set]) listener();
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

/** The session was closed: its queue goes with it. */
export function clearAcpQueue(sessionId: string) {
  if (!queues.has(sessionId)) return;
  write(sessionId, EMPTY_QUEUE);
}
