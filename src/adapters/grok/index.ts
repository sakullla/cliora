import { quoteAttachmentPath } from '../attachments';
import icon from '../../assets/tools/grok.svg';
import type { ToolUiAdapter } from '../contract';
export const grokUiAdapter: ToolUiAdapter = {
  // Grok accepts dropped image paths; keep each paste independently parseable.
  attachmentPastes: (paths) => paths.map(quoteAttachmentPath),
  remoteAgent: { root: '.grok/agents', extension: 'md' }, id: 'grok',
  officialUsage: { accountRequired: false, automaticRefresh: false }, icon: { light: icon, source: 'https://grok.com/images/favicon.svg' } };
