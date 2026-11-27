import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GuideDialog } from '../../../components/GuideDialog';
import { Icon } from '../../../components/Icon';
import { Button } from '../../../components/ui';
import type { AcpNativeSession, AcpNativeSessionPage, AcpSessionSnapshot } from '../../../types/acp';
import { visibleControls } from './acpView';
import styles from './acpComposer.module.css';

function errorText(value: unknown): string {
  return String((value as { message?: string })?.message ?? value);
}

function when(value: string | null, locale: string): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  try { return new Date(time).toLocaleString(locale); } catch { return value; }
}

/**
 * The agent's own session history for this directory, read through the open
 * conversation. Resuming opens the chosen session in a new pane; deleting asks
 * once more before anything is sent. An agent that did not declare listing gets
 * its reason instead of a list, and the way forward: a new conversation.
 */
export function AcpHistoryDialog({ open, snapshot, toolName, onClose, onList, onDelete, onResume, onNewConversation }: {
  open: boolean;
  snapshot: AcpSessionSnapshot;
  toolName: string;
  onClose: () => void;
  onList: (cursor: string | null) => Promise<AcpNativeSessionPage>;
  onDelete: (nativeId: string) => Promise<void>;
  onResume: (nativeId: string) => Promise<void>;
  /** Starts a new conversation in the same directory. */
  onNewConversation?: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const capabilities = snapshot.agent?.sessionCapabilities;
  const listable = !!capabilities?.list;
  const deletable = !!capabilities?.delete;
  const [sessions, setSessions] = useState<AcpNativeSession[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [rowError, setRowError] = useState('');
  const generation = useRef(0);

  async function load(from: string | null) {
    const id = generation.current;
    setLoading(true);
    setLoadError('');
    try {
      const page = await onList(from);
      if (generation.current !== id) return;
      setSessions((current) => {
        const known = new Set(from ? current.map((item) => item.nativeId) : []);
        const fresh = (page.sessions ?? []).filter((item) => !known.has(item.nativeId));
        return from ? [...current, ...fresh] : fresh;
      });
      setCursor(page.nextCursor ?? null);
    } catch (value) {
      if (generation.current === id) setLoadError(errorText(value));
    } finally {
      if (generation.current === id) setLoading(false);
    }
  }

  useEffect(() => {
    generation.current += 1;
    setSessions([]);
    setCursor(null);
    setConfirm(null);
    setRowError('');
    setLoadError('');
    if (open && listable) void load(null);
    // A fresh list each time the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, listable]);

  async function remove(item: AcpNativeSession) {
    if (busy) return;
    setBusy(`delete:${item.nativeId}`);
    setRowError('');
    try {
      await onDelete(item.nativeId);
      setSessions((current) => current.filter((entry) => entry.nativeId !== item.nativeId));
      setConfirm(null);
    } catch (value) {
      setRowError(t('sessions.acpHistoryDeleteFailed', { reason: errorText(value) }));
    } finally { setBusy(''); }
  }

  async function startNew() {
    if (busy || !onNewConversation) return;
    setBusy('new');
    setRowError('');
    try {
      await onNewConversation();
      onClose();
    } catch (value) {
      setRowError(errorText(value));
    } finally { setBusy(''); }
  }

  async function resume(item: AcpNativeSession) {
    if (busy) return;
    setBusy(`resume:${item.nativeId}`);
    setRowError('');
    try {
      await onResume(item.nativeId);
      onClose();
    } catch (value) {
      setRowError(errorText(value));
    } finally { setBusy(''); }
  }

  return <GuideDialog open={open} title={t('sessions.acpHistoryTitle', { tool: toolName })} hint={listable ? t('sessions.acpHistoryHint') : undefined} closeDisabled={busy.startsWith('resume:') || busy === 'new'} onClose={onClose}>
    <div className={styles.history} data-acp-history="">
      {!listable ? <>
        <div className={styles.historyNote} role="status" data-acp-history-unsupported="">
          <span>{t('sessions.acpHistoryUnsupported', { tool: toolName })}</span>
          {onNewConversation && <Button size="sm" variant="primary" disabled={!!busy} onClick={() => void startNew()} icon={<Icon name="plus" size={12} />}>{t('sessions.acpNewConversation')}</Button>}
        </div>
        {rowError && <p className={styles.historyError} role="alert">{rowError}</p>}
      </> : <>
        {loadError && <div className={styles.historyNote} role="alert">
          <span>{t('sessions.acpHistoryFailed', { reason: loadError })}</span>
          <Button size="sm" variant="secondary" onClick={() => void load(sessions.length ? cursor : null)}>{t('sessions.acpHistoryRetry')}</Button>
        </div>}
        {rowError && <p className={styles.historyError} role="alert">{rowError}</p>}
        {!loadError && !loading && !sessions.length && <p className={styles.historyNote}>{t('sessions.acpHistoryEmpty')}</p>}
        {sessions.length > 0 && <ul className={styles.historyList} aria-label={t('sessions.acpHistory')}>
          {sessions.map((item) => {
            const title = item.title ? visibleControls(item.title) : t('sessions.acpHistoryUntitled');
            const updated = when(item.updatedAt, i18n.language);
            const asking = confirm === item.nativeId;
            return <li key={item.nativeId} className={styles.historyRow} data-native-id={item.nativeId} data-current={item.current || undefined}>
              <div className={styles.historyCopy}>
                <strong className={styles.historyTitle}>{title}</strong>
                <span className={styles.historyMeta}>
                  {item.current && <span className={styles.historyBadge}>{t('sessions.acpHistoryCurrent')}</span>}
                  {updated && <span>{t('sessions.acpHistoryUpdated', { time: updated })}</span>}
                  {item.cwd && <span className={styles.historyPath} title={item.cwd}>{item.cwd}</span>}
                </span>
                {asking && <span className={styles.historyAsk} role="status">{t('sessions.acpHistoryDeleteAsk', { title })}</span>}
              </div>
              <div className={styles.historyActions}>
                {asking ? <>
                  <Button size="sm" variant="danger" disabled={!!busy} onClick={() => void remove(item)}>{t('sessions.acpHistoryDeleteConfirm')}</Button>
                  <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => setConfirm(null)}>{t('sessions.acpHistoryDeleteCancel')}</Button>
                </> : <>
                  <Button size="sm" variant="primary" disabled={!!busy || item.current} title={item.current ? t('sessions.acpHistoryCurrent') : undefined} onClick={() => void resume(item)} icon={<Icon name="refresh" size={12} />}>{t('sessions.acpHistoryResume')}</Button>
                  {deletable && !item.current && <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => setConfirm(item.nativeId)} icon={<Icon name="trash" size={12} />}>{t('sessions.acpHistoryDelete')}</Button>}
                </>}
              </div>
            </li>;
          })}
        </ul>}
        {loading && <p className={styles.historyNote} role="status">{t('sessions.acpHistoryLoading')}</p>}
        {cursor && !loading && !loadError && <div className={styles.historyMore}>
          <Button size="sm" variant="secondary" onClick={() => void load(cursor)}>{t('sessions.acpHistoryMore')}</Button>
        </div>}
      </>}
    </div>
  </GuideDialog>;
}
