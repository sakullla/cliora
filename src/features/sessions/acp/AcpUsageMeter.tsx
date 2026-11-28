import { useTranslation } from 'react-i18next';
import type { AcpUsage } from '../../../types/acp';
import { formatTokens, usageLevel } from './acpView';
import styles from './acpComposer.module.css';

const RADIUS = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * The context window the agent reported, in the input card next to the send button:
 * a small ring and "132K / 500K" (K/M/B in every language). A narrow pane keeps the
 * ring and the percentage. From 80% on it turns to the warning color and says it is
 * near the limit; hovering or focusing it shows the exact numbers and the cost. An
 * unknown size shows only what was used, without a ring share. Nothing is shown
 * until the agent reports usage.
 */
export function AcpUsageMeter({ usage, compact }: { usage: AcpUsage | null | undefined; compact: boolean }) {
  const { t } = useTranslation();
  if (!usage) return null;
  const { ratio, high } = usageLevel(usage.used, usage.size);
  const percent = ratio == null ? null : Math.round(ratio * 100);
  const exact = ratio == null
    ? t('sessions.acpUsageUsed', { used: usage.used.toLocaleString() })
    : t('sessions.acpUsagePercent', { used: usage.used.toLocaleString(), size: usage.size.toLocaleString(), percent });
  const cost = usage.cost
    ? t('sessions.acpUsageCost', { amount: usage.cost.amount.toLocaleString(undefined, { maximumFractionDigits: 4 }), currency: usage.cost.currency })
    : '';
  const detail = [exact, cost, high ? t('sessions.acpUsageHigh') : ''].filter(Boolean).join(' · ');
  const label = ratio == null
    ? formatTokens(usage.used)
    : compact ? `${percent}%` : `${formatTokens(usage.used)} / ${formatTokens(usage.size)}`;
  const filled = ratio == null ? 0 : Math.min(1, ratio) * CIRCUMFERENCE;

  return <span
    className={styles.usage}
    data-acp-usage=""
    data-level={high ? 'high' : 'normal'}
    role="meter"
    tabIndex={0}
    aria-label={t('sessions.acpUsageLabel')}
    aria-valuemin={0}
    aria-valuemax={usage.size > 0 ? usage.size : undefined}
    aria-valuenow={usage.used}
    aria-valuetext={detail}
  >
    {ratio != null && <svg className={styles.usageRing} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle className={styles.usageTrack} cx="7" cy="7" r={RADIUS} />
      <circle className={styles.usageFill} cx="7" cy="7" r={RADIUS} strokeDasharray={`${filled} ${CIRCUMFERENCE}`} transform="rotate(-90 7 7)" />
    </svg>}
    <span className={styles.usageText} aria-hidden="true">{label}</span>
    <span className={styles.usageTip} data-acp-usage-tip="" aria-hidden="true">{detail}</span>
  </span>;
}
