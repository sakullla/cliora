import icon from '../../assets/tools/opencode.svg';
import type { ToolUiAdapter } from '../contract';
import { OpenCodeConfigurationEditor } from './ConfigurationEditor';
import i18n from '../../i18n';
export const opencodeUiAdapter: ToolUiAdapter = { id: 'open_code',
  accounts: {
    get description() { return i18n.t('tools.adapters.opencode.accounts.description'); },
    get nativeDescription() { return i18n.t('tools.adapters.opencode.accounts.nativeDescription'); },
    get managedDescription() { return i18n.t('tools.adapters.opencode.accounts.managedDescription'); },
    get defaultLabel() { return i18n.t('tools.adapters.opencode.accounts.defaultLabel'); },
    methods: { get browser() { return i18n.t('tools.adapters.opencode.accounts.methodBrowser'); } },
  },
  configuration: { Editor: OpenCodeConfigurationEditor },
  plugins: { get installLabel() { return i18n.t('tools.adapters.opencode.installLabel'); } }, icon: { light: icon, source: 'https://opencode.ai/favicon-v3.svg' } };
