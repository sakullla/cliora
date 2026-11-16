import { quoteAttachmentPath } from '../attachments';
import i18n from '../../i18n';
import icon from '../../assets/tools/antigravity.svg';
import type { ToolUiAdapter } from '../contract';

export const antigravityUiAdapter: ToolUiAdapter = {
  // Antigravity file mentions carry context without invoking local clipboard keys.
  attachmentPastes: (paths) => [paths.map((path) => `@${quoteAttachmentPath(path)}`).join(' ')],
  icon: { light: icon, source: 'https://antigravity.google/favicon.svg' },
  id: 'antigravity',
  // Verified install source is a local plugin directory (agy plugin install
  // <dir>, 1.5.9 evidence); the label says so instead of the generic default.
  plugins: { get installLabel() { return i18n.t('tools.adapters.antigravity.installLabel'); } },
};
