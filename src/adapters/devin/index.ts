import { quoteAttachmentPath } from '../attachments';
import icon from '../../assets/tools/devin.svg';
import type { ToolUiAdapter } from '../contract';

export const devinUiAdapter: ToolUiAdapter = {
  // Devin's @ file context works without reading the CLI host's clipboard.
  attachmentPastes: (paths) => [paths.map((path) => `@${quoteAttachmentPath(path)}`).join(' ')],
  remoteAgent: { root: '.devin/agents', extension: 'md' },
  icon: { light: icon, tile: 'light', source: 'https://devin.ai/favicon.svg' },
  id: 'devin',
};
