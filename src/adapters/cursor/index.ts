import i18n from '../../i18n';
import type { ToolUiAdapter } from '../contract';

export const cursorUiAdapter: ToolUiAdapter = {
  id: 'cursor',
  plugins: { get installLabel() { return i18n.t('tools.adapters.cursor.installLabel'); } },
};
