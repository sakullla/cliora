import { native } from '../../lib/native';
import icon from '../../assets/tools/codex.svg';
import type { ToolUiAdapter } from '../contract';
import { CodexConfigurationEditor } from './ConfigurationEditor';

const reasoningLine = /^\s*model_reasoning_effort\s*=\s*(?:"([^"\\]*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:#.*)?$/;

/** Read the config-root effort from the draft. Absent means the native default. */
export function readReasoningEffort(text: string): string | null {
  if (typeof text !== 'string') return null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(reasoningLine);
    if (match) return match[1] ?? match[2] ?? match[3] ?? null;
  }
  return null;
}

export const codexUiAdapter: ToolUiAdapter = {
  icon: { light: icon, tile: 'light', source: 'OpenAI.Codex 26.924.2738.0 / webview/assets/codex-new-f14177b03534.svg' },
  id: 'codex',
  configuration: { Editor: CodexConfigurationEditor },
  officialUsage: { accountRequired: true, automaticRefresh: true },
  reasoning: {
    label: '推理强度（Codex 原生）',
    choices: [['minimal', '极低'], ['low', '低'], ['medium', '中'], ['high', '高'], ['xhigh', '极高']],
    read: readReasoningEffort,
    update: native.setCodexReasoningEffort,
  },
};
