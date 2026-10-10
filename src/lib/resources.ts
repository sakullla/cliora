import { native } from './native';
import type { McpTargetResult, ResourceItemResult, ResourceOperation, ResourceStateRequest } from '../types/resources';

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
export async function runResourceOperations(operations: Array<ResourceOperation | (() => Promise<ResourceOperation>)>, control: { cancelled: boolean; active: string | null }, progress: (items: ResourceItemResult[]) => void, confirmReplace: (operation: Extract<ResourceOperation, { action: 'mcp_apply' }>, preview: McpTargetResult) => Promise<boolean>) {
  const results: ResourceItemResult[] = operations.map((_, index) => ({ index, status: 'not_executed', detail: '', value: null }));
  for (let offset = 0; offset < operations.length; offset += RESOURCE_PAGE_SIZE) {
    if (control.cancelled) break;
    const chunk: ResourceOperation[] = []; const indices: number[] = [];
    for (let index = offset; index < Math.min(offset + RESOURCE_PAGE_SIZE, operations.length); index++) {
      if (control.cancelled) break;
      try {
        const source = operations[index]; let operation = typeof source === 'function' ? await source() : source;
        if (operation.action === 'mcp_apply') {
          const preview = (await native.previewMcpTargets(operation.definitionId, [operation.target]))[0];
          if (!preview || !['ready', 'conflict'].includes(preview.status) || !preview.previewToken || !preview.baselineHash) throw new Error(preview?.detail || 'MCP preview unavailable');
          if (preview.status === 'conflict' && !await confirmReplace(operation, preview)) {
            results[index] = { index, status: 'conflict', detail: preview.detail, value: null }; continue;
          }
          operation = { ...operation, target: { ...operation.target, contextId: preview.contextId ?? operation.target.contextId, baselineHash: preview.baselineHash, previewToken: preview.previewToken, allowReplace: preview.status === 'conflict' } };
        }
        if (!control.cancelled) { indices.push(index); chunk.push(operation); }
      } catch (error) { results[index] = { index, status: 'failed', detail: resourceError(error), value: null }; }
    }
    if (control.cancelled || !chunk.length) { progress([...results]); continue; }
    control.active = crypto.randomUUID();
    try {
      const result = await native.runResourceBatch(control.active, chunk);
      for (let index = 0; index < chunk.length; index++) {
        const item = result.items.find(item => item.index === index);
        results[indices[index]] = item ? { ...item, index: indices[index] } : { index: indices[index], status: 'not_executed', detail: '', value: null };
      }
      if (result.cancelled) control.cancelled = true;
    } catch (error) {
      for (const index of indices) results[index] = { index, status: 'failed', detail: resourceError(error), value: null };
    }
    control.active = null;
    progress([...results]);
  }
  control.active = null;
  progress(results);
  return results;
}
