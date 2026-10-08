import { codexFieldPresentation } from './fieldPresentation';
import { CommonConfigurationFields } from '../../components/configuration/CommonConfigurationFields';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfigurationField } from '../../components/configuration/ConfigurationField';
import { ConnectionCredential } from '../../components/configuration/ConnectionCredential';
import { ConfigurationStep, connectionMeta } from '../../components/configuration/ConfigurationStep';
import sharedStyles from '../../components/configuration/configuration.module.css';
import type { ConfigurationContentProps } from '../contract';
import styles from './ConfigurationEditor.module.css';

type View = { values?: Record<string, unknown>; defaultAddressReason?: string | null; effortChoices?: string[]; capabilitySource?: string };
function Editor({ draft, descriptor, disabled, onAction, onValidityChange, section, rawResetEpoch, catalog }: ConfigurationContentProps) {
  const { t } = useTranslation();
  const view = draft.view as View | null;
  const values = view?.values ?? {};
  const validity = useRef(onValidityChange);
  validity.current = onValidityChange;
  useEffect(() => () => { for (const field of descriptor.fields) validity.current(field.id, true); }, [draft.sessionId]);
  const render = (id: string) => {
    const field = descriptor.fields.find(field => field.id === id);
    if (!field) return null;
    const target = id === 'base_url' ? String(values.model_provider ?? 'openai') : 'configuration';
    const action = (operation: string, value: unknown = null) => onAction({ version: descriptor.version, target, operation, field: id, value });
    const metadata = id === 'model_reasoning_effort' ? { ...field, choices: view?.effortChoices ?? [] } : field;
    const builtinAddress = id === 'base_url' && ['openai', 'ollama', 'lmstudio'].includes(target);
    return <ConfigurationField resetEpoch={rawResetEpoch} presentation={{ ...codexFieldPresentation(id), ...(builtinAddress ? { placeholder: undefined } : {}), origin: draft.profile.editing?.intents.some(action => action.operation === 'set' && action.field === id && action.target === target) ? 'explicit' : field?.origin, ...(id === 'model' ? { combobox: true, catalog: catalog ? { supported: catalog.supported, busy: catalog.busy, fetch: catalog.fetch } : undefined, suggestions: [...new Set([...(catalog?.models ?? []), values.model].filter((value): value is string => typeof value === 'string' && value.trim() !== ''))] } : {}) }} key={`${draft.sessionId}:${id}:${target}`} field={builtinAddress ? { ...metadata, unavailableReason: t('tools.adapters.codex.builtinAddress') } : metadata}
      value={values[id]} disabled={disabled} issues={draft.issues.filter(issue => issue.field === id)}
      onChange={value => value === '' ? action('reset') : action('set', value)} onReset={() => action('reset')}
      onValidityChange={valid => onValidityChange(id, valid)} />;
  };
  return <section className={styles.editor} aria-label={t('tools.adapters.codex.label')}>
    <div hidden={section === 'settings'}>
      <ConfigurationStep step="connection" label={t('common.provider.title')} title={t('common.provider.title')} meta={connectionMeta(values.model_provider, values.base_url)}>
        <div className={styles.fields}>{render('model_provider')}{render('base_url')}</div>
        {view?.defaultAddressReason && <p className={styles.note}>{view.defaultAddressReason}</p>}
      </ConfigurationStep>
      <ConnectionCredential />
      <ConfigurationStep step="model" title={t('tools.config.modelStepTitle')} meta={t('tools.config.modelStepHint')}>
        <div className={styles.fields}>{render('model')}</div>
      </ConfigurationStep>
    </div>
    <div hidden={section === 'models'}><details className={sharedStyles.disclosureCard} open={section === 'settings'}><summary>{t('tools.adapters.codex.paramsSummary')}</summary><p className={styles.note}>{t('tools.adapters.codex.paramsNote', { source: view?.capabilitySource })}</p>
      <div className={styles.fields}>{['model_reasoning_effort', 'model_context_window', 'model_reasoning_summary', 'model_verbosity'].map(render)}</div>
    </details>
    </div>
  </section>;
}

export function CodexConfigurationEditor(props: ConfigurationContentProps) {
  if (props.mode === 'common') return <CommonConfigurationFields {...props} presentationFor={codexFieldPresentation} />;
  return <Editor key={props.draft.sessionId} {...props} />;
}
