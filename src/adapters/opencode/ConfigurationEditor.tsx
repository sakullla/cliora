import { useState } from 'react';
import { AdditionalIssues, objectFields, EntityActions, EditorField, ProviderEditor, NewModelForm, useEditorAction, fieldValue } from '../../components/configuration/ModelEditorControls';
import type { ConfigurationEditorProps } from '../../types/configuration';
import styles from './ConfigurationEditor.module.css';

type Model = { id: string; kind: string; fields: Record<string, unknown> };
type View = { providerId?: string | null; providers?: string[]; models?: Model[]; defaultModel?: string | null; smallModel?: string | null; connection?: { baseUrl?: string; protocol?: string }; capabilityReason?: string };
const protocols = { '@ai-sdk/openai-compatible': 'openai_completions', '@ai-sdk/openai': 'openai_responses', '@ai-sdk/anthropic': 'anthropic_messages' };

export function OpenCodeConfigurationEditor(props: ConfigurationEditorProps) {
  return <Editor key={props.draft.sessionId} {...props} />;
}
function Editor(props: ConfigurationEditorProps) {
  const { draft, descriptor } = props;
  const view = (draft.view ?? {}) as View;
  const models = (view.models ?? []).map(model => ({ ...model, fields: objectFields(model.fields) }));
  const [expanded, setExpanded] = useState<string | null>(null);
  const action = useEditorAction(props, 'opencode-actions');
  const provider = view.providerId ?? '';
  const blocked = props.disabled || action.pending;
  const can = (operation: string) => descriptor.operations.includes(operation);
  const target = (id: string) => ({ kind: 'model', provider, id });
  const field = (id: string, model: Model) => <EditorField key={`${draft.sessionId}:${provider}:${model.id}:${id}`} props={action.props} id={id} target={target(model.id)} value={fieldValue(model.fields, id)} disabled={blocked}
    listChoices={id.startsWith('modalities.') ? [['text', '文本'], ['image', '图片'], ['audio', '音频'], ['video', '视频'], ['pdf', 'PDF']] : undefined} />;
  return <section className={styles.editor} aria-label="OpenCode 专属配置">
    <ProviderEditor key={`provider:${draft.sessionId}:${provider}`} provider={provider} providers={view.providers ?? []} connection={view.connection}
      protocol={view.connection?.protocol ? protocols[view.connection.protocol as keyof typeof protocols] ?? '' : ''}
      disabled={blocked || action.invalid} canConfigure={can('configure_provider')} canSelect={can('select_provider')}
      onConfigure={(id, value) => action.run({ kind: 'provider', provider: id }, 'configure_provider', value)}
      onSelect={id => action.run({ kind: 'provider', provider: id }, 'select_provider')} />
    <p className={styles.note}>默认与轻量模型分别设置。恢复默认会取消本层覆盖，采用继承配置或 OpenCode 原生默认。</p>
    {models.map(model => <article className={styles.model} key={`${provider}:${model.id}`} aria-label={`模型 ${model.id}`}>
      <button type="button" className={styles.modelHeading} aria-expanded={expanded === model.id} onClick={() => setExpanded(expanded === model.id ? null : model.id)}>
        {typeof model.fields.name === 'string' ? model.fields.name : model.id} · {model.id}{view.defaultModel === model.id ? ' · 默认' : ''}{view.smallModel === model.id ? ' · 轻量' : ''}
      </button>
      {<div className={styles.fields} hidden={expanded !== model.id}>
        {descriptor.fields.filter(item => !item.advanced).map(item => field(item.id, model))}
        {field('modalities.input', model)}{field('modalities.output', model)}
        <details><summary>模型选项与推理变体</summary>{field('options', model)}{field('variants', model)}</details>
        <EntityActions id={model.id} target={target(model.id)} descriptor={descriptor} disabled={blocked} defaultModel={view.defaultModel === model.id} smallModel={view.smallModel === model.id} onRun={action.run} onRemove={() => setExpanded(null)} />
      </div>}
    </article>)}
    {can('create') && <NewModelForm key={`new-model:${draft.sessionId}:${provider}`} props={action.props} provider={provider} disabled={blocked || !provider} label="模型 ID" fields={descriptor.fields} listChoices={{ 'modalities.input': [['text', '文本'], ['image', '图片'], ['audio', '音频'], ['video', '视频'], ['pdf', 'PDF']], 'modalities.output': [['text', '文本'], ['image', '图片'], ['audio', '音频'], ['video', '视频'], ['pdf', 'PDF']] }}
      onCreate={async (id, values) => { const success = await action.run(target(id), 'create', values); if (success) setExpanded(id); return success; }} />}
    <details><summary>默认模型设置</summary>
      <button type="button" disabled={blocked || !can('reset')} onClick={() => { void action.run({ kind: 'settings' }, 'reset', null, 'model'); }}>恢复默认模型</button>
      <button type="button" disabled={blocked || !can('reset')} onClick={() => { void action.run({ kind: 'settings' }, 'reset', null, 'small_model'); }}>恢复轻量模型</button>
    </details>
    {view.capabilityReason && <p className={styles.note}>{view.capabilityReason}</p>}
    <AdditionalIssues props={props} />
    {action.error && <div role="alert">{action.error}<button type="button" onClick={action.cancelFailure}>取消本次操作</button></div>}
  </section>;
}
