import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ConfigurationField, type FieldPresentation } from './ConfigurationField';
import styles from './configuration.module.css';
import type { ConfigurationContentProps } from '../../adapters/contract';
import type { ConfigurationAction, ConfigurationDescriptor, ConfigurationEditorProps, ConfigurationField as Field } from '../../types/configuration';

type Run = (target: unknown, operation: string, value?: unknown, field?: string | null) => Promise<boolean>;
type ListChoices = Record<string, readonly (readonly [string, string])[]>;
type Connection = { baseUrl?: string; protocol?: string; readOnlyReason?: string };
const targetIdentity = (target: unknown) => target && typeof target === 'object' ? JSON.stringify(target, Object.keys(target).sort()) : JSON.stringify(target);
const validIdentity = (id: string, maximum = 200) => Boolean(id.trim()) && id.length <= maximum && !/[\u0000-\u001f\u007f]/.test(id);
export function objectFields(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function AdditionalIssues({ props }: { props: ConfigurationEditorProps }) {
  return <>{props.draft.issues.filter(issue => !props.descriptor.fields.some(field => field.id === issue.field)).map((issue, index) => <p role="alert" className={styles.message} key={`${issue.code}:${index}`}>{issue.message}</p>)}</>;
}
export function fieldValue(values: Record<string, unknown>, id: string): unknown {
  return id.split('.').reduce<unknown>((value, part) => value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined, values);
}
function withField(values: Record<string, unknown>, id: string, value: unknown): Record<string, unknown> {
  const next = structuredClone(values);
  const parts = id.split('.');
  let object = next;
  for (const part of parts.slice(0, -1)) {
    const current = object[part];
    if (!current || typeof current !== 'object' || Array.isArray(current)) object[part] = {};
    object = object[part] as Record<string, unknown>;
  }
  if (value == null || value === '') delete object[parts[parts.length - 1]];
  else object[parts[parts.length - 1]] = value;
  return next;
}

/** Entity operations and fields share the session's submit guard. */
export function useEditorAction(props: ConfigurationContentProps, name: string) {
  const latest = useRef(props);
  latest.current = props;
  const generation = useRef(0);
  const invalidFields = useRef(new Set<string>());
  const [invalid, setInvalid] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((field: string, valid: boolean) => {
    if (valid) invalidFields.current.delete(field); else invalidFields.current.add(field);
    setInvalid(invalidFields.current.size > 0);
    latest.current.onValidityChange(field, valid);
  }, []);
  useEffect(() => {
    generation.current += 1;
    return () => {
      generation.current += 1;
      for (const field of invalidFields.current) latest.current.onValidityChange(field, true);
      invalidFields.current.clear();
    };
  }, [props.draft.sessionId]);
  const run: Run = async (target, operation, value = null, field = null) => {
    const token = ++generation.current;
    const sessionId = latest.current.draft.sessionId;
    setPending(true); setError(null); report(name, false);
    try {
      await latest.current.onAction({ version: latest.current.descriptor.version, target, operation, field, value } satisfies ConfigurationAction);
      if (generation.current !== token || latest.current.draft.sessionId !== sessionId) return false;
      setPending(false); report(name, true); return true;
    } catch (failure) {
      if (generation.current !== token || latest.current.draft.sessionId !== sessionId) return false;
      setPending(false); setError(failure instanceof Error ? failure.message : '修改失败，请重试');
      return false;
    }
  };
  const cancelFailure = () => { setError(null); report(name, true); };
  const hasInvalidExcept = (target: unknown, field: string) => {
    const key = `${props.draft.sessionId}:${targetIdentity(target)}:${field}`;
    return [...invalidFields.current].some(candidate => candidate !== key);
  };
  return { run, pending, error, invalid, cancelFailure, hasInvalidExcept, props: { ...props, onValidityChange: report } };
}

export function EditorField({ props, id, target, value, disabled, defaultSource, listChoices, choices, presentation }: { props: ConfigurationContentProps; id: string; target: unknown; value: unknown; disabled?: boolean; defaultSource?: string; choices?: string[]; presentation?: FieldPresentation; listChoices?: readonly (readonly [string, string])[] }) {
  const field = props.descriptor.fields.find(item => item.id === id);
  const targetKey = targetIdentity(target);
  const validityKey = `${props.draft.sessionId}:${targetKey}:${id}`;
  const touched = useRef(false);
  const latest = useRef(props.onValidityChange);
  latest.current = props.onValidityChange;
  useEffect(() => {
    if (field?.required && !field.unavailableReason && !touched.current) latest.current(validityKey, value != null && String(value).trim() !== '' && (!['number', 'integer'].includes(field.kind) || (typeof value === 'number' && value > 0 && (field.kind !== 'integer' || Number.isInteger(value)))));
  }, [validityKey, value, field]);
  useEffect(() => () => latest.current(validityKey, true), [validityKey]);
  if (!field) return null;
  const action = (operation: string, next: unknown = null) => props.onAction({ version: props.descriptor.version, target, operation, field: id, value: next });
  if (listChoices && (value == null || (Array.isArray(value) && value.every(item => typeof item === 'string')))) return <StringListControl field={field} values={value as string[] | null} choices={listChoices} disabled={disabled}
    issues={props.draft.issues.filter(issue => issue.field === id && targetIdentity(issue.target) === targetKey).map(issue => issue.message)}
    onChange={next => action('set', next)} onReset={() => action('reset')} onValidityChange={valid => props.onValidityChange(validityKey, valid)} />;
  const metadata = field.kind === 'string_list' ? { ...field, kind: 'json', choices: [] } : field;
  const explicit = props.draft.profile.editing?.intents.some(action => action.operation === 'set' && action.field === id && targetIdentity(action.target) === targetKey);
  return <ConfigurationField presentation={{ ...presentation, origin: explicit ? 'explicit' : field?.origin ?? presentation?.origin }} resetEpoch={props.rawResetEpoch} field={{ ...metadata, ...(defaultSource ? { defaultSource } : {}), ...(choices ? { choices } : {}) }} value={value} disabled={disabled}
    issues={props.draft.issues.filter(issue => issue.field === id && targetIdentity(issue.target) === targetKey)}
    onChange={next => next === '' && !field.required ? action('reset') : action('set', next)}
    onReset={props.descriptor.operations.includes('reset') ? () => action('reset') : undefined}
    onValidityChange={valid => { touched.current = true; props.onValidityChange(validityKey, valid); }} />;
}

function StringListControl({ field, values, choices, disabled, issues, onChange, onReset, onValidityChange }: {
  field: Field; values?: string[] | null; choices: readonly (readonly [string, string])[]; disabled?: boolean; issues: string[];
  onChange: (value: string[]) => Promise<void>; onReset: () => Promise<void>; onValidityChange: (valid: boolean) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const entries = [...choices, ...(values ?? []).filter(value => !choices.some(([id]) => id === value)).map(value => [value, `${value}（原生值）`] as const)];
  const commit = async (operation: () => Promise<void>) => {
    setPending(true); setError(null); onValidityChange(false);
    try { await operation(); if (active.current) { setPending(false); onValidityChange(true); } }
    catch (failure) { if (active.current) { setPending(false); setError(failure instanceof Error ? failure.message : '修改失败，请重试'); } }
  };
  return <fieldset className={`${styles.controls} ${styles.group}`}><legend>{field.label}</legend>{entries.map(([id, label]) => <label key={id}><input type="checkbox" checked={(values ?? []).includes(id)} disabled={disabled || pending || Boolean(field.unavailableReason)}
    onChange={event => { const next = event.target.checked ? [...(values ?? []), id] : (values ?? []).filter(value => value !== id); void commit(() => onChange(next)); }} />{label}</label>)}
    <button type="button" className={styles.restore} disabled={disabled || pending || Boolean(field.unavailableReason)} onClick={() => { void commit(onReset); }}>恢复默认</button>
    {values == null && <p>{field.defaultSource ?? '跟随原生默认'}</p>}
    {error && <p role="alert">{error}</p>}{issues.map(message => <p role="alert" key={message}>{message}</p>)}{field.unavailableReason && <p>{field.unavailableReason}</p>}
  </fieldset>;
}

export function ModelRow({ id, name, sub = [], badges = [], expanded, sectioned, disabled, canDefault, onToggle, onSetDefault }: {
  id: string; name?: string; sub?: string[]; badges?: string[]; expanded: boolean; sectioned?: boolean; disabled?: boolean;
  canDefault?: boolean; onToggle: () => void; onSetDefault?: () => void;
}) {
  const display = name && name !== id ? name : id;
  const subtitle = [...(name && name !== id ? [id] : []), ...sub];
  const label = [display, ...subtitle, ...badges].join(' · ');
  const chips = badges.map(badge => <span key={badge} className={styles.modelBadge} {...(badge === '默认' ? { 'data-default-badge': true } : {})}>{badge}</span>);
  if (sectioned && expanded) return <div className={styles.modelBack}>
    <button type="button" className={styles.modelBackButton} aria-label={`返回模型列表 · ${label}`} disabled={disabled} onClick={onToggle}><span aria-hidden="true">‹</span>返回模型列表</button>
    <span className={styles.modelBackTitle}><span className={styles.modelRowName}>{display}</span>{chips}</span>
  </div>;
  return <div className={styles.modelRowHead}>
    <button type="button" className={styles.modelRowButton} disabled={disabled} aria-expanded={expanded} aria-label={label} onClick={onToggle}>
      <span className={styles.modelRowText}>
        <span className={styles.modelRowName}>{display}</span>
        {subtitle.length > 0 && <span className={styles.modelRowSub}>{subtitle.join(' · ')}</span>}
      </span>
      {chips}
      <span className={styles.modelRowChevron} aria-hidden="true">›</span>
    </button>
    {canDefault && <button type="button" className={styles.modelRowDefault} disabled={disabled} onClick={onSetDefault}>设为默认</button>}
  </div>;
}

export function ProviderEditor({ provider, providers, connection, protocol, disabled, canConfigure, canSelect, onConfigure, onSelect, onDraftValidityChange }: {
  provider: string; providers: string[]; connection?: Connection; protocol: string; disabled?: boolean; canConfigure: boolean; canSelect: boolean;
  onConfigure: (id: string, value: { baseUrl: string; interfaceFormat: string }) => Promise<boolean>; onSelect: (id: string) => Promise<boolean>;
  onDraftValidityChange?: (valid: boolean) => void;
}) {
  const selectId = useId();
  const [id, setId] = useState(provider);
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? '');
  const [format, setFormat] = useState(protocol);
  const readOnly = id === provider && Boolean(connection?.readOnlyReason);
  const validity = useRef(onDraftValidityChange); validity.current = onDraftValidityChange;
  useEffect(() => { validity.current?.(!canConfigure || id === provider && baseUrl === (connection?.baseUrl ?? '') && format === protocol); }, [id, provider, baseUrl, connection?.baseUrl, format, protocol, canConfigure]);
  useEffect(() => () => validity.current?.(true), []);
  return <div className={`${styles.controls} ${styles.providerCard}`}>
    <strong className={styles.connectionTitle}>供应商连接{provider ? ` · ${provider}` : ''}{connection?.baseUrl ? ` · ${connection.baseUrl}` : ''}</strong>
    {canSelect && providers.length > 0 && <label htmlFor={selectId}>查看供应商<select id={selectId} value={provider} disabled={disabled} onChange={event => { void onSelect(event.target.value); }}><option value="" disabled>请选择供应商</option>{providers.map(item => <option key={item} value={item}>{item}</option>)}</select></label>}
    {canConfigure ? <div className={styles.fields}>
      <label>供应商标识<input value={id} maxLength={80} disabled={disabled} onChange={event => setId(event.target.value)} /></label>
      <label>连接地址<input value={baseUrl} disabled={disabled || readOnly} placeholder="https://…" onChange={event => setBaseUrl(event.target.value)} /></label>
      <label>接口协议<select value={format} disabled={disabled || readOnly} onChange={event => setFormat(event.target.value)}><option value="" disabled>{connection?.protocol ? `原生协议：${connection.protocol}` : '请选择协议'}</option><option value="openai_completions">OpenAI Chat Completions</option><option value="openai_responses">OpenAI Responses</option><option value="anthropic_messages">Anthropic Messages</option></select></label>
      <div className={styles.buttons}><button type="button" className={styles.accent} disabled={disabled || readOnly || !validIdentity(id, 80) || !baseUrl.trim() || !format} onClick={() => { void onConfigure(id, { baseUrl: baseUrl.trim(), interfaceFormat: format }); }}>设置供应商连接</button>
      <button type="button" disabled={disabled} onClick={() => { setId(provider); setBaseUrl(connection?.baseUrl ?? ''); setFormat(protocol); }}>取消连接修改</button></div>
      {connection?.readOnlyReason && <p>{connection.readOnlyReason}。使用不同供应商标识可创建独立连接。</p>}
    </div> : <p>{provider || '当前范围不支持供应商连接编辑'}</p>}
  </div>;
}

export function EntityActions({ id, target, descriptor, disabled, defaultModel, smallModel, renameLabel = '新模型 ID', onRun, onRemove }: {
  id: string; target: unknown; descriptor: ConfigurationDescriptor; disabled?: boolean; defaultModel?: boolean; smallModel?: boolean; renameLabel?: string; onRun: Run; onRemove: () => void;
}) {
  const [nextId, setNextId] = useState('');
  const can = (operation: string) => descriptor.operations.includes(operation);
  const identityValid = validIdentity(nextId) && nextId !== id;
  return <div className={styles.controls}>
    <div className={styles.entityPrimary}>
      {can('default') && <button type="button" className={styles.accent} disabled={disabled || defaultModel} onClick={() => { void onRun(target, 'default'); }}>{defaultModel ? '当前默认模型' : '设为默认模型'}</button>}
      {can('small_default') && <button type="button" className={styles.accent} disabled={disabled || smallModel} onClick={() => { void onRun(target, 'small_default'); }}>{smallModel ? '当前轻量模型' : '设为轻量模型'}</button>}
    </div>
    <details className={styles.entityMore}>
      <summary>更多</summary>
      <div className={styles.entityPanel}>
        {(can('copy') || can('rename')) && <label>{renameLabel}<input value={nextId} maxLength={200} disabled={disabled} onChange={event => setNextId(event.target.value)} /></label>}
        {can('copy') && <button type="button" disabled={disabled || !identityValid} onClick={() => { void onRun(target, 'copy', nextId).then(success => { if (success) setNextId(''); }); }}>复制模型</button>}
        {can('rename') && <button type="button" disabled={disabled || !identityValid} onClick={() => { void onRun(target, 'rename', nextId).then(success => { if (success) onRemove(); }); }}>修改模型标识</button>}
        {can('delete') && <button type="button" className={styles.danger} disabled={disabled || defaultModel || smallModel} onClick={() => { void onRun(target, 'delete').then(success => { if (success) onRemove(); }); }}>删除模型</button>}
        {(defaultModel || smallModel) && <p>先选择替代默认或轻量模型，再删除。</p>}
      </div>
    </details>
  </div>;
}

/** Local creation values never become a second persisted model document. */
export function NewModelForm({ props, provider, disabled, label, fields, initialValues = {}, allowOverride, listChoices = {}, onCreate }: {
  props: ConfigurationEditorProps; provider: string; disabled?: boolean; label: string; fields: Field[]; initialValues?: Record<string, unknown>; allowOverride?: boolean; listChoices?: ListChoices;
  onCreate: (id: string, values: Record<string, unknown>, kind: 'model' | 'override') => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  return <div className={styles.controls}>{!open ? <button type="button" disabled={disabled} onClick={() => setOpen(true)}>新增模型</button>
    : <CreationFields props={props} provider={provider} disabled={disabled} label={label} fields={fields} initialValues={initialValues} allowOverride={allowOverride} listChoices={listChoices} onCreate={onCreate} onClose={() => setOpen(false)} />}</div>;
}
function CreationFields({ props, provider, disabled, label, fields, initialValues, allowOverride, listChoices, onCreate, onClose }: {
  props: ConfigurationEditorProps; provider: string; disabled?: boolean; label: string; fields: Field[]; initialValues: Record<string, unknown>; allowOverride?: boolean; listChoices: ListChoices; onClose: () => void;
  onCreate: (id: string, values: Record<string, unknown>, kind: 'model' | 'override') => Promise<boolean>;
}) {
  const [id, setId] = useState('');
  const [kind, setKind] = useState<'model' | 'override'>('model');
  const [values, setValues] = useState(initialValues);
  const [invalidFields, setInvalidFields] = useState(new Set<string>());
  const [pending, setPending] = useState(false);
  const formKey = `${props.draft.sessionId}:new-model:${provider}`;
  const latest = useRef(props.onValidityChange);
  latest.current = props.onValidityChange;
  const active = useRef(true);
  useEffect(() => {
    active.current = true; latest.current(formKey, false);
    return () => { active.current = false; latest.current(formKey, true); for (const field of fields) latest.current(`${formKey}:${field.id}`, true); };
  }, [formKey]);
  const requiredValid = fields.filter(field => field.required).every(field => { const value = fieldValue(values, field.id); return value != null && String(value).trim() !== '' && (field.kind !== 'integer' || (typeof value === 'number' && Number.isInteger(value) && value > 0)); });
  const reportField = (field: Field, valid: boolean) => {
    setInvalidFields(previous => { const next = new Set(previous); if (valid) next.delete(field.id); else next.add(field.id); return next; });
    props.onValidityChange(`${formKey}:${field.id}`, valid);
  };
  const render = (field: Field) => {
    const value = fieldValue(values, field.id);
    const metadata = kind === 'override' ? { ...field, defaultSource: '跟随内置模型' } : field;
    if (listChoices[field.id]) return <StringListControl key={field.id} field={metadata} values={value as string[] | undefined} choices={listChoices[field.id]} issues={[]} disabled={disabled || pending}
      onChange={async next => { setValues(previous => withField(previous, field.id, next)); }}
      onReset={async () => { setValues(previous => withField(previous, field.id, null)); }} onValidityChange={valid => reportField(field, valid)} />;
    return <ConfigurationField key={field.id} field={metadata} value={value} disabled={disabled || pending}
      onChange={async next => { setValues(previous => withField(previous, field.id, next)); }}
      onReset={field.required ? undefined : async () => { setValues(previous => withField(previous, field.id, null)); }}
      onValidityChange={valid => reportField(field, valid)} />;
  };
  return <fieldset className={styles.group} aria-label="新增模型表单"><legend>新增模型</legend>
    <label>{label}<input value={id} maxLength={200} disabled={disabled || pending} onChange={event => setId(event.target.value)} /></label>
    {allowOverride && <label>模型定义<select value={kind} disabled={disabled || pending} onChange={event => setKind(event.target.value as 'model' | 'override')}><option value="model">自定义模型</option><option value="override">内置模型覆盖</option></select></label>}
    {fields.filter(field => !field.advanced || field.required).map(render)}
    {fields.some(field => field.advanced && !field.required) && <details><summary>可选参数</summary>{fields.filter(field => field.advanced && !field.required).map(render)}</details>}
    <button type="button" disabled={disabled || pending || !validIdentity(id) || !requiredValid || invalidFields.size > 0} onClick={() => {
      setPending(true); void onCreate(id, values, kind).then(success => { if (!active.current) return; setPending(false); if (success) onClose(); });
    }}>创建模型</button>
    <button type="button" disabled={disabled || pending} onClick={onClose}>取消新增</button>
  </fieldset>;
}
