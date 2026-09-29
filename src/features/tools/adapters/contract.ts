import type { Connection } from '../../../types/native';

export type ReasoningControl = {
  label: string;
  choices: readonly [string, string][];
  update: (text: string, value: string | null) => Promise<string>;
};

export type ToolUiAdapter = {
  id: string;
  authEnvName?: (connection: Connection) => string;
  incompleteConnectionText?: string;
  reasoning?: ReasoningControl;
};
