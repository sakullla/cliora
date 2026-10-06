import { kimiFieldPresentation } from './fieldPresentation';
import { CommonConfigurationFields } from '../../components/configuration/CommonConfigurationFields';
import { useState } from 'react';
import { AdditionalIssues, objectFields, EntityActions, EditorField, ModelRow, ProviderEditor, NewModelForm, useEditorAction } from '../../components/configuration/ModelEditorControls';
import sharedStyles from '../../components/configuration/configuration.module.css';
import type { ConfigurationContentProps } from '../contract';
import styles from './ConfigurationEditor.module.css';

type Model = { id: string; fields: Record<string, unknown> };
type View = { providerId?: string | null; providers?: string[]; models?: Model[]; defaultModel?: string | null; settings?: Record<string, unknown>; connection?: { baseUrl?: string; protocol?: string; readOnlyReason?: string }; capabilityReason?: string };
const protocols = { openai: 'openai_completions', openai_responses: 'openai_responses', anthropic: 'anthropic_messages' };
const capabilityChoices = [
  ['image_in', '图片'], ['thinking', '思考'], ['video_in', '视频'], ['audio_in', '音频'],
  ['always_thinking', '始终思考'], ['tool_use', '工具调用'], ['dynamically_loaded_tools', '动态加载工具'],
] as const;

export function KimiConfigurationEditor(props: ConfigurationContentProps) {
  if (props.mode === 'common') return <CommonConfigurationFields {...props} presentationFor={kimiFieldPresentation} />;
  return <Editor key={props.draft.sessionId} {...props} />;
}
function Editor(props: ConfigurationContentProps) {
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
    listChoices={id === 'capabilities' ? capabilityChoices : undefined}
    choices={id === 'provider' ? [...new Set([provider, ...(view.providers ?? [])])].filter(Boolean) : id === 'default_effort' && Array.isArray(model?.fields.support_efforts) && model.fields.support_efforts.every(value => typeof value === 'string') ? model.fields.support_efforts as string[] : undefined} />;
  const modelFields = descriptor.fields.filter(item => !item.id.startsWith('thinking.')).sort((a, b) => (a.id === 'max_context_size' ? -1 : b.id === 'max_context_size' ? 1 : 0)).map(item => item.id === 'capabilities' ? { ...item, advanced: false } : item.id === 'provider' ? { ...item, choices: [...new Set([provider, ...(view.providers ?? [])])].filter(Boolean) } : item);
  return <section onKeyDown={event => { if (props.section && expanded && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setExpanded(null); } }} className={styles.editor} aria-label="Kimi 专属配置">
    <div hidden={props.section === 'settings'}>
    <div hidden={Boolean(props.section && expanded)}><ProviderEditor key={`provider:${draft.sessionId}:${provider}`} provider={provider} providers={view.providers ?? []} connection={view.connection}
      protocol={view.connection?.protocol ? protocols[view.connection.protocol as keyof typeof protocols] ?? '' : ''}
      disabled={structuralBlocked || action.invalid} canConfigure={can('configure_provider')} canSelect={can('select_provider')}
      onDraftValidityChange={valid => props.onValidityChange('connection-form', valid)}
      onConfigure={(id, value) => action.run({ kind: 'provider', provider: id }, 'configure_provider', value)}
      onSelect={id => action.run({ kind: 'provider', provider: id }, 'select_provider')} />
    <details className={sharedStyles.disclosureCard}><summary>模型说明</summary><p className={styles.note}>alias 是配置内的模型名称，请求模型 ID 单独填写。上下文上限必填；恢复默认仅取消本层覆盖，必填项仍需有效继承值。</p>
    <p className={styles.note}>文本是 Kimi 的原生默认能力，无需声明；图片、思考等能力按模型实际支持情况选择。已有未知原生能力会保留。</p>
    </details></div>
    {models.map(model => <article className={styles.model} key={`${provider}:${model.id}`} hidden={Boolean(props.section && expanded && expanded !== model.id)} aria-label={`模型 ${model.id}`}>
      <ModelRow id={model.id} name={typeof model.fields.display_name === 'string' ? model.fields.display_name : undefined}
        sub={typeof model.fields.model === 'string' && model.fields.model !== model.id ? [`请求 ${model.fields.model}`] : []}
        badges={view.defaultModel === model.id ? ['默认'] : []}
        expanded={expanded === model.id} sectioned={Boolean(props.section)} disabled={structuralBlocked}
        canDefault={can('default') && view.defaultModel !== model.id}
        onToggle={() => setExpanded(expanded === model.id ? null : model.id)}
        onSetDefault={() => void action.run(target(model), 'default')} />
      {<div className={styles.fields} hidden={expanded !== model.id}>
        {modelFields.filter(item => !item.advanced).map(item => field(item.id, model))}
        <details><summary>能力、思考与可选上限</summary>{modelFields.filter(item => item.advanced).map(item => field(item.id, model))}</details>
        <EntityActions id={model.id} target={target(model)} descriptor={descriptor} disabled={structuralBlocked} defaultModel={view.defaultModel === model.id} renameLabel="新 alias" onRun={action.run} onRemove={() => setExpanded(null)} />
      </div>}
    </article>)}
    <div hidden={Boolean(props.section && expanded)}>{can('create') && <NewModelForm key={`new-model:${draft.sessionId}:${provider}`} props={action.props} provider={provider} disabled={structuralBlocked || !provider} label="模型 alias" fields={modelFields}
      listChoices={{ capabilities: capabilityChoices }}
      initialValues={{ provider }} onCreate={async (id, values) => { const success = await action.run({ kind: 'model', provider, id }, 'create', values); if (success) setExpanded(id); return success; }} />}
    </div>
    <div className={styles.modelSpacer} data-list-spacer /></div>
    <div hidden={props.section === 'models'}><details className={sharedStyles.disclosureCard} open={props.section === 'settings'}><summary>默认思考设置</summary>{descriptor.fields.filter(item => item.id.startsWith('thinking.')).map(item => field(item.id))}</details>
    </div>
    {view.capabilityReason && <details className={sharedStyles.disclosureCard}><summary>模型能力说明</summary><p className={styles.note}>{view.capabilityReason}</p></details>}
    {!descriptor.operations.length && <p role="status">Kimi 用户模型配置不支持项目范围。</p>}
    <AdditionalIssues props={props} />
    {action.error && <div role="alert">{action.error}<button type="button" onClick={action.cancelFailure}>取消本次操作</button></div>}
  </section>;
}
