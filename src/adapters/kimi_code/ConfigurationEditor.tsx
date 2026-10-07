import { kimiFieldPresentation } from './fieldPresentation';
import { CommonConfigurationFields } from '../../components/configuration/CommonConfigurationFields';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AdditionalIssues, objectFields, EntityActions, EditorField, ModelRow, ProviderEditor, NewModelForm, useEditorAction } from '../../components/configuration/ModelEditorControls';
import sharedStyles from '../../components/configuration/configuration.module.css';
import type { ConfigurationContentProps } from '../contract';
import i18n from '../../i18n';
import styles from './ConfigurationEditor.module.css';

type Model = { id: string; fields: Record<string, unknown> };
type View = { providerId?: string | null; providers?: string[]; models?: Model[]; defaultModel?: string | null; settings?: Record<string, unknown>; connection?: { baseUrl?: string; protocol?: string; readOnlyReason?: string }; capabilityReason?: string };
const protocols = { openai: 'openai_completions', openai_responses: 'openai_responses', anthropic: 'anthropic_messages' };
const capabilityChoices = (): readonly (readonly [string, string])[] => [
  ['image_in', i18n.t('tools.adapters.kimi.capability.image_in')], ['thinking', i18n.t('tools.adapters.kimi.capability.thinking')], ['video_in', i18n.t('tools.adapters.kimi.capability.video_in')], ['audio_in', i18n.t('tools.adapters.kimi.capability.audio_in')],
  ['always_thinking', i18n.t('tools.adapters.kimi.capability.always_thinking')], ['tool_use', i18n.t('tools.adapters.kimi.capability.tool_use')], ['dynamically_loaded_tools', i18n.t('tools.adapters.kimi.capability.dynamically_loaded_tools')],
];

