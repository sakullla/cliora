import type { RemoteFailure, RemoteOperationKind, RemoteOperationRequest, RemotePriority } from '../types/remote';

export type RemoteFreshness = { stale: boolean; at: number };

export type RemoteOperationOptions = {
  expectedFiles?: Record<string, string>;
  captureVersions?: boolean;
  onVersions?: (versions: Record<string, string>) => void;
  signal?: AbortSignal;
  targetId?: string;
  timeoutMs?: number;
  priority?: RemotePriority;
  targetRevision?: number;
  /** Full resource/scope identity; only read operations can share work. */
  shareKey?: string;
  /** Bypass settled freshness; overlapping refreshes still share work. */
  fresh?: boolean;
  cacheTtlMs?: number;
  onFreshness?: (state: RemoteFreshness) => void;
};

export type RemoteOperationHandle<T> = {
  requestId: string;
  promise: Promise<T>;
  cancel: () => void;
};

type Transport = <T>(name: string, args: Record<string, unknown>) => Promise<T>;
type Flight = {
  request: RemoteOperationRequest;
  promise: Promise<unknown>;
  subscribers: number;
  settled: boolean;
  versions?: Record<string, string>;
  invalidated?: boolean;
};

export function remoteFailure(stage: string, request: RemoteOperationRequest): RemoteFailure {
  return {
    code: `remote_${stage}`, stage: 'subscription', reason: stage,
    message: stage === 'timeout' ? '远程操作超时' : stage === 'identity' ? '远程数据已失效，请刷新后重试' : '远程操作已取消',
    action: '需要时重新发起读取。', requestId: request.requestId, targetId: request.targetId,
    targetRevision: request.targetRevision ?? null, outcome: 'failed', retryable: false, exitCode: null,
  };
}

/** A draft freezes the versions the user saw. Other reads may update inventory
 * without rebasing that draft; closing/reloading it explicitly starts a new one. */
export class RemoteDraftVersions {
  private latest: Record<string, string> = {};
  private draft: Record<string, string> | null = null;
  private token: string | null = null;
  private action: Record<string, string> | null = null;
  observe(versions: Record<string, string>) {
    this.latest = { ...this.latest, ...versions };
    if (this.draft) this.draft = { ...versions, ...this.draft };
    if (this.action) this.action = { ...versions, ...this.action };
  }
  bind(token: string | null) {
    if (token === this.token) return;
    this.token = token;
    this.draft = token === null ? null : { ...this.latest };
  }
  beginAction() { if (this.action === null) this.action = { ...this.latest }; }
  rebaseAction() { this.action = null; }
  committed(versions: Record<string, string>) {
    this.observe(versions);
    if (this.draft) this.draft = { ...this.draft, ...versions };
    this.action = null;
  }
  expected() { return { ...(this.draft ?? this.action ?? this.latest) }; }
}

/** Each subscription has its own cancellation/deadline. The native operation
 * is cancelled only after its final reader leaves. Cached values are cloned
 * so editable drafts cannot mutate other subscribers or cached data. */
export class RemoteOperations {
  private readonly flights = new Map<string, Flight>();

  private readonly cache = new Map<string, { targetId: string; at: number; value: unknown; bytes: number; stale: boolean; versions: Record<string, string> }>();
  private cacheBytes = 0;

  constructor(private readonly transport: Transport) {}

  invalidate(targetId?: string) {
    for (const [key, entry] of this.cache) {
      if (!targetId || entry.targetId === targetId) { this.cacheBytes -= entry.bytes; this.cache.delete(key); }
    }
    for (const [key, flight] of this.flights) {
      if (!targetId || flight.request.targetId === targetId) {
        flight.invalidated = true;
        this.flights.delete(key);
      }
    }
  }

  private remember(key: string, targetId: string, value: unknown, versions: Record<string, string>) {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
    if (bytes > 8 * 1024 * 1024) return;
    const old = this.cache.get(key);
    if (old) this.cacheBytes -= old.bytes;
    this.cache.delete(key);
    this.cache.set(key, { targetId, at: Date.now(), value: structuredClone(value), bytes, stale: false, versions });
    this.cacheBytes += bytes;
    while (this.cache.size > 96 || this.cacheBytes > 24 * 1024 * 1024) {
      const first = this.cache.entries().next().value!;
      this.cache.delete(first[0]); this.cacheBytes -= first[1].bytes;
    }
  }

