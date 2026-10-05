import icon from '../../assets/tools/opencode.svg';
import type { ToolUiAdapter } from '../contract';
import { OpenCodeConfigurationEditor } from './ConfigurationEditor';
export const opencodeUiAdapter: ToolUiAdapter = { id: 'open_code',
  configuration: { Editor: OpenCodeConfigurationEditor },
  plugins: { installLabel: '添加插件声明' }, icon: { light: icon, source: 'https://opencode.ai/favicon-v3.svg' } };
