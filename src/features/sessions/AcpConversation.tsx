import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui';
import { modLabel } from '../../lib/shortcut';
import type { AcpConversation as Conversation } from './acpSession';
import { acpIsLive, acpResumeKey, acpStateKey, acpTurnActive, acpTurnKey } from './acpSession';
import workbenchStyles from './SessionWorkbench.module.css';
import styles from './AcpConversation.module.css';

/** How close to the bottom a reader may be and still follow new output. */
const FOLLOW_SLACK = 24;

/**
 * One ACP conversation: a native chat view, not a terminal. It renders the ordered
 * message stream, the tool calls merged by their call id, the authorization cards
 * bound to this turn's live request, and the turn's own result. The pane frame is
 * the shared session card, so the rail, the title bar, the split and the keyboard
 * menu treat it like any other session.
 */
export function AcpConversation({ conversation, toolName, active, focused = active, pane, header, onSend, onStop, onAnswer, onClose }: {
  conversation: Conversation;
  toolName: string;
  active: boolean;
  focused?: boolean;
  pane?: number;
  header?: ReactNode;
  /** Submits one prompt. The first prompt of a launch was already sent natively. */
  onSend: (text: string) => Promise<void>;
  onStop: () => Promise<void>;
  /** Answers exactly this request; the card disappears when the host confirms it. */
  onAnswer: (requestId: string, optionId: string | null) => Promise<void>;
  onClose: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const snapshot = conversation.snapshot;
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const logRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const live = acpIsLive(snapshot);
  const turnActive = acpTurnActive(snapshot);
  const lastMessage = snapshot.messages[snapshot.messages.length - 1];
  const streaming = snapshot.state === 'running' && !!lastMessage && lastMessage.role === 'agent';
  const turnKey = acpTurnKey(snapshot.lastTurnReason);
  const resumeKey = acpResumeKey(snapshot.resume);
  const placement = pane != null && pane >= 0 ? { gridColumn: pane + 1, gridRow: 1 } : undefined;

  // New output follows only while the reader is already at the bottom: scrolling up
  // to read must not be undone by the next chunk.
  const messageCount = snapshot.messages.length;
  const toolCount = snapshot.tools.length;
  useEffect(() => {
    const node = logRef.current;
    if (!node || !followRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [messageCount, toolCount, snapshot.permissions.length, active]);

  async function submit() {
    const text = draft.trim();
    if (!text || pending) return;
    setPending('send');
    setError('');
    try {
      await onSend(text);
      setDraft('');
    } catch (value) {
      setError(String((value as { message?: string })?.message ?? value));
    } finally { setPending(''); }
  }

  async function stop() {
    if (pending) return;
    setPending('stop');
    setError('');
    try { await onStop(); }
    catch (value) { setError(String((value as { message?: string })?.message ?? value)); }
    finally { setPending(''); }
  }

  async function answer(requestId: string, optionId: string | null) {
    if (pending) return;
    setPending(requestId);
    setError('');
    try { await onAnswer(requestId, optionId); }
    catch (value) { setError(String((value as { message?: string })?.message ?? value)); }
    finally { setPending(''); }
  }

  async function close() {
    if (pending) return;
    setPending('close');
    setError('');
    try { await onClose(); }
    catch (value) { setError(String((value as { message?: string })?.message ?? value)); }
    finally { setPending(''); }
  }

  const canCompose = live && !turnActive && snapshot.state !== 'starting';

  return <div className={workbenchStyles.terminalInstance} hidden={!active} style={placement} data-pane-session={snapshot.id} data-acp="true" data-focused={(active && focused) || undefined} data-running={live || undefined}>
    {header}
    <div className={styles.acpBody} data-acp-body={snapshot.id}>
      <div className={styles.acpMeta}>
        <span className={styles.acpMetaItem}><Icon name="terminal" size={12} />{toolName}</span>
        <span className={styles.acpMetaItem} title={snapshot.directory}><Icon name="folder" size={12} />{snapshot.directory}</span>
        <span className={styles.acpState} data-state={snapshot.state} role="status">{t(acpStateKey(snapshot.state))}</span>
      </div>
      <div ref={logRef} className={styles.acpLog} role="log" aria-live="polite" aria-label={t('sessions.acpLog', { tool: toolName })} onScroll={(event) => {
        const node = event.currentTarget;
        followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK;
      }}>
        {!snapshot.messages.length && !snapshot.tools.length && <p className={styles.acpEmpty}>{t('sessions.acpEmpty', { tool: toolName })}</p>}
        {snapshot.messages.map((message) => <div key={message.id} className={styles.acpMessage} data-role={message.role}>
          <span className={styles.acpRole}>{message.role === 'user' ? t('sessions.acpRoleUser') : message.role === 'thought' ? t('sessions.acpRoleThought') : t('sessions.acpRoleAgent', { tool: toolName })}</span>
          <p className={styles.acpText}>{message.text || ' '}{message.truncated && <span className={styles.acpTruncated}>{t('sessions.acpTruncated')}</span>}</p>
        </div>)}
        {streaming && <span className={styles.acpCursor} aria-hidden="true" />}
        {snapshot.tools.length > 0 && <section className={styles.acpTools} aria-label={t('sessions.acpTools')}>
          {snapshot.tools.map((call) => <div key={call.callId} className={styles.acpTool} data-status={call.status}>
            <span className={styles.acpToolHead}><Icon name="plug" size={12} /><strong>{call.title || call.callId}</strong><span className={styles.acpToolStatus}>{t(`sessions.acpTool${call.status === 'in_progress' ? 'Running' : call.status === 'completed' ? 'Done' : call.status === 'failed' ? 'Failed' : 'Pending'}`)}</span></span>
            {call.detail && <pre className={styles.acpToolDetail}>{call.detail}</pre>}
          </div>)}
        </section>}
      </div>
      {snapshot.permissions.length > 0 && <div className={styles.acpPermissions}>
        {snapshot.permissions.map((card) => <section key={card.requestId} className={styles.acpCard} role="group" aria-label={card.title} data-request-id={card.requestId}>
          <strong className={styles.acpCardTitle}><Icon name="shield" size={13} />{card.title}</strong>
          {card.detail && <p className={styles.acpCardDetail}>{card.detail}</p>}
          <div className={styles.acpCardOptions}>
            {card.options.map((option) => <Button key={option.optionId} size="sm" variant={option.kind.includes('reject') ? 'ghost' : 'primary'} disabled={!!pending} onClick={() => void answer(card.requestId, option.optionId)}>{option.name}</Button>)}
            <Button size="sm" variant="ghost" disabled={!!pending} onClick={() => void answer(card.requestId, null)}>{t('sessions.acpPermissionDismiss')}</Button>
          </div>
        </section>)}
      </div>}
      {(turnKey || resumeKey || snapshot.diagnostics.length > 0) && <div className={styles.acpFooter}>
        {turnKey && <p className={styles.acpTurn} data-reason={snapshot.lastTurnReason} role="status">{t(turnKey)}</p>}
        {resumeKey && <p className={styles.acpTurn} data-resume={snapshot.resume} role="status">{t(resumeKey)}</p>}
        {snapshot.diagnostics.length > 0 && <details className={styles.acpDiagnostics}>
          <summary>{t('sessions.acpDiagnostics', { count: snapshot.diagnostics.length })}</summary>
          <pre>{snapshot.diagnostics.join('\n')}</pre>
        </details>}
      </div>}
      {error && <p className={styles.acpError} role="alert">{error}</p>}
      <div className={styles.acpComposer}>
        <textarea
          className={styles.acpInput}
          aria-label={t('sessions.acpMessageLabel', { tool: toolName })}
          placeholder={live ? t('sessions.acpPlaceholder') : t('sessions.acpEndedPlaceholder')}
          value={draft}
          rows={3}
          disabled={!canCompose}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key !== 'Enter' || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void submit();
          }}
        />
        <div className={styles.acpActions}>
          <span className={styles.acpHint}>{canCompose ? t('sessions.acpSendHint', { mod: modLabel }) : live ? t('sessions.acpBusyHint') : t('sessions.acpEnded')}</span>
          {turnActive && <Button size="sm" variant="secondary" disabled={!!pending || snapshot.state === 'stopping'} onClick={() => void stop()} icon={<Icon name="square" size={12} />}>{snapshot.state === 'stopping' ? t('sessions.acpStopping') : t('sessions.acpStop')}</Button>}
          {!live && <Button size="sm" variant="ghost" disabled={!!pending} onClick={() => void close()}>{t('sessions.acpClose')}</Button>}
          <Button size="sm" variant="primary" disabled={!canCompose || !draft.trim() || !!pending} onClick={() => void submit()}>{t('sessions.acpSend')}</Button>
        </div>
      </div>
    </div>
  </div>;
}
