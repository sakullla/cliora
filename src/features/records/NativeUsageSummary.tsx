import { useTranslation } from 'react-i18next';
import type { UsageTotals } from '../../types/history';
import { formatNativeValue, nativeUnitLabel } from './usageFormat';
import styles from './NativeUsageSummary.module.css';

/** Registry-independent native units; no token conversion or balance inference. */
export function NativeUsageSummary({ totals }: { totals: UsageTotals }) {
  const { t } = useTranslation();
  if (!totals.nativeUsage?.length) return totals.unknownTokenRecords
    ? <p className={styles.summary}>{t('records.native.unknownTokens', { count: totals.unknownTokenRecords })}</p>
    : null;
  return <section className={styles.summary} aria-label={t('records.native.title')}>
    <h3>{t('records.native.title')}</h3>
    <ul>{totals.nativeUsage.map((usage) => <li key={`${usage.unit}:${usage.billable}`}>
      <strong>{formatNativeValue(usage.value)} {nativeUnitLabel(usage.unit)}</strong>
      <span>{t(`records.native.${usage.billable === true ? 'billable' : usage.billable === false ? 'unbilled' : 'unknownBilling'}`)}</span>
      <small>{t('records.native.original', { value: usage.originalValue === null ? t('records.native.unknown') : formatNativeValue(usage.originalValue) })}{usage.unknownOriginalRecords > 0 && ` · ${t('records.native.unknownOriginal', { count: usage.unknownOriginalRecords })}`}</small>
    </li>)}</ul>
    <p>{t('records.native.hint')}{!!totals.unknownTokenRecords && ` ${t('records.native.unknownTokens', { count: totals.unknownTokenRecords })}`}</p>
  </section>;
}
