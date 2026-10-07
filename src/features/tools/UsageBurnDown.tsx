import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { UsageMetric, UsageSample } from '../../types/usage';
import i18n from '../../i18n';
import styles from './UsageQuota.module.css';

interface Reading { t: number; value: number }

/** Remaining-quota readings for one metric, ascending by measurement time. */
function readings(metricId: string, samples: UsageSample[]): Reading[] {
  const points: Reading[] = [];
  for (const sample of samples) {
    const metric = sample.snapshot.result.metrics.find(item => item.id === metricId);
    if (!metric || metric.unlimited) continue;
    const value = metric.remaining ?? (metric.used !== null && metric.total !== null ? metric.total - metric.used : null);
    if (value === null) continue;
    points.push({ t: sample.measuredAt, value });
  }
  return points.sort((a, b) => a.t - b.t);
}

/** A rising reading marks a refill/reset; later readings start a new segment. */
function segments(points: Reading[]): Reading[][] {
  const result: Reading[][] = [];
  let current: Reading[] = [];
  for (const point of points) {
    if (current.length && point.value > current[current.length - 1].value) { result.push(current); current = []; }
    current.push(point);
  }
  if (current.length) result.push(current);
  return result;
}

function estimateDuration(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
  return days
    ? i18n.t(hours ? 'tools.usage.durationDaysHours' : 'tools.usage.durationDays', { days, hours })
    : hours
      ? i18n.t(rest ? 'tools.usage.durationHoursMinutes' : 'tools.usage.durationHours', { hours, rest })
      : i18n.t('tools.usage.durationMinutes', { minutes });
}

/**
 * Linear depletion time (unix seconds) extrapolated from the latest segment.
 * Null when the segment is too short, has no consumption, or is already depleted.
 */
export function depletionEstimate(points: Reading[], now: number): number | null {
  const latest = segments(points).pop() ?? [];
  if (latest.length < 3) return null;
  const first = latest[0], last = latest[latest.length - 1];
  const elapsed = last.t - first.t, consumed = first.value - last.value;
  if (elapsed <= 0 || consumed <= 0 || last.value <= 0) return null;
  const at = last.t + last.value / (consumed / elapsed);
  return at > now ? at : null;
}

export function BurnDown({ metric, label, samples, now }: { metric: UsageMetric; label: string; samples: UsageSample[]; now: number }) {
  const { t, i18n: instance } = useTranslation();
  const points = useMemo(() => readings(metric.id, samples), [metric.id, samples]);
  if (points.length < 2) return null;
  const parts = segments(points);
  const width = 100, height = 34, pad = 2;
  const t0 = points[0].t, t1 = points[points.length - 1].t, span = Math.max(1, t1 - t0);
  const max = Math.max(...points.map(point => point.value), 1e-9);
  const x = (t: number) => (t - t0) / span * width;
  const y = (value: number) => height - pad - Math.max(0, value) / max * (height - pad * 2);
  const nowSeconds = Math.floor(now / 1000);
  const estimate = depletionEstimate(points, nowSeconds);
  const last = points[points.length - 1];
  return <figure className={styles.burnDown}>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={t('tools.burnDown.aria', { label })}>
      {parts.map((part, index) => part.length > 1
        ? <polyline key={index} points={part.map(point => `${x(point.t)},${y(point.value)}`).join(' ')} />
        : <circle key={index} cx={x(part[0].t)} cy={y(part[0].value)} r={1.5} />)}
      <circle cx={x(last.t)} cy={y(last.value)} r={2} />
    </svg>
    {estimate !== null && <figcaption><small title={new Date(estimate * 1000).toLocaleString(instance.language === 'en' ? 'en-US' : 'zh-CN')}>{t('tools.burnDown.depletion', { duration: estimateDuration(estimate - nowSeconds) })}</small></figcaption>}
  </figure>;
}
