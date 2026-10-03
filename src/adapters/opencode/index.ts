import icon from '../../assets/tools/opencode.svg';
import type { ToolUiAdapter } from '../contract';
export const opencodeUiAdapter: ToolUiAdapter = { id: 'open_code',
  plugins: { installLabel: '添加插件声明' }, icon: { light: icon, source: 'https://opencode.ai/favicon-v3.svg' } };
