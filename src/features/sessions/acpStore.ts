import type { AcpEvent, AcpSessionSnapshot } from '../../types/acp';
import { acpPendingCount, applyAcpEvents, type AcpConversation } from './acpSession.ts';

/** What the workbench frame (rail, titles, tones, menus) reads of a conversation.
 *  It changes only when one of these fields does, never on a streamed chunk. */
export type AcpSummary = Pick<AcpSessionSnapshot, 'id' | 'toolId' | 'projectId' | 'directory' | 'mode' | 'state'> & {
  /** Requests still waiting for this person; 0 once the conversation has ended. */
  pendingCount: number;
  /** The title the agent reported, if any. */
  title: string | null;
};

/** Runs `flush` once, later; the returned function cancels it. */
export type AcpFlushScheduler = (flush: () => void) => () => void;

/**
 * The conversations one workbench holds, outside React. Events are buffered and folded
 * once per frame per session; a view subscribes to its own session and is notified only
 * when that session changed, and the workbench frame subscribes to the derived summaries.
 */
export type AcpStore = {
  get: (sessionId: string) => AcpConversation | undefined;
  has: (sessionId: string) => boolean;
  /** Held, or a snapshot of it is waiting in the buffer. */
  known: (sessionId: string) => boolean;
  /** Registers a native snapshot at once. A held conversation with a newer sequence is kept:
   *  an older read must not undo output that already arrived. */
  register: (snapshot: AcpSessionSnapshot | null | undefined) => void;
  /** Buffers one ordered event; it is applied with the others at the next frame. */
  push: (event: AcpEvent) => void;
  /** Applies every buffered event now. */
  flush: () => void;
  /** The conversation was closed: its data and buffered events are dropped, and a later
   *  snapshot or event for it is ignored. */
  retire: (sessionId: string) => void;
  retired: (sessionId: string) => boolean;
  subscribe: (sessionId: string, listener: () => void) => () => void;
  subscribeSummaries: (listener: () => void) => () => void;
  /** A new map only when a summary changed. */
  summaries: () => ReadonlyMap<string, AcpSummary>;
  /** Cancels a scheduled flush; buffered events stay until the next push or flush. */
  dispose: () => void;
};

/** One flush per animation frame. A hidden window runs no frames, so a timer still
 *  drains the buffer there instead of letting it grow. */
export const frameScheduler: AcpFlushScheduler = (flush) => {
  let done = false;
  let frame = 0;
  const run = () => {
    if (done) return;
    done = true;
    cancel();
    flush();
  };
  const timer = setTimeout(run, 120);
  if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(run);
  function cancel() {
    clearTimeout(timer);
    if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
  }
  return () => {
    done = true;
    cancel();
  };
};

export function acpSummary(snapshot: AcpSessionSnapshot): AcpSummary {
  return {
    id: snapshot.id,
    toolId: snapshot.toolId,
    projectId: snapshot.projectId,
    directory: snapshot.directory,
    mode: snapshot.mode,
    state: snapshot.state,
    pendingCount: acpPendingCount(snapshot),
    title: snapshot.info?.title ?? null,
  };
}

function sameSummary(a: AcpSummary | undefined, b: AcpSummary): boolean {
  if (!a) return false;
  return a.id === b.id && a.toolId === b.toolId && a.projectId === b.projectId && a.directory === b.directory
    && a.mode === b.mode && a.state === b.state && a.pendingCount === b.pendingCount && a.title === b.title;
}

export function createAcpStore(options: { schedule?: AcpFlushScheduler } = {}): AcpStore {
  const schedule = options.schedule ?? frameScheduler;
  const conversations = new Map<string, AcpConversation>();
  const buffer = new Map<string, AcpEvent[]>();
  const retiredIds = new Set<string>();
  const listeners = new Map<string, Set<() => void>>();
  const summaryListeners = new Set<() => void>();
  let summaryMap: ReadonlyMap<string, AcpSummary> = new Map();
  let cancelScheduled: (() => void) | null = null;

  /** Recomputes the summaries of the changed sessions, then notifies their subscribers. */
  function commit(changed: Iterable<string>) {
    const ids = [...changed];
    if (!ids.length) return;
    let nextSummaries: Map<string, AcpSummary> | null = null;
    for (const id of ids) {
      const conversation = conversations.get(id);
      const previous = summaryMap.get(id);
      if (!conversation) {
        if (previous) {
          nextSummaries ??= new Map(summaryMap);
          nextSummaries.delete(id);
        }
        continue;
      }
      const summary = acpSummary(conversation.snapshot);
      if (sameSummary(previous, summary)) continue;
      nextSummaries ??= new Map(summaryMap);
      nextSummaries.set(id, summary);
    }
    if (nextSummaries) summaryMap = nextSummaries;
    for (const id of ids) {
      const set = listeners.get(id);
      if (set) for (const listener of [...set]) listener();
    }
    if (nextSummaries) for (const listener of [...summaryListeners]) listener();
  }

  /** Folds the buffered events of one session; true when its conversation changed. */
  function fold(id: string): boolean {
    const events = buffer.get(id);
    if (!events) return false;
    buffer.delete(id);
    const current = conversations.get(id);
    const updated = applyAcpEvents(current, events);
    if (!updated || updated === current) return false;
    conversations.set(id, updated);
    return true;
  }

  function flush() {
    cancelScheduled?.();
    cancelScheduled = null;
    if (!buffer.size) return;
    const changed: string[] = [];
    for (const id of [...buffer.keys()]) if (fold(id)) changed.push(id);
    commit(changed);
  }

  return {
    get: (id) => conversations.get(id),
    has: (id) => conversations.has(id),
    known: (id) => conversations.has(id) || !!buffer.get(id)?.some((event) => event.kind === 'snapshot'),
    register(snapshot) {
      if (!snapshot || typeof snapshot.id !== 'string' || retiredIds.has(snapshot.id)) return;
      const id = snapshot.id;
      // Events that arrived before this read are applied first, as they were received.
      const folded = fold(id);
      const existing = conversations.get(id);
      if (existing && existing.snapshot.seq > snapshot.seq) {
        if (folded) commit([id]);
        return;
      }
      conversations.set(id, { snapshot });
      commit([id]);
    },
    push(event) {
      if (!event || typeof event.sessionId !== 'string' || retiredIds.has(event.sessionId)) return;
      const events = buffer.get(event.sessionId);
      if (events) events.push(event);
      else buffer.set(event.sessionId, [event]);
      cancelScheduled ??= schedule(flush);
    },
    flush,
    retire(id) {
      retiredIds.add(id);
      buffer.delete(id);
      if (!conversations.delete(id) && !summaryMap.has(id)) return;
      commit([id]);
    },
    retired: (id) => retiredIds.has(id),
    subscribe(id, listener) {
      let set = listeners.get(id);
      if (!set) listeners.set(id, set = new Set());
      set.add(listener);
      return () => {
        const current = listeners.get(id);
        if (!current) return;
        current.delete(listener);
        if (!current.size) listeners.delete(id);
      };
    },
    subscribeSummaries(listener) {
      summaryListeners.add(listener);
      return () => { summaryListeners.delete(listener); };
    },
    summaries: () => summaryMap,
    dispose() {
      cancelScheduled?.();
      cancelScheduled = null;
    },
  };
}
