import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConnectionCredential } from '../../components/configuration/ConnectionCredential';
import { CommonConfigurationFields } from '../../components/configuration/CommonConfigurationFields';
import {
  AdditionalIssues,
  EntityActions,
  EditorField,
  ModelRow,
  ModelStep,
  NewModelForm,
  objectFields,
  ProviderEditor,
  useEditorAction,
} from '../../components/configuration/ModelEditorControls';
import sharedStyles from '../../components/configuration/configuration.module.css';
import type { ConfigurationContentProps } from '../contract';
import { ompFieldPresentation } from './fieldPresentation';
import styles from './ConfigurationEditor.module.css';

type Model = { id: string; kind: 'model'; fields: Record<string, unknown> };
type View = {
  providerId?: string | null;
  providers?: string[];
  models?: Model[];
  roles?: Record<string, string | null>;
  roleNames?: string[];
  defaultModel?: string | null;
  smallModel?: string | null;
  settings?: Record<string, unknown>;
  connection?: { baseUrl?: string; protocol?: string };
  capabilityReason?: string;
};

const protocols: Record<string, string> = {
  'openai-completions': 'openai_completions',
  'openai-responses': 'openai_responses',
  'anthropic-messages': 'anthropic_messages',
};

/** Roles OMP documents; any other role in the native file stays untouched. */
const knownRoles = ['default', 'smol', 'slow', 'plan'] as const;

export function OmpConfigurationEditor(props: ConfigurationContentProps) {
  if (props.mode === 'common') return <CommonConfigurationFields {...props} presentationFor={ompFieldPresentation} />;
  return <Editor key={props.draft.sessionId} {...props} />;
}

