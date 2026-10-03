import type { Connection } from '../types/native';
import { claudeUiAdapter } from './claude';
import { codexUiAdapter } from './codex';
import { grokUiAdapter } from './grok';
import { piUiAdapter } from './pi';
import { opencodeUiAdapter } from './opencode';
import type { ToolUiAdapter } from './contract';

const specialized = new Map<string, ToolUiAdapter>([
  [claudeUiAdapter.id, claudeUiAdapter],
  [codexUiAdapter.id, codexUiAdapter],
  [grokUiAdapter.id, grokUiAdapter],
  [piUiAdapter.id, piUiAdapter],
  [opencodeUiAdapter.id, opencodeUiAdapter],
]);

export function uiAdapterFor(id: string): ToolUiAdapter {
  return specialized.get(id) ?? { id };
}

export function authEnvName(adapter: ToolUiAdapter, connection: Connection | null, toolId: string): string | null {
  if (!connection) return null;
  if (connection.authEnvVar) return connection.authEnvVar;
  if (!connection.secretRef) return null;
  if (adapter.authEnvName) return adapter.authEnvName(connection);
  const tool = toolId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const provider = connection.providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `CLIORA_${tool}_${provider}_API_KEY`;
}
