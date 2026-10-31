import icon from '../../assets/tools/grok.svg';
import type { ToolUiAdapter } from '../contract';
export const grokUiAdapter: ToolUiAdapter = {
  remoteAgent: { root: '.grok/agents', extension: 'md' }, id: 'grok',
  officialUsage: { accountRequired: false, automaticRefresh: false }, icon: { light: icon, source: 'https://grok.com/images/favicon.svg' } };
