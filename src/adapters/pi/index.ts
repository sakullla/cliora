import icon from '../../assets/tools/pi.svg';
import type { ToolUiAdapter } from '../contract';
import { PiConfigurationEditor } from './ConfigurationEditor';
export const piUiAdapter: ToolUiAdapter = { id: 'pi',
  accounts: {
    description: '查看 Pi 的当前凭据；受管账号仅支持已核验的 openai-codex 登录。',
    nativeDescription: '读取 Pi 当前登录记录的脱敏身份，不刷新令牌或复制凭据。',
    managedDescription: '在独立 Pi 目录的终端中执行 /login，等待原生身份核验。',
    defaultLabel: 'Pi 账号',
    methods: { browser: '终端 /login' },
  },
  configuration: { Editor: PiConfigurationEditor },
  plugins: { projectTrust: true, projectUpdate: false }, primaryRole: 'models', icon: { light: icon, scale: 1.35, source: 'https://pi.dev/logo-auto.svg' } };
