import { useRef, useState } from 'react';
import { GuideDialog } from '../../components/GuideDialog';
import { navigateChoices } from './choiceNavigation';
import styles from './DateRangeFilter.module.css';

export type RangeKey = 'all' | 'today' | 'yesterday' | '7' | '30' | 'month' | 'custom';
const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const parse = (value: string) => new Date(`${value}T12:00:00`);
const caption = (value: string) => value ? value.replaceAll('-', '/') : '请选择';

export function DateRangeFilter({ value, customFrom, customTo, presets, onChange, onCustomRange, variant = 'compact' }: {
  value: RangeKey; customFrom: string; customTo: string;
  presets: Array<{ id: RangeKey; label: string }>;
  onChange: (value: RangeKey) => void; onCustomRange: (from: string, to: string) => void;
  variant?: 'compact' | 'toolbar';
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [edge, setEdge] = useState<'from' | 'to'>('from');
  const [month, setMonth] = useState(() => new Date());
  const [focused, setFocused] = useState(iso(new Date()));
  const calendar = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const offset = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
  const days = new Date(year, monthIndex + 1, 0).getDate();
  const today = iso(new Date());
  function show() {
    trigger.current = document.activeElement as HTMLElement | null;
    const initial = customFrom || today;
    setFrom(customFrom); setTo(customTo); setMonth(parse(initial)); setFocused(initial); setEdge('from'); setOpen(true);
  }
  function close() { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); }
  function choose(date: string) {
    if (edge === 'from') { setFrom(date); setTo(''); setEdge('to'); }
    else { setFrom(date < from ? date : from); setTo(date < from ? from : date); setEdge('from'); }
    setFocused(date);
  }
  function moveFocus(value: string, delta: number) {
    const next = parse(value); next.setDate(next.getDate() + delta);
    const day = iso(next); setMonth(next); setFocused(day);
    requestAnimationFrame(() => calendar.current?.querySelector<HTMLButtonElement>(`[data-day="${day}"]`)?.focus());
  }
  return <div className={styles.filter} data-variant={variant}>
    {variant === 'compact' && <span className={styles.label}>时间范围</span>}
    <div className={styles.presets} role={variant === 'toolbar' ? 'radiogroup' : undefined} aria-label={variant === 'toolbar' ? '统计时间' : '时间范围'} onKeyDown={variant === 'toolbar' ? navigateChoices : undefined}>
      {presets.map((preset) => <button key={preset.id} type="button" role={variant === 'toolbar' ? 'radio' : undefined} tabIndex={variant === 'toolbar' ? value === preset.id ? 0 : -1 : undefined} aria-checked={variant === 'toolbar' ? value === preset.id : undefined} aria-pressed={variant === 'compact' ? value === preset.id : undefined} onClick={() => preset.id === 'custom' ? show() : onChange(preset.id)}>{preset.label}</button>)}
    </div>
    {value === 'custom' && <button type="button" className={styles.selectedRange} onClick={show}>{caption(customFrom)} — {caption(customTo)}</button>}
    <GuideDialog open={open} title="自定义时间范围" hint="选择起止日期，包含开始日与结束日。" onClose={close}>
      <div className={styles.calendar} ref={calendar}>
        <div className={styles.edges}>
          <button type="button" aria-pressed={edge === 'from'} onClick={() => setEdge('from')}><span>开始日期</span><strong>{caption(from)}</strong></button>
          <span>—</span>
          <button type="button" disabled={!from} aria-pressed={edge === 'to'} onClick={() => setEdge('to')}><span>结束日期</span><strong>{caption(to)}</strong></button>
        </div>
        <div className={styles.month}>
          <button type="button" aria-label="上个月" onClick={() => setMonth(new Date(year, monthIndex - 1, 1))}>‹</button>
          <strong aria-live="polite">{year} 年 {monthIndex + 1} 月</strong>
          <button type="button" aria-label="下个月" onClick={() => setMonth(new Date(year, monthIndex + 1, 1))}>›</button>
        </div>
        <div className={styles.grid} aria-label={`${year}年${monthIndex + 1}月日期`}>
          {['一', '二', '三', '四', '五', '六', '日'].map((day) => <span key={day} className={styles.weekday}>{day}</span>)}
          {Array.from({ length: offset }, (_, index) => <span key={`blank-${index}`} />)}
          {Array.from({ length: days }, (_, index) => {
            const day = iso(new Date(year, monthIndex, index + 1));
            return <button key={day} type="button" data-day={day} data-in-range={!!from && !!to && day > from && day < to || undefined} aria-label={day} aria-pressed={day === from || day === to} aria-current={day === today ? 'date' : undefined} tabIndex={day === focused || (focused.slice(0, 7) !== day.slice(0, 7) && index === 0) ? 0 : -1} onClick={() => choose(day)} onKeyDown={(event) => {
              const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
              if (delta) { event.preventDefault(); moveFocus(day, delta); }
            }}>{index + 1}</button>;
          })}
        </div>
        <p className={styles.hint} role="status">{from && to ? `已选择 ${Math.round((parse(to).getTime() - parse(from).getTime()) / 86400000) + 1} 天` : edge === 'from' ? '请选择开始日期' : '请选择结束日期，可选择同一天'}</p>
        <div className={styles.footer}>
          <button type="button" className="text-button" onClick={() => { setMonth(new Date()); setFocused(today); }}>回到本月</button>
          <button type="button" onClick={close}>取消</button>
          <button type="button" className={styles.apply} data-dialog-save disabled={!from || !to} onClick={() => { onCustomRange(from, to); close(); }}>应用范围</button>
        </div>
      </div>
    </GuideDialog>
  </div>;
}
