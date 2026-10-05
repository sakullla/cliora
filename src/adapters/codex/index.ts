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
  accounts: {
    description: '选择 ChatGPT 账号；API 密钥连接在配置中单独填写。',
    nativeDescription: '读取 Codex 当前登录的脱敏身份；沿用原生来源不会纳入账号管理。',
    managedDescription: '独立账号使用各自的 Codex 登录与配置目录，凭据由原生 CLI 维护。',
    defaultLabel: 'ChatGPT 账号',
    methods: { browser: '浏览器登录 ChatGPT', device: 'ChatGPT 设备码登录' },
  },
  configuration: { Editor: CodexConfigurationEditor },
  officialUsage: { accountRequired: true, automaticRefresh: true },
  reasoning: {
    label: '推理强度（Codex 原生）',
    choices: [['minimal', '极低'], ['low', '低'], ['medium', '中'], ['high', '高'], ['xhigh', '极高']],
    read: readReasoningEffort,
    update: native.setCodexReasoningEffort,
  },
};
