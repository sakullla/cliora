import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfigurationField, type FieldPresentation } from './ConfigurationField';
import { StepHead } from './ConfigurationStep';
import styles from './configuration.module.css';
import type { CatalogControls, ConfigurationContentProps } from '../../adapters/contract';
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
  const { t } = useTranslation();
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
      setPending(false); setError(failure instanceof Error ? failure.message : t('common.field.changeFailed'));
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
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const entries = [...choices, ...(values ?? []).filter(value => !choices.some(([id]) => id === value)).map(value => [value, t('common.field.nativeValue', { value })] as const)];
  const commit = async (operation: () => Promise<void>) => {
    setPending(true); setError(null); onValidityChange(false);
    try { await operation(); if (active.current) { setPending(false); onValidityChange(true); } }
    catch (failure) { if (active.current) { setPending(false); setError(failure instanceof Error ? failure.message : t('common.field.changeFailed')); } }
  };
  return <fieldset className={`${styles.controls} ${styles.group}`}><legend>{field.label}</legend>{entries.map(([id, label]) => <label key={id}><input type="checkbox" checked={(values ?? []).includes(id)} disabled={disabled || pending || Boolean(field.unavailableReason)}
    onChange={event => { const next = event.target.checked ? [...(values ?? []), id] : (values ?? []).filter(value => value !== id); void commit(() => onChange(next)); }} />{label}</label>)}
    <button type="button" className={styles.restore} disabled={disabled || pending || Boolean(field.unavailableReason)} onClick={() => { void commit(onReset); }}>{t('common.field.restoreDefault')}</button>
    {values == null && <p>{field.defaultSource ?? t('common.field.followNativeDefault')}</p>}
    {error && <p role="alert">{error}</p>}{issues.map(message => <p role="alert" key={message}>{message}</p>)}{field.unavailableReason && <p>{field.unavailableReason}</p>}
  </fieldset>;
}

export function ModelRow({ id, name, sub = [], badges = [], expanded, sectioned, disabled, canDefault, onToggle, onSetDefault }: {
  id: string; name?: string; sub?: string[]; badges?: string[]; expanded: boolean; sectioned?: boolean; disabled?: boolean;
  canDefault?: boolean; onToggle: () => void; onSetDefault?: () => void;
}) {
  const { t } = useTranslation();
  const display = name && name !== id ? name : id;
  const subtitle = [...(name && name !== id ? [id] : []), ...sub];
  const label = [display, ...subtitle, ...badges].join(' · ');
  const chips = badges.map(badge => <span key={badge} className={styles.modelBadge} {...(badge === t('common.models.defaultBadge') ? { 'data-default-badge': true } : {})}>{badge}</span>);
  if (sectioned && expanded) return <div className={styles.modelBack}>
    <button type="button" className={styles.modelBackButton} aria-label={t('common.models.backAria', { label })} disabled={disabled} onClick={onToggle}><span aria-hidden="true">‹</span>{t('common.models.back')}</button>
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
    {canDefault && <button type="button" className={styles.modelRowDefault} disabled={disabled} onClick={onSetDefault}>{t('common.models.setDefault')}</button>}
  </div>;
}

