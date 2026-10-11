import type { ToolUiAdapter } from '../contract';

export const minimaxCodeUiAdapter: ToolUiAdapter = {
  id: 'minimax_code',
  accounts: {
    description: '在终端执行 mcode login。默认中国区；国际区使用 --region global。状态未确认，不读取登录凭证。',
    nativeDescription: '未确认。没有已核对的、不输出凭证的状态命令。',
    managedDescription: '退出使用 mcode logout，不删除栖点里的 API Key。',
    defaultLabel: 'MiniMax',
    methods: { browser: '中国区', device: '国际区' },
  },
  plugins: { installLabel: '添加' },
  officialUsage: { accountRequired: false, automaticRefresh: false },
  authEnvName: () => 'MCODE_PROVIDER_API_KEY',
};
