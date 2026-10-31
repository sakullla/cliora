import icon from '../../assets/tools/minimax_code.svg';
import type { ToolUiAdapter } from '../contract';
import { MiniMaxCodeConfigurationEditor } from './ConfigurationEditor';

export const minimaxCodeUiAdapter: ToolUiAdapter = {
  remoteAgent: { root: '.minimax/agents', extension: 'md' },
  icon: { light: icon, source: 'https://mintcdn.com/minimax-zh/1UjvBcdoC6r0UeyA/logo/light.svg' },
  id: 'minimax_code',
  configuration: { Editor: MiniMaxCodeConfigurationEditor },
  accounts: {
    description: '在终端执行 mcode login。默认中国区；国际区使用 --region global。登录完成看不含凭证的状态文件；没有账号 ID 时不显示是谁。',
    nativeDescription: '只读核对不含凭证的登录状态。不读取 auth.json。',
    managedDescription: '退出使用 mcode logout，不删除栖点里的 API Key。',
    defaultLabel: 'MiniMax',
    methods: { browser: '中国区', device: '国际区' },
  },
  plugins: { installLabel: '添加' },
  officialUsage: { accountRequired: false, automaticRefresh: false },
  authEnvName: () => 'MCODE_PROVIDER_API_KEY',
};
