import { piFieldPresentation } from './fieldPresentation';
import { CommonConfigurationFields } from '../../components/configuration/CommonConfigurationFields';
import { useState } from 'react';
import { AdditionalIssues, objectFields, EntityActions, EditorField, ProviderEditor, NewModelForm, useEditorAction } from '../../components/configuration/ModelEditorControls';
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
  const { draft, descriptor } = props;
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
    id={id} presentation={piFieldPresentation(id)} target={model ? target(model) : { kind: 'settings' }} value={model ? model.fields[id] : view.settings?.[id]} defaultSource={model?.kind === 'override' ? '跟随内置模型' : undefined}
    listChoices={id === 'input' ? [['text', '文本'], ['image', '图片']] : undefined} disabled={blocked || (id === 'defaultProvider' && action.hasInvalidExcept({ kind: 'settings' }, id))} />;
  return <section onKeyDown={event => { if (props.section && expanded && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setExpanded(null); } }} className={styles.editor} aria-label="Pi 专属配置">
    <div hidden={props.section === 'settings'}>
    <div hidden={Boolean(props.section && expanded)}><ProviderEditor key={`provider:${draft.sessionId}:${provider}`} provider={provider} providers={view.providers ?? []} connection={view.connection}
      protocol={view.connection?.protocol ? protocols[view.connection.protocol as keyof typeof protocols] ?? '' : ''}
      disabled={structuralBlocked || action.invalid} canConfigure={can('configure_provider')} canSelect={can('select_provider')}
      onDraftValidityChange={valid => props.onValidityChange('connection-form', valid)}
      onConfigure={(id, value) => action.run({ kind: 'provider', provider: id }, 'configure_provider', value)}
      onSelect={id => action.run({ kind: 'provider', provider: id }, 'select_provider')} />
    <p className={styles.note}>默认模型用于启动设置。恢复默认会取消本层覆盖，采用继承配置或 Pi 原生默认。</p>
    </div>
    {models.map(model => <article className={styles.model} key={`${provider}:${key(model)}`} hidden={Boolean(props.section && expanded && expanded !== key(model))} aria-label={`模型 ${model.id}`}>
      <button type="button" className={styles.modelHeading} disabled={structuralBlocked} aria-expanded={expanded === key(model)} onClick={() => setExpanded(expanded === key(model) ? null : key(model))}>
        {props.section && expanded === key(model) && '返回模型列表 · '}{typeof model.fields.name === 'string' ? model.fields.name : model.id} · {model.id}{model.kind === 'override' ? ' · 内置覆盖' : ''}{view.defaultModel === model.id ? ' · 启动默认' : ''}
      </button>
      {<div className={styles.fields} hidden={expanded !== key(model)}>
        {descriptor.fields.filter(item => !item.advanced && !item.id.startsWith('default')).map(item => field(item.id, model))}
        {field('input', model)}
        <details><summary>可选模型参数</summary>{field('thinkingLevelMap', model)}</details>
        <EntityActions id={model.id} target={target(model)} descriptor={descriptor} disabled={structuralBlocked} defaultModel={view.defaultModel === model.id} onRun={action.run} onRemove={() => setExpanded(null)} />
      </div>}
    </article>)}
    <div hidden={Boolean(props.section && expanded)}>{can('create') && <NewModelForm key={`new-model:${draft.sessionId}:${provider}`} props={action.props} provider={provider} disabled={structuralBlocked || !provider} label="模型 ID" fields={descriptor.fields.filter(item => !item.id.startsWith('default'))}
      onCreate={async (id, values, kind) => { const success = await action.run({ kind, provider, id }, kind === 'override' ? 'create_override' : 'create', values); if (success) setExpanded(`${kind}:${id}`); return success; }} allowOverride={can('create_override')} listChoices={{ input: [['text', '文本'], ['image', '图片']] }} />}
    </div></div>
    <div hidden={props.section === 'models'}><details open={props.section === 'settings'}><summary>启动思考与默认设置</summary>{field('defaultProvider')}{field('defaultModel')}{field('defaultThinkingLevel')}
      {!descriptor.fields.some(item => item.id === 'defaultModel') && <button type="button" disabled={blocked || !can('reset')} onClick={() => { void action.run({ kind: 'settings' }, 'reset', null, 'defaultModel'); }}>恢复默认模型</button>}
      {!descriptor.fields.some(item => item.id === 'defaultProvider') && <button type="button" disabled={blocked || !can('reset')} onClick={() => { void action.run({ kind: 'settings' }, 'reset', null, 'defaultProvider'); }}>恢复默认供应商</button>}
      {draft.scope === 'project' && <p className={styles.note}>项目层只支持启动设置；模型标识使用原生已有模型。</p>}
    </details>
    </div>
    {view.capabilityReason && <details><summary>模型能力说明</summary><p className={styles.note}>{view.capabilityReason}</p></details>}
    <AdditionalIssues props={props} />
    {action.error && <div role="alert">{action.error}<button type="button" onClick={action.cancelFailure}>取消本次操作</button></div>}
  </section>;
}