function Editor(props: ConfigurationContentProps) {
  const { t } = useTranslation();
  const { draft, descriptor } = props;
  const view = (draft.view ?? {}) as View;
  const models = useMemo(() => (view.models ?? []).map(model => ({ ...model, fields: objectFields(model.fields) })), [view.models]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set());
  const action = useEditorAction(props, 'omp-actions');
  const provider = view.providerId ?? '';
  const blocked = props.disabled || action.pending;
  const structuralBlocked = blocked || props.pending;
  const can = (operation: string) => descriptor.operations.includes(operation);
  const modelValue = (model: Model, id: string) => model.fields[id];
  const target = (model: Model) => ({ kind: 'model', provider, id: model.id });
  const key = (model: Model) => model.id;
  const choices = useMemo(() => models.map(model => `${provider}/${model.id}`), [models, provider]);
  const modelFields = useMemo(() => descriptor.fields.filter(item => !item.id.startsWith('modelRoles.') && item.id !== 'retry'), [descriptor.fields]);
  const basicFields = useMemo(() => modelFields.filter(item => !item.advanced), [modelFields]);
  const visitKey = (id: string) => `${provider}/${id}`;
  const expandModel = (id: string) => {
    const identity = visitKey(id);
    setVisited(previous => previous.has(identity) ? previous : new Set(previous).add(identity));
    setExpanded(id);
  };
  const unknownRoles = (view.roleNames ?? []).filter(role => !knownRoles.includes(role as (typeof knownRoles)[number]));
  const field = (id: string, model?: Model) => <EditorField
    key={`${draft.sessionId}:${provider}:${model ? key(model) : 'settings'}:${id}`}
    props={action.props}
    id={id}
    presentation={ompFieldPresentation(id)}
    target={model ? target(model) : { kind: 'settings' }}
    value={model ? modelValue(model, id) : view.settings?.[id]}
    defaultSource={undefined}
    choices={id.startsWith('modelRoles.') ? choices : undefined}
    disabled={blocked || (id.startsWith('modelRoles.') && !provider)}
  />;
  const modelField = (id: string, model: Model) => <EditorField
    key={`${draft.sessionId}:${provider}:${key(model)}:${id}`}
    props={action.props}
    id={id}
    presentation={ompFieldPresentation(id)}
    target={target(model)}
    value={modelValue(model, id)}
    listChoices={id === 'input' ? [['text', t('tools.adapters.shared.modality.text')], ['image', t('tools.adapters.shared.modality.image')]] : undefined}
    disabled={blocked}
  />;
  return <section onKeyDown={event => { if (props.section && expanded && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setExpanded(null); } }} className={styles.editor} aria-label={t('tools.adapters.omp.label')}>
    <div hidden={props.section === 'settings'}>
      <div hidden={Boolean(props.section && expanded)}>
        <ProviderEditor key={`provider:${draft.sessionId}:${provider}`} provider={provider} providers={view.providers ?? []} connection={view.connection}
          protocol={view.connection?.protocol ? protocols[view.connection.protocol] ?? '' : ''}
          disabled={structuralBlocked || action.invalid} canConfigure={can('configure_provider')} canSelect={can('select_provider')}
          onDraftValidityChange={valid => props.onValidityChange('connection-form', valid)}
          onConfigure={(id, value) => action.run({ kind: 'provider', provider: id }, 'configure_provider', value)}
          onSelect={id => action.run({ kind: 'provider', provider: id }, 'select_provider')} />
        <ConnectionCredential />
      </div>
      <ModelStep count={models.length} collapsed={Boolean(props.section && expanded)} defaultModel={view.defaultModel} note={<p className={sharedStyles.stepNote}>{t('tools.adapters.omp.defaultNote')}</p>} catalog={props.catalog} disabled={structuralBlocked || !provider}>
        {models.map(model => <article className={styles.model} key={`${provider}:${key(model)}`} hidden={Boolean(props.section && expanded && expanded !== key(model))} aria-label={t('tools.adapters.shared.modelAria', { id: model.id })}>
          <ModelRow id={model.id} name={typeof model.fields.name === 'string' ? model.fields.name : undefined}
            badges={[view.defaultModel === model.id ? t('common.models.defaultBadge') : '', view.smallModel === model.id ? t('tools.adapters.omp.smallBadge') : ''].filter(Boolean)}
            expanded={expanded === key(model)} sectioned={Boolean(props.section)} disabled={structuralBlocked}
            canDefault={can('default') && view.defaultModel !== model.id}
            onToggle={() => expanded === key(model) ? setExpanded(null) : expandModel(key(model))}
            onSetDefault={() => void action.run(target(model), 'default')} />
          {(expanded === key(model) || visited.has(visitKey(model.id))) && <div className={styles.fields} hidden={expanded !== key(model)}>
            {basicFields.map(item => modelField(item.id, model))}
            {modelField('input', model)}
            <details><summary>{t('tools.adapters.omp.optionalSummary')}</summary>{modelField('thinkingLevelMap', model)}{modelField('cost', model)}</details>
            <EntityActions id={model.id} target={target(model)} descriptor={descriptor} disabled={structuralBlocked}
              defaultModel={view.defaultModel === model.id} smallModel={view.smallModel === model.id}
              onRun={action.run} onRemove={() => setExpanded(null)} />
          </div>}
        </article>)}
        <div hidden={Boolean(props.section && expanded)}>{can('create') && <NewModelForm key={`new-model:${draft.sessionId}:${provider}`} props={action.props} provider={provider} disabled={structuralBlocked || !provider} label={t('tools.adapters.shared.modelId')}
          fields={modelFields}
          onQuickCreate={async id => {
            const success = await action.run({ kind: 'model', provider, id }, 'create', {});
            if (success && can('default') && !view.defaultModel) await action.run({ kind: 'model', provider, id }, 'default');
            return success;
          }}
          onCreate={async (id, values) => { const success = await action.run({ kind: 'model', provider, id }, 'create', values); if (success) expandModel(id); return success; }}
          listChoices={{ input: [['text', t('tools.adapters.shared.modality.text')], ['image', t('tools.adapters.shared.modality.image')]] }} />}</div>
      </ModelStep>
      <div className={styles.modelSpacer} data-list-spacer />
    </div>
    <div hidden={props.section === 'models'}>
      <details className={sharedStyles.disclosureCard} open={props.section === 'settings'}>
        <summary>{t('tools.adapters.omp.rolesSummary')}</summary>
        <p className={styles.note}>{t('tools.adapters.omp.roleNote')}</p>
        {knownRoles.map(role => <div className={styles.role} key={role}>{field(`modelRoles.${role}`)}</div>)}
        {unknownRoles.length > 0 && <p className={styles.note}>{t('tools.adapters.omp.unknownRoles', { roles: unknownRoles.join(' / ') })}</p>}
      </details>
      <details className={sharedStyles.disclosureCard}>
        <summary>{t('tools.adapters.omp.retrySummary')}</summary>
        <p className={styles.note}>{t('tools.adapters.omp.retryNote')}</p>
        {field('retry')}
      </details>
      {draft.scope === 'project' && <p className={styles.note}>{t('tools.adapters.omp.projectNote')}</p>}
      <p className={styles.note}>{t('tools.adapters.omp.secretNote')}</p>
    </div>
    {view.capabilityReason && <details className={sharedStyles.disclosureCard}><summary>{t('tools.adapters.shared.capabilitySummary')}</summary><p className={styles.note}>{view.capabilityReason}</p></details>}
    <AdditionalIssues props={props} />
    {action.error && <div role="alert">{action.error}<button type="button" onClick={action.cancelFailure}>{t('tools.adapters.shared.cancelOperation')}</button></div>}
  </section>;
}
