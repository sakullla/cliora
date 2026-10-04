import icon from '../../assets/tools/zcode.svg';
import type { ToolUiAdapter } from '../contract';

export const zcodeUiAdapter: ToolUiAdapter = {
  icon: { light: icon, source: 'https://z-cdn.chatglm.cn/z-ai/static/logo.svg' },
  id: 'zcode',
};