export function KimiConfigurationEditor(props: ConfigurationContentProps) {
  if (props.mode === 'common') return <CommonConfigurationFields {...props} presentationFor={kimiFieldPresentation} />;
  return <Editor key={props.draft.sessionId} {...props} />;
}
function Editor(props: ConfigurationContentProps) {
  const { t } = useTranslation();
  const { draft, descriptor } = props;
  const view = (draft.view ?? {}) as View;
  const models = (view.models ?? []).map(model => ({ ...model, fields: objectFields(model.fields) }));
  const [expanded, setExpanded] = useState<string | null>(null);
  const action = useEditorAction(props, 'kimi-actions');
  const provider = view.providerId ?? '';
  const blocked = props.disabled || action.pending;
  const structuralBlocked = blocked || props.pending;
  const can = (operation: string) => descriptor.operations.includes(operation);
  const target = (model: Model) => ({ kind: 'model', provider: String(model.fields.provider ?? provider), id: model.id });
  const field = (id: string, model?: Model) => <EditorField key={`${draft.sessionId}:${provider}:${model?.id ?? 'settings'}:${id}`} props={action.props}
    id={id} presentation={kimiFieldPresentation(id)} target={model ? target(model) : { kind: 'settings' }} value={model ? model.fields[id] : view.settings?.[id.slice('thinking.'.length)]} disabled={blocked || (id === 'provider' && Boolean(model) && action.hasInvalidExcept(target(model!), id))}
    listChoices={id === 'capabilities' ? capabilityChoices() : undefined}
    choices={id === 'provider' ? [...new Set([provider, ...(view.providers ?? [])])].filter(Boolean) : id === 'default_effort' && Array.isArray(model?.fields.support_efforts) && model.fields.support_efforts.every(value => typeof value === 'string') ? model.fields.support_efforts as string[] : undefined} />;
  const modelFields = descriptor.fields.filter(item => !item.id.startsWith('thinking.')).sort((a, b) => (a.id === 'max_context_size' ? -1 : b.id === 'max_context_size' ? 1 : 0)).map(item => item.id === 'capabilities' ? { ...item, advanced: false } : item.id === 'provider' ? { ...item, choices: [...new Set([provider, ...(view.providers ?? [])])].filter(Boolean) } : item);
  return <section onKeyDown={event => { if (props.section && expanded && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setExpanded(null); } }} className={styles.editor} aria-label={t('tools.adapters.kimi.label')}>
    <div hidden={props.section === 'settings'}>
    <div hidden={Boolean(props.section && expanded)}><ProviderEditor key={`provider:${draft.sessionId}:${provider}`} provider={provider} providers={view.providers ?? []} connection={view.connection}
      protocol={view.connection?.protocol ? protocols[view.connection.protocol as keyof typeof protocols] ?? '' : ''}
      disabled={structuralBlocked || action.invalid} canConfigure={can('configure_provider')} canSelect={can('select_provider')}
      onDraftValidityChange={valid => props.onValidityChange('connection-form', valid)}
      onConfigure={(id, value) => action.run({ kind: 'provider', provider: id }, 'configure_provider', value)}
      onSelect={id => action.run({ kind: 'provider', provider: id }, 'select_provider')} />
    <details className={sharedStyles.disclosureCard}><summary>{t('tools.adapters.kimi.notesSummary')}</summary><p className={styles.note}>{t('tools.adapters.kimi.note1')}</p>
    <p className={styles.note}>{t('tools.adapters.kimi.note2')}</p>
    </details></div>
    {models.map(model => <article className={styles.model} key={`${provider}:${model.id}`} hidden={Boolean(props.section && expanded && expanded !== model.id)} aria-label={t('tools.adapters.shared.modelAria', { id: model.id })}>
      <ModelRow id={model.id} name={typeof model.fields.display_name === 'string' ? model.fields.display_name : undefined}
        sub={typeof model.fields.model === 'string' && model.fields.model !== model.id ? [t('tools.adapters.kimi.requestModel', { model: model.fields.model })] : []}
        badges={view.defaultModel === model.id ? [t('common.models.defaultBadge')] : []}
        expanded={expanded === model.id} sectioned={Boolean(props.section)} disabled={structuralBlocked}
        canDefault={can('default') && view.defaultModel !== model.id}
        onToggle={() => setExpanded(expanded === model.id ? null : model.id)}
        onSetDefault={() => void action.run(target(model), 'default')} />
      {<div className={styles.fields} hidden={expanded !== model.id}>
        {modelFields.filter(item => !item.advanced).map(item => field(item.id, model))}
        <details><summary>{t('tools.adapters.kimi.advancedSummary')}</summary>{modelFields.filter(item => item.advanced).map(item => field(item.id, model))}</details>
        <EntityActions id={model.id} target={target(model)} descriptor={descriptor} disabled={structuralBlocked} defaultModel={view.defaultModel === model.id} renameLabel={t('tools.adapters.kimi.newAlias')} onRun={action.run} onRemove={() => setExpanded(null)} />
      </div>}
    </article>)}
    <div hidden={Boolean(props.section && expanded)}>{can('create') && <NewModelForm key={`new-model:${draft.sessionId}:${provider}`} props={action.props} provider={provider} disabled={structuralBlocked || !provider} label={t('tools.adapters.kimi.modelAlias')} fields={modelFields}
      listChoices={{ capabilities: capabilityChoices() }}
      initialValues={{ provider }} onCreate={async (id, values) => { const success = await action.run({ kind: 'model', provider, id }, 'create', values); if (success) setExpanded(id); return success; }} />}
    </div>
    <div className={styles.modelSpacer} data-list-spacer /></div>
    <div hidden={props.section === 'models'}><details className={sharedStyles.disclosureCard} open={props.section === 'settings'}><summary>{t('tools.adapters.kimi.thinkingSummary')}</summary>{descriptor.fields.filter(item => item.id.startsWith('thinking.')).map(item => field(item.id))}</details>
    </div>
    {view.capabilityReason && <details className={sharedStyles.disclosureCard}><summary>{t('tools.adapters.shared.capabilitySummary')}</summary><p className={styles.note}>{view.capabilityReason}</p></details>}
    {!descriptor.operations.length && <p role="status">{t('tools.adapters.kimi.projectUnsupported')}</p>}
    <AdditionalIssues props={props} />
    {action.error && <div role="alert">{action.error}<button type="button" onClick={action.cancelFailure}>{t('tools.adapters.shared.cancelOperation')}</button></div>}
  </section>;
}
