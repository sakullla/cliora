import type { ToolUiAdapter } from './contract';

export const claudeUiAdapter: ToolUiAdapter = {
  id: 'claude_code',
  authEnvName: () => 'ANTHROPIC_API_KEY',
  incompleteConnectionText: '；未指定项沿用 Claude Code 默认值',
};
