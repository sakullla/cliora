import { useTranslation } from 'react-i18next';
import { EditorField, useEditorAction } from '../../components/configuration/ModelEditorControls';
import type { ConfigurationContentProps } from '../contract';
import styles from '../../components/configuration/configuration.module.css';

export function CursorIdeConfigurationEditor(props: ConfigurationContentProps) {
  const { t } = useTranslation();
  const action = useEditorAction(props, 'cursor-ide-settings');
  const view = (props.draft.view ?? {}) as Record<string, unknown>;
  const common = Array.isArray(view.commonFields) ? view.commonFields as { id: string; value: unknown }[] : [];
  const value = (id: string) => props.mode === 'common' ? common.find(field => field.id === id)?.value : view[id];
  return <section className={styles.fieldGrid} aria-label={t('tools.cursorIde.settingsLabel')}>
    <p className={styles.span}>{t('tools.cursorIde.settingsNote')}</p>
    {props.descriptor.fields.map(field => <EditorField key={`${props.draft.sessionId}:${field.id}`} props={action.props} id={field.id} target={{ kind: 'settings' }} value={value(field.id)} disabled={props.disabled || action.pending} presentation={{ label: t(`tools.cursorIde.fields.${field.id.replaceAll('.', '_')}`) }} />)}
  </section>;
}
