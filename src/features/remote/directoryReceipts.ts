import { useSyncExternalStore } from 'react';
import { native } from '../../lib/native';
import type { DirectoryReceipt, RemoteTarget } from '../../types/remote';
export type { DirectoryReceipt } from '../../types/remote';

// SQLite is the authority, not this view snapshot. Persist pending before
// dispatching mkdir so a lost WebView/native response cannot erase the fault.
let receipts: DirectoryReceipt[] = [];
let loaded = false;
let loading: Promise<void> | undefined;
let version = 0;
let poll: ReturnType<typeof setTimeout> | undefined;
const inspectionVersions = new Map<string, number>();
const updates = new Map<string, Promise<boolean>>();
export function beginDirectoryInspection(id: string) {
  const token = (inspectionVersions.get(id) ?? 0) + 1;
  inspectionVersions.set(id, token);
  return () => inspectionVersions.get(id) === token;
}
const listeners = new Set<() => void>();
const publish = (next: DirectoryReceipt[]) => {
  const retained = new Set(next.map(item => item.id));
  for (const id of inspectionVersions.keys()) if (!retained.has(id)) inspectionVersions.delete(id);
  receipts = next; version++;
  if (poll) clearTimeout(poll);
  // A refreshed WebView may lose its IPC promise while native is still running.
  // Observe completion without ever resubmitting the mutation.
  if (receipts.some(item => item.active)) poll = setTimeout(() => { void loadDirectoryReceipts(true).catch(() => {}); }, 1000);
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useDirectoryReceipts = () => useSyncExternalStore(subscribe, () => receipts);

export function loadDirectoryReceipts(fresh = false): Promise<void> {
  if (loaded && !fresh) return Promise.resolve();
  if (loading) return loading;
  const captured = version;
  loading = native.listRemoteDirectoryReceipts().then(stored => {
    // Native distinguishes live requests from an interrupted process. A
    // module/window lifetime alone cannot make that decision.
    if (captured === version) {
      const visible = new Set(receipts.map(item => item.id));
      // Resolved history is retained for safety, not restored as a permanent
      // fault entry. Keep this view's recent results as immediate feedback.
      publish(stored.filter(item => visible.has(item.id) || item.outcome === 'pending'
        || (item.outcome === 'unknown' && item.inspection?.state !== 'missing')));
    }
    loaded = true;
  }).finally(() => { loading = undefined; });
  return loading;
}

export async function beginDirectoryReceipt(target: RemoteTarget, path: string): Promise<DirectoryReceipt | null> {
  await loadDirectoryReceipts();
  if (receipts.some(item => blocksDirectoryCreation(item, target, path))) return null;
  let next = receipts;
  if (next.length >= 32) {
    const discard = next.findIndex(item => item.outcome !== 'pending' && (item.outcome !== 'unknown' || item.inspection?.state === 'missing'));
    if (discard < 0) return null; // Never evict an unresolved mutation to admit another one.
    next = next.filter((_, index) => index !== discard);
  }
  const { id, name, host, port, user, updatedAt } = target;
  const receipt: DirectoryReceipt = { id: crypto.randomUUID(), target: { id, name, host, port, user, updatedAt }, path, outcome: 'pending', detail: '' };
  await native.saveRemoteDirectoryReceipt(receipt);
  publish([...next, receipt]);
  return receipt;
}

export function updateDirectoryReceipt(id: string, patch: Partial<Pick<DirectoryReceipt, 'outcome' | 'detail' | 'inspection'>>, isCurrent = () => true): Promise<boolean> {
  const run = () => persistDirectoryReceipt(id, patch, isCurrent);
  const previous = updates.get(id);
  const pending = previous ? previous.then(run, run) : run();
  updates.set(id, pending);
  void pending.then(() => { if (updates.get(id) === pending) updates.delete(id); });
  return pending;
}

async function persistDirectoryReceipt(id: string, patch: Partial<Pick<DirectoryReceipt, 'outcome' | 'detail' | 'inspection'>>, isCurrent: () => boolean): Promise<boolean> {
  if (!isCurrent()) return false;
  const previous = receipts.find(item => item.id === id);
  if (!previous) return false;
  const next = { ...previous, ...patch };
  try {
    await native.saveRemoteDirectoryReceipt(next);
    if (!isCurrent()) return false;
    publish(receipts.map(item => item.id === id ? next : item));
    return true;
  } catch (error) {
    if (!isCurrent()) return false;
    // Keep the durable fault reachable; storage failure after dispatch cannot
    // grant permission to repeat a possible remote side effect.
    const detail = (error as { message?: string })?.message || String(error);
    publish(receipts.map(item => item.id === id ? { ...previous,
      outcome: previous.outcome === 'pending' || patch.outcome === 'created' ? 'unknown' : previous.outcome,
      inspection: { state: 'failed', detail },
    } : item));
    // A native terminal result wins over a late browser inspection/outcome.
    await loadDirectoryReceipts(true).catch(() => {});
    return false;
  }
}

export function blocksDirectoryCreation(receipt: DirectoryReceipt, target: RemoteTarget | null, path: string) {
  return receipt.target.id === target?.id && receipt.target.updatedAt === target.updatedAt && receipt.path === path
    && (receipt.outcome === 'pending' || (receipt.outcome === 'unknown' && receipt.inspection?.state !== 'missing'));
}
