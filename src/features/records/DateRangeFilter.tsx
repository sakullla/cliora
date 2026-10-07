import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GuideDialog } from '../../components/GuideDialog';
import { navigateChoices } from '../../lib/choiceNavigation';
import { saveShortcutHint } from '../../lib/shortcut';
import i18n from '../../i18n';
import styles from './DateRangeFilter.module.css';

export type RangeKey = 'all' | 'today' | 'yesterday' | '7' | '30' | 'month' | 'custom';
const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const parse = (value: string) => new Date(`${value}T12:00:00`);
const caption = (value: string) => value ? value.replaceAll('-', '/') : i18n.t('records.range.choose');
const weekdayNames = () => [1, 2, 3, 4, 5, 6, 0].map((day) => i18n.t(`records.range.weekday.${day}`));

export function DateRangeFilter({ value, customFrom, customTo, presets, onChange, onCustomRange, variant = 'compact' }: {
  value: RangeKey; customFrom: string; customTo: string;
  presets: Array<{ id: RangeKey; label: string }>;
  onChange: (value: RangeKey) => void; onCustomRange: (from: string, to: string) => void;
  variant?: 'compact' | 'toolbar';
}) {
  const { t } = useTranslation();
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
    {variant === 'compact' && <span className={styles.label}>{t('records.range.label')}</span>}
    <div className={styles.presets} role={variant === 'toolbar' ? 'radiogroup' : undefined} aria-label={variant === 'toolbar' ? t('records.range.statsAria') : t('records.range.label')} onKeyDown={variant === 'toolbar' ? navigateChoices : undefined}>
      {presets.map((preset) => <button key={preset.id} type="button" role={variant === 'toolbar' ? 'radio' : undefined} tabIndex={variant === 'toolbar' ? value === preset.id ? 0 : -1 : undefined} aria-checked={variant === 'toolbar' ? value === preset.id : undefined} aria-pressed={variant === 'compact' ? value === preset.id : undefined} onClick={() => preset.id === 'custom' ? show() : onChange(preset.id)}>{preset.label}</button>)}
    </div>
    {value === 'custom' && <button type="button" className={styles.selectedRange} onClick={show}>{caption(customFrom)} — {caption(customTo)}</button>}
    <GuideDialog open={open} title={t('records.range.title')} hint={t('records.range.hint')} onClose={close}>
      <div className={styles.calendar} ref={calendar}>
        <div className={styles.edges}>
          <button type="button" aria-pressed={edge === 'from'} onClick={() => setEdge('from')}><span>{t('records.range.from')}</span><strong>{caption(from)}</strong></button>
          <span>—</span>
          <button type="button" disabled={!from} aria-pressed={edge === 'to'} onClick={() => setEdge('to')}><span>{t('records.range.to')}</span><strong>{caption(to)}</strong></button>
        </div>
        <div className={styles.month}>
          <button type="button" aria-label={t('records.range.prevMonth')} onClick={() => setMonth(new Date(year, monthIndex - 1, 1))}>‹</button>
          <strong aria-live="polite">{t('records.range.monthLabel', { year, month: monthIndex + 1 })}</strong>
          <button type="button" aria-label={t('records.range.nextMonth')} onClick={() => setMonth(new Date(year, monthIndex + 1, 1))}>›</button>
        </div>
        <div className={styles.grid} aria-label={t('records.range.gridAria', { year, month: monthIndex + 1 })}>
          {weekdayNames().map((day, index) => <span key={index} className={styles.weekday}>{day}</span>)}
          {Array.from({ length: offset }, (_, index) => <span key={`blank-${index}`} />)}
          {Array.from({ length: days }, (_, index) => {
            const day = iso(new Date(year, monthIndex, index + 1));
            return <button key={day} type="button" data-day={day} data-in-range={!!from && !!to && day > from && day < to || undefined} aria-label={day} aria-pressed={day === from || day === to} aria-current={day === today ? 'date' : undefined} tabIndex={day === focused || (focused.slice(0, 7) !== day.slice(0, 7) && index === 0) ? 0 : -1} onClick={() => choose(day)} onKeyDown={(event) => {
              const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
              if (delta) { event.preventDefault(); moveFocus(day, delta); }
            }}>{index + 1}</button>;
          })}
        </div>
        <p className={styles.hint} role="status">{from && to ? t('records.range.selected', { count: Math.round((parse(to).getTime() - parse(from).getTime()) / 86400000) + 1 }) : edge === 'from' ? t('records.range.pickFrom') : t('records.range.pickTo')}</p>
        <div className={styles.footer}>
          <button type="button" className="text-button" onClick={() => { setMonth(new Date()); setFocused(today); }}>{t('records.range.currentMonth')}</button>
          <button type="button" onClick={close}>{t('common.dialog.cancel')}</button>
          <button type="button" className={styles.apply} data-dialog-save title={saveShortcutHint()} disabled={!from || !to} onClick={() => { onCustomRange(from, to); close(); }}>{t('records.range.apply')}</button>
        </div>
      </div>
    </GuideDialog>
  </div>;
}
