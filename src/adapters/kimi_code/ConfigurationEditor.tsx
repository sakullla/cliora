import { useState } from 'react';
import { AdditionalIssues, objectFields, EntityActions, EditorField, ProviderEditor, NewModelForm, useEditorAction } from '../../components/configuration/ModelEditorControls';
import type { ConfigurationEditorProps } from '../../types/configuration';
import styles from './ConfigurationEditor.module.css';

type Model = { id: string; fields: Record<string, unknown> };
type View = { providerId?: string | null; providers?: string[]; models?: Model[]; defaultModel?: string | null; settings?: Record<string, unknown>; connection?: { baseUrl?: string; protocol?: string; readOnlyReason?: string }; capabilityReason?: string };
const protocols = { openai: 'openai_completions', openai_responses: 'openai_responses', anthropic: 'anthropic_messages' };

export function KimiConfigurationEditor(props: ConfigurationEditorProps) {
  return <Editor key={props.draft.sessionId} {...props} />;
}
function Editor(props: ConfigurationEditorProps) {
  const { draft, descriptor } = props;
  const view = (draft.view ?? {}) as View;
  const models = (view.models ?? []).map(model => ({ ...model, fields: objectFields(model.fields) }));
  const [expanded, setExpanded] = useState<string | null>(null);
  const action = useEditorAction(props, 'kimi-actions');
  const provider = view.providerId ?? '';
  const blocked = props.disabled || action.pending;
  const can = (operation: string) => descriptor.operations.includes(operation);
  const target = (model: Model) => ({ kind: 'model', provider: String(model.fields.provider ?? provider), id: model.id });
  const field = (id: string, model?: Model) => <EditorField key={`${draft.sessionId}:${provider}:${model?.id ?? 'settings'}:${id}`} props={action.props}
    id={id} target={model ? target(model) : { kind: 'settings' }} value={model ? model.fields[id] : view.settings?.[id.slice('thinking.'.length)]} disabled={blocked || (id === 'provider' && Boolean(model) && action.hasInvalidExcept(target(model!), id))}
    choices={id === 'default_effort' && Array.isArray(model?.fields.support_efforts) && model.fields.support_efforts.every(value => typeof value === 'string') ? model.fields.support_efforts as string[] : undefined} />;
  const modelFields = descriptor.fields.filter(item => !item.id.startsWith('thinking.'));
  return <section className={styles.editor} aria-label="Kimi 专属配置">
    <ProviderEditor key={`${draft.sessionId}:${provider}`} provider={provider} providers={view.providers ?? []} connection={view.connection}
      protocol={view.connection?.protocol ? protocols[view.connection.protocol as keyof typeof protocols] ?? '' : ''}
      disabled={blocked || action.invalid} canConfigure={can('configure_provider')} canSelect={can('select_provider')}
      onConfigure={(id, value) => action.run({ kind: 'provider', provider: id }, 'configure_provider', value)}
      onSelect={id => action.run({ kind: 'provider', provider: id }, 'select_provider')} />
    <p className={styles.note}>alias 是配置内的模型名称，请求模型 ID 单独填写。上下文上限必填；恢复默认仅取消本层覆盖，必填项仍需有效继承值。</p>
    {models.map(model => <article className={styles.model} key={`${provider}:${model.id}`} aria-label={`模型 ${model.id}`}>
      <button type="button" className={styles.modelHeading} aria-expanded={expanded === model.id} onClick={() => setExpanded(expanded === model.id ? null : model.id)}>
        {typeof model.fields.display_name === 'string' ? model.fields.display_name : model.id} · {model.id}{view.defaultModel === model.id ? ' · 默认' : ''}
      </button>
      {<div className={styles.fields} hidden={expanded !== model.id}>
        {modelFields.filter(item => !item.advanced).map(item => field(item.id, model))}
        <details><summary>能力、思考与可选上限</summary>{modelFields.filter(item => item.advanced).map(item => field(item.id, model))}</details>
        <EntityActions id={model.id} target={target(model)} descriptor={descriptor} disabled={blocked} defaultModel={view.defaultModel === model.id} renameLabel="新 alias" onRun={action.run} onRemove={() => setExpanded(null)} />
      </div>}
    </article>)}
    {can('create') && <NewModelForm key={`${draft.sessionId}:${provider}`} props={action.props} provider={provider} disabled={blocked || !provider} label="模型 alias" fields={modelFields}
      initialValues={{ provider }} onCreate={async (id, values) => { const success = await action.run({ kind: 'model', provider, id }, 'create', values); if (success) setExpanded(id); return success; }} />}
    <details><summary>默认思考设置</summary>{descriptor.fields.filter(item => item.id.startsWith('thinking.')).map(item => field(item.id))}</details>
    {view.capabilityReason && <details><summary>模型能力说明</summary><p className={styles.note}>{view.capabilityReason}</p></details>}
    {!descriptor.operations.length && <p role="status">Kimi 用户模型配置不支持项目范围。</p>}
    <AdditionalIssues props={props} />
    {action.error && <div role="alert">{action.error}<button type="button" onClick={action.cancelFailure}>取消本次操作</button></div>}
  </section>;
}
