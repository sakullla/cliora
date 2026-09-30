import { native } from '../../../lib/native';
import icon from '../../../assets/tools/codex.svg';
import type { ToolUiAdapter } from './contract';

export const codexUiAdapter: ToolUiAdapter = {
  icon: { light: icon, tile: 'light', source: 'OpenAI.Codex 26.924.2738.0 / webview/assets/codex-new-f14177b03534.svg' },
  id: 'codex',
  reasoning: {
    label: '推理强度（Codex 原生）',
    choices: [['minimal', '极低'], ['low', '低'], ['medium', '中'], ['high', '高'], ['xhigh', '极高']],
    update: native.setCodexReasoningEffort,
  },
};
