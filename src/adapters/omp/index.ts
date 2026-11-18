import icon from '../../assets/tools/omp.svg';
import type { ToolUiAdapter } from '../contract';
import { OmpConfigurationEditor } from './ConfigurationEditor';

/**
 * oh-my-pi (OMP) presentation root. Capability work adds behaviour inside its
 * own files; registration, icon and the configuration editor entry stay here.
 */
export const ompUiAdapter: ToolUiAdapter = {
  id: 'omp',
  icon: { light: icon, source: 'https://github.com/can1357/oh-my-pi' },
  configuration: { Editor: OmpConfigurationEditor },
};
