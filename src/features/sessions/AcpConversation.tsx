import { forwardRef, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { AcpAccessKind, AcpAttachment, AcpFileList, AcpImageFile, AcpNativeSessionPage, AcpSessionSnapshot } from '../../types/acp';
import type { AcpConversation as Conversation } from './acpSession';
import { acpIsLive, acpNeedsLogin, acpResumeKey, acpTurnActive } from './acpSession';
import type { AccessAnswer } from './acp/AcpAccessCard';
import { AcpAuthPanel } from './acp/AcpAuthPanel';
import { AcpComposer, type AcpComposerHandle } from './acp/AcpComposer';
import type { ElicitationAction } from './acp/AcpElicitationForm';
import { AcpHistoryDialog } from './acp/AcpHistoryDialog';
import { AcpPendingBar } from './acp/AcpPendingBar';
import { AcpPlan } from './acp/AcpPlan';
import { AcpSessionBar } from './acp/AcpSessionBar';
import { AcpTimeline, type AcpTimelineHandle } from './acp/AcpTimeline';
import { pendingItems, pendingRequest } from './acp/acpView';
import workbenchStyles from './SessionWorkbench.module.css';
import styles from './AcpConversation.module.css';

/** A card or form that belongs to a turn waits for an answer. The host never
 *  counts the user's own card (a dropped image) toward waiting_permission: a turn
 *  stays running, and stoppable, while that card waits. A subagent's card between
 *  turns may report waiting_permission, but it leaves no turn to stop. */
function turnWaiting(snapshot: AcpSessionSnapshot): boolean {
  if (snapshot.state !== 'waiting_permission') return false;
  const pending = new Set(snapshot.pending);
  return snapshot.timeline.some((item) => {
    const request = pendingRequest(item);
    if (!request || !pending.has(request)) return false;
    if (item.kind === 'access' && item.userPath != null) return false;
    return 'turnId' in item && !!item.turnId;
  });
}

/** What the workbench may ask of a mounted conversation: the shared quick input and
 *  a native drop route their attachments here, and the pane menu opens the history. */
export type AcpConversationHandle = AcpComposerHandle & { openHistory: () => void };

/**
 * One ACP conversation: a native chat view, not a terminal. The session bar says
 * what the conversation is and how far it may reach; the plan is pinned above the
 * ordered timeline (messages, tool cards with their authorization cards, approval
 * cards, forms and records, notices, turn ends, subagents); "N items wait for you"
 * sits above the composer, which gives way to the login panel while the agent
 * waits for a login. The pane frame is the shared session card, so the rail, the
 * title bar, the split and the keyboard menu treat it like any other session.
 */
export const AcpConversation = forwardRef<AcpConversationHandle, {
  conversation: Conversation;
  toolName: string;
  active: boolean;
  focused?: boolean;
  pane?: number;
  header?: ReactNode;
  /** Submits one prompt with its attachments. The first prompt of a launch was already sent natively. */
  onSend: (text: string, attachments: AcpAttachment[]) => Promise<void>;
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
  onSetMode: (modeId: string) => Promise<void>;
  onSetConfig: (configId: string, value: string | boolean) => Promise<void>;
  onAuthenticate: (methodId: string) => Promise<void>;
  /** Opens a terminal session in the same directory to log in there. */
  onLoginTerminal?: () => Promise<void>;
  onRespondElicitation: (requestId: string, action: ElicitationAction, content: Record<string, unknown> | null) => Promise<void>;
  onListFiles: (query: string) => Promise<AcpFileList>;
  /** Reads a dropped image file for the composer's preview. */
  onReadImage: (path: string) => Promise<AcpImageFile>;
  onNativeSessions: (cursor: string | null) => Promise<AcpNativeSessionPage>;
  onDeleteNativeSession: (nativeId: string) => Promise<void>;
  /** Opens the chosen native session in a new pane. */
  onResumeNative: (nativeId: string) => Promise<void>;
  /** Starts a new conversation in the same directory (the pane menu's action). */
  onNewConversation?: () => Promise<void>;
}>(function AcpConversation({ conversation, toolName, active, focused = active, pane, header, onSend, onStop, onAnswer, onAnswerAccess, onRevokeGrants, onKillTerminal, onOpenPath, onClose,
  onSetMode, onSetConfig, onAuthenticate, onLoginTerminal, onRespondElicitation, onListFiles, onReadImage, onNativeSessions, onDeleteNativeSession, onResumeNative, onNewConversation }, ref) {
  const { t } = useTranslation();
  const snapshot = conversation.snapshot;
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const timelineRef = useRef<AcpTimelineHandle | null>(null);
  const composerRef = useRef<AcpComposerHandle | null>(null);
  const locateIndex = useRef(0);
  const live = acpIsLive(snapshot);
  const login = acpNeedsLogin(snapshot);
  // Waiting for an answer is still inside the turn: the main button stops it.
  const turnBusy = acpTurnActive(snapshot) || turnWaiting(snapshot);
  const resumeKey = acpResumeKey(snapshot.resume);
  const placement = pane != null && pane >= 0 ? { gridColumn: pane + 1, gridRow: 1 } : undefined;
  const waiting = pendingItems(snapshot);

  useImperativeHandle(ref, () => ({
    addFiles: (files) => composerRef.current?.addFiles(files),
    addPaths: (paths) => composerRef.current?.addPaths(paths),
    submitText: (text) => composerRef.current ? composerRef.current.submitText(text) : onSend(text, []),
    focus: () => composerRef.current?.focus(),
    openHistory: () => setHistoryOpen(true),
  }));

  async function run(key: string, action: () => Promise<void>) {
    if (pending) return;
    setPending(key);
    setError('');
    try {
      await action();
    } catch (value) {
      setError(String((value as { message?: string })?.message ?? value));
    } finally { setPending(''); }
  }

  function locatePending() {
    if (!waiting.length) return;
    const index = locateIndex.current % waiting.length;
    locateIndex.current = index + 1;
    timelineRef.current?.scrollToItem(waiting[index]);
  }

  const canSend = live && !login && snapshot.state !== 'starting';

  return <div className={workbenchStyles.terminalInstance} hidden={!active} style={placement} data-pane-session={snapshot.id} data-acp="true" data-focused={(active && focused) || undefined} data-running={live || undefined}>
    {header}
    <div className={styles.acpBody} data-acp-body={snapshot.id}>
      <AcpSessionBar snapshot={snapshot} toolName={toolName} onRevoke={onRevokeGrants} onHistory={() => setHistoryOpen(true)} />
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
        onRespondElicitation={onRespondElicitation}
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
      {login
        ? <AcpAuthPanel snapshot={snapshot} toolName={toolName} onAuthenticate={onAuthenticate} onLoginTerminal={onLoginTerminal} />
        : <AcpComposer
          ref={composerRef}
          snapshot={snapshot}
          toolName={toolName}
          live={live}
          turnBusy={turnBusy}
          busy={!!pending}
          canSend={canSend}
          onSend={onSend}
          onStop={() => void run('stop', onStop)}
          onClose={() => void run('close', onClose)}
          onListFiles={onListFiles}
          onReadImage={onReadImage}
          onWithdrawAccess={(requestId) => onAnswerAccess(requestId, 'deny')}
          onSetMode={onSetMode}
          onSetConfig={onSetConfig}
        />}
    </div>
    {historyOpen && createPortal(<AcpHistoryDialog open={historyOpen} snapshot={snapshot} toolName={toolName} onClose={() => setHistoryOpen(false)} onList={onNativeSessions} onDelete={onDeleteNativeSession} onResume={onResumeNative} onNewConversation={onNewConversation} />, document.body)}
  </div>;
});
