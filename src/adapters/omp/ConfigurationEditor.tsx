import { useTranslation } from 'react-i18next';

import sharedStyles from '../../components/configuration/configuration.module.css';
import type { ConfigurationContentProps } from '../contract';

/**
 * Configuration surface for oh-my-pi (OMP).
 *
 * The configuration task replaces this body with the YAML/profile editor. OMP's
 * native configuration capability is not published yet, so the shared workspace
 * never mounts this editor; keeping the import here means that task does not
 * have to edit the adapter composition root.
 */
export function OmpConfigurationEditor(_props: ConfigurationContentProps) {
  const { t } = useTranslation();
  return <p className={sharedStyles.message} role="status">{t('tools.adapters.omp.configurationPending')}</p>;
}
