import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import type { AcpPermissionRequest } from '../../../types/acp';
import styles from './acp.module.css';

/** The agent's own options decide the button weight: allowing this once is the
 *  primary choice; allowing always is a lasting decision, so it stays secondary
 *  and is never the easiest button to hit; a reject option stays quiet. */
function optionVariant(kind: string): 'primary' | 'secondary' | 'quiet' {
  if (kind === 'allow_always') return 'secondary';
  return kind.startsWith('allow') ? 'primary' : 'quiet';
}

/**
 * An open authorization request, drawn on the tool call that asked. It answers
 * exactly its own request id; every option is disabled while an answer is in
 * flight, so a double click never answers twice.
 */
export function AcpPermissionCard({ title, request, busy, onAnswer }: {
  title: string;
  request: AcpPermissionRequest;
  busy: boolean;
  onAnswer: (requestId: string, optionId: string | null) => void;
}) {
  const { t } = useTranslation();
  return <section className={styles.card} role="group" aria-label={title} data-request-id={request.requestId} data-card="permission">
    <strong className={styles.cardTitle}><Icon name="shield" size={13} />{t('sessions.acpPermissionTitle')}</strong>
    <div className={styles.cardActions}>
      {request.options.map((option) => <button key={option.optionId} type="button" className={styles.action} data-variant={optionVariant(option.kind)} data-option-kind={option.kind} disabled={busy} onClick={() => onAnswer(request.requestId, option.optionId)}>{option.name}</button>)}
      <button type="button" className={styles.action} data-variant="quiet" disabled={busy} onClick={() => onAnswer(request.requestId, null)}>{t('sessions.acpPermissionDismiss')}</button>
    </div>
  </section>;
}
