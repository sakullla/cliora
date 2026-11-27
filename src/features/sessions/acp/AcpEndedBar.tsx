import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import type { AcpSessionSnapshot } from '../../../types/acp';
import { visibleControls } from './acpView';
import styles from './acpComposer.module.css';

function errorText(value: unknown): string {
  return String((value as { message?: string })?.message ?? value);
}

function latestFailureDetail(snapshot: AcpSessionSnapshot): string {
  if (snapshot.authError?.trim()) return snapshot.authError.trim();
  for (let index = snapshot.timeline.length - 1; index >= 0; index -= 1) {
    const item = snapshot.timeline[index];
    if (item.kind === 'notice' && item.level === 'error' && item.text.trim()) {
      return item.text.trim();
    }
  }
  return '';
}

/**
 * Recovery banner shown in place of the disabled composer once an ACP conversation
 * has ended, failed, or disconnected. Mirrors the terminal endedBar while keeping
 * every action inside the pane's --term-* theme tokens and guarding against
 * duplicate launches.
 */
export function AcpEndedBar({
  snapshot,
  busy = false,
  onNewConversation,
  onOpenTerminal,
  onHistory,
  onClose,
}: {
  snapshot: AcpSessionSnapshot;
  busy?: boolean;
  onNewConversation?: () => Promise<void>;
  onOpenTerminal?: () => Promise<void>;
  onHistory?: () => void;
  onClose: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [action, setAction] = useState<'' | 'reopen' | 'terminal' | 'close'>('');
  const [error, setError] = useState('');

  const failed = snapshot.state === 'failed';
  const disconnected = !failed && snapshot.lastTurnReason === 'disconnected';
  const failureReason = failed ? latestFailureDetail(snapshot) : '';
  const title = t(failed ? 'sessions.acpFailedTitle' : 'sessions.acpEndedTitle');
  const detail = failureReason
    ? visibleControls(failureReason)
    : snapshot.lastTurnReason === 'disconnected'
      ? t('sessions.acpTurnDisconnected')
      : t('sessions.acpEndedHint');
  const disabled = busy || !!action;

  async function runAction(kind: 'reopen' | 'terminal' | 'close', task: () => Promise<void>) {
    if (disabled) return;
    setAction(kind);
    setError('');
    try {
      await task();
    } catch (value) {
      setError(errorText(value));
    } finally {
      setAction('');
    }
  }

  return <section
    className={styles.endedBar}
    data-acp-ended=""
    data-failed={failed || undefined}
    data-disconnected={disconnected || undefined}
    aria-label={title}
  >
    <div className={styles.endedMain}>
      <span className={styles.endedGlyph} aria-hidden="true">
        <Icon name={failed || disconnected ? 'alert' : 'info'} size={15} />
      </span>
      <div className={styles.endedCopy}>
        <strong className={styles.endedTitle}>{title}</strong>
        <p className={styles.endedDetail}>{detail}</p>
      </div>
      <div className={styles.endedActions}>
        {onNewConversation && <button
          type="button"
          className={styles.button}
          data-variant="primary"
          disabled={disabled}
          aria-busy={action === 'reopen' || undefined}
          onClick={() => void runAction('reopen', onNewConversation)}
        >
          <Icon name="refresh" size={13} />
          {action === 'reopen' ? t('sessions.acpReopening') : t('sessions.acpRestoreReopen')}
        </button>}
        {onOpenTerminal && <button
          type="button"
          className={styles.button}
          disabled={disabled}
          aria-busy={action === 'terminal' || undefined}
          onClick={() => void runAction('terminal', onOpenTerminal)}
        >
          <Icon name="terminal" size={13} />
          {action === 'terminal' ? t('sessions.acpOpeningTerminal') : t('sessions.acpOpenTerminalShort')}
        </button>}
        {onHistory && <button
          type="button"
          className={styles.button}
          data-variant="quiet"
          disabled={disabled}
          onClick={onHistory}
        >
          <Icon name="clock" size={13} />
          {t('sessions.acpHistory')}
        </button>}
        <button
          type="button"
          className={styles.button}
          data-variant="quiet"
          disabled={disabled}
          aria-busy={action === 'close' || undefined}
          onClick={() => void runAction('close', onClose)}
        >
          {t('sessions.acpClose')}
        </button>
      </div>
    </div>
    {error && <p className={styles.error} role="alert">{visibleControls(error)}</p>}
  </section>;
}
