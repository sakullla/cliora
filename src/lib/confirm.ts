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

// Concurrent callers keep their own request ids and original expiry times.
const approvals: (PromptSecretApprovalRequest & { expiresAt: number })[] = [];
const approvalListeners = new Set<() => void>();

export const secretApprovalSnapshot = () => approvals[0] ?? null;
export function subscribeSecretApproval(listener: () => void) {
  approvalListeners.add(listener);
  return () => { approvalListeners.delete(listener); };
}
function notifyApproval() {
  approvalListeners.forEach(listener => listener());
}

export function presentSecretApproval(request: PromptSecretApprovalRequest): boolean {
  if (!request?.approvalId || !Number.isFinite(request.expiresInSeconds) || request.expiresInSeconds <= 0
    || approvals.some(item => item.approvalId === request.approvalId)) return false;
  approvals.push({ ...request, expiresAt: Date.now() + request.expiresInSeconds * 1000 });
  notifyApproval();
  return true;
}

/**
 * Answers by id and nothing else. A duplicate answer, an answer to a request that
 * already expired and an answer after the window closed all do nothing: the native
 * side owns the pending entry and refuses what it no longer holds.
 */
export function answerSecretApproval(approvalId: string, accepted: boolean, rememberSession = false): Promise<void> {
  const approval = secretApprovalSnapshot();
  if (!approval || approval.approvalId !== approvalId) return Promise.resolve();
  const session = accepted && approval.sessionAvailable === true && rememberSession;
  dismissSecretApproval(approvalId);
  if (Date.now() >= approval.expiresAt) return Promise.resolve();
  return Promise.resolve(native.answerPromptSecretApproval(approvalId, accepted, session)).then(() => undefined, () => undefined);
}

/** Advance to the next unexpired request, or clear the window's queue on unmount. */
export function dismissSecretApproval(approvalId?: string) {
  if (!approvals.length || (approvalId && approvals[0].approvalId !== approvalId)) return;
  if (approvalId) {
    approvals.shift();
    while (approvals.length && approvals[0].expiresAt <= Date.now()) approvals.shift();
  } else {
    approvals.length = 0;
  }
  notifyApproval();
}
