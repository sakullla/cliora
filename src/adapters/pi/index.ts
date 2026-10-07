import icon from '../../assets/tools/pi.svg';
import type { ToolUiAdapter } from '../contract';
import { PiConfigurationEditor } from './ConfigurationEditor';
import i18n from '../../i18n';
export const piUiAdapter: ToolUiAdapter = { id: 'pi',
  accounts: {
    get description() { return i18n.t('tools.adapters.pi.accounts.description'); },
    get nativeDescription() { return i18n.t('tools.adapters.pi.accounts.nativeDescription'); },
    get managedDescription() { return i18n.t('tools.adapters.pi.accounts.managedDescription'); },
    get defaultLabel() { return i18n.t('tools.adapters.pi.accounts.defaultLabel'); },
    methods: { get browser() { return i18n.t('tools.adapters.pi.accounts.methodBrowser'); } },
  },
  configuration: { Editor: PiConfigurationEditor },
  plugins: { projectTrust: true, projectUpdate: false }, primaryRole: 'models', icon: { light: icon, scale: 1.35, source: 'https://pi.dev/logo-auto.svg' } };
