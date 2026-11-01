import { quoteAttachmentPath } from '../attachments';
import icon from '../../assets/tools/kiro.svg';
import type { ToolUiAdapter } from '../contract';

export const kiroUiAdapter: ToolUiAdapter = {
  // Kiro reads image paths from prompts; /paste reads the CLI host clipboard.
  attachmentPastes: (paths) => [paths.map(quoteAttachmentPath).join(' ')],
  icon: { light: icon, source: 'https://kiro.dev/icon.svg' },
  id: 'kiro',
};
