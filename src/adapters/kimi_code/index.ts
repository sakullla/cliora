import icon from '../../assets/tools/kimi_code.svg';
import type { ToolUiAdapter } from '../contract';

export const kimiCodeUiAdapter: ToolUiAdapter = {
  icon: {
    light: icon,
    source: 'K symbol from https://platform.kimi.com/kimi.svg on the official https://www.kimi.com/pwa-192.png black tile',
  },
  id: 'kimi_code',
};
