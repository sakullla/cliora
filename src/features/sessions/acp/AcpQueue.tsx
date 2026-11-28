import { useCallback, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import { AcpCopyButton } from './AcpCopyButton';
import { acpQueueSending, queueCopyText, queuePreview, readAcpQueue, subscribeAcpQueue, takeAcpEntry, type AcpQueueState, type QueuedPrompt } from './acpQueue.ts';
import styles from './acpComposer.module.css';

/** The queue of one session, re-rendered only when that queue changes. */
export function useAcpQueue(sessionId: string): AcpQueueState {
  const subscribe = useCallback((listener: () => void) => subscribeAcpQueue(sessionId, listener), [sessionId]);
  const read = useCallback(() => readAcpQueue(sessionId), [sessionId]);
  return useSyncExternalStore(subscribe, read);
}

/** Whether a send of this session waits for the host, whichever view started it. */
export function useAcpQueueSending(sessionId: string): boolean {
  const subscribe = useCallback((listener: () => void) => subscribeAcpQueue(sessionId, listener), [sessionId]);
  const read = useCallback(() => acpQueueSending(sessionId), [sessionId]);
  return useSyncExternalStore(subscribe, read);
}

/** Texts longer than this fold in the ended panel until expanded. */
const FOLD_CHARS = 280;
const FOLD_LINES = 6;

/**
 * The prompts waiting for the running turn to end, above the input card: one row each
 * with its preview and attachment count; each can go back into the input, be deleted
 * or be sent now (which stops the running turn first). A paused queue says so, with the
 * reason a send failed, and waits for "continue sending".
 */
export function AcpQueue({ sessionId, onEdit, onSendNow, onResume }: {
  sessionId: string;
  onEdit: (entry: QueuedPrompt) => void;
  onSendNow: (entry: QueuedPrompt) => void;
  onResume: () => void;
}) {
  const { t } = useTranslation();
  const queue = useAcpQueue(sessionId);
  if (!queue.items.length) return null;
  return <section className={styles.queue} aria-label={t('sessions.acpQueueLabel', { count: queue.items.length })} data-acp-queue="" data-paused={queue.paused || undefined}>
    {queue.paused && <div className={styles.queuePaused} role="status" data-acp-queue-paused="">
      <Icon name="info" size={12} />
      <span className={styles.queuePausedText}>
        {t('sessions.acpQueuePaused')}
        {queue.error && <span className={styles.queueError} data-acp-queue-error="">{t('sessions.acpQueueFailed', { reason: queue.error })}</span>}
      </span>
      <button type="button" className={styles.button} data-variant="quiet" data-acp-queue-resume="" onClick={onResume}>
        <Icon name="play" size={12} />{t('sessions.acpQueueResume')}
      </button>
    </div>}
    <ol className={styles.queueList}>
      {queue.items.map((entry) => {
        const preview = queuePreview(entry.text) || t('sessions.acpQueueNoText');
        return <li key={entry.id} className={styles.queueItem} data-acp-queue-item="" data-immediate={entry.immediate || undefined}>
          <Icon name={entry.immediate ? 'arrowUp' : 'clock'} size={12} className={styles.queueGlyph} />
          <span className={styles.queueText} title={entry.text}>{preview}</span>
          {entry.attachments.length > 0 && <span className={styles.queueMeta}>{t('sessions.acpQueueAttachments', { count: entry.attachments.length })}</span>}
          {entry.immediate && <span className={styles.queueMeta}>{t('sessions.acpQueueNext')}</span>}
          <span className={styles.queueActions}>
            <button type="button" className={styles.trayRemove} data-acp-queue-edit="" aria-label={t('sessions.acpQueueEdit', { text: preview })} title={t('sessions.acpQueueEditHint')} onClick={() => onEdit(entry)}>
              <Icon name="pencil" size={11} />
            </button>
            <button type="button" className={styles.trayRemove} data-acp-queue-delete="" aria-label={t('sessions.acpQueueDelete', { text: preview })} title={t('sessions.acpQueueDeleteHint')} onClick={() => { takeAcpEntry(sessionId, entry.id); }}>
              <Icon name="trash" size={11} />
            </button>
            {!entry.immediate && <button type="button" className={styles.trayRemove} data-acp-queue-now="" aria-label={t('sessions.acpQueueSendNow', { text: preview })} title={t('sessions.acpQueueSendNowHint')} onClick={() => onSendNow(entry)}>
              <Icon name="arrowUp" size={11} />
            </button>}
          </span>
        </li>;
      })}
    </ol>
  </section>;
}

function folds(text: string): boolean {
  return text.length > FOLD_CHARS || text.split('\n').length > FOLD_LINES;
}

/**
 * What was still queued when the conversation ended: nothing is dropped and nothing
 * is sent. Each prompt reads in full (a long one folds until expanded) and can be
 * copied, alone or all together separated by blank lines.
 */
export function AcpUnsentQueue({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const queue = useAcpQueue(sessionId);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  if (!queue.items.length) return null;
  const title = t('sessions.acpQueueUnsent', { count: queue.items.length });
  return <section className={styles.unsent} aria-label={title} data-acp-unsent="">
    <div className={styles.unsentHead}>
      <strong className={styles.unsentTitle}>{title}</strong>
      <span className={styles.unsentHint}>{t('sessions.acpQueueUnsentHint')}</span>
      <AcpCopyButton className={styles.unsentCopyAll} text={queueCopyText(queue.items)} label={t('sessions.acpQueueCopyAll')} />
    </div>
    <ol className={styles.queueList}>
      {queue.items.map((entry) => {
        const folded = folds(entry.text) && !expanded.has(entry.id);
        return <li key={entry.id} className={styles.unsentItem} data-acp-unsent-item="" data-folded={folded || undefined}>
          <p className={styles.unsentText}>{entry.text || t('sessions.acpQueueNoText')}</p>
          <div className={styles.unsentMeta}>
            {entry.attachments.length > 0 && <span className={styles.queueMeta}>{t('sessions.acpQueueAttachments', { count: entry.attachments.length })}</span>}
            {folds(entry.text) && <button type="button" className={styles.button} data-variant="quiet" aria-expanded={!folded} onClick={() => setExpanded((current) => {
              const next = new Set(current);
              if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
              return next;
            })}>{folded ? t('sessions.acpQueueExpand') : t('sessions.acpQueueCollapse')}</button>}
            <AcpCopyButton text={entry.text} label={t('sessions.acpQueueCopy')} />
          </div>
        </li>;
      })}
    </ol>
  </section>;
}
