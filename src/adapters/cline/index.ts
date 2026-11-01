import { quoteAttachmentPath } from '../attachments';
import iconDark from '../../assets/tools/cline_dark.svg';
import icon from '../../assets/tools/cline.svg';
import type { ToolUiAdapter } from '../contract';

export const clineUiAdapter: ToolUiAdapter = {
  // Cline resolves image @mentions into prompt attachments.
  attachmentPastes: (paths) => [paths.map((path) => `@${quoteAttachmentPath(path)}`).join(' ')],
  icon: {
    light: icon,
    dark: iconDark,
    source: 'https://cline.bot/assets/branding/logos/cline-icon.svg',
  },
  id: 'cline',
};
