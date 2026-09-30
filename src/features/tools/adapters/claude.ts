import icon from '../../../assets/tools/claude.svg';
import type { ToolUiAdapter } from './contract';

export const claudeUiAdapter: ToolUiAdapter = {
  icon: { light: icon, source: 'https://code.claude.com/docs/logo/light.svg' },
  id: 'claude_code',
  authEnvName: () => 'ANTHROPIC_API_KEY',
  incompleteConnectionText: '；未指定项沿用 Claude Code 默认值',
};
