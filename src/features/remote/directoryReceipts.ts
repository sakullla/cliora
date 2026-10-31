import { useSyncExternalStore } from 'react';
import type { RemoteTarget } from '../../types/remote';

export type DirectoryReceipt = {
  id: string;
  target: Pick<RemoteTarget, 'id' | 'name' | 'host' | 'port' | 'user' | 'updatedAt'>;
  path: string;
  outcome: 'pending' | 'created' | 'failed' | 'unknown';
  detail: string;
  inspection?: { state: 'checking' | 'exists' | 'missing' | 'failed'; detail: string };
};

// Operation receipts survive dialog/page lifecycles. They are not read caches:
// an abandoned subscriber cannot erase the outcome of a dispatched mutation.
let receipts: DirectoryReceipt[] = [];
const listeners = new Set<() => void>();
const publish = (next: DirectoryReceipt[]) => { receipts = next; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useDirectoryReceipts = () => useSyncExternalStore(subscribe, () => receipts);

export function beginDirectoryReceipt(target: RemoteTarget, path: string): DirectoryReceipt | null {
  let next = receipts;
  if (next.length >= 32) {
    const discard = next.findIndex(item => item.outcome !== 'pending' && (item.outcome !== 'unknown' || item.inspection?.state === 'missing'));
    if (discard < 0) return null; // Never evict an unresolved mutation to admit another one.
    next = next.filter((_, index) => index !== discard);
  }
  const { id, name, host, port, user, updatedAt } = target;
  const receipt: DirectoryReceipt = { id: crypto.randomUUID(), target: { id, name, host, port, user, updatedAt }, path, outcome: 'pending', detail: '' };
  publish([...next, receipt]);
  return receipt;
}

export function updateDirectoryReceipt(id: string, patch: Partial<Pick<DirectoryReceipt, 'outcome' | 'detail' | 'inspection'>>) {
  publish(receipts.map(item => item.id === id ? { ...item, ...patch } : item));
}

export function blocksDirectoryCreation(receipt: DirectoryReceipt, target: RemoteTarget | null, path: string) {
  return receipt.target.id === target?.id && receipt.target.updatedAt === target.updatedAt && receipt.path === path
    && (receipt.outcome === 'pending' || (receipt.outcome === 'unknown' && receipt.inspection?.state !== 'missing'));
}
