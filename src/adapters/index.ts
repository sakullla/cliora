import type { Connection } from '../types/native';
import { claudeUiAdapter } from './claude';
import { codexUiAdapter } from './codex';
import { grokUiAdapter } from './grok';
import { piUiAdapter } from './pi';
import { opencodeUiAdapter } from './opencode';
import { zcodeUiAdapter } from './zcode';
import { qoderCnUiAdapter } from './qoder_cn';
import { kimiCodeUiAdapter } from './kimi_code';
import { deepseekUiAdapter } from './deepseek';
import { codebuddyUiAdapter } from './codebuddy';
import { mimoCodeUiAdapter } from './mimo_code';
import { clineUiAdapter } from './cline';
import { devinUiAdapter } from './devin';
import { commandCodeUiAdapter } from './command_code';
import { antigravityUiAdapter } from './antigravity';
import { kiroUiAdapter } from './kiro';
import type { ToolUiAdapter } from './contract';

const specialized = new Map<string, ToolUiAdapter>([
  [claudeUiAdapter.id, claudeUiAdapter],
  [codexUiAdapter.id, codexUiAdapter],
  [grokUiAdapter.id, grokUiAdapter],
  [piUiAdapter.id, piUiAdapter],
  [opencodeUiAdapter.id, opencodeUiAdapter],
  [zcodeUiAdapter.id, zcodeUiAdapter],
  [qoderCnUiAdapter.id, qoderCnUiAdapter],
  [kimiCodeUiAdapter.id, kimiCodeUiAdapter],
  [deepseekUiAdapter.id, deepseekUiAdapter],
  [codebuddyUiAdapter.id, codebuddyUiAdapter],
  [mimoCodeUiAdapter.id, mimoCodeUiAdapter],
  [clineUiAdapter.id, clineUiAdapter],
  [devinUiAdapter.id, devinUiAdapter],
  [commandCodeUiAdapter.id, commandCodeUiAdapter],
  [antigravityUiAdapter.id, antigravityUiAdapter],
  [kiroUiAdapter.id, kiroUiAdapter],
]);

export function uiAdapterFor(id: string): ToolUiAdapter {
  return specialized.get(id) ?? { id };
}

export function authEnvName(adapter: ToolUiAdapter, connection: Connection | null, toolId: string): string | null {
  if (!connection) return null;
  if (connection.authEnvVar) return connection.authEnvVar;
  if (!connection.secretRef) return null;
  if (adapter.authEnvName) return adapter.authEnvName(connection);
  void toolId;
  return null;
}
