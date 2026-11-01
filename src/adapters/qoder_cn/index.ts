import { quoteAttachmentPath } from '../attachments';
import icon from '../../assets/tools/qoder.svg';
import type { ToolUiAdapter } from '../contract';
import { QoderConfigurationEditor } from './ConfigurationEditor';

export const qoderCnUiAdapter: ToolUiAdapter = {
  // Qoder file mentions attach image files without its Alt+V clipboard shortcut.
  attachmentPastes: (paths) => [paths.map((path) => `@${quoteAttachmentPath(path)}`).join(' ')],
  icon: { light: icon, source: 'https://qoder.com/favIcon.svg' },
  id: 'qoder_cn',
  configuration: { Editor: QoderConfigurationEditor },
};
