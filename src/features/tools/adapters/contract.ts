import type { Connection } from '../../../types/native';

export type ReasoningControl = {
  label: string;
  choices: readonly [string, string][];
  update: (text: string, value: string | null) => Promise<string>;
};

export type ModelRoleValue = { model: string; name: string; longContext: boolean };
export type ModelMappingControl = {
  fileRole: string;
  primaryRole?: string;
  decodeModel?: (model: string) => ModelRoleValue;
  encodeModel?: (value: ModelRoleValue) => string;
  roles: readonly { id: string; label: string; displayName: boolean; longContext: boolean }[];
  read: (text: string) => Record<string, ModelRoleValue>;
  update: (text: string, role: string, value: ModelRoleValue) => Promise<string>;
  useModelForAll: (text: string, model: string, longContext?: boolean) => Promise<string>;
};
export type ToolUiAdapter = {
  id: string;
  primaryRole?: string;
  icon?: { light: string; dark?: string; fit?: 'contain' | 'cover'; tile?: 'light'; scale?: number; source: string };
  authEnvName?: (connection: Connection) => string;
  incompleteConnectionText?: string;
  reasoning?: ReasoningControl;
  modelMapping?: ModelMappingControl;
};
