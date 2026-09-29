import { native } from '../../../lib/native';
import type { ToolUiAdapter } from './contract';

export const codexUiAdapter: ToolUiAdapter = {
  id: 'codex',
  reasoning: {
    label: '推理强度（Codex 原生）',
    choices: [['minimal', '极低'], ['low', '低'], ['medium', '中'], ['high', '高'], ['xhigh', '极高']],
    update: native.setCodexReasoningEffort,
  },
};