  start<T>(name: string, args: Record<string, unknown>, targetId: string, kind: RemoteOperationKind, options: RemoteOperationOptions = {}): RemoteOperationHandle<T> {
    const timeout = Math.max(1, Math.min(options.timeoutMs ?? 40_000, 120_000));
    const deadline = Date.now() + timeout;
    const key = kind === 'read' && options.shareKey ? JSON.stringify([targetId, options.targetRevision, name, options.shareKey, args]) : undefined;
    const cached = key && !options.fresh && !options.signal?.aborted ? this.cache.get(key) : undefined;
    if (cached && Date.now() - cached.at < (options.cacheTtlMs ?? 30_000)) {
      const request: RemoteOperationRequest = {
        requestId: crypto.randomUUID(), cancelToken: crypto.randomUUID(), targetId,
        targetRevision: options.targetRevision ?? null, kind, priority: options.priority ?? 'interactive', deadlineUnixMs: deadline,
      };
      let cancel = () => {};
      const promise = new Promise<T>((resolve, reject) => {
        let done = false;
        cancel = () => { if (!done) { done = true; options.signal?.removeEventListener('abort', cancel); reject(remoteFailure('cancelled', request)); } };
        options.signal?.addEventListener('abort', cancel, { once: true });
        queueMicrotask(() => {
          if (done) return;
          done = true;
          options.signal?.removeEventListener('abort', cancel);
          options.onVersions?.({ ...cached.versions });
          options.onFreshness?.({ stale: cached.stale, at: cached.at });
          resolve(structuredClone(cached.value) as T);
        });
      });
      return { requestId: request.requestId, promise, cancel };
    }
    let flight = key ? this.flights.get(key) : undefined;
    // Joining must never give a new subscriber less than its requested budget.
    if (flight && (flight.settled || flight.request.deadlineUnixMs < deadline)) flight = undefined;
    if (!flight) {
      const request: RemoteOperationRequest = {
        requestId: crypto.randomUUID(), cancelToken: crypto.randomUUID(), targetId,
        targetRevision: options.targetRevision ?? null, kind,
        refresh: options.fresh ?? false,
        expectedFiles: kind === 'write' ? structuredClone(options.expectedFiles ?? {}) : undefined,
        priority: options.priority ?? 'interactive',
        // Shared work has a hard cap; each subscriber still enforces its own
        // deadline below and the last departed reader cancels the process.
        deadlineUnixMs: key ? Date.now() + 120_000 : deadline,
      };
      flight = { request, promise: Promise.resolve(), subscribers: 0, settled: false };
      const created = flight;
      created.promise = options.signal?.aborted
        ? Promise.reject(remoteFailure('cancelled', request))
        : this.transport<T>(name, { ...args, operation: request });
      created.promise = created.promise.then(async value => {
        if (options.captureVersions) {
          const versions = await this.transport<Record<string, string>>('get_remote_write_snapshot', { requestId: request.requestId });
          if (versions && typeof versions === 'object' && !Array.isArray(versions)) created.versions = versions;
        }
        if (created.invalidated) throw remoteFailure('identity', request);
        if (key && created.subscribers > 0 && (options.cacheTtlMs ?? 30_000) > 0) this.remember(key, targetId, value, created.versions ?? {});
        return value;
      }).catch(error => {
        const previous = key ? this.cache.get(key) : undefined;
        if (previous && !created.invalidated) previous.stale = true;
        throw error;
      }).finally(() => {
        created.settled = true;
        if (key && this.flights.get(key) === created) this.flights.delete(key);
      });
      if (key && !options.signal?.aborted) this.flights.set(key, created);
    }
    const subscribed = flight;
    subscribed.subscribers++;
    let cancel = () => {};
    const promise = new Promise<T>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const release = () => {
        if (done) return false;
        done = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        subscribed.subscribers--;
        return true;
      };
      const stopNative = () => {
        if (!subscribed.settled && subscribed.subscribers === 0) {
          if (key && this.flights.get(key) === subscribed) this.flights.delete(key);
          void this.transport('cancel_remote_operation', {
            requestId: subscribed.request.requestId, cancelToken: subscribed.request.cancelToken,
          }).catch(() => { /* Original request still returns its native outcome. */ });
        }
      };
      const stop = (stage: string) => {
        if (kind === 'write') {
          // Wait for the native result to distinguish queued cancellation from
          // a dispatched write with unknown outcome. Cancellation is not undo.
          if (!done) void this.transport('cancel_remote_operation', {
            requestId: subscribed.request.requestId, cancelToken: subscribed.request.cancelToken,
          }).catch(() => {});
          return;
        }
        if (release()) { stopNative(); reject(remoteFailure(stage, subscribed.request)); }
      };
      const abort = () => stop('cancelled');
      cancel = abort;
      options.signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => stop('timeout'), Math.max(0, deadline - Date.now()));
      subscribed.promise.then(
        value => { if (release()) { options.onVersions?.({ ...subscribed.versions }); options.onFreshness?.({ stale: false, at: Date.now() }); resolve(structuredClone(value) as T); } },
        error => { if (release()) {
          const previous = key ? this.cache.get(key) : undefined;
          options.onFreshness?.({ stale: true, at: previous?.at ?? 0 });
          reject(error);
        } },
      );
      if (options.signal?.aborted) abort();
    });
    return { requestId: subscribed.request.requestId, promise, cancel };
  }
}
