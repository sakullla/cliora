import { useSyncExternalStore } from 'react';
import type { RemoteWriteReceipt } from '../../types/remote';

const key = 'cliora:remote-writes:v1';
let receipts: RemoteWriteReceipt[] = [];
try {
  const stored: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
  if (Array.isArray(stored)) receipts = stored.filter(item => item && typeof item.id === 'string' && typeof item.targetId === 'string' && Array.isArray(item.items));
} catch { /* Remote journals remain the durable authority. */ }
const listeners = new Set<() => void>();
const versions = new Map<string, number>();
const inspecting = new Set<string>();
// Lists are snapshots, while inspection/restore and write results are newer
// observations. Coordinate by receipt in this shared store across page mounts.
export const captureWriteReceiptVersions = () => new Map(versions);
export function beginWriteReceiptInspection(id: string) {
  if (inspecting.has(id)) return null;
  inspecting.add(id);
  versions.set(id, (versions.get(id) ?? 0) + 1);
  return () => { inspecting.delete(id); versions.set(id, (versions.get(id) ?? 0) + 1); };
}
export function rememberListedWriteReceipt(receipt: RemoteWriteReceipt, snapshot: Map<string, number>) {
  if (!inspecting.has(receipt.id) && (snapshot.get(receipt.id) ?? 0) === (versions.get(receipt.id) ?? 0)) rememberWriteReceipt(receipt);
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getWriteReceipts = () => receipts;
export const useWriteReceipts = () => useSyncExternalStore(subscribe, () => receipts);
export const unresolvedWrite = (receipt: RemoteWriteReceipt) => !['committed', 'rolled_back', 'conflict_before_commit', 'prepare_failed'].includes(receipt.outcome);
export function rememberWriteReceipt(receipt: RemoteWriteReceipt) {
  versions.set(receipt.id, (versions.get(receipt.id) ?? 0) + 1);
  receipts = [...receipts.filter(item => item.id !== receipt.id), receipt];
  // Never evict an unresolved outcome to make a retry appear safe.
  const resolved = receipts.filter(item => !unresolvedWrite(item));
  receipts = [...receipts.filter(unresolvedWrite), ...resolved.slice(-32)];
  try { localStorage.setItem(key, JSON.stringify(receipts)); } catch { /* Journal can be rediscovered on the original host. */ }
  for (const listener of listeners) listener();
}
