import icon from '../../assets/tools/opencode.svg';
import type { ToolUiAdapter } from '../contract';
import { OpenCodeConfigurationEditor } from './ConfigurationEditor';
export const opencodeUiAdapter: ToolUiAdapter = { id: 'open_code',
  accounts: {
    description: '查看 OpenCode 当前凭据，或选择受支持的独立登录账号。',
    nativeDescription: '读取 OpenCode 当前原生认证记录；凭据配置与已核验身份分别展示。',
    managedDescription: '独立账号通过 OpenCode 原生登录核验，支持范围以本机能力为准。',
    defaultLabel: 'OpenCode 账号',
    methods: { browser: 'OpenCode 原生交互登录' },
  },
  configuration: { Editor: OpenCodeConfigurationEditor },
  plugins: { installLabel: '添加插件声明' }, icon: { light: icon, source: 'https://opencode.ai/favicon-v3.svg' } };
