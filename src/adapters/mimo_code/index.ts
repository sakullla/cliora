import icon from '../../assets/tools/mimo_code.png';
import type { ToolUiAdapter } from '../contract';

export const mimoCodeUiAdapter: ToolUiAdapter = {
  remoteAgent: { root: '.mimo/agents', extension: 'md' },
  icon: { light: icon, source: 'https://platform.xiaomimimo.com/favicon.png' },
  id: 'mimo_code',
};