export function ProviderEditor({ provider, providers, connection, protocol, disabled, canConfigure, canSelect, onConfigure, onSelect, onDraftValidityChange }: {
  provider: string; providers: string[]; connection?: Connection; protocol: string; disabled?: boolean; canConfigure: boolean; canSelect: boolean;
  onConfigure: (id: string, value: { baseUrl: string; interfaceFormat: string }) => Promise<boolean>; onSelect: (id: string) => Promise<boolean>;
  onDraftValidityChange?: (valid: boolean) => void;
}) {
  const { t } = useTranslation();
  const selectId = useId();
  const [id, setId] = useState(provider);
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? '');
  const [format, setFormat] = useState(protocol);
  const readOnly = id === provider && Boolean(connection?.readOnlyReason);
  const validity = useRef(onDraftValidityChange); validity.current = onDraftValidityChange;
  const dirty = canConfigure && !(id === provider && baseUrl === (connection?.baseUrl ?? '') && format === protocol);
  useEffect(() => { validity.current?.(!dirty); }, [dirty]);
  useEffect(() => () => validity.current?.(true), []);
  const reset = () => { setId(provider); setBaseUrl(connection?.baseUrl ?? ''); setFormat(protocol); };
  const summary = provider || connection?.baseUrl ? <>{provider && <code>{provider}</code>}{provider && connection?.baseUrl ? ' · ' : ''}{connection?.baseUrl}</> : t('common.provider.metaEmpty');
  return <section data-config-step="connection" className={`${styles.controls} ${styles.step}`}>
    <StepHead step="connection" title={t('common.provider.title')} meta={summary} actions={canSelect && providers.length > 0 ? <select id={selectId} aria-label={t('common.provider.view')} title={t('common.provider.view')} value={provider} disabled={disabled} onChange={event => { void onSelect(event.target.value); }}><option value="" disabled>{t('common.provider.choose')}</option>{providers.map(item => <option key={item} value={item}>{item}</option>)}</select> : undefined} />
    {canConfigure ? <>
      <div className={styles.fieldGrid}>
        <label>{t('common.provider.id')}<input value={id} maxLength={80} disabled={disabled} placeholder={t('common.provider.idPlaceholder')} spellCheck={false} onChange={event => setId(event.target.value)} /></label>
        <label>{t('common.provider.protocol')}<select value={format} disabled={disabled || readOnly} onChange={event => setFormat(event.target.value)}><option value="" disabled>{connection?.protocol ? t('common.provider.nativeProtocol', { protocol: connection.protocol }) : t('common.provider.chooseProtocol')}</option><option value="openai_completions">OpenAI Chat Completions</option><option value="openai_responses">OpenAI Responses</option><option value="anthropic_messages">Anthropic Messages</option></select></label>
        <label className={styles.span}>{t('common.provider.baseUrl')}<input value={baseUrl} disabled={disabled || readOnly} placeholder="https://api.example.com/v1" spellCheck={false} inputMode="url" onChange={event => setBaseUrl(event.target.value)} /></label>
      </div>
      {connection?.readOnlyReason && <p className={styles.stepNote}>{t('common.provider.readOnlyHint', { reason: connection.readOnlyReason })}</p>}
      {dirty && <div className={styles.pendingBar}>
        <span>{!validIdentity(id, 80) || !baseUrl.trim() || !format ? t('common.provider.pendingIncomplete') : t('common.provider.pending')}</span>
        <div className={styles.buttons}>
          <button type="button" disabled={disabled} onClick={reset}>{t('common.provider.cancel')}</button>
          <button type="button" className={styles.accent} disabled={disabled || readOnly || !validIdentity(id, 80) || !baseUrl.trim() || !format} onClick={() => { void onConfigure(id, { baseUrl: baseUrl.trim(), interfaceFormat: format }); }}>{t('common.provider.configure')}</button>
        </div>
      </div>}
    </> : <p className={styles.stepNote}>{provider || t('common.provider.unsupported')}</p>}
  </section>;
}

/** Model step of multi-model editors: count, catalog entry point and an explicit empty state. */
export function ModelStep({ count, collapsed, defaultModel, note, catalog, disabled, children }: {
  count: number; collapsed?: boolean; defaultModel?: string | null; note?: ReactNode; catalog?: CatalogControls; disabled?: boolean; children: ReactNode;
}) {
  const { t } = useTranslation();
  if (collapsed) return <section data-config-step="model" className={styles.modelList}>{children}</section>;
  const fetch = catalog?.supported ? <button type="button" className={styles.catalogButton} disabled={disabled || catalog.busy} onClick={() => catalog.fetch()}>{catalog.busy ? t('common.models.fetching') : t('common.models.fromCatalog')}</button> : undefined;
  return <section data-config-step="model" className={`${styles.controls} ${styles.step}`}>
    <StepHead step="model" title={<>{t('common.models.title')}{count > 0 && <span className="count-chip">{count}</span>}</>} meta={defaultModel ? t('common.models.defaultMeta', { model: defaultModel }) : count ? t('common.models.noDefaultMeta') : undefined} actions={fetch} />
    {note}
    {count === 0 && <div className={styles.modelEmpty}><strong>{t('common.models.emptyTitle')}</strong><span>{catalog?.supported ? t('common.models.emptyCatalog') : t('common.models.empty')}</span></div>}
    <div className={styles.modelList}>{children}</div>
  </section>;
}

