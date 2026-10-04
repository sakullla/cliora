import icon from '../../assets/tools/deepseek.svg';
import type { ToolUiAdapter } from '../contract';

export const deepseekUiAdapter: ToolUiAdapter = {
  icon: { light: icon, source: 'https://api-docs.deepseek.com/img/favicon.svg' },
  id: 'deepseek',
};
