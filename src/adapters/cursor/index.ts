import icon from '../../assets/tools/cursor.svg';
import i18n from '../../i18n';
import type { ToolUiAdapter } from '../contract';

export const cursorUiAdapter: ToolUiAdapter = {
  icon: { light: icon, source: 'https://cursor.com/favicon.svg' },
  id: 'cursor',
  plugins: { get installLabel() { return i18n.t('tools.adapters.cursor.installLabel'); } },
};
