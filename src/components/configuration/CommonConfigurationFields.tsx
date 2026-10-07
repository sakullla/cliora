import { useTranslation } from 'react-i18next';
import type { ConfigurationContentProps } from '../../adapters/contract';
import { ConfigurationField, type FieldPresentation } from './ConfigurationField';
import styles from './configuration.module.css';

/** Targets and applicable fields come from the selected adapter's subject projection. */
export function CommonConfigurationFields(props: ConfigurationContentProps & { presentationFor?: (id: string) => FieldPresentation }) {
  const { t } = useTranslation();
  const fields = (props.draft.view as { commonFields?: { id: string; target: unknown; value: unknown }[] } | null)?.commonFields ?? [];
  return <section className={styles.controls} aria-label={t('common.fields.sectionLabel')}>{fields.map(item => {
    const descriptor = props.descriptor.fields.find(field => field.id === item.id);
    if (!descriptor) return null;
    const run = (operation: string, value: unknown = null) => props.onAction({ version: props.descriptor.version, target: item.target, operation, field: item.id, value });
    return <ConfigurationField presentation={{ ...props.presentationFor?.(item.id), origin: item.value == null ? 'unset' : 'explicit' }} resetEpoch={props.rawResetEpoch} key={`${props.draft.sessionId}:${item.id}`} field={descriptor} value={item.value} disabled={props.disabled}
      issues={props.draft.issues.filter(issue => issue.field === item.id)} onChange={value => run(value === '' ? 'reset' : 'set', value)}
      onReset={() => run('reset')} onValidityChange={valid => props.onValidityChange(`common:${item.id}`, valid)} />;
  })}{!fields.length && <p>{t('common.fields.empty')}</p>}</section>;
}
