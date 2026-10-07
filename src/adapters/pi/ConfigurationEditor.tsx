import { piFieldPresentation } from './fieldPresentation';
import { CommonConfigurationFields } from '../../components/configuration/CommonConfigurationFields';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AdditionalIssues, objectFields, EntityActions, EditorField, ModelRow, ProviderEditor, NewModelForm, useEditorAction } from '../../components/configuration/ModelEditorControls';
import sharedStyles from '../../components/configuration/configuration.module.css';
import type { ConfigurationContentProps } from '../contract';
import styles from './ConfigurationEditor.module.css';

type Model = { id: string; kind: 'model' | 'override'; fields: Record<string, unknown> };
type View = { providerId?: string | null; providers?: string[]; models?: Model[]; defaultModel?: string | null; settings?: Record<string, unknown>; connection?: { baseUrl?: string; protocol?: string }; capabilityReason?: string };
const protocols = { 'openai-completions': 'openai_completions', 'openai-responses': 'openai_responses', 'anthropic-messages': 'anthropic_messages' };

export function PiConfigurationEditor(props: ConfigurationContentProps) {
  if (props.mode === 'common') return <CommonConfigurationFields {...props} presentationFor={piFieldPresentation} />;
  return <Editor key={props.draft.sessionId} {...props} />;
}
function Editor(props: ConfigurationContentProps) {
  const { t } = useTranslation();
  const { draft, descriptor } = props;
  const inputChoices = ((): readonly (readonly [string, string])[] => [['text', t('tools.adapters.shared.modality.text')], ['image', t('tools.adapters.shared.modality.image')]])();
  const view = (draft.view ?? {}) as View;
  const models = (view.models ?? []).map(model => ({ ...model, fields: objectFields(model.fields) }));
  const [expanded, setExpanded] = useState<string | null>(null);
  const action = useEditorAction(props, 'pi-actions');
  const provider = view.providerId ?? '';
  const blocked = props.disabled || action.pending;
  const structuralBlocked = blocked || props.pending;
  const can = (operation: string) => descriptor.operations.includes(operation);
  const target = (model: Model) => ({ kind: model.kind, provider, id: model.id });
  const key = (model: Model) => `${model.kind}:${model.id}`;
  const field = (id: string, model?: Model) => <EditorField key={`${draft.sessionId}:${provider}:${model ? key(model) : 'settings'}:${id}`} props={action.props}
    id={id} presentation={piFieldPresentation(id)} target={model ? target(model) : { kind: 'settings' }} value={model ? model.fields[id] : view.settings?.[id]} defaultSource={model?.kind === 'override' ? t('common.models.followBuiltin') : undefined}
    listChoices={id === 'input' ? inputChoices : undefined} choices={!model && id === 'defaultModel' ? models.map(item => item.id) : !model && id === 'defaultProvider' ? (view.providers ?? []) : undefined} disabled={blocked || (id === 'defaultProvider' && action.hasInvalidExcept({ kind: 'settings' }, id))} />;
  return <section onKeyDown={event => { if (props.section && expanded && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setExpanded(null); } }} className={styles.editor} aria-label={t('tools.adapters.pi.label')}>
    <div hidden={props.section === 'settings'}>
    <div hidden={Boolean(props.section && expanded)}><ProviderEditor key={`provider:${draft.sessionId}:${provider}`} provider={provider} providers={view.providers ?? []} connection={view.connection}
      protocol={view.connection?.protocol ? protocols[view.connection.protocol as keyof typeof protocols] ?? '' : ''}
      disabled={structuralBlocked || action.invalid} canConfigure={can('configure_provider')} canSelect={can('select_provider')}
      onDraftValidityChange={valid => props.onValidityChange('connection-form', valid)}
      onConfigure={(id, value) => action.run({ kind: 'provider', provider: id }, 'configure_provider', value)}
      onSelect={id => action.run({ kind: 'provider', provider: id }, 'select_provider')} />
    <p className={styles.note}>{t('tools.adapters.pi.defaultNote')}</p>
    </div>
    {models.map(model => <article className={styles.model} key={`${provider}:${key(model)}`} hidden={Boolean(props.section && expanded && expanded !== key(model))} aria-label={t('tools.adapters.shared.modelAria', { id: model.id })}>
      <ModelRow id={model.id} name={typeof model.fields.name === 'string' ? model.fields.name : undefined}
        badges={[model.kind === 'override' ? t('tools.adapters.pi.badgeOverride') : '', view.defaultModel === model.id ? t('common.models.defaultBadge') : ''].filter(Boolean)}
        expanded={expanded === key(model)} sectioned={Boolean(props.section)} disabled={structuralBlocked}
        canDefault={can('default') && view.defaultModel !== model.id}
        onToggle={() => setExpanded(expanded === key(model) ? null : key(model))}
        onSetDefault={() => void action.run(target(model), 'default')} />
      {<div className={styles.fields} hidden={expanded !== key(model)}>
        {descriptor.fields.filter(item => !item.advanced && !item.id.startsWith('default')).map(item => field(item.id, model))}
        {field('input', model)}
        <details><summary>{t('tools.adapters.pi.optionalSummary')}</summary>{field('thinkingLevelMap', model)}</details>
        <EntityActions id={model.id} target={target(model)} descriptor={descriptor} disabled={structuralBlocked} defaultModel={view.defaultModel === model.id} onRun={action.run} onRemove={() => setExpanded(null)} />
      </div>}
    </article>)}
    <div hidden={Boolean(props.section && expanded)}>{can('create') && <NewModelForm key={`new-model:${draft.sessionId}:${provider}`} props={action.props} provider={provider} disabled={structuralBlocked || !provider} label={t('tools.adapters.shared.modelId')} fields={descriptor.fields.filter(item => !item.id.startsWith('default'))}
      onCreate={async (id, values, kind) => { const success = await action.run({ kind, provider, id }, kind === 'override' ? 'create_override' : 'create', values); if (success) setExpanded(`${kind}:${id}`); return success; }} allowOverride={can('create_override')} listChoices={{ input: inputChoices }} />}
    </div>
    <div className={styles.modelSpacer} data-list-spacer /></div>
    <div hidden={props.section === 'models'}><details className={sharedStyles.disclosureCard} open={props.section === 'settings'}><summary>{t('tools.adapters.pi.defaultsSummary')}</summary>{field('defaultProvider')}{field('defaultModel')}{field('defaultThinkingLevel')}
      {!descriptor.fields.some(item => item.id === 'defaultModel') && <button type="button" disabled={blocked || !can('reset')} onClick={() => { void action.run({ kind: 'settings' }, 'reset', null, 'defaultModel'); }}>{t('tools.adapters.shared.resetDefaultModel')}</button>}
      {!descriptor.fields.some(item => item.id === 'defaultProvider') && <button type="button" disabled={blocked || !can('reset')} onClick={() => { void action.run({ kind: 'settings' }, 'reset', null, 'defaultProvider'); }}>{t('tools.adapters.pi.resetDefaultProvider')}</button>}
      {draft.scope === 'project' && <p className={styles.note}>{t('tools.adapters.pi.projectNote')}</p>}
    </details>
    </div>
    {view.capabilityReason && <details className={sharedStyles.disclosureCard}><summary>{t('tools.adapters.shared.capabilitySummary')}</summary><p className={styles.note}>{view.capabilityReason}</p></details>}
    <AdditionalIssues props={props} />
    {action.error && <div role="alert">{action.error}<button type="button" onClick={action.cancelFailure}>{t('tools.adapters.shared.cancelOperation')}</button></div>}
  </section>;
}
