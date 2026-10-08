import icon from '../../assets/tools/devin.svg';
import type { ToolUiAdapter } from '../contract';

export const devinUiAdapter: ToolUiAdapter = {
  icon: { light: icon, tile: 'light', source: 'https://devin.ai/favicon.svg' },
  id: 'devin',
};
