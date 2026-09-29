export const CLI_IDS = ['codex', 'claude_code', 'grok', 'pi', 'open_code'] as const;
export type CliId = (typeof CLI_IDS)[number];
export type Theme = 'system' | 'light' | 'dark';

export type Preferences = {
  schema_version: number;
  managed_tools: CliId[];
  theme: Theme;
};

export type ToolSummary = {
  id: CliId;
  name: string;
  installation: 'not_checked';
  configuration: 'not_checked';
};

export type Bootstrap = {
  preferences: Preferences;
  tools: ToolSummary[];
};

export type ApiError = {
  code: string;
  message: string;
  action: string;
  data_directory?: string | null;
};

/** The only catalogue used for browser shell rendering before the native bootstrap arrives. */
export const CLI_NAMES: Record<CliId, string> = {
  codex: 'Codex',
  claude_code: 'Claude Code',
  grok: 'Grok',
  pi: 'Pi',
  open_code: 'OpenCode',
};

export function browserBootstrap(): Bootstrap {
  return {
    preferences: { schema_version: 1, managed_tools: [...CLI_IDS], theme: 'system' },
    tools: CLI_IDS.map((id) => ({
      id,
      name: CLI_NAMES[id],
      installation: 'not_checked',
      configuration: 'not_checked',
    })),
  };
}
