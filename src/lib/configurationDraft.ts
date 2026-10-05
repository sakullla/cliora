import type { ConfigurationAction, ConfigurationDraft } from '../types/configuration';

/** Every request reserves its own generation; a late response cannot overwrite a newer edit. */
export function createConfigurationSession(initial: ConfigurationDraft) {
  let draft = initial;
  let generation = 0;
  let closed = false;
  let epoch = 0;
  let sequence = Promise.resolve();
  let requestId = 0;
  const invalidFields = new Set<string>();
  const pending = new Set<number>();
  return {
    get draft() { return draft; },
    get pending() { return pending.size > 0; },
    get canSubmit() { return !closed && pending.size === 0 && draft.issues.length === 0 && invalidFields.size === 0; },
    setFieldValidity(field: string, valid: boolean) { if (valid) invalidFields.delete(field); else invalidFields.add(field); },
    invalidate() { generation += 1; epoch += 1; pending.clear(); },
    close() { closed = true; generation += 1; epoch += 1; pending.clear(); },
    /** Serialize form actions so consecutive field edits consume the previous response. */
    edit(request: (current: ConfigurationDraft) => Promise<ConfigurationDraft>): Promise<boolean> {
      if (closed) return Promise.resolve(false);
      const token = ++requestId;
      const editEpoch = epoch;
      pending.add(token);
      let accepted = false;
      const operation = sequence.then(async () => {
        if (closed || editEpoch !== epoch) return;
        const next = await request(draft);
        if (closed || editEpoch !== epoch || next.sessionId !== draft.sessionId || next.revision < draft.revision) return;
        draft = next;
        accepted = true;
      });
      sequence = operation.catch(() => {});
      return operation.then(() => accepted).finally(() => { pending.delete(token); });
    },
    async update(request: (current: ConfigurationDraft) => Promise<ConfigurationDraft>): Promise<boolean> {
      if (closed) return false;
      epoch += 1;
      const generationToken = ++generation;
      const token = ++requestId;
      const sessionId = draft.sessionId;
      pending.add(token);
      try {
        const next = await request(draft);
        if (closed || generationToken !== generation || next.sessionId !== sessionId || next.revision < draft.revision) return false;
        draft = next;
        return true;
      } finally { pending.delete(token); }
    },
  };
}

export function configurationAction(operation: string, target: unknown, field: string | null = null, value: unknown = null): ConfigurationAction {
  return { version: 1, operation, target, field, value };
}
