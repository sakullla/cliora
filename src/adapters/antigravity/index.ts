import { quoteAttachmentPath } from '../attachments';
import icon from '../../assets/tools/antigravity.svg';
import type { ToolUiAdapter } from '../contract';

export const antigravityUiAdapter: ToolUiAdapter = {
  // Antigravity file mentions carry context without invoking local clipboard keys.
  attachmentPastes: (paths) => [paths.map((path) => `@${quoteAttachmentPath(path)}`).join(' ')],
  icon: { light: icon, source: 'https://antigravity.google/favicon.svg' },
  id: 'antigravity',
};
