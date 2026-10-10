import { native } from './native';
import type { ResourceItemResult, ResourceOperation, ResourceStateRequest } from '../types/resources';

export const RESOURCE_PAGE_SIZE = 50;
export const resourceSucceeded = (status: string) => ['written', 'installed', 'removed', 'already_current'].includes(status);
export function resourceError(error: unknown): string { return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error); }
export async function resourceSortPreference(context: string, value?: 'added' | 'name') {
  const encoded = new TextEncoder().encode(context);
  const key = encoded.length <= 256 ? context : 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoded))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return native.resourceSortPreference(key, value);
}
let stateQueue: Promise<unknown> = Promise.resolve();
export function readResourceStates(requests: ResourceStateRequest[], current: () => boolean) {
  const result = stateQueue.then(() => current() ? native.resourceStates(requests) : []);
  stateQueue = result.catch(() => {});
  return result;
}

// One active IPC at a time, including when selection spans many pages. A cancel
// stops future chunks; committed results from the active chunk are retained.
export async function runResourceOperations(operations: ResourceOperation[], control: { cancelled: boolean; active: string | null }, progress: (items: ResourceItemResult[]) => void) {
  const results: ResourceItemResult[] = [];
  for (let offset = 0; offset < operations.length; offset += RESOURCE_PAGE_SIZE) {
    if (control.cancelled) break;
    const chunk = operations.slice(offset, offset + RESOURCE_PAGE_SIZE);
    control.active = crypto.randomUUID();
    try {
      const result = await native.runResourceBatch(control.active, chunk);
      for (let index = 0; index < chunk.length; index++) {
        const item = result.items.find(item => item.index === index);
        results.push(item ? { ...item, index: offset + index } : { index: offset + index, status: 'not_executed', detail: '', value: null });
      }
      if (result.cancelled) control.cancelled = true;
    } catch (error) {
      results.push(...chunk.map((_, index): ResourceItemResult => ({ index: offset + index, status: 'failed', detail: resourceError(error), value: null })));
    }
    progress([...results]);
  }
  control.active = null;
  for (let index = results.length; index < operations.length; index++) results.push({ index, status: 'not_executed', detail: '', value: null });
  progress(results);
  return results;
}
