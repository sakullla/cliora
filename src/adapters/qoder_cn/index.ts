import icon from '../../assets/tools/qoder.svg';
import type { ToolUiAdapter } from '../contract';
import { QoderConfigurationEditor } from './ConfigurationEditor';

export const qoderCnUiAdapter: ToolUiAdapter = {
  icon: { light: icon, source: 'https://qoder.com/favIcon.svg' },
  id: 'qoder_cn',
  configuration: { Editor: QoderConfigurationEditor },
};
