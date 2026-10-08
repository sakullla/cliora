import iconDark from '../../assets/tools/cline_dark.svg';
import icon from '../../assets/tools/cline.svg';
import type { ToolUiAdapter } from '../contract';

export const clineUiAdapter: ToolUiAdapter = {
  icon: {
    light: icon,
    dark: iconDark,
    source: 'https://cline.bot/assets/branding/logos/cline-icon.svg',
  },
  id: 'cline',
};
