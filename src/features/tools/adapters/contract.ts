import type { Connection } from '../../../types/native';

export type ReasoningControl = {
  label: string;
  choices: readonly [string, string][];
  update: (text: string, value: string | null) => Promise<string>;
};

export type ToolUiAdapter = {
  id: string;
  icon?: { light: string; dark?: string; fit?: 'contain' | 'cover'; tile?: 'light'; scale?: number; source: string };
  authEnvName?: (connection: Connection) => string;
  incompleteConnectionText?: string;
  reasoning?: ReasoningControl;
};
