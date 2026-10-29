import { useTranslation } from 'react-i18next';
import type { UsageTotals } from '../../types/history';
import { Icon } from '../../components/Icon';
import { formatNativeValue, nativeUnitLabel } from './usageFormat';
import styles from './NativeUsageSummary.module.css';

/** Registry-independent native units; no token conversion or balance inference. One quiet line,
 *  with the per-unit values, billing flags and original values behind a disclosure. */
export function NativeUsageSummary({ totals }: { totals: UsageTotals }) {
  const { t } = useTranslation();
  const units = totals.nativeUsage ?? [];
  const unknown = totals.unknownTokenRecords ?? 0;
  if (!units.length && !unknown) return null;
  const lead = unknown ? t('records.native.unknownTokens', { count: unknown }) : t('records.native.extra');
  if (!units.length) return <p className={styles.note}><Icon name="info" size={14} /><span>{lead}</span></p>;
  return <section className={styles.note} aria-label={t('records.native.title')}>
    <details>
      <summary><Icon name="info" size={14} /><span>{lead}</span><small>{t('records.native.more', { count: units.length })}</small></summary>
      <ul>{units.map((usage) => <li key={`${usage.unit}:${usage.billable}`}>
        <b>{formatNativeValue(usage.value)}</b>{' '}<span title={nativeUnitLabel(usage.unit)}>{nativeUnitLabel(usage.unit)}</span>
        <small>{t(`records.native.${usage.billable === true ? 'billable' : usage.billable === false ? 'unbilled' : 'unknownBilling'}`)} · {t('records.native.original', { value: usage.originalValue === null ? t('records.native.unknown') : formatNativeValue(usage.originalValue) })}{usage.unknownOriginalRecords > 0 && ` · ${t('records.native.unknownOriginal', { count: usage.unknownOriginalRecords })}`}</small>
      </li>)}</ul>
      <p>{t('records.native.hint')}</p>
    </details>
  </section>;
}
