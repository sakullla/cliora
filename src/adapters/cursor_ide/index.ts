import icon from '../../assets/tools/cursor-ide.png';
import { CursorIdeConfigurationEditor } from './ConfigurationEditor';
import type { ToolUiAdapter } from '../contract';
export const cursorIdeUiAdapter: ToolUiAdapter = {
  id: 'cursor_ide',
  icon: { light: icon, source: 'Cursor IDE 3.24.9 resources/win32/code_150x150.png' },
  configuration: { Editor: CursorIdeConfigurationEditor },
};
