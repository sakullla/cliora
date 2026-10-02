import type { UsageBucket, UsageTotals } from '../../types/history';

export const DAY_MS = 86_400_000;

const compactFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 });
export const formatTokens = (value: number) => value < 1000 ? Math.round(value).toLocaleString() : compactFormat.format(value);

const symbols: Record<string, string> = { USD: '$', CNY: '¥', EUR: '€', GBP: '£', JPY: '¥', HKD: 'HK$' };
export function formatMoney(value: number | null, currency: string) {
  if (value === null) return '未定价';
  const symbol = symbols[currency] ?? `${currency} `;
  if (value === 0) return `${symbol}0`;
  if (value < 0.01) return `<${symbol}0.01`;
  const digits = value >= 1000 ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return `${symbol}${value.toLocaleString('en-US', digits)}`;
}
export const exactMoney = (value: number | null, currency: string) => value === null ? '没有可用价格' : `${currency} ${value.toFixed(4)}`;

export const ratio = (part: number, whole: number) => whole > 0 ? part / whole : 0;
export function formatPercent(value: number) {
  if (value <= 0) return '0%';
  if (value < 0.001) return '<0.1%';
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

/** Token buckets in stacking order, bottom to top. */
export const tokenParts = [
  { key: 'input', label: '新输入', hint: '没有命中缓存的提示词 token' },
  { key: 'cacheRead', label: '缓存读取', hint: '从缓存读取的提示词 token，通常按低价计费' },
  { key: 'cacheWrite', label: '缓存写入', hint: '写入缓存的提示词 token' },
  { key: 'output', label: '输出', hint: '模型生成的 token，包含推理' },
] as const satisfies ReadonlyArray<{ key: keyof UsageTotals; label: string; hint: string }>;

/** Share of prompt tokens served from cache. */
export const cacheHitRate = (totals: UsageTotals) => ratio(totals.cacheRead, totals.input + totals.cacheRead + totals.cacheWrite);

const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (value: number) => String(value).padStart(2, '0');
export function bucketLabel(bucket: Pick<UsageBucket, 'start' | 'end'>, kind: 'hour' | 'day' | 'month', long: boolean, multiYear = false) {
  const date = new Date(bucket.start);
  if (kind === 'hour') {
    if (!long) return `${pad(date.getHours())}:00`;
    const end = new Date(bucket.end);
    return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:00–${pad(end.getHours() === 0 && end.getTime() > date.getTime() ? 24 : end.getHours())}:00`;
  }
  if (kind === 'day') return long ? `${date.getMonth() + 1}月${date.getDate()}日 ${weekdays[date.getDay()]}` : `${date.getMonth() + 1}/${date.getDate()}`;
  return long || multiYear ? `${date.getFullYear()}年${date.getMonth() + 1}月` : `${date.getMonth() + 1}月`;
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

export const clockTime = (ms: number) => new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
export function shortDate(ms: number | null) {
  if (ms === null) return '时间未知';
  const date = new Date(ms);
  const now = new Date();
  const start = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((start(now) - start(date)) / DAY_MS);
  if (days <= 0) return `今天 ${clockTime(ms)}`;
  if (days === 1) return `昨天 ${clockTime(ms)}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
