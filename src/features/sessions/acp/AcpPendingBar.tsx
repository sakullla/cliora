import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import styles from './acp.module.css';

/**
 * "N items wait for you", above the composer. Each click brings the next waiting
 * card or form into view (cycling), so a card far up the timeline is never missed.
 */
export function AcpPendingBar({ count, onLocate }: { count: number; onLocate: () => void }) {
  const { t } = useTranslation();
  if (count <= 0) return null;
  return <div className={styles.pendingBar} data-acp-pending="">
    <Icon name="bell" size={13} />
    <span className={styles.pendingText}>{t('sessions.acpPendingCount', { count })}</span>
    <button type="button" className={styles.pendingLocate} onClick={onLocate}>{t('sessions.acpPendingLocate')}</button>
  </div>;
}
