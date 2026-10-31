import icon from '../../assets/tools/codebuddy.svg';
import type { ToolUiAdapter } from '../contract';

export const codebuddyUiAdapter: ToolUiAdapter = {
  remoteAgent: { root: '.codebuddy/agents', extension: 'md' },
  icon: { light: icon, source: '@tencent-ai/codebuddy-code 2.161.1 / dist/web-ui/pwa-icon.svg' },
  id: 'codebuddy',
};
