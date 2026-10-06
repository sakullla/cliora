import { useEffect, useId, useRef, useState } from 'react';
import type { ConfigurationField as Field, ConfigurationIssue } from '../../types/configuration';
import { ModelCombobox } from '../../features/tools/ModelCombobox';
import styles from './configuration.module.css';
export type FieldPresentation = { unit?: string; description?: string; nativeField?: string; origin?: 'explicit' | 'inherited' | 'unset' | 'unknown'; placeholder?: string; suggestions?: string[]; combobox?: boolean; catalog?: { supported: boolean; busy: boolean; fetch: () => void } };

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
      setError(failure instanceof Error ? failure.message : '修改失败，请重试');
      onValidityChange(false);
    }
  };
  const change = async (text: string) => {
    const token = ++request.current;
    setInput(text);
    localInput.current = true;
    if (text === '' && field.choices.length && !field.required) {
      if (onReset) await commit(onReset, token);
      else { setError('此字段不支持恢复默认'); onValidityChange(false); }
      return;
    }
    let next: unknown = text;
    if (field.kind === 'number' || field.kind === 'integer') {
      if (text.trim() && !/^[+-]?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(text.trim())) {
        setError('请输入完整数值'); onValidityChange(false); return;
      }
      next = text.trim() === '' ? null : Number(text);
      if (next !== null && (!Number.isFinite(next) || (field.kind === 'integer' && !Number.isInteger(next)) || (field.minimum != null && Number(next) < field.minimum))) {
        setError('请输入有效数值'); onValidityChange(false); return;
      }
    } else if (field.kind === 'json') {
      try { next = JSON.parse(text); } catch { setError('请输入有效 JSON'); onValidityChange(false); return; }
    }
    if (field.required && (next == null || text.trim() === '')) { setError('此项必填'); onValidityChange(false); return; }
    await commit(() => next === null && onReset ? onReset() : onChange(next), token);
  };
  const blocked = disabled || Boolean(field.unavailableReason);
  // Restore is offered only when the value is known to deviate from the
  // default: this layer explicitly set it. Inherited/unset fields are already
  // on the default; unknown origins keep the previous always-available behavior.
  const deviates = presentation?.origin !== 'inherited' && presentation?.origin !== 'unset';
  return <div className={styles.controls}>
    <div className={styles.fieldHead}>
      <label htmlFor={id}>{field.label}{presentation?.unit ? `（${presentation.unit}）` : ''}{field.required ? ' *' : ''}</label>
      {onReset && deviates && <button type="button" className={styles.restore} disabled={blocked} onClick={() => { void commit(onReset, undefined, true); }}>恢复默认</button>}
      <button type="button" className={styles.infoToggle} aria-label="字段信息" aria-expanded={infoOpen} aria-controls={`${id}-info`} onClick={() => { setInfoOpen(open => !open); }}>ⓘ</button>
    </div>
    {field.kind === 'boolean' ? <input id={id} type="checkbox" checked={value === true} disabled={blocked} aria-invalid={Boolean(error || issues.length)} aria-describedby={`${id}-issues`} onChange={event => { const next = event.target.checked; void commit(() => onChange(next)); }} />
      : presentation?.combobox && field.kind === 'string' ? <ModelCombobox id={id} label={field.label} value={input} placeholder={presentation.placeholder ?? '选择或输入'} disabled={blocked} options={[...new Set([...field.choices, ...(presentation.suggestions ?? []), ...(input ? [input] : [])])]} action={presentation.catalog?.supported ? { label: '获取模型目录', busy: presentation.catalog.busy, onClick: () => presentation.catalog!.fetch() } : undefined} onChange={value => { void change(value); }} />
      : field.choices.length ? <select id={id} value={input} disabled={blocked} onChange={event => { void change(event.target.value); }}>
        <option value="" disabled={field.required || !onReset}>{field.required ? '请选择' : onReset ? field.defaultSource ?? '跟随默认' : '未设置'}</option>
        {input && !field.choices.includes(input) && <option value={input}>{input}（原生值）</option>}
        {field.choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
      </select> : <><input id={id} value={input} disabled={blocked} placeholder={presentation?.placeholder} list={presentation?.suggestions?.length ? `${id}-suggestions` : undefined} inputMode={field.kind === 'number' || field.kind === 'integer' ? 'numeric' : undefined} aria-invalid={Boolean(error || issues.length)} aria-describedby={`${id}-issues`} onChange={event => { void change(event.target.value); }} />{presentation?.suggestions?.length ? <datalist id={`${id}-suggestions`}>{presentation.suggestions.map(suggestion => <option key={suggestion} value={suggestion} />)}</datalist> : null}</>}
    {infoOpen && <div id={`${id}-info`} className={styles.infoPanel}>
      <small>{value == null ? `未设置 · ${field.defaultSource ?? '原生默认'}` : presentation?.origin === 'inherited' ? '继承自通用配置 · 在通用配置中修改' : presentation?.origin === 'explicit' ? field.kind === 'boolean' ? value ? '本层显式开启' : '本层显式关闭' : value === 0 ? '本层显式设置为 0' : '本层显式值' : field.kind === 'boolean' ? value ? '读取到开启值 · 来源见合并' : '读取到关闭值 · 来源见合并' : value === 0 ? '读取到 0 · 来源见合并' : '已读取值 · 来源见合并'}</small>
      {presentation?.description && <small>{presentation.description}</small>}
      <small>原生字段：<code>{presentation?.nativeField ?? field.id}</code>{field.defaultSource && ` · 未设置时：${field.defaultSource}`}</small>
    </div>}
    <div id={`${id}-issues`} role={error || issues.length ? 'alert' : undefined}>{error}{issues.map(issue => <p key={`${issue.code}:${issue.message}`}>{issue.message}</p>)}{field.unavailableReason}</div>
  </div>;
}
