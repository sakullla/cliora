import type { ConfigurationAction, ConfigurationDraft } from '../types/configuration';

/** Text replacements and form actions share one order and consume the latest accepted draft. */
export function createConfigurationSession(initial: ConfigurationDraft) {
  let draft = initial;
  let closed = false;
  let epoch = 0;
  let sequence = Promise.resolve();
  let requestId = 0;
  const invalidFields = new Set<string>();
  const pending = new Set<number>();
  const enqueue = (request: (current: ConfigurationDraft) => Promise<ConfigurationDraft>): Promise<boolean> => {
    if (closed) return Promise.resolve(false);
    const token = ++requestId;
    const requestEpoch = epoch;
    pending.add(token);
    let accepted = false;
    const operation = sequence.then(async () => {
      if (closed || requestEpoch !== epoch) return;
      const base = draft;
      const next = await request(base);
      if (closed || requestEpoch !== epoch || next.sessionId !== base.sessionId || next.revision <= base.revision) return;
      draft = next;
      accepted = true;
    });
    sequence = operation.catch(() => {});
    return operation.then(() => accepted).finally(() => { pending.delete(token); });
  };
  return {
    get draft() { return draft; },
    get pending() { return pending.size > 0; },
    get canSubmit() { return !closed && pending.size === 0 && draft.issues.length === 0 && invalidFields.size === 0; },
    setFieldValidity(field: string, valid: boolean) { if (valid) invalidFields.delete(field); else invalidFields.add(field); },
    invalidate() { epoch += 1; pending.clear(); sequence = Promise.resolve(); },
    close() { closed = true; epoch += 1; pending.clear(); },
    edit: enqueue,
    update: enqueue,
  };
}

export function configurationAction(operation: string, target: unknown, field: string | null = null, value: unknown = null): ConfigurationAction {
  return { version: 1, operation, target, field, value };
}
