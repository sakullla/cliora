import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { modLabel } from '../../lib/shortcut';
import type { AcpAccessKind } from '../../types/acp';
import type { AcpConversation as Conversation } from './acpSession';
import { acpIsLive, acpResumeKey, acpTurnActive } from './acpSession';
import type { AccessAnswer } from './acp/AcpAccessCard';
import { AcpPendingBar } from './acp/AcpPendingBar';
import { AcpPlan } from './acp/AcpPlan';
import { AcpSessionBar } from './acp/AcpSessionBar';
import { AcpTimeline, type AcpTimelineHandle } from './acp/AcpTimeline';
import { pendingItems } from './acp/acpView';
import workbenchStyles from './SessionWorkbench.module.css';
import styles from './AcpConversation.module.css';

/**
 * One ACP conversation: a native chat view, not a terminal. The session bar says
 * what the conversation is and how far it may reach; the plan is pinned above the
 * ordered timeline (messages, tool cards with their authorization cards, approval
 * cards and records, notices, turn ends, subagents); "N items wait for you" sits
 * above the composer. The pane frame is the shared session card, so the rail, the
 * title bar, the split and the keyboard menu treat it like any other session.
 */
export function AcpConversation({ conversation, toolName, active, focused = active, pane, header, onSend, onStop, onAnswer, onAnswerAccess, onRevokeGrants, onKillTerminal, onOpenPath, onClose }: {
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
  /** Answers one out-of-directory approval card. */
  onAnswerAccess: (accessId: string, decision: AccessAnswer) => Promise<void>;
  /** Revokes session grants; the next access of each kind asks again. */
  onRevokeGrants: (kinds: AcpAccessKind[]) => Promise<void>;
  /** Ends one terminal's process tree. */
  onKillTerminal: (terminalId: string) => Promise<void>;
  /** Opens a path inside the session directory; absent where nothing can be opened. */
  onOpenPath?: (target: string) => Promise<void>;
  onClose: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const snapshot = conversation.snapshot;
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const timelineRef = useRef<AcpTimelineHandle | null>(null);
  const locateIndex = useRef(0);
  const live = acpIsLive(snapshot);
  const turnActive = acpTurnActive(snapshot);
  const resumeKey = acpResumeKey(snapshot.resume);
  const placement = pane != null && pane >= 0 ? { gridColumn: pane + 1, gridRow: 1 } : undefined;
  const waiting = pendingItems(snapshot);

  async function run(key: string, action: () => Promise<void>, after?: () => void) {
    if (pending) return;
    setPending(key);
    setError('');
    try {
      await action();
      after?.();
    } catch (value) {
      setError(String((value as { message?: string })?.message ?? value));
    } finally { setPending(''); }
  }

  function submit() {
    const text = draft.trim();
    if (!text) return;
    void run('send', () => onSend(text), () => setDraft(''));
  }

  function locatePending() {
    if (!waiting.length) return;
    const index = locateIndex.current % waiting.length;
    locateIndex.current = index + 1;
    timelineRef.current?.scrollToItem(waiting[index]);
  }

  const canCompose = live && !turnActive && snapshot.state !== 'starting';

  return <div className={workbenchStyles.terminalInstance} hidden={!active} style={placement} data-pane-session={snapshot.id} data-acp="true" data-focused={(active && focused) || undefined} data-running={live || undefined}>
    {header}
    <div className={styles.acpBody} data-acp-body={snapshot.id}>
      <AcpSessionBar snapshot={snapshot} toolName={toolName} onRevoke={onRevokeGrants} />
      <AcpPlan entries={snapshot.plan} />
      <AcpTimeline
        ref={timelineRef}
        snapshot={snapshot}
        toolName={toolName}
        active={active}
        busyKey={pending}
        onAnswer={(requestId, optionId) => void run(requestId, () => onAnswer(requestId, optionId))}
        onAnswerAccess={(accessId, decision) => void run(accessId, () => onAnswerAccess(accessId, decision))}
        onKillTerminal={onKillTerminal}
        onOpenPath={onOpenPath}
      />
      {(resumeKey || snapshot.diagnostics.length > 0) && <div className={styles.acpFooter}>
        {resumeKey && <p className={styles.acpResume} data-resume={snapshot.resume} role="status">{t(resumeKey)}</p>}
        {snapshot.diagnostics.length > 0 && <details className={styles.acpDiagnostics}>
          <summary>{t('sessions.acpDiagnostics', { count: snapshot.diagnostics.length })}</summary>
          <pre>{snapshot.diagnostics.join('\n')}</pre>
        </details>}
      </div>}
      <AcpPendingBar count={waiting.length} onLocate={locatePending} />
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
            submit();
          }}
        />
        <div className={styles.acpActions}>
          <span className={styles.acpHint}>{canCompose ? t('sessions.acpSendHint', { mod: modLabel }) : live ? t('sessions.acpBusyHint') : t('sessions.acpEnded')}</span>
          {turnActive && <button type="button" className={styles.acpButton} data-variant="secondary" disabled={!!pending || snapshot.state === 'stopping'} onClick={() => void run('stop', onStop)}><Icon name="square" size={12} />{snapshot.state === 'stopping' ? t('sessions.acpStopping') : t('sessions.acpStop')}</button>}
          {!live && <button type="button" className={styles.acpButton} data-variant="quiet" disabled={!!pending} onClick={() => void run('close', onClose)}>{t('sessions.acpClose')}</button>}
          <button type="button" className={styles.acpButton} data-variant="primary" disabled={!canCompose || !draft.trim() || !!pending} onClick={submit}>{t('sessions.acpSend')}</button>
        </div>
      </div>
    </div>
  </div>;
}
