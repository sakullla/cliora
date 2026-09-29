/** An IPC result may update only the exact draft it was started from. */
export type DraftRequest<T extends object> = {
  context: string;
  revision: number;
  draft: T | null;
};

export function sameDraftRequest<T extends object>(started: DraftRequest<T>, current: DraftRequest<T>): boolean {
  return started.context === current.context
    && started.revision === current.revision
    && started.draft === current.draft;
}
