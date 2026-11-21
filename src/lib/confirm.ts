import { native } from './native';
import type { PromptSecretApprovalRequest } from '../types/secrets';

export interface ConfirmationOptions {
  title?: string;
  confirmLabel?: string;
  destructive?: boolean;
}
export interface ConfirmationRequest extends ConfirmationOptions {
  id: number;
  message: string;
}

let sequence = 0;
let current: (ConfirmationRequest & { resolve: (accepted: boolean) => void }) | null = null;
const listeners = new Set<() => void>();

export const confirmationSnapshot = () => current;
export function subscribeConfirmation(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function answerConfirmation(id: number, accepted: boolean) {
  if (current?.id !== id) return;
  const request = current;
  current = null;
  listeners.forEach(listener => listener());
  request.resolve(accepted);
}

/** All environments use the same application dialog; stale answers authorize nothing. */
export async function confirmAction(message: string, isCurrent: () => boolean = () => true, options: ConfirmationOptions = {}): Promise<boolean> {
  try {
    if (current || !isCurrent()) return false;
    const accepted = await new Promise<boolean>(resolve => {
      current = { id: ++sequence, message, ...options, resolve };
      listeners.forEach(listener => listener());
    });
    return accepted === true && isCurrent();
  } catch {
    return false;
  }
}

// A secret read approval is a separate queue from ordinary confirmations: it is
// created by the broker, not by a window action, and the window only ever holds the
// alias, the request source and one approval id. There is at most one open request;
// a second one waits for the broker to time out instead of stacking dialogs.

let approval: PromptSecretApprovalRequest | null = null;
const approvalListeners = new Set<() => void>();

export const secretApprovalSnapshot = () => approval;
export function subscribeSecretApproval(listener: () => void) {
  approvalListeners.add(listener);
  return () => { approvalListeners.delete(listener); };
}
function notifyApproval() {
  approvalListeners.forEach(listener => listener());
}

/**
 * Shows one request. Returns false when the payload is unusable or another request is
 * already open; the broker then reports the read as unavailable or expired.
 */
export function presentSecretApproval(request: PromptSecretApprovalRequest): boolean {
  if (!request || typeof request.approvalId !== 'string' || !request.approvalId || approval) return false;
  approval = { ...request, alias: String(request.alias ?? ''), source: String(request.source ?? '') };
  notifyApproval();
  return true;
}

/**
 * Answers by id and nothing else. A duplicate answer, an answer to a request that
 * already expired and an answer after the window closed all do nothing: the native
 * side owns the pending entry and refuses what it no longer holds.
 */
export function answerSecretApproval(approvalId: string, accepted: boolean): Promise<void> {
  if (!approval || approval.approvalId !== approvalId) return Promise.resolve();
  approval = null;
  notifyApproval();
  return Promise.resolve(native.answerPromptSecretApproval(approvalId, accepted)).then(() => undefined, () => undefined);
}

/** Drops the open request without answering it, so it expires on the native side. */
export function dismissSecretApproval(approvalId?: string) {
  if (!approval || (approvalId && approval.approvalId !== approvalId)) return;
  approval = null;
  notifyApproval();
}
