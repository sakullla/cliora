import type { ConfigurationAction, ConfigurationDraft } from '../types/configuration';
import type { AppliedBinding, Connection, RegisteredCommon, RegisteredProfile } from '../types/native';

/** Last-success identity is independent of the currently saved profile. */
export function configurationApplicationState(profile: RegisteredProfile, binding: AppliedBinding | null | undefined, common: RegisteredCommon | null | undefined) {
  const same = binding?.profileId === profile.id;
  const commonPending = same && profile.inheritCommon && (common
    ? !common.revision || binding?.commonVersion !== common.version || binding?.commonRevision !== common.revision
    : binding?.commonVersion != null || binding?.commonRevision != null);
  const trusted = binding?.appliedProfileAvailable === true && !!binding.appliedSummary
    && binding.appliedSummary.profileVersion === binding.profileVersion;
  const applied = same && trusted && binding?.profileVersion === profile.version
    && !!profile.revision && binding.appliedSummary?.profileRevision === profile.revision && !commonPending;
  return { same, commonPending, trusted, applied };
}

/** Opaque API refs can be restored only for the same connection identity. */
export const configurationConnectionIdentity = (connection: Connection | null) => connection ? JSON.stringify([connection.providerId, connection.interfaceFormat, connection.baseUrl]) : '';

/** Query results belong to both the document and the independent request generation. */
export function configurationRequestMatches(current: ConfigurationDraft, started: ConfigurationDraft, result: { sessionId: string; revision: number; requestGeneration: number }) {
  return current.sessionId === started.sessionId && current.revision === started.revision
    && current.requestGeneration === started.requestGeneration && result.sessionId === started.sessionId
    && result.revision === started.revision && result.requestGeneration === (started.requestGeneration ?? 0);
}

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
    /** A successful save can update persisted identity without editing the document. */
    acceptSaved(next: ConfigurationDraft) {
      if (closed || pending.size || next.sessionId !== draft.sessionId || next.revision < draft.revision) return false;
      draft = next; return true;
    },
    setFieldValidity(field: string, valid: boolean) { if (valid) invalidFields.delete(field); else invalidFields.add(field); },
    isFieldValid(field: string) { return !invalidFields.has(field); },
    invalidate() { epoch += 1; pending.clear(); sequence = Promise.resolve(); },
    close() { closed = true; epoch += 1; pending.clear(); },
    edit: enqueue,
    update: enqueue,
  };
}

export function configurationAction(operation: string, target: unknown, field: string | null = null, value: unknown = null): ConfigurationAction {
  return { version: 1, operation, target, field, value };
}
