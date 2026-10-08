import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConfigurationField as Field, ConfigurationIssue } from '../../types/configuration';
import { ModelCombobox } from '../../features/tools/ModelCombobox';
import styles from './configuration.module.css';
export type FieldPresentation = { label?: string; unit?: string; description?: string; nativeField?: string; origin?: 'explicit' | 'inherited' | 'unset' | 'unknown'; placeholder?: string; suggestions?: string[]; combobox?: boolean; catalog?: { supported: boolean; busy: boolean; fetch: () => void } };

type Props = {
  field: Field;
  value: unknown;
  issues?: ConfigurationIssue[];
  disabled?: boolean;
  resetEpoch?: number;
  presentation?: FieldPresentation;
  onChange: (value: unknown) => Promise<void>;
  onReset?: () => Promise<void>;
  /** Invalid intermediate input and pending writes must block the surrounding submit. */
  onValidityChange: (valid: boolean) => void;
};
export function ConfigurationField({ field, value, issues = [], disabled, resetEpoch, presentation, onChange, onReset, onValidityChange }: Props) {
  const { t } = useTranslation();
  const id = useId();
  const request = useRef(0);
  const display = typeof value === 'string' ? value : value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const [input, setInput] = useState(display);
  const [error, setError] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const localInput = useRef(false);
  const latestDisplay = useRef(display);
  const seenReset = useRef(resetEpoch);
  // Only a new external projection is a value update. Clearing an error or
  // finishing an IPC request must not restore an unchanged, older prop value.
  useEffect(() => {
    latestDisplay.current = display;
    if (!localInput.current) setInput(display);
  }, [display]);
  useEffect(() => {
    if (seenReset.current === resetEpoch) return;
    seenReset.current = resetEpoch; request.current++;
    localInput.current = false; setInput(display); setError(null); onValidityChange(true);
  }, [resetEpoch]);
  useEffect(() => () => { request.current += 1; }, []);
  const commit = async (operation: () => Promise<void>, token = ++request.current, resetDisplay = false) => {
    setError(null);
    localInput.current = true;
    onValidityChange(false);
    try {
      await operation();
      if (token !== request.current) return;
      setError(null);
      localInput.current = false;
      if (resetDisplay) setInput(latestDisplay.current);
      onValidityChange(true);
    } catch (failure) {
      if (token !== request.current) return;
      localInput.current = true;
      setError(failure instanceof Error ? failure.message : t('common.field.changeFailed'));
      onValidityChange(false);
    }
  };
  const change = async (text: string) => {
    const token = ++request.current;
    setInput(text);
    localInput.current = true;
    if (text === '' && field.choices.length && !field.required) {
      if (onReset) await commit(onReset, token);
      else { setError(t('common.field.resetUnsupported')); onValidityChange(false); }
      return;
    }
    let next: unknown = text;
    if (field.kind === 'number' || field.kind === 'integer') {
      if (text.trim() && !/^[+-]?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(text.trim())) {
        setError(t('common.field.invalidNumber')); onValidityChange(false); return;
      }
      next = text.trim() === '' ? null : Number(text);
      if (next !== null && (!Number.isFinite(next) || (field.kind === 'integer' && !Number.isInteger(next)) || (field.minimum != null && Number(next) < field.minimum))) {
        setError(t('common.field.invalidValue')); onValidityChange(false); return;
      }
    } else if (field.kind === 'json') {
      try { next = JSON.parse(text); } catch { setError(t('common.field.invalidJson')); onValidityChange(false); return; }
    }
    if (field.required && (next == null || text.trim() === '')) { setError(t('common.field.required')); onValidityChange(false); return; }
    await commit(() => next === null && onReset ? onReset() : onChange(next), token);
  };
  const blocked = disabled || Boolean(field.unavailableReason);
  // Restore is offered only when the value is known to deviate from the
  // default: this layer explicitly set it. Inherited/unset fields are already
  // on the default; unknown origins keep the previous always-available behavior.
  const deviates = presentation?.origin !== 'inherited' && presentation?.origin !== 'unset';
  const caption = presentation?.label ?? field.label;
  return <div className={styles.controls}>
    <div className={styles.fieldHead}>
      <label htmlFor={id}>{caption}{presentation?.unit ? `（${presentation.unit}）` : ''}{field.required ? ' *' : ''}</label>
      {onReset && deviates && <button type="button" className={styles.restore} disabled={blocked} onClick={() => { void commit(onReset, undefined, true); }}>{t('common.field.restoreDefault')}</button>}
      <button type="button" className={styles.infoToggle} aria-label={t('common.field.info')} aria-expanded={infoOpen} aria-controls={`${id}-info`} onClick={() => { setInfoOpen(open => !open); }}>ⓘ</button>
    </div>
    {field.kind === 'boolean' ? <input id={id} type="checkbox" checked={value === true} disabled={blocked} aria-invalid={Boolean(error || issues.length)} aria-describedby={`${id}-issues`} onChange={event => { const next = event.target.checked; void commit(() => onChange(next)); }} />
      : presentation?.combobox && field.kind === 'string' ? <ModelCombobox id={id} label={caption} value={input} placeholder={presentation.placeholder ?? t('common.field.pickOrType')} disabled={blocked} options={[...new Set([...field.choices, ...(presentation.suggestions ?? []), ...(input ? [input] : [])])]} action={presentation.catalog?.supported ? { label: t('common.field.fetchCatalog'), busy: presentation.catalog.busy, onClick: () => presentation.catalog!.fetch() } : undefined} onChange={value => { void change(value); }} />
      : field.choices.length ? <select id={id} value={input} disabled={blocked} onChange={event => { void change(event.target.value); }}>
        <option value="" disabled={field.required || !onReset}>{field.required ? t('common.field.choose') : onReset ? field.defaultSource ?? t('common.field.followDefault') : t('common.field.unset')}</option>
        {input && !field.choices.includes(input) && <option value={input}>{t('common.field.nativeValue', { value: input })}</option>}
        {field.choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
      </select> : <><input id={id} value={input} disabled={blocked} placeholder={presentation?.placeholder} list={presentation?.suggestions?.length ? `${id}-suggestions` : undefined} inputMode={field.kind === 'number' || field.kind === 'integer' ? 'numeric' : undefined} aria-invalid={Boolean(error || issues.length)} aria-describedby={`${id}-issues`} onChange={event => { void change(event.target.value); }} />{presentation?.suggestions?.length ? <datalist id={`${id}-suggestions`}>{presentation.suggestions.map(suggestion => <option key={suggestion} value={suggestion} />)}</datalist> : null}</>}
    {infoOpen && <div id={`${id}-info`} className={styles.infoPanel}>
      <small>{value == null ? t('common.field.unsetWithDefault', { source: field.defaultSource ?? t('common.field.nativeDefault') }) : presentation?.origin === 'inherited' ? t('common.field.inherited') : presentation?.origin === 'explicit' ? field.kind === 'boolean' ? value ? t('common.field.explicitOn') : t('common.field.explicitOff') : value === 0 ? t('common.field.explicitZero') : t('common.field.explicitValue') : field.kind === 'boolean' ? value ? t('common.field.readOn') : t('common.field.readOff') : value === 0 ? t('common.field.readZero') : t('common.field.readValue')}</small>
      {presentation?.description && <small>{presentation.description}</small>}
      <small>{t('common.field.nativeField')}<code>{presentation?.nativeField ?? field.id}</code>{field.defaultSource && t('common.field.whenUnset', { source: field.defaultSource })}</small>
    </div>}
    <div id={`${id}-issues`} role={error || issues.length ? 'alert' : undefined}>{error}{issues.map(issue => <p key={`${issue.code}:${issue.message}`}>{issue.message}</p>)}{field.unavailableReason && <small className={styles.unavailable}>{field.unavailableReason}</small>}</div>
  </div>;
}
