import type { RegisteredCommon, RegisteredProfile, Scope } from './native';

export const configurationEditingVersion = 1;
export type ConfigurationAction = {
  version: number;
  target: unknown;
  operation: string;
  field: string | null;
  value: unknown | null;
};
export type EditingState = { version: number; selectedProvider: string | null; intents: ConfigurationAction[] };
export type ConfigurationField = {
  id: string; label: string; kind: string; required: boolean; advanced: boolean;
  choices: string[]; minimum: number | null; defaultSource: string | null; unavailableReason: string | null;
};
export type ConfigurationDescriptor = { version: number; fields: ConfigurationField[]; operations: string[] };
export type ConfigurationIssue = { target: unknown; field: string | null; code: string; message: string };
export type ConfigurationDraft = {
  sessionId: string; revision: number; scope: Scope; profile: RegisteredProfile;
  baselineFiles: Record<string, string>; common?: RegisteredCommon | null; view: unknown; issues: ConfigurationIssue[];
  subject?: ConfigurationSubject;
  contextId?: string | null;
  projectPath?: string | null;
  descriptor?: ConfigurationDescriptor;
  draftConnection?: import('./native').Connection | null;
  credential?: ConfigurationCredential;
  catalogSupport?: ConfigurationCatalogSupport;
  /** Stored describes persisted ownership, not authentication/network readiness. */
  credentialStatus?: 'draft' | 'stored' | 'none' | 'removed';
  sourceCapabilities?: { source: 'native' | 'account' | 'api_key'; available: boolean; reason: string | null }[];
};
export type ConfigurationEditorProps = {
  draft: ConfigurationDraft;
  descriptor: ConfigurationDescriptor;
  disabled?: boolean;
  onAction: (action: ConfigurationAction) => Promise<void>;
  onValidityChange: (field: string, valid: boolean) => void;
};

export type ConfigurationSubject = 'profile' | 'current' | 'common';
export type ConfigurationCredential =
  | { source: 'native' }
  | { source: 'account'; accountId: string }
  | { source: 'api_key'; secretRef: string | null; remove?: boolean };
export type ConfigurationBeginRequest = {
  toolId: string; scope: Scope; projectPath: string | null; sessionId: string;
  subject: ConfigurationSubject; profile: RegisteredProfile | null;
};
export type ConfigurationCatalogSupport = { available: boolean; multiple: boolean; reason: string | null };
export type ConfigurationSaveResult = {
  draft: ConfigurationDraft; profile: RegisteredProfile | null; common: RegisteredCommon | null;
  application: import('./native').ApplyOutcome | null;
};
export type CommonInfluenceTarget = {
  scopeKey: string; profileId: string; profileName: string; profileVersion: number; profileRevision: string;
  appliedVersion: number; contextId: string | null; scope: Scope; projectPath: string | null;
};
export type CommonInfluence = { toolId: string; commonVersion: number | null; commonRevision: string | null; targets: CommonInfluenceTarget[] };
export type CommonApplicationResult = { scopeKey: string; profileId: string; status: string; detail: string | null };
export type ConfigurationDirectoryResult = { sessionId: string; revision: number; directory: import('./native').ModelDirectory };
export type ConfigurationCheckResult = { sessionId: string; revision: number; check: import('./native').ConnectionCheck };
export type ConfigurationCurrentComparison = {
  comparisonId: string; sessionId: string; revision: number; contextId: string | null;
  files: { role: string; original: string; current: string; edited: string }[];
};
export type ConfigurationBackupPreview = { sessionId: string; revision: number; role: string; transactionId: string; current: string; original: string };
