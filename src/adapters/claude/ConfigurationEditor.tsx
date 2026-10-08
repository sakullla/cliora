import { claudeFieldPresentation } from './fieldPresentation';
import { CommonConfigurationFields } from '../../components/configuration/CommonConfigurationFields';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfigurationField, type FieldPresentation } from '../../components/configuration/ConfigurationField';
import { ConnectionCredential } from '../../components/configuration/ConnectionCredential';
import sharedStyles from '../../components/configuration/configuration.module.css';
import type { ConfigurationContentProps } from '../contract';
import styles from './ConfigurationEditor.module.css';

type View = { values?: Record<string, unknown>; editTarget?: string; effortChoices?: string[]; effortWarnings?: string[]; effortOverride?: unknown; modelEffortOverride?: unknown; modelEfforts?: Record<string, unknown>; modelEffortChoices?: Record<string, string[]>; currentEffortModel?: string | null; capabilitySource?: string };
const roles = [['sonnet', 'Sonnet'], ['opus', 'Opus'], ['fable', 'Fable'], ['haiku', 'Haiku'], ['subagent', 'Subagent']] as const;
function Editor({ draft, descriptor, disabled, onAction, onValidityChange, section, rawResetEpoch, catalog }: ConfigurationContentProps) {
  const { t } = useTranslation();
  const view = draft.view as View | null;
  const values = view?.values ?? {};
  const [unifyError, setUnifyError] = useState<string | null>(null);
  const [unifying, setUnifying] = useState(false);
  const [effortModel, setEffortModel] = useState(view?.currentEffortModel ?? '');
  const request = useRef(0);
  const validity = useRef(onValidityChange);
  validity.current = onValidityChange;
  useEffect(() => { setEffortModel(view?.currentEffortModel ?? ''); }, [draft.sessionId, view?.currentEffortModel]);
  useEffect(() => () => { validity.current('modelEffortLevel', true); }, [draft.sessionId, effortModel]);
  useEffect(() => () => {
    request.current += 1;
    for (const field of descriptor.fields) validity.current(field.id, true);
    validity.current('unify', true);
  }, [draft.sessionId]);
  const render = (id: string) => {
    const field = descriptor.fields.find(field => field.id === id);
    if (!field) return null;
    const editTarget = view?.editTarget ?? 'configuration';
    const target = id === 'modelEffortLevel' ? `${editTarget === 'local_configuration' ? 'local:' : ''}model:${effortModel}` : editTarget;
    const action = (operation: string, value: unknown = null) => onAction({ version: descriptor.version, target, operation, field: id, value });
    const choices = id === 'modelEffortLevel' ? view?.modelEffortChoices?.[effortModel] : undefined;
    const isModel = id === 'default.model' || id.endsWith('.model');
    const metadata = choices?.length ? { ...field, choices } : field;
    const role = roles.find(([key]) => id === `${key}.model` || id === `${key}.name`);
    const roleModel = role ? values[`${role[0]}.model`] : undefined;
    const presentation: FieldPresentation = {
      ...claudeFieldPresentation(id),
      origin: draft.profile.editing?.intents.some(action => action.operation === 'set' && action.field === id && action.target === target) ? 'explicit' : field?.origin,
      ...(isModel ? { combobox: true, catalog: catalog ? { supported: catalog.supported, busy: catalog.busy, fetch: catalog.fetch } : undefined, suggestions: [...new Set([...(catalog?.models ?? []), ...roles.map(([key]) => values[`${key}.model`]), values['default.model']].filter((value): value is string => typeof value === 'string' && value.trim() !== ''))] } : {}),
      ...(id.endsWith('.name') && typeof roleModel === 'string' && roleModel.trim() ? { placeholder: t('tools.adapters.claude.sameAsModel', { model: roleModel }) } : {}),
    };
    return <ConfigurationField resetEpoch={rawResetEpoch} presentation={presentation} key={`${draft.sessionId}:${id}:${target}`} field={metadata} value={id === 'modelEffortLevel' ? view?.modelEfforts?.[effortModel] : values[id]} disabled={disabled || unifying || (id === 'modelEffortLevel' && !effortModel.trim())}
      issues={draft.issues.filter(issue => issue.field === id)}
      onChange={value => value === '' ? action('reset') : action('set', value)}
      onReset={id.endsWith('.longContext') ? undefined : () => action('reset')}
      onValidityChange={valid => onValidityChange(id, valid)} />;
  };
  const unify = async () => {
    const token = ++request.current;
    const model = values['default.model'];
    if (typeof model !== 'string' || !model.trim()) return;
    setUnifying(true); setUnifyError(null); onValidityChange('unify', false);
    try {
      await onAction({ version: descriptor.version, target: view?.editTarget ?? 'configuration', operation: 'unify', field: null, value: model + (values['default.longContext'] === true ? '[1m]' : '') });
      if (token === request.current) { setUnifying(false); onValidityChange('unify', true); }
    } catch (error) {
      if (token === request.current) { setUnifying(false); setUnifyError(error instanceof Error ? error.message : t('tools.adapters.claude.unifyFailed')); }
    }
  };
  return <section className={styles.editor} aria-label={t('tools.adapters.claude.label')}>
    <div hidden={section === 'settings'}>
      <section className={sharedStyles.providerCard} aria-label={t('common.provider.title')}>
        <strong className={sharedStyles.sectionTitle}>{t('common.provider.title')}</strong>
        {render('base_url')}
      </section>
      <ConnectionCredential />
      {render('default.model')}
    </div>
    <div hidden={section === 'models'}><details className={sharedStyles.disclosureCard} open={section === 'settings'}><summary>{t('tools.adapters.claude.rolesSummary')}</summary><div className={styles.fields}>
      <div className={styles.unifyRow}><button type="button" className={sharedStyles.accent} disabled={disabled || unifying || !values['default.model']} onClick={() => { void unify(); }}>{unifying ? t('tools.adapters.claude.unifying') : t('tools.adapters.claude.unify')}</button>{unifyError && <p role="alert">{unifyError}</p>}<p className={styles.note}>{t('tools.adapters.claude.unifyNote')}</p></div>
      {render('default.longContext')}
      <div className={styles.roleGrid}>{roles.map(([role, label]) => <fieldset className={styles.roleCard} key={role}><legend>{role === 'subagent' ? t('tools.adapters.claude.roleSubagent') : label}</legend>{render(`${role}.model`)}{render(`${role}.name`)}{render(`${role}.longContext`)}</fieldset>)}</div>
    </div></details>
    <details className={sharedStyles.disclosureCard}><summary>{t('tools.adapters.claude.effortSummary')}</summary><p className={styles.note}>{view?.capabilitySource}</p>{render('effortLevel')}
      {view?.effortWarnings?.map(message => <p key={message} className={styles.note}>{message}</p>)}
      <div className={styles.fields}>
        <label>{t('tools.adapters.claude.effortModelId')}<input aria-label={t('tools.adapters.claude.effortModelId')} value={effortModel} list="claude-existing-effort-models" disabled={disabled || unifying} onChange={event => setEffortModel(event.target.value)} /></label>
        <datalist id="claude-existing-effort-models">{Object.keys(view?.modelEfforts ?? {}).map(id => <option key={id} value={id} />)}</datalist>
        <p className={styles.note}>{t('tools.adapters.claude.effortModelNote')}</p>
        {render('modelEffortLevel')}
      </div>
      {view?.effortOverride != null && <p className={styles.note}>{t('tools.adapters.claude.effortEnvOverride', { value: String(view.effortOverride) })}</p>}
      {view?.modelEffortOverride != null && <p className={styles.note}>{t('tools.adapters.claude.effortModelOverride', { value: String(view.modelEffortOverride) })}</p>}
    </details>
    </div>
  </section>;
}

export function ClaudeConfigurationEditor(props: ConfigurationContentProps) {
  if (props.mode === 'common') return <CommonConfigurationFields {...props} presentationFor={claudeFieldPresentation} />;
  return <Editor key={props.draft.sessionId} {...props} />;
}
