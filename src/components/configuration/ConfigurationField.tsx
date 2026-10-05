import { useEffect, useId, useRef, useState } from 'react';
import type { ConfigurationField as Field, ConfigurationIssue } from '../../types/configuration';

type Props = {
  field: Field;
  value: unknown;
  issues?: ConfigurationIssue[];
  disabled?: boolean;
  onChange: (value: unknown) => Promise<void>;
  onReset?: () => Promise<void>;
  /** Invalid intermediate input and pending writes must block the surrounding submit. */
  onValidityChange: (valid: boolean) => void;
};
export function ConfigurationField({ field, value, issues = [], disabled, onChange, onReset, onValidityChange }: Props) {
  const id = useId();
  const request = useRef(0);
  const display = typeof value === 'string' ? value : value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const [input, setInput] = useState(display);
  const [error, setError] = useState<string | null>(null);
  const localInput = useRef(false);
  const latestDisplay = useRef(display);
  // Only a new external projection is a value update. Clearing an error or
  // finishing an IPC request must not restore an unchanged, older prop value.
  useEffect(() => {
    latestDisplay.current = display;
    if (!localInput.current) setInput(display);
  }, [display]);
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
  return <div>
    <label htmlFor={id}>{field.label}{field.required ? ' *' : ''}</label>
    {field.kind === 'boolean' ? <input id={id} type="checkbox" checked={value === true} disabled={blocked} aria-invalid={Boolean(error || issues.length)} aria-describedby={`${id}-issues`} onChange={event => { const next = event.target.checked; void commit(() => onChange(next)); }} />
      : field.choices.length ? <select id={id} value={input} disabled={blocked} onChange={event => { void change(event.target.value); }}>
        <option value="" disabled={field.required || !onReset}>{field.required ? '请选择' : onReset ? field.defaultSource ?? '跟随默认' : '未设置'}</option>
        {input && !field.choices.includes(input) && <option value={input}>{input}（原生值）</option>}
        {field.choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
      </select> : <input id={id} value={input} disabled={blocked} inputMode={field.kind === 'number' || field.kind === 'integer' ? 'numeric' : undefined} aria-invalid={Boolean(error || issues.length)} aria-describedby={`${id}-issues`} onChange={event => { void change(event.target.value); }} />}
    {onReset && <button type="button" disabled={blocked} onClick={() => { void commit(onReset, undefined, true); }}>恢复默认</button>}
    <div id={`${id}-issues`} role={error || issues.length ? 'alert' : undefined}>{error}{issues.map(issue => <p key={`${issue.code}:${issue.message}`}>{issue.message}</p>)}{field.unavailableReason}</div>
  </div>;
}