export function EntityActions({ id, target, descriptor, disabled, defaultModel, smallModel, renameLabel, onRun, onRemove }: {
  id: string; target: unknown; descriptor: ConfigurationDescriptor; disabled?: boolean; defaultModel?: boolean; smallModel?: boolean; renameLabel?: string; onRun: Run; onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [nextId, setNextId] = useState('');
  const can = (operation: string) => descriptor.operations.includes(operation);
  const identityValid = validIdentity(nextId) && nextId !== id;
  return <div className={styles.controls}>
    <div className={styles.entityPrimary}>
      {can('default') && <button type="button" className={styles.accent} disabled={disabled || defaultModel} onClick={() => { void onRun(target, 'default'); }}>{defaultModel ? t('common.models.currentDefault') : t('common.models.setDefaultModel')}</button>}
      {can('small_default') && <button type="button" className={styles.accent} disabled={disabled || smallModel} onClick={() => { void onRun(target, 'small_default'); }}>{smallModel ? t('common.models.currentSmall') : t('common.models.setSmallModel')}</button>}
    </div>
    <details className={styles.entityMore}>
      <summary>{t('common.models.more')}</summary>
      <div className={styles.entityPanel}>
        {(can('copy') || can('rename')) && <label>{renameLabel ?? t('common.models.newModelId')}<input value={nextId} maxLength={200} disabled={disabled} onChange={event => setNextId(event.target.value)} /></label>}
        {can('copy') && <button type="button" disabled={disabled || !identityValid} onClick={() => { void onRun(target, 'copy', nextId).then(success => { if (success) setNextId(''); }); }}>{t('common.models.copy')}</button>}
        {can('rename') && <button type="button" disabled={disabled || !identityValid} onClick={() => { void onRun(target, 'rename', nextId).then(success => { if (success) onRemove(); }); }}>{t('common.models.rename')}</button>}
        {can('delete') && <button type="button" className={styles.danger} disabled={disabled || defaultModel || smallModel} onClick={() => { void onRun(target, 'delete').then(success => { if (success) onRemove(); }); }}>{t('common.models.delete')}</button>}
        {(defaultModel || smallModel) && <p>{t('common.models.deleteBlocked')}</p>}
      </div>
    </details>
  </div>;
}

/** Local creation values never become a second persisted model document. */
export function NewModelForm({ props, provider, disabled, label, fields, initialValues = {}, allowOverride, listChoices = {}, onCreate }: {
  props: ConfigurationEditorProps; provider: string; disabled?: boolean; label: string; fields: Field[]; initialValues?: Record<string, unknown>; allowOverride?: boolean; listChoices?: ListChoices;
  onCreate: (id: string, values: Record<string, unknown>, kind: 'model' | 'override') => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return <div className={styles.controls}>{!open ? <button type="button" className={styles.addModel} disabled={disabled} onClick={() => setOpen(true)}><span aria-hidden="true">＋</span>{t('common.models.add')}</button>
    : <CreationFields props={props} provider={provider} disabled={disabled} label={label} fields={fields} initialValues={initialValues} allowOverride={allowOverride} listChoices={listChoices} onCreate={onCreate} onClose={() => setOpen(false)} />}</div>;
}
function CreationFields({ props, provider, disabled, label, fields, initialValues, allowOverride, listChoices, onCreate, onClose }: {
  props: ConfigurationEditorProps; provider: string; disabled?: boolean; label: string; fields: Field[]; initialValues: Record<string, unknown>; allowOverride?: boolean; listChoices: ListChoices; onClose: () => void;
  onCreate: (id: string, values: Record<string, unknown>, kind: 'model' | 'override') => Promise<boolean>;
}) {
  const { t } = useTranslation();
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
    const metadata = kind === 'override' ? { ...field, defaultSource: t('common.models.followBuiltin') } : field;
    if (listChoices[field.id]) return <StringListControl key={field.id} field={metadata} values={value as string[] | undefined} choices={listChoices[field.id]} issues={[]} disabled={disabled || pending}
      onChange={async next => { setValues(previous => withField(previous, field.id, next)); }}
      onReset={async () => { setValues(previous => withField(previous, field.id, null)); }} onValidityChange={valid => reportField(field, valid)} />;
    return <ConfigurationField key={field.id} field={metadata} value={value} disabled={disabled || pending}
      onChange={async next => { setValues(previous => withField(previous, field.id, next)); }}
      onReset={field.required ? undefined : async () => { setValues(previous => withField(previous, field.id, null)); }}
      onValidityChange={valid => reportField(field, valid)} />;
  };
  return <fieldset className={styles.createForm} aria-label={t('common.models.formLabel')}><legend>{t('common.models.add')}</legend>
    <label>{label}<input value={id} maxLength={200} disabled={disabled || pending} spellCheck={false} autoFocus onChange={event => setId(event.target.value)} /></label>
    {allowOverride && <label>{t('common.models.definition')}<select value={kind} disabled={disabled || pending} onChange={event => setKind(event.target.value as 'model' | 'override')}><option value="model">{t('common.models.custom')}</option><option value="override">{t('common.models.override')}</option></select></label>}
    {fields.filter(field => !field.advanced || field.required).map(render)}
    {fields.some(field => field.advanced && !field.required) && <details><summary>{t('common.models.optionalParams')}</summary>{fields.filter(field => field.advanced && !field.required).map(render)}</details>}
    <div className={styles.createActions}>
    <button type="button" disabled={disabled || pending} onClick={onClose}>{t('common.models.cancelAdd')}</button>
    <button type="button" className={styles.accent} disabled={disabled || pending || !validIdentity(id) || !requiredValid || invalidFields.size > 0} onClick={() => {
      setPending(true); void onCreate(id, values, kind).then(success => { if (!active.current) return; setPending(false); if (success) onClose(); });
    }}>{t('common.models.create')}</button>
    </div>
  </fieldset>;
}
