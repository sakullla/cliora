import type { UsageMetric } from '../../types/usage';

export function usagePercent(metric: UsageMetric): number | null {
  if (metric.unlimited) return null;
  if (metric.sourcePercent !== null) return metric.sourcePercent;
  if (metric.total === null || metric.total <= 0) return null;
  const used = metric.used ?? (metric.remaining === null ? null : metric.total - metric.remaining);
  return used === null ? null : used / metric.total * 100;
}
export function usageUnit(metric: UsageMetric): string {
  const unit = metric.unit;
  return unit.kind === 'currency' ? unit.code : unit.kind === 'custom' ? unit.label : { tokens: 'Token', requests: '次', credits: '积分' }[unit.kind];
}
export function usageAmount(value: number): string { return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value); }
export function usageReset(metric: UsageMetric, now: number): string {
  const window = metric.window;
  if (!window) return '';
  const kind = window.recovery === 'rolling' ? '滚动恢复' : window.recovery === 'fixed' ? '重置' : '恢复方式未知';
  if (!window.resetsAt) return kind;
  const seconds = Math.ceil((Date.parse(window.resetsAt) - now) / 1000);
  return seconds <= 0 ? `${kind}时间已到，待刷新` : `${kind}：${seconds >= 3600 ? `${Math.ceil(seconds / 3600)} 小时` : `${Math.ceil(seconds / 60)} 分钟`}后`;
}
