import { quoteAttachmentPath } from '../attachments';
import icon from '../../assets/tools/codebuddy.svg';
import type { ToolUiAdapter } from '../contract';

export const codebuddyUiAdapter: ToolUiAdapter = {
  // CodeBuddy documents image paths as an alternative to clipboard paste.
  attachmentPastes: (paths) => [paths.map(quoteAttachmentPath).join(' ')],
  remoteAgent: { root: '.codebuddy/agents', extension: 'md' },
  icon: { light: icon, source: '@tencent-ai/codebuddy-code 2.161.1 / dist/web-ui/pwa-icon.svg' },
  id: 'codebuddy',
};
