import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../../components/Icon';
import type { SyncTransfer } from '../../types/portable';
import { Badge, IconButton } from '../../components/ui';
import styles from './Sync.module.css';

export const MIN_PASSPHRASE = 12;

/** "3 minutes ago" for recent times, otherwise the date; the absolute time goes in a tooltip. */
export function relativeTime(seconds: number, language: string) {
  const locale = language === 'en' ? 'en-US' : 'zh-CN';
  const delta = Math.round(seconds - Date.now() / 1000);
  const absolute = new Date(seconds * 1000).toLocaleString(locale);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const span = Math.abs(delta);
  if (span < 45) return { text: format.format(0, 'second'), absolute };
  if (span < 3600) return { text: format.format(Math.round(delta / 60), 'minute'), absolute };
  if (span < 86400) return { text: format.format(Math.round(delta / 3600), 'hour'), absolute };
  if (span < 86400 * 7) return { text: format.format(Math.round(delta / 86400), 'day'), absolute };
  return { text: new Date(seconds * 1000).toLocaleDateString(locale), absolute };
}

export function endpointHost(endpoint: string | null | undefined) {
  if (!endpoint) return '';
  try { return new URL(endpoint).host; } catch { return ''; }
}

export function Notice({ tone, children, onDismiss }: { tone: 'error' | 'success' | 'info' | 'warning'; children: ReactNode; onDismiss?: () => void }) {
  const { t } = useTranslation();
  const icon: IconName = tone === 'error' ? 'alert' : tone === 'success' ? 'check' : tone === 'warning' ? 'alert' : 'info';
  return <div className={styles.notice} data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
    <span className={styles.noticeIcon}><Icon name={icon} size={16} /></span>
    <div className={styles.noticeText}>{children}</div>
    {onDismiss && <IconButton size="sm" className={styles.noticeClose} aria-label={t('common.dialog.close')} icon={<Icon name="close" size={14} />} onClick={onDismiss} />}
  </div>;
}

/** One passphrase input with a reveal toggle and an optional length meter toward the minimum. */
export function PassphraseField({ label, value, onChange, placeholder, autoComplete, onEnter, meter, hint, autoFocus }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete: string;
  onEnter?: () => void;
  meter?: boolean;
  hint?: ReactNode;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const [reveal, setReveal] = useState(false);
  const id = useId();
  const ratio = Math.min(1, value.length / MIN_PASSPHRASE);
  return <div className={styles.field}>
    <label htmlFor={id}>{label}</label>
    <div className={styles.secret}>
      <span className={styles.fieldIcon} aria-hidden="true"><Icon name="lock" size={16} /></span>
      <input id={id} type={reveal ? 'text' : 'password'} value={value} autoComplete={autoComplete} placeholder={placeholder} autoFocus={autoFocus} spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && onEnter) { event.preventDefault(); onEnter(); } }} />
      <IconButton size="sm" className={styles.reveal} aria-label={reveal ? t('settings.migration.hidePassword') : t('settings.migration.showPassword')} aria-pressed={reveal} icon={<Icon name={reveal ? 'eyeOff' : 'eye'} size={16} />} onClick={() => setReveal((current) => !current)} />
    </div>
    {meter && <div className={styles.meter} data-ok={ratio >= 1 || undefined} aria-hidden="true"><span style={{ width: `${Math.round(ratio * 100)}%` }} /></div>}
    {hint && <small className={styles.fieldHint} data-ok={meter && ratio >= 1 ? '' : undefined}>{hint}</small>}
  </div>;
}

export function TextField({ label, icon, hint, ...input }: { label: string; icon: IconName; hint?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return <div className={styles.field}>
    <label htmlFor={id}>{label}</label>
    <div className={styles.secret}>
      <span className={styles.fieldIcon} aria-hidden="true"><Icon name={icon} size={16} /></span>
      <input id={id} spellCheck={false} {...input} />
    </div>
    {hint && <small className={styles.fieldHint}>{hint}</small>}
  </div>;
}

export function useKindLabel() {
  const { t } = useTranslation();
  return (kind: string, scope: 'webdav' | 'migration' = 'webdav') => {
    const known = ['preferences', 'profile', 'common', 'project', 'library', 'mcp', 'skill', 'account', 'binding'];
    return known.includes(kind) ? t(`settings.${scope}.kind.${kind}`) : kind;
  };
}

export function TransferList({ items, limit, live }: { items: Pick<SyncTransfer, 'direction' | 'key' | 'label' | 'kind' | 'deleted'>[]; limit?: number; live?: boolean }) {
  const { t } = useTranslation();
  const kindLabel = useKindLabel();
  const shown = limit ? items.slice(0, limit) : items;
  return <ul className={styles.transfers} aria-live={live ? 'polite' : undefined}>
    {shown.map((item, index) => {
      const down = item.direction === 'download';
      const name = item.deleted || !item.label ? t('settings.webdav.deletedItem', { kind: kindLabel(item.kind) }) : item.label;
      return <li key={`${item.direction}:${item.key}:${index}`} data-direction={down ? 'download' : 'upload'} data-deleted={item.deleted || undefined}>
        <span className={styles.transferIcon} title={down ? t('settings.webdav.directionDownload') : t('settings.webdav.directionUpload')}>
          <Icon name={down ? 'arrowDown' : 'upload'} size={14} />
          <span className={styles.srOnly}>{down ? t('settings.webdav.directionDownload') : t('settings.webdav.directionUpload')}</span>
        </span>
        <span className={styles.transferName}>{name}</span>
        <Badge className={styles.kindChip}>{kindLabel(item.kind)}</Badge>
      </li>;
    })}
  </ul>;
}

export function Metric({ label, value, icon, tone }: { label: string; value: ReactNode; icon: IconName; tone?: 'accent' | 'info' | 'warning' | 'muted'; }) {
  return <div className={styles.metric} data-tone={tone}>
    <span className={styles.metricIcon} aria-hidden="true"><Icon name={icon} size={16} /></span>
    <span className={styles.metricBody}><small>{label}</small><strong>{value}</strong></span>
  </div>;
}
