import { quoteAttachmentPath } from '../attachments';
import icon from '../../assets/tools/mimo_code.png';
import type { ToolUiAdapter } from '../contract';

export const mimoCodeUiAdapter: ToolUiAdapter = {
  // MiMo pastePlainText processes dropped media paths in the TUI.
  attachmentPastes: (paths) => paths.map(quoteAttachmentPath),
  remoteAgent: { root: '.mimo/agents', extension: 'md' },
  icon: { light: icon, source: 'https://platform.xiaomimimo.com/favicon.png' },
  id: 'mimo_code',
};
