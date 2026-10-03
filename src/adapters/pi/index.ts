import icon from '../../assets/tools/pi.svg';
import type { ToolUiAdapter } from '../contract';
export const piUiAdapter: ToolUiAdapter = { id: 'pi',
  plugins: { projectTrust: true, projectUpdate: false }, primaryRole: 'models', icon: { light: icon, scale: 1.35, source: 'https://pi.dev/logo-auto.svg' } };
