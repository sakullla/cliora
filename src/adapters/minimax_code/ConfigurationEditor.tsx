import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { EditorField, useEditorAction } from '../../components/configuration/ModelEditorControls';
import { ConnectionCredential } from '../../components/configuration/ConnectionCredential';
import type { ConfigurationContentProps } from '../contract';
import type { Connection } from '../../types/native';
import styles from '../../components/configuration/configuration.module.css';

export function MiniMaxCodeConfigurationEditor(props: ConfigurationContentProps) {
  return <Editor key={props.draft.sessionId} {...props} />;
}

function Editor(props: ConfigurationContentProps) {
  const { t } = useTranslation();
  const action = useEditorAction(props, 'minimax-code-actions');
  const view = (props.draft.view ?? {}) as Record<string, unknown>;
  const common = Array.isArray(view.commonFields) ? view.commonFields as { id: string; value: unknown }[] : [];
  const value = (id: string) => props.mode === 'common' ? common.find(field => field.id === id)?.value : view[id];
  const connection = view.connection as Connection | null;
  const current = { providerId: connection?.providerId ?? 'minimax_api', interfaceFormat: connection?.interfaceFormat ?? 'anthropic_messages', baseUrl: connection?.baseUrl ?? '', model: connection?.model ?? '' };
  const [input, setInput] = useState(current);
  const [baseline, setBaseline] = useState(current);
  if (JSON.stringify(baseline) !== JSON.stringify(current)) {
    // Reconcile before commit so an untouched hidden form never invalidates a
    // settings edit. Only preserve fields actually changed by the user.
    const next = { ...input };
    for (const key of Object.keys(current) as (keyof typeof current)[]) {
      if (input[key] === baseline[key]) next[key] = current[key];
    }
    setInput(next);
    setBaseline(current);
  }
  const dirty = JSON.stringify(input) !== JSON.stringify(current);
  useEffect(() => { props.onValidityChange('connection-form', !dirty); return () => props.onValidityChange('connection-form', true); }, [dirty, props.onValidityChange]);
  const blocked = props.disabled || props.pending || action.pending;
  const field = (key: 'providerId' | 'baseUrl' | 'model', label: string) => <label>{label}<input value={input[key]} spellCheck={false} disabled={blocked} onChange={event => setInput(previous => ({ ...previous, [key]: event.target.value }))} /></label>;
  return <section className={styles.fieldGrid} aria-label={t('tools.minimaxCode.settingsLabel')}>
    <p className={styles.span}>{t('tools.minimaxCode.settingsNote')}</p>
    {props.mode !== 'common' && props.section !== 'settings' && <div className={styles.span}>
      <div className={styles.fieldGrid} data-config-step="connection">
        {field('providerId', t('tools.config.providerId'))}
        <label>{t('tools.config.interfaceProtocol')}<select value={input.interfaceFormat} disabled={blocked} onChange={event => setInput(previous => ({ ...previous, interfaceFormat: event.target.value }))}><option value="anthropic_messages">Anthropic Messages</option><option value="openai_completions">OpenAI Chat Completions</option><option value="openai_responses">OpenAI Responses</option></select></label>
        {field('baseUrl', t('tools.config.apiUrl'))}{field('model', t('tools.config.model'))}
      </div>
      <p>{t('tools.minimaxCode.connectionNote')}</p>
      <button type="button" disabled={blocked || !input.providerId.trim() || !input.baseUrl.trim() || !input.model.trim() || !dirty} onClick={() => void action.run({ kind: 'connection' }, 'configure_connection', { ...input, secretRef: null, authEnvVar: null, modelRecords: [] })}>{t('tools.minimaxCode.applyConnection')}</button>
      {dirty && <button type="button" disabled={blocked} onClick={() => setInput(current)}>{t('common.dialog.cancel')}</button>}
      <ConnectionCredential />
    </div>}
    {props.section !== 'models' && props.descriptor.fields.map(field => <EditorField key={`${props.draft.sessionId}:${field.id}`} props={action.props} id={field.id} target={{ kind: 'settings' }} value={value(field.id)} disabled={blocked} presentation={{ label: t(`tools.minimaxCode.fields.${field.id.replaceAll('.', '_')}`) }} />)}
    {action.error && <p role="alert">{action.error}<button type="button" onClick={action.cancelFailure}>{t('common.dialog.cancel')}</button></p>}
  </section>;
}
