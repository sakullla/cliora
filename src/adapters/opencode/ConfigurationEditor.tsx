import { openCodeFieldPresentation } from './fieldPresentation';
import { CommonConfigurationFields } from '../../components/configuration/CommonConfigurationFields';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConnectionCredential } from '../../components/configuration/ConnectionCredential';
import { AdditionalIssues, objectFields, EntityActions, EditorField, ModelRow, ProviderEditor, NewModelForm, useEditorAction, fieldValue } from '../../components/configuration/ModelEditorControls';
import sharedStyles from '../../components/configuration/configuration.module.css';
import type { ConfigurationContentProps } from '../contract';
import styles from './ConfigurationEditor.module.css';

type Model = { id: string; kind: string; fields: Record<string, unknown> };
type View = { providerId?: string | null; providers?: string[]; models?: Model[]; defaultModel?: string | null; smallModel?: string | null; connection?: { baseUrl?: string; protocol?: string }; capabilityReason?: string };
const protocols = { '@ai-sdk/openai-compatible': 'openai_completions', '@ai-sdk/openai': 'openai_responses', '@ai-sdk/anthropic': 'anthropic_messages' };

export function OpenCodeConfigurationEditor(props: ConfigurationContentProps) {
  if (props.mode === 'common') return <CommonConfigurationFields {...props} presentationFor={openCodeFieldPresentation} />;
  return <Editor key={props.draft.sessionId} {...props} />;
}
function Editor(props: ConfigurationContentProps) {
  const { t } = useTranslation();
  const { draft, descriptor } = props;
  const modalityChoices = ((): readonly (readonly [string, string])[] => [['text', t('tools.adapters.shared.modality.text')], ['image', t('tools.adapters.shared.modality.image')], ['audio', t('tools.adapters.shared.modality.audio')], ['video', t('tools.adapters.shared.modality.video')], ['pdf', 'PDF']])();
  const view = (draft.view ?? {}) as View;
  const models = (view.models ?? []).map(model => ({ ...model, fields: objectFields(model.fields) }));
  const [expanded, setExpanded] = useState<string | null>(null);
  const action = useEditorAction(props, 'opencode-actions');
  const provider = view.providerId ?? '';
  const blocked = props.disabled || action.pending;
  const structuralBlocked = blocked || props.pending;
  const can = (operation: string) => descriptor.operations.includes(operation);
  const target = (id: string) => ({ kind: 'model', provider, id });
  const field = (id: string, model: Model) => <EditorField key={`${draft.sessionId}:${provider}:${model.id}:${id}`} props={action.props} id={id} presentation={openCodeFieldPresentation(id)} target={target(model.id)} value={fieldValue(model.fields, id)} disabled={blocked}
    listChoices={id.startsWith('modalities.') ? modalityChoices : undefined} />;
  return <section onKeyDown={event => { if (props.section && expanded && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setExpanded(null); } }} className={styles.editor} aria-label={t('tools.adapters.opencode.label')}>
    <div hidden={props.section === 'settings'}>
    <div hidden={Boolean(props.section && expanded)}><ProviderEditor key={`provider:${draft.sessionId}:${provider}`} provider={provider} providers={view.providers ?? []} connection={view.connection}
      protocol={view.connection?.protocol ? protocols[view.connection.protocol as keyof typeof protocols] ?? '' : ''}
      disabled={structuralBlocked || action.invalid} canConfigure={can('configure_provider')} canSelect={can('select_provider')}
      onDraftValidityChange={valid => props.onValidityChange('connection-form', valid)}
      onConfigure={(id, value) => action.run({ kind: 'provider', provider: id }, 'configure_provider', value)}
      onSelect={id => action.run({ kind: 'provider', provider: id }, 'select_provider')} />
    <ConnectionCredential />
    <p className={styles.note}>{t('tools.adapters.opencode.defaultNote')}</p>
    </div>
    {models.map(model => <article className={styles.model} key={`${provider}:${model.id}`} hidden={Boolean(props.section && expanded && expanded !== model.id)} aria-label={t('tools.adapters.shared.modelAria', { id: model.id })}>
      <ModelRow id={model.id} name={typeof model.fields.name === 'string' ? model.fields.name : undefined}
        badges={[view.defaultModel === model.id ? t('common.models.defaultBadge') : '', view.smallModel === model.id ? t('tools.adapters.opencode.badgeSmall') : ''].filter(Boolean)}
        expanded={expanded === model.id} sectioned={Boolean(props.section)} disabled={structuralBlocked}
        canDefault={can('default') && view.defaultModel !== model.id}
        onToggle={() => setExpanded(expanded === model.id ? null : model.id)}
        onSetDefault={() => void action.run(target(model.id), 'default')} />
      {<div className={styles.fields} hidden={expanded !== model.id}>
        {descriptor.fields.filter(item => !item.advanced).map(item => field(item.id, model))}
        {field('modalities.input', model)}{field('modalities.output', model)}
        <details><summary>{t('tools.adapters.opencode.optionsSummary')}</summary>{field('options', model)}{field('variants', model)}</details>
        <EntityActions id={model.id} target={target(model.id)} descriptor={descriptor} disabled={structuralBlocked} defaultModel={view.defaultModel === model.id} smallModel={view.smallModel === model.id} onRun={action.run} onRemove={() => setExpanded(null)} />
      </div>}
    </article>)}
    <div hidden={Boolean(props.section && expanded)}>{can('create') && <NewModelForm key={`new-model:${draft.sessionId}:${provider}`} props={action.props} provider={provider} disabled={structuralBlocked || !provider} label={t('tools.adapters.shared.modelId')} fields={descriptor.fields} listChoices={{ 'modalities.input': modalityChoices, 'modalities.output': modalityChoices }}
      onCreate={async (id, values) => { const success = await action.run(target(id), 'create', values); if (success) setExpanded(id); return success; }} />}
    </div>
    <div className={styles.modelSpacer} data-list-spacer /></div>
    <div hidden={props.section === 'models'}><details className={sharedStyles.disclosureCard} open={props.section === 'settings'}><summary>{t('tools.adapters.opencode.defaultsSummary')}</summary>
      <button type="button" disabled={blocked || !can('reset')} onClick={() => { void action.run({ kind: 'settings' }, 'reset', null, 'model'); }}>{t('tools.adapters.shared.resetDefaultModel')}</button>
      <button type="button" disabled={blocked || !can('reset')} onClick={() => { void action.run({ kind: 'settings' }, 'reset', null, 'small_model'); }}>{t('tools.adapters.opencode.resetSmall')}</button>
    </details>
    </div>
    {view.capabilityReason && <p className={styles.note}>{view.capabilityReason}</p>}
    <AdditionalIssues props={props} />
    {action.error && <div role="alert">{action.error}<button type="button" onClick={action.cancelFailure}>{t('tools.adapters.shared.cancelOperation')}</button></div>}
  </section>;
}
