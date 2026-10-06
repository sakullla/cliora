import { claudeFieldPresentation } from './fieldPresentation';
import { CommonConfigurationFields } from '../../components/configuration/CommonConfigurationFields';
import { useEffect, useRef, useState } from 'react';
import { ConfigurationField, type FieldPresentation } from '../../components/configuration/ConfigurationField';
import sharedStyles from '../../components/configuration/configuration.module.css';
import type { ConfigurationContentProps } from '../contract';
import styles from './ConfigurationEditor.module.css';

type View = { values?: Record<string, unknown>; editTarget?: string; effortChoices?: string[]; effortWarnings?: string[]; effortOverride?: unknown; modelEffortOverride?: unknown; modelEfforts?: Record<string, unknown>; modelEffortChoices?: Record<string, string[]>; currentEffortModel?: string | null; capabilitySource?: string };
const roles = [['sonnet', 'Sonnet'], ['opus', 'Opus'], ['fable', 'Fable'], ['haiku', 'Haiku'], ['subagent', '子代理']] as const;
function Editor({ draft, descriptor, disabled, onAction, onValidityChange, section, rawResetEpoch, catalog }: ConfigurationContentProps) {
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
      ...(id.endsWith('.name') && typeof roleModel === 'string' && roleModel.trim() ? { placeholder: `与模型相同 · ${roleModel}` } : {}),
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
      if (token === request.current) { setUnifying(false); setUnifyError(error instanceof Error ? error.message : '统一失败，请重试'); }
    }
  };
  return <section className={styles.editor} aria-label="Claude 专属配置">
    <div hidden={section === 'settings'}>{render('default.model')}
    <details className={sharedStyles.disclosureCard} open={draft.credential?.source === 'api_key' && !draft.draftConnection?.baseUrl}><summary>供应商连接</summary>{render('base_url')}</details>
    </div>
    <div hidden={section === 'models'}><details className={sharedStyles.disclosureCard} open={section === 'settings'}><summary>角色、子代理与长上下文</summary><div className={styles.fields}>
      <div className={styles.unifyRow}><button type="button" className={sharedStyles.accent} disabled={disabled || unifying || !values['default.model']} onClick={() => { void unify(); }}>{unifying ? '统一中…' : '将默认模型用于全部角色'}</button>{unifyError && <p role="alert">{unifyError}</p>}<p className={styles.note}>统一保留各角色显示名称；长上下文使用原生 [1m] 后缀，服务是否可用取决于模型与账号。</p></div>
      {render('default.longContext')}
      <div className={styles.roleGrid}>{roles.map(([role, label]) => <fieldset className={styles.roleCard} key={role}><legend>{label}</legend>{render(`${role}.model`)}{render(`${role}.name`)}{render(`${role}.longContext`)}</fieldset>)}</div>
    </div></details>
    <details className={sharedStyles.disclosureCard}><summary>推理参数</summary><p className={styles.note}>{view?.capabilitySource}</p>{render('effortLevel')}
      {view?.effortWarnings?.map(message => <p key={message} className={styles.note}>{message}</p>)}
      <div className={styles.fields}>
        <label>模型 effort 的 canonical ID<input aria-label="模型 effort 的 canonical ID" value={effortModel} list="claude-existing-effort-models" disabled={disabled || unifying} onChange={event => setEffortModel(event.target.value)} /></label>
        <datalist id="claude-existing-effort-models">{Object.keys(view?.modelEfforts ?? {}).map(id => <option key={id} value={id} />)}</datalist>
        <p className={styles.note}>此模型设置优先于默认 effort。选用已确认的原生 canonical ID；恢复默认将取消本层模型 effort 覆盖，并保留该模型的其他设置。</p>
        {render('modelEffortLevel')}
      </div>
      {view?.effortOverride != null && <p className={styles.note}>原生环境变量 CLAUDE_CODE_EFFORT_LEVEL 当前优先于 effortLevel（{String(view.effortOverride)}）；可在原文中调整。</p>}
      {view?.modelEffortOverride != null && <p className={styles.note}>当前模型已有 modelSettings effort（{String(view.modelEffortOverride)}），优先于默认推理 effort；可在原文中调整。</p>}
    </details>
    </div>
  </section>;
}

export function ClaudeConfigurationEditor(props: ConfigurationContentProps) {
  if (props.mode === 'common') return <CommonConfigurationFields {...props} presentationFor={claudeFieldPresentation} />;
  return <Editor key={props.draft.sessionId} {...props} />;
}
