import icon from '../../assets/tools/minimax_code.svg';
import type { ToolUiAdapter } from '../contract';
import { MiniMaxCodeConfigurationEditor } from './ConfigurationEditor';

export const minimaxCodeUiAdapter: ToolUiAdapter = {
  id: 'minimax_code',
  icon: { light: icon, source: 'Cliora text badge for MiniMax Code; not an official product logo' },
  configuration: { Editor: MiniMaxCodeConfigurationEditor },
};
