import { quoteAttachmentPath } from '../attachments';
import iconDark from '../../assets/tools/command_code_dark.svg';
import icon from '../../assets/tools/command_code.svg';
import type { ToolUiAdapter } from '../contract';

export const commandCodeUiAdapter: ToolUiAdapter = {
  // Command Code recognizes pasted image paths and unwraps quoting.
  attachmentPastes: (paths) => paths.map(quoteAttachmentPath),
  icon: {
    light: icon,
    dark: iconDark,
    source: 'command-code 1.73.4 / vsix/extension/icons/icon-light.svg',
  },
  id: 'command_code',
};
