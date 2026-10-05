import { useEffect, useId, useState } from 'react';
import type { ConfigurationField as Field, ConfigurationIssue } from '../../types/configuration';

type Props = {
  field: Field;
  value: unknown;
  issues?: ConfigurationIssue[];
  disabled?: boolean;
  onChange: (value: unknown) => Promise<void>;
  onReset?: () => Promise<void>;
  /** Invalid number/JSON intermediate input must block the surrounding submit. */
  onValidityChange: (valid: boolean) => void;
};
export function ConfigurationField({ field, value, issues = [], disabled, onChange, onReset, onValidityChange }: Props) {
  const id = useId();
  const display = typeof value === 'string' ? value : value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const [input, setInput] = useState(display);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!error) setInput(display); }, [display, error]);
  const change = async (text: string) => {
    setInput(text);
    let next: unknown = text;
    if (field.kind === 'number' || field.kind === 'integer') {
      next = text.trim() === '' ? null : Number(text);
      if (next !== null && (!Number.isFinite(next) || (field.kind === 'integer' && !Number.isInteger(next)) || (field.minimum != null && Number(next) < field.minimum))) {
        setError('请输入有效数值'); onValidityChange?.(false); return;
      }
    } else if (field.kind === 'json') {
      try { next = JSON.parse(text); } catch { setError('请输入有效 JSON'); onValidityChange?.(false); return; }
    }
    if (field.required && (next == null || text.trim() === '')) { setError('此项必填'); onValidityChange?.(false); return; }
    setError(null); onValidityChange?.(true);
    try { if (next === null && onReset) await onReset(); else await onChange(next); } catch (failure) { setError(failure instanceof Error ? failure.message : '修改失败，请重试'); onValidityChange?.(false); }
  };
  const blocked = disabled || Boolean(field.unavailableReason);
  return <div>
    <label htmlFor={id}>{field.label}{field.required ? ' *' : ''}</label>
    {field.kind === 'boolean' ? <input id={id} type="checkbox" checked={value === true} disabled={blocked} onChange={event => { void onChange(event.target.checked).catch(() => { setError('修改失败，请重试'); onValidityChange?.(false); }); }} />
      : field.choices.length ? <select id={id} value={input} disabled={blocked} onChange={event => { void change(event.target.value); }}>
        <option value="">{field.defaultSource ?? '跟随默认'}</option>
        {input && !field.choices.includes(input) && <option value={input}>{input}（原生值）</option>}
        {field.choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
      </select> : <input id={id} value={input} disabled={blocked} inputMode={field.kind === 'number' || field.kind === 'integer' ? 'numeric' : undefined} aria-invalid={Boolean(error || issues.length)} aria-describedby={`${id}-issues`} onChange={event => { void change(event.target.value); }} />}
    {onReset && <button type="button" disabled={blocked} onClick={() => { void onReset().then(() => { setError(null); onValidityChange(true); }).catch(() => { setError('恢复默认失败'); onValidityChange(false); }); }}>恢复默认</button>}
    <div id={`${id}-issues`} role={error || issues.length ? 'alert' : undefined}>{error}{issues.map(issue => <p key={`${issue.code}:${issue.message}`}>{issue.message}</p>)}{field.unavailableReason}</div>
  </div>;
}
