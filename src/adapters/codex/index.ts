import { native } from '../../lib/native';
import icon from '../../assets/tools/codex.svg';
import type { ToolUiAdapter } from '../contract';
import { CodexConfigurationEditor } from './ConfigurationEditor';
import i18n from '../../i18n';

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
    get description() { return i18n.t('tools.adapters.codex.accounts.description'); },
    get nativeDescription() { return i18n.t('tools.adapters.codex.accounts.nativeDescription'); },
    get managedDescription() { return i18n.t('tools.adapters.codex.accounts.managedDescription'); },
    get defaultLabel() { return i18n.t('tools.adapters.codex.accounts.defaultLabel'); },
    methods: { get browser() { return i18n.t('tools.adapters.codex.accounts.methodBrowser'); }, get device() { return i18n.t('tools.adapters.codex.accounts.methodDevice'); } },
  },
  configuration: { Editor: CodexConfigurationEditor },
  officialUsage: { accountRequired: true, automaticRefresh: true },
  reasoning: {
    get label() { return i18n.t('tools.adapters.codex.reasoningLabel'); },
    get choices() { return [['minimal', i18n.t('tools.adapters.codex.effort.minimal')], ['low', i18n.t('tools.adapters.codex.effort.low')], ['medium', i18n.t('tools.adapters.codex.effort.medium')], ['high', i18n.t('tools.adapters.codex.effort.high')], ['xhigh', i18n.t('tools.adapters.codex.effort.xhigh')]] as [string, string][]; },
    read: readReasoningEffort,
    update: native.setCodexReasoningEffort,
  },
};
