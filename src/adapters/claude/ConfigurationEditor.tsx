import { claudeFieldPresentation } from './fieldPresentation';
import { CommonConfigurationFields } from '../../components/configuration/CommonConfigurationFields';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfigurationField, type FieldPresentation } from '../../components/configuration/ConfigurationField';
import { ConnectionCredential } from '../../components/configuration/ConnectionCredential';
import { ConfigurationStep, connectionMeta } from '../../components/configuration/ConfigurationStep';
import { confirmAction } from '../../lib/confirm';
import sharedStyles from '../../components/configuration/configuration.module.css';
import type { ConfigurationContentProps } from '../contract';
import styles from './ConfigurationEditor.module.css';

type View = { values?: Record<string, unknown>; editTarget?: string; effortChoices?: string[]; effortWarnings?: string[]; effortOverride?: unknown; modelEffortOverride?: unknown; modelEfforts?: Record<string, unknown>; modelEffortChoices?: Record<string, string[]>; currentEffortModel?: string | null; roleFollowing?: Record<string, boolean>; inheritedRoleModels?: string[]; baseUrlSource?: string | null; capabilitySource?: string };
const roles = [['sonnet', 'Sonnet'], ['opus', 'Opus'], ['fable', 'Fable'], ['haiku', 'Haiku'], ['subagent', 'Subagent']] as const;
function Editor({ draft, descriptor, disabled, onAction, onValidityChange, section, rawResetEpoch, catalog }: ConfigurationContentProps) {
  const { t } = useTranslation();
  const view = draft.view as View | null;
  const values = view?.values ?? {};
  const [unifyError, setUnifyError] = useState<string | null>(null);
  const [unifying, setUnifying] = useState(false);
  const [effortModel, setEffortModel] = useState(view?.currentEffortModel ?? '');
  const request = useRef(0);
  const alive = useRef(true);
  const validity = useRef(onValidityChange);
  validity.current = onValidityChange;
  useEffect(() => { setEffortModel(view?.currentEffortModel ?? ''); }, [draft.sessionId, view?.currentEffortModel]);
  useEffect(() => () => { validity.current('modelEffortLevel', true); }, [draft.sessionId, effortModel]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current += 1;
      for (const field of descriptor.fields) validity.current(field.id, true);
      validity.current('roleOverrides', true);
    };
  }, [draft.sessionId]);
  // The native projection states which roles have no model key and therefore
  // follow the default model. Missing data is treated conservatively from the
  // displayed value so older drafts still render a truthful placeholder.
  const followingOf = (role: string) => {
    const value = values[`${role}.model`];
    return view?.roleFollowing?.[role] ?? !(typeof value === 'string' && value.trim() !== '');
  };
  const defaultModel = values['default.model'];
  const roleLabel = (role: string, label: string) => role === 'subagent' ? t('tools.adapters.claude.roleSubagent') : label;
  const roleDisplay = (role: string) => {
    const entry = roles.find(([key]) => key === role);
    return entry ? roleLabel(entry[0], entry[1]) : role;
  };
  const inheritedRoles = view?.inheritedRoleModels ?? [];
  const affectedRoles = () => roles.filter(([role]) => !followingOf(role)).map(([role, label]) => roleLabel(role, label));
  const affected = affectedRoles();
  const render = (id: string) => {
    const field = descriptor.fields.find(field => field.id === id);
    if (!field) return null;
    const editTarget = view?.editTarget ?? 'configuration';
    const target = id === 'modelEffortLevel' ? `${editTarget === 'local_configuration' ? 'local:' : ''}model:${effortModel}` : editTarget;
    const action = (operation: string, value: unknown = null) => onAction({ version: descriptor.version, target, operation, field: id, value });
    const choices = id === 'modelEffortLevel' ? view?.modelEffortChoices?.[effortModel] : undefined;
    const isModel = id === 'default.model' || id.endsWith('.model');
    const metadata = choices?.length ? { ...field, choices } : field;
    const role = roles.find(([key]) => id === `${key}.model` || id === `${key}.name` || id === `${key}.longContext`);
    const roleModel = role ? values[`${role[0]}.model`] : undefined;
    const following = Boolean(role) && id.endsWith('.model') && followingOf(role![0]);
    // A following role has no own long-context key; its checkbox reflects the
    // default model and stays disabled instead of offering a failing write.
    const followsLongContext = Boolean(role) && id.endsWith('.longContext') && followingOf(role![0]);
    const presentation: FieldPresentation = {
      ...claudeFieldPresentation(id),
      ...(followsLongContext ? { description: t('tools.adapters.claude.followsDefaultLongContext') } : {}),
      origin: draft.profile.editing?.intents.some(action => action.operation === 'set' && action.field === id && action.target === target) ? 'explicit' : field?.origin,
      ...(isModel ? { combobox: true, catalog: catalog ? { supported: catalog.supported, busy: catalog.busy, fetch: catalog.fetch, error: catalog.error } : undefined, suggestions: [...new Set([...(catalog?.models ?? []), ...roles.map(([key]) => values[`${key}.model`]), values['default.model']].filter((value): value is string => typeof value === 'string' && value.trim() !== ''))] } : {}),
      ...(id.endsWith('.name') && typeof roleModel === 'string' && roleModel.trim() ? { placeholder: t('tools.adapters.claude.sameAsModel', { model: roleModel }) } : {}),
      ...(following && typeof defaultModel === 'string' && defaultModel.trim() ? { placeholder: t('tools.adapters.claude.followsDefaultWith', { model: defaultModel }) } : following ? { placeholder: t('tools.adapters.claude.followsDefault') } : {}),
    };
    const value = followsLongContext ? values['default.longContext'] === true : id === 'modelEffortLevel' ? view?.modelEfforts?.[effortModel] : values[id];
    return <ConfigurationField resetEpoch={rawResetEpoch} presentation={presentation} key={`${draft.sessionId}:${id}:${target}`} field={metadata} value={value} disabled={disabled || unifying || followsLongContext || (id === 'modelEffortLevel' && !effortModel.trim())}
      issues={draft.issues.filter(issue => issue.field === id)}
      onChange={value => value === '' ? action('reset') : action('set', value)}
      onReset={id.endsWith('.longContext') ? undefined : () => action('reset')}
      onValidityChange={valid => onValidityChange(id, valid)} />;
  };
  const unify = async () => {
    const model = values['default.model'];
    const labels = affectedRoles();
    if (inheritedRoles.length || typeof model !== 'string' || !model.trim() || !labels.length) return;
    // A shared dialog states which roles change. Cancelling sends no action,
    // and a stale answer authorizes nothing after the draft moved on.
    const accepted = await confirmAction(
      t('tools.adapters.claude.unifyConfirm', { roles: labels.join(t('tools.adapters.claude.roleListSeparator')), model }),
      () => alive.current && values['default.model'] === model,
      { title: t('tools.adapters.claude.unifyTitle'), confirmLabel: t('tools.adapters.claude.unify') },
    );
    if (!accepted) return;
    const token = ++request.current;
    setUnifying(true); setUnifyError(null); onValidityChange('roleOverrides', false);
    try {
      await onAction({ version: descriptor.version, target: view?.editTarget ?? 'configuration', operation: 'unify', field: null, value: model + (values['default.longContext'] === true ? '[1m]' : '') });
      if (token === request.current) { setUnifying(false); onValidityChange('roleOverrides', true); }
    } catch (error) {
      if (token === request.current) { setUnifying(false); setUnifyError(error instanceof Error ? error.message : t('tools.adapters.claude.unifyFailed')); }
    }
  };
  const customAddress = typeof values.base_url === 'string' && values.base_url.trim() !== '';
  return <section className={styles.editor} aria-label={t('tools.adapters.claude.label')}>
    <div hidden={section === 'settings'}>
      <ConfigurationStep step="connection" label={t('common.provider.title')} title={t('common.provider.title')} meta={connectionMeta(null, values.base_url)}>
        <div className={styles.fields}>{render('base_url')}</div>
        {view?.baseUrlSource && <p className={styles.note}>{t('tools.adapters.claude.baseUrlSource', { source: view.baseUrlSource })}</p>}
      </ConfigurationStep>
      <ConnectionCredential />
      <ConfigurationStep step="model" title={t('tools.config.modelStepTitle')} meta={customAddress ? connectionMeta(null, values.base_url) : t('tools.config.modelStepHint')}>
        <div className={styles.fields}>{render('default.model')}</div>
      </ConfigurationStep>
    </div>
    <div hidden={section === 'models'}><details className={sharedStyles.disclosureCard} open={section === 'settings'}><summary>{t('tools.adapters.claude.rolesSummary')}</summary><div className={styles.fields}>
      <div className={styles.unifyRow}><button type="button" className={sharedStyles.accent} disabled={disabled || unifying || inheritedRoles.length > 0 || !values['default.model'] || !affected.length} onClick={() => { void unify(); }}>{unifying ? t('tools.adapters.claude.unifying') : t('tools.adapters.claude.unify')}</button>{unifyError && <p role="alert">{unifyError}</p>}<p className={styles.note}>{inheritedRoles.length ? t('tools.adapters.claude.unifyInheritedBlocked', { roles: inheritedRoles.map(roleDisplay).join(t('tools.adapters.claude.roleListSeparator')) }) : affected.length ? t('tools.adapters.claude.unifyNote') : t('tools.adapters.claude.unifyNoChanges')}</p></div>
      {render('default.longContext')}
      <div className={styles.roleGrid}>{roles.map(([role, label]) => <fieldset className={styles.roleCard} key={role}><legend>{roleLabel(role, label)}{followingOf(role) && <span className={styles.follow}>{t('tools.adapters.claude.followsDefault')}</span>}{inheritedRoles.includes(role) && <span className={styles.inherited}>{t('tools.adapters.claude.inheritedGlobal')}</span>}</legend>{render(`${role}.model`)}{render(`${role}.name`)}{render(`${role}.longContext`)}</fieldset>)}</div>
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
