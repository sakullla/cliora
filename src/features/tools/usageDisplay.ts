import type { UsageMetric } from '../../types/usage';
import i18n from '../../i18n';

function numberLocale(): string {
  return i18n.language === 'en' ? 'en-US' : 'zh-CN';
}

export function usagePercent(metric: UsageMetric): number | null {
  if (metric.unlimited) return null;
  if (metric.sourcePercent !== null) return metric.sourcePercent;
  if (metric.total === null || metric.total <= 0) return null;
  const used = metric.used ?? (metric.remaining === null ? null : metric.total - metric.remaining);
  return used === null ? null : used / metric.total * 100;
}
export function usageUnit(metric: UsageMetric): string {
  const unit = metric.unit;
  return unit.kind === 'currency' ? unit.code : unit.kind === 'custom' ? unit.label : { tokens: 'Token', requests: i18n.t('tools.usage.unitRequests'), credits: i18n.t('tools.usage.unitCredits') }[unit.kind];
}
export function usageAmount(value: number): string { return new Intl.NumberFormat(numberLocale(), { maximumFractionDigits: 4 }).format(value); }
export function usageReset(metric: UsageMetric, now: number): string {
  const window = metric.window;
  if (!window) return '';
  const kind = window.recovery === 'rolling' ? i18n.t('tools.usage.recoveryRolling') : window.recovery === 'fixed' ? i18n.t('tools.usage.recoveryFixed') : window.resetsAt ? i18n.t('tools.usage.windowEnd') : i18n.t('tools.usage.recoveryUnknown');
  if (!window.resetsAt) return kind;
  const seconds = Math.ceil((Date.parse(window.resetsAt) - now) / 1000);
  if (seconds <= 0) return kind === i18n.t('tools.usage.windowEnd') ? i18n.t('tools.usage.windowEnded') : i18n.t('tools.usage.duePending', { kind });
  const minutes = Math.ceil(seconds / 60);
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
  const duration = days
    ? i18n.t(hours ? 'tools.usage.durationDaysHours' : 'tools.usage.durationDays', { days, hours })
    : hours
      ? i18n.t(rest ? 'tools.usage.durationHoursMinutes' : 'tools.usage.durationHours', { hours, rest })
      : i18n.t('tools.usage.durationMinutes', { minutes });
  return i18n.t('tools.usage.resetIn', { kind, duration });
}
