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
