/** Ephemeral operation results. This store never persists messages or recovery closures. */
export type FeedbackTone = 'success' | 'error' | 'partial' | 'pending';
export type FeedbackEvent = {
  id: number; context: string; operation: string; tone: FeedbackTone; text: string;
  detail?: string; surface: string | null; expiresAt: number | null;
  recovery?: { label: string; valid: () => boolean; run: () => void | Promise<void> };
};
type ResultOptions = { detail?: string; recovery?: FeedbackEvent['recovery'] };
export type FeedbackOperation = {
  readonly operation: string;
  identify: (operation: string) => void;
  retry: (surface?: string | null) => FeedbackOperation;
  committed: (text: string) => void;
  complete: () => void;
  success: (text: string, options?: ResultOptions) => void;
  error: (text: string, options?: ResultOptions) => void;
  partial: (text: string, options?: ResultOptions) => void;
  pending: (text: string) => void;
};

export function createNotificationStore(now = () => Date.now()) {
  let events: FeedbackEvent[] = [];
  let sequence = 0;
  const revisions = new Map<string, number>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  const dismiss = (id: number) => { events = events.filter((event) => event.id !== id); emit(); };
  function begin(context: string, operation: string, surface: string | null = null): FeedbackOperation {
    let committedText = '';
    let key = JSON.stringify([context, operation]);
    let revision = (revisions.get(key) ?? 0) + 1;
    revisions.set(key, revision);
    function publish(tone: FeedbackTone, text: string, options: ResultOptions = {}) {
      if (!text || revisions.get(key) !== revision) return;
      // Only the same operation can resolve its own error; other operations survive.
      const previous = events.find((event) => event.context === context && event.operation === operation);
      events = events.filter((event) => event.context !== context || event.operation !== operation);
      events = [...events, { id: previous?.id ?? ++sequence, context, operation, surface, tone, text,
        ...options, expiresAt: tone === 'success' ? now() + 4000 : null }];
      emit();
    }
    return {
      get operation() { return operation; },
      // A newly persisted object takes over its stable ID without losing the
      // original event, surface or already completed phase.
      identify(next: string) {
        if (next === operation || revisions.get(key) !== revision) return;
        const old = operation;
        revisions.set(key, revision + 1);
        operation = next; key = JSON.stringify([context, operation]);
        revision = (revisions.get(key) ?? 0) + 1; revisions.set(key, revision);
        const previous = events.find(event => event.context === context && event.operation === old);
        if (previous) {
          events = events.filter(event => event.context !== context || event.operation !== old && event.operation !== next);
          events = [...events, { ...previous, operation }]; emit();
        }
      },
      retry: (nextSurface = surface) => begin(context, operation, nextSurface),
      committed: (text: string) => { committedText = text; },
      complete: () => {
        if (revisions.get(key) !== revision) return;
        events = events.filter((event) => event.context !== context || event.operation !== operation);
        emit();
      },
      success: (text: string, options?: ResultOptions) => publish('success', text, options),
      error: (text: string, options?: ResultOptions) => committedText ? publish('partial', committedText, { ...options, detail: [text, options?.detail].filter(Boolean).join(' · ') }) : publish('error', text, options),
      partial: (text: string, options?: ResultOptions) => publish('partial', text, options),
      pending: (text: string) => publish('pending', text),
    };
  }
  return {
    begin, dismiss,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => events,
    expire(paused: ReadonlySet<number> = new Set()) {
      const next = events.filter((event) => !event.expiresAt || event.expiresAt > now() || paused.has(event.id));
      if (next.length !== events.length) { events = next; emit(); }
    },
    pause(id: number) { events = events.map((event) => event.id === id && event.expiresAt ? { ...event, expiresAt: now() + 4000 } : event); },
    async recover(id: number) {
      const event = events.find((item) => item.id === id);
      if (!event?.recovery || !event.recovery.valid()) return false;
      await event.recovery.run();
      return true;
    },
  };
}

export const notifications = createNotificationStore();
