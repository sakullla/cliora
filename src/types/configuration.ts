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
};
export type ConfigurationEditorProps = {
  draft: ConfigurationDraft;
  descriptor: ConfigurationDescriptor;
  disabled?: boolean;
  onAction: (action: ConfigurationAction) => Promise<void>;
};
