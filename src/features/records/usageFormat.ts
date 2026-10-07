import type { UsageBucket, UsageTotals } from '../../types/history';
import i18n from '../../i18n';

export const DAY_MS = 86_400_000;

const compactFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 });
export const formatTokens = (value: number) => value < 1000 ? Math.round(value).toLocaleString() : compactFormat.format(value);

const symbols: Record<string, string> = { USD: '$', CNY: '¥', EUR: '€', GBP: '£', JPY: '¥', HKD: 'HK$' };
export function formatMoney(value: number | null, currency: string) {
  if (value === null) return i18n.t('records.format.unpriced');
  const symbol = symbols[currency] ?? `${currency} `;
  if (value === 0) return `${symbol}0`;
  if (value < 0.01) return `<${symbol}0.01`;
  const digits = value >= 1000 ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return `${symbol}${value.toLocaleString('en-US', digits)}`;
}
export const exactMoney = (value: number | null, currency: string) => value === null ? i18n.t('records.format.noPrice') : `${currency} ${value.toFixed(4)}`;

export const ratio = (part: number, whole: number) => whole > 0 ? part / whole : 0;
export function formatPercent(value: number) {
  if (value <= 0) return '0%';
  if (value < 0.001) return '<0.1%';
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

/** Token buckets in stacking order, bottom to top. */
export function tokenParts(): ReadonlyArray<{ key: 'input' | 'cacheRead' | 'cacheWrite' | 'output'; label: string; hint: string }> {
  return [
    { key: 'input', label: i18n.t('records.format.tokenInput'), hint: i18n.t('records.format.tokenInputHint') },
    { key: 'cacheRead', label: i18n.t('records.format.tokenCacheRead'), hint: i18n.t('records.format.tokenCacheReadHint') },
    { key: 'cacheWrite', label: i18n.t('records.format.tokenCacheWrite'), hint: i18n.t('records.format.tokenCacheWriteHint') },
    { key: 'output', label: i18n.t('records.format.tokenOutput'), hint: i18n.t('records.format.tokenOutputHint') },
  ];
}

/** Share of prompt tokens served from cache. */
export const cacheHitRate = (totals: UsageTotals) => ratio(totals.cacheRead, totals.input + totals.cacheRead + totals.cacheWrite);

const weekdayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const pad = (value: number) => String(value).padStart(2, '0');
export function bucketLabel(bucket: Pick<UsageBucket, 'start' | 'end'>, kind: 'hour' | 'day' | 'month', long: boolean, multiYear = false) {
  const date = new Date(bucket.start);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (kind === 'hour') {
    if (!long) return `${pad(date.getHours())}:00`;
    const end = new Date(bucket.end);
    return i18n.t('records.format.hourLong', { month, day, start: pad(date.getHours()), end: pad(end.getHours() === 0 && end.getTime() > date.getTime() ? 24 : end.getHours()) });
  }
  if (kind === 'day') return long
    ? i18n.t('records.format.dayLong', { month, day, weekday: i18n.t(`records.format.weekday.${weekdayKeys[date.getDay()]}`) })
    : i18n.t('records.format.dayShort', { month, day });
  return long || multiYear
    ? i18n.t('records.format.monthLong', { year: date.getFullYear(), month })
    : i18n.t('records.format.monthShort', { month });
}

/** Axis top and gridlines for a maximum, using 1/2/2.5/5 steps. */
export function niceScale(max: number, lines = 4) {
  if (!(max > 0)) return { top: 1, ticks: [0] };
  const rough = max / lines;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((item) => item * power).find((item) => item >= rough) ?? 10 * power;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(value);
  return { top, ticks };
}

const timeLocale = () => i18n.language === 'en' ? 'en-US' : 'zh-CN';
export const clockTime = (ms: number) => new Date(ms).toLocaleTimeString(timeLocale(), { hour: '2-digit', minute: '2-digit' });
export function shortDate(ms: number | null) {
  if (ms === null) return i18n.t('records.format.timeUnknown');
  const date = new Date(ms);
  const now = new Date();
  const start = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((start(now) - start(date)) / DAY_MS);
  if (days <= 0) return i18n.t('records.format.today', { time: clockTime(ms) });
  if (days === 1) return i18n.t('records.format.yesterday', { time: clockTime(ms) });
  if (date.getFullYear() === now.getFullYear()) return i18n.t('records.format.dayOfYear', { month: date.getMonth() + 1, day: date.getDate() });
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
