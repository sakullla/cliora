import type { ConfigurationAction, ConfigurationCredential, ConfigurationDraft } from '../types/configuration';
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

/** The four tones the board's live strip may use; only a trusted binding is green. */
export type ConfigurationLiveTone = 'success' | 'warning' | 'unknown' | 'neutral';
export type ConfigurationLiveState = 'applied' | 'invalid' | 'external' | 'unconfirmed' | 'unapplied' | 'project_unbound';

/**
 * What a read-only comparison of an applied binding against the current native files said.
 * `unchecked` is not a fact about the files: nothing comparable was read, so nothing is claimed.
 */
export type ConfigurationNativeFileState = 'unchecked' | 'unchanged' | 'changed' | 'unknown';

/** Name and copy for one configuration row; `external` and `unconfirmed` never read as in effect. */
export type ConfigurationRowState = 'active' | 'pending' | 'saved' | 'external' | 'unconfirmed';

/**
 * The rows and the board's strip share this judgement, so they cannot disagree about the
 * same record. A file that is no longer what the profile wrote is an external change, and a
 * comparison that could not be read is unconfirmed; neither may be reported as in effect.
 */
export function configurationRowState(
  profile: RegisteredProfile,
  binding: AppliedBinding | null | undefined,
  common: RegisteredCommon | null | undefined,
  file: ConfigurationNativeFileState = 'unchecked',
): ConfigurationRowState {
  const { same, trusted, applied } = configurationApplicationState(profile, binding, common);
  if (applied) {
    if (file === 'changed') return 'external';
    if (file === 'unknown') return 'unconfirmed';
    return 'active';
  }
  // Another saved profile is applied here: this row only has a saved version.
  if (!same) return 'saved';
  // The binding points here but its application record is unreadable, so nothing is confirmed.
  return trusted ? 'pending' : 'unconfirmed';
}

/**
 * What the board may state about this exact scope. It reuses the row judgement so the
 * strip and the rows cannot disagree, and it never claims more than the facts support:
 * a remote target carries no binding, a stale binding is "no longer in effect", and an
 * applied profile whose native file changed outside Cliora is never shown as in effect.
 */
export function configurationLiveState(
  binding: AppliedBinding | null | undefined,
  profiles: readonly RegisteredProfile[],
  common: RegisteredCommon | null | undefined,
  scope: 'global' | 'project',
  remote: boolean,
  file: ConfigurationNativeFileState = 'unchecked',
): { tone: ConfigurationLiveTone; state: ConfigurationLiveState; profile: RegisteredProfile | null } {
  // A remote target's tool store has no binding, so nothing here is readable as a fact.
  if (remote) return { tone: 'unknown', state: 'unconfirmed', profile: null };
  if (!binding) return {
    tone: 'neutral',
    state: scope === 'project' ? 'project_unbound' : 'unapplied',
    profile: null,
  };
  const profile = profiles.find(item => item.id === binding.profileId) ?? null;
  if (profile && configurationApplicationState(profile, binding, common).applied) {
    if (file === 'changed') return { tone: 'warning', state: 'external', profile };
    // A comparison that failed says nothing about the files; it does not read as broken either.
    if (file === 'unknown') return { tone: 'unknown', state: 'unconfirmed', profile };
    return { tone: 'success', state: 'applied', profile };
  }
  return { tone: 'warning', state: 'invalid', profile };
}

/** Opaque API refs can be restored only for the same connection identity. */
export const configurationConnectionIdentity = (connection: Connection | null) => connection ? JSON.stringify([connection.providerId, connection.interfaceFormat, connection.baseUrl]) : '';

export type ConfigurationApiBuffer = { credential: Extract<ConfigurationCredential, { source: 'api_key' }>; input: string; replacing: boolean };
export const configurationCredentialIdentity = (draft: ConfigurationDraft) => configurationConnectionIdentity(draft.draftConnection ?? draft.profile.connection) || draft.nativeCredentialTarget?.identity || '';

/** Browsing a new connection cannot reassign an existing ref or unfinished key. */
export function rememberConfigurationApiBuffer(buffers: Map<string, ConfigurationApiBuffer>, credentialIdentity: string, credential: ConfigurationApiBuffer['credential'], inputIdentity: string, input: string, replacing: boolean) {
  const previous = buffers.get(credentialIdentity);
  buffers.set(credentialIdentity, {
    credential,
    input: inputIdentity === credentialIdentity ? input : previous?.input ?? '',
    replacing: inputIdentity === credentialIdentity ? replacing : previous?.replacing ?? false,
  });
  if (inputIdentity !== credentialIdentity) buffers.set(inputIdentity, { credential: buffers.get(inputIdentity)?.credential ?? { source: 'api_key', secretRef: null }, input, replacing });
}

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
    /** Opaque validity keys, surfaced so the dialog can name what blocks saving. */
    get invalidFields(): readonly string[] { return [...invalidFields]; },
    invalidate() { epoch += 1; pending.clear(); sequence = Promise.resolve(); },
    close() { closed = true; epoch += 1; pending.clear(); },
    edit: enqueue,
    update: enqueue,
  };
}

export function configurationAction(operation: string, target: unknown, field: string | null = null, value: unknown = null): ConfigurationAction {
  return { version: 1, operation, target, field, value };
}
