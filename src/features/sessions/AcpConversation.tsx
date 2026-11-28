import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import type { AcpAccessKind, AcpAttachment, AcpFileList, AcpImageFile, AcpNativeSessionPage, AcpSessionSnapshot } from '../../types/acp';
import type { PromptContext } from '../../types/prompts';
import type { BusinessWorkspace } from '../../types/workspaces';
import type { AcpConversation as Conversation } from './acpSession';
import { acpIsLive, acpNeedsLogin, acpResumeKey, acpTurnActive } from './acpSession';
import type { AcpStore } from './acpStore';
import type { AccessAnswer } from './acp/AcpAccessCard';
import { AcpAuthPanel } from './acp/AcpAuthPanel';
import { AcpComposer, type AcpComposerHandle } from './acp/AcpComposer';
import { AcpCopyButton } from './acp/AcpCopyButton';
import type { ElicitationAction } from './acp/AcpElicitationForm';
import { AcpEndedBar } from './acp/AcpEndedBar';
import { AcpHistoryDialog } from './acp/AcpHistoryDialog';
import { AcpPendingBar } from './acp/AcpPendingBar';
import { AcpPlan } from './acp/AcpPlan';
import { AcpSessionBar } from './acp/AcpSessionBar';
import { AcpTimeline, type AcpTimelineHandle } from './acp/AcpTimeline';
import { searchAcpTimeline, type AcpFindMatch } from './acp/acpSearch';
import { pendingItems, pendingRequest } from './acp/acpView';
import workbenchStyles from './SessionWorkbench.module.css';
import styles from './AcpConversation.module.css';

export type { AcpFindMatch } from './acp/acpSearch';

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

/** What the workbench may ask of a mounted conversation: native drops route paths
 *  here, Ctrl+Shift+F searches and reveals matches symmetrically to SessionTerminal,
 *  history opens from the pane menu, and focus/fillDraft address the composer. */
export type AcpConversationHandle = AcpComposerHandle & {
  openHistory: () => void;
  findMatches: (query: string, caseSensitive?: boolean) => AcpFindMatch[];
  revealMatch: (match: AcpFindMatch | null) => void;
};

/**
 * One ACP conversation: a native chat view, not a terminal. The session bar says
 * what ACP-exclusive metadata applies; the plan is pinned above the ordered
 * timeline (messages, grouped lightweight tool calls, tool cards with their
 * authorization cards, approval cards, forms and records, notices, turn ends,
 * subagents); "N items wait for you" sits above the unified composer card, which
 * gives way to the login panel during auth_required or the recovery banner once
 * the conversation has ended. The pane frame is the shared session card, so the
 * rail, the title bar, the split and the keyboard menu treat it like any other
 * session.
 */
type AcpConversationProps = {
  toolName: string;
  active: boolean;
  focused?: boolean;
  pane?: number;
  header?: ReactNode;
  /** Scope context & workspace list for the integrated prompt library picker. */
  promptContext?: PromptContext | null;
  workspaces?: BusinessWorkspace[];
  /** Native desktop drag is currently hovering this session pane. */
  dropActive?: boolean;
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
  /** Opens a terminal session in the same directory from the ended recovery banner. */
  onOpenTerminal?: () => Promise<void>;
  onRespondElicitation: (requestId: string, action: ElicitationAction, content: Record<string, unknown> | null) => Promise<void>;
  onListFiles: (query: string) => Promise<AcpFileList>;
  /** Reads a dropped image file for the composer's preview. */
  onReadImage: (path: string) => Promise<AcpImageFile>;
  onNativeSessions: (cursor: string | null) => Promise<AcpNativeSessionPage>;
  onDeleteNativeSession: (nativeId: string) => Promise<void>;
  /** Opens the chosen native session in a new pane. */
  onResumeNative: (nativeId: string) => Promise<void>;
  /** Starts a new conversation in the same directory (the pane menu / ended banner action). */
  onNewConversation?: () => Promise<void>;
  /** Notifies the workbench when the conversation snapshot updates so find counts stay live. */
  onSearchRevision?: (sessionId: string) => void;
};

/**
 * The mounted conversation of one session. It subscribes to that session alone in the
 * workbench's store, so a chunk streaming into another conversation never renders it.
 * A retired session renders nothing until the workbench unmounts it.
 */
export const AcpConversation = forwardRef<AcpConversationHandle, AcpConversationProps & {
  store: AcpStore;
  sessionId: string;
}>(function AcpConversation({ store, sessionId, ...props }, ref) {
  const subscribe = useCallback((listener: () => void) => store.subscribe(sessionId, listener), [store, sessionId]);
  const read = useCallback(() => store.get(sessionId), [store, sessionId]);
  const conversation = useSyncExternalStore(subscribe, read);
  if (!conversation) return null;
  return <AcpConversationView ref={ref} conversation={conversation} {...props} />;
});

const AcpConversationView = forwardRef<AcpConversationHandle, AcpConversationProps & {
  conversation: Conversation;
}>(function AcpConversationView({
  conversation,
  toolName,
  active,
  focused = active,
  pane,
  header,
  promptContext = null,
  workspaces = [],
  dropActive = false,
  onSend,
  onStop,
  onAnswer,
  onAnswerAccess,
  onRevokeGrants,
  onKillTerminal,
  onOpenPath,
  onClose,
  onSetMode,
  onSetConfig,
  onAuthenticate,
  onLoginTerminal,
  onOpenTerminal,
  onRespondElicitation,
  onListFiles,
  onReadImage,
  onNativeSessions,
  onDeleteNativeSession,
  onResumeNative,
  onNewConversation,
  onSearchRevision,
}, ref) {
  const { t } = useTranslation();
  const snapshot = conversation.snapshot;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const onSearchRevisionRef = useRef(onSearchRevision);
  onSearchRevisionRef.current = onSearchRevision;
  const lastSnapshotRef = useRef({ id: snapshot.id, seq: snapshot.seq });

  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [searchState, setSearchState] = useState<{
    query: string;
    caseSensitive: boolean;
    active: AcpFindMatch | null;
  }>({ query: '', caseSensitive: false, active: null });

  const bodyRef = useRef<HTMLDivElement | null>(null);
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
  const canSend = live && !login && snapshot.state !== 'starting';
  const showDropOverlay = live && !login && (dragOver || dropActive);

  useEffect(() => {
    if (!live || login || !active) setDragOver(false);
  }, [live, login, active]);

  useEffect(() => {
    const previous = lastSnapshotRef.current;
    lastSnapshotRef.current = { id: snapshot.id, seq: snapshot.seq };
    if (previous.id !== snapshot.id || previous.seq === snapshot.seq) return;
    onSearchRevisionRef.current?.(snapshot.id);
  }, [snapshot.seq, snapshot.id]);

  useImperativeHandle(ref, () => ({
    addFiles: (files) => composerRef.current?.addFiles(files),
    addPaths: (paths) => composerRef.current?.addPaths(paths),
    submitText: (text) => composerRef.current ? composerRef.current.submitText(text) : onSend(text, []),
    fillDraft: (text) => composerRef.current?.fillDraft(text),
    triggerPrefix: (prefix) => composerRef.current?.triggerPrefix(prefix),
    openPromptPicker: () => composerRef.current?.openPromptPicker(),
    focus: () => {
      if (live && !login) composerRef.current?.focus();
      else if (login) bodyRef.current?.querySelector<HTMLButtonElement>('[data-acp-auth] button:not(:disabled)')?.focus();
      else bodyRef.current?.querySelector<HTMLElement>('[role="log"]')?.focus();
    },
    openHistory: () => setHistoryOpen(true),
    findMatches: (query, caseSensitive = false) => {
      const matches = searchAcpTimeline(snapshotRef.current, query, caseSensitive);
      setSearchState((current) => (current.query === query && current.caseSensitive === caseSensitive
        ? current
        : { ...current, query, caseSensitive }));
      return matches;
    },
    revealMatch: (match) => {
      if (!match) {
        setSearchState((current) => (current.query === '' && current.active === null
          ? current
          : { query: '', caseSensitive: false, active: null }));
        return;
      }
      setSearchState((current) => {
        if (current.active
          && current.active.itemId === match.itemId
          && current.active.occurrence === match.occurrence
          && current.active.groupId === match.groupId) {
          return current;
        }
        return { ...current, active: match };
      });
    },
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

  const diagnosticsText = snapshot.diagnostics.join('\n');

  return <div className={workbenchStyles.terminalInstance} hidden={!active} style={placement} data-pane-session={snapshot.id} data-acp="true" data-focused={(active && focused) || undefined} data-running={live || undefined}>
    {header}
    <div
      ref={bodyRef}
      className={styles.acpBody}
      data-acp-body={snapshot.id}
      data-drop-active={showDropOverlay || undefined}
      onDragOver={(event) => {
        if (!live || login || !event.dataTransfer?.types?.includes('Files')) return;
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(event) => {
        if (!bodyRef.current?.contains(event.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(event) => {
        setDragOver(false);
        if (!live || login) return;
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (!files.length) return;
        event.preventDefault();
        composerRef.current?.addFiles(files);
      }}
    >
      <AcpSessionBar snapshot={snapshot} toolName={toolName} inSplit={pane != null} onRevoke={onRevokeGrants} onHistory={() => setHistoryOpen(true)} />
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
        onReuseMessage={canSend ? (text) => composerRef.current?.fillDraft(text) : undefined}
        onQuickTrigger={canSend ? (prefix) => composerRef.current?.triggerPrefix(prefix) : undefined}
        onOpenPromptPicker={canSend && promptContext ? () => composerRef.current?.openPromptPicker() : undefined}
        searchQuery={searchState.query}
        searchCase={searchState.caseSensitive}
        activeFindItemId={searchState.active?.itemId ?? null}
        activeFindGroupId={searchState.active?.groupId ?? null}
        activeFindOccurrence={searchState.active?.occurrence ?? 0}
      />
      {(resumeKey || snapshot.diagnostics.length > 0) && <div className={styles.acpFooter}>
        {resumeKey && <p className={styles.acpResume} data-resume={snapshot.resume} role="status">{t(resumeKey)}</p>}
        {snapshot.diagnostics.length > 0 && <div className={styles.acpDiagnosticsWrap} data-acp-diagnostics="">
          <details className={styles.acpDiagnostics}>
            <summary className={styles.acpDiagnosticsSummary}>
              <Icon name="chevronRight" size={12} className={styles.acpDiagnosticsChevron} />
              <span>{t('sessions.acpDiagnostics', { count: snapshot.diagnostics.length })}</span>
            </summary>
            <pre className={styles.acpDiagnosticsPre}>{diagnosticsText}</pre>
          </details>
          <AcpCopyButton className={styles.acpDiagnosticsCopy} text={diagnosticsText} label={t('sessions.acpCopyDiagnostics')} />
        </div>}
      </div>}
      <AcpPendingBar count={waiting.length} onLocate={locatePending} />
      {error && <p className={styles.acpError} role="alert">{error}</p>}
      {live ? <>
        {login && <AcpAuthPanel snapshot={snapshot} toolName={toolName} onAuthenticate={onAuthenticate} onLoginTerminal={onLoginTerminal} />}
        {/* Hidden rather than removed during a login, so the draft (and a prompt a
            failed turn gave back) is still there afterwards. */}
        <AcpComposer
          ref={composerRef}
          hidden={login}
          active={active}
          snapshot={snapshot}
          toolName={toolName}
          live={live}
          turnBusy={turnBusy}
          busy={!!pending}
          canSend={canSend}
          promptContext={promptContext}
          workspaces={workspaces}
          dragActive={showDropOverlay}
          onSend={onSend}
          onStop={() => void run('stop', onStop)}
          onClose={() => void run('close', onClose)}
          onListFiles={onListFiles}
          onReadImage={onReadImage}
          onWithdrawAccess={(requestId) => onAnswerAccess(requestId, 'deny')}
          onSetMode={onSetMode}
          onSetConfig={onSetConfig}
        />
      </> : <AcpEndedBar
        snapshot={snapshot}
        busy={!!pending}
        onNewConversation={onNewConversation}
        onOpenTerminal={onOpenTerminal ?? onLoginTerminal}
        onHistory={() => setHistoryOpen(true)}
        onClose={onClose}
      />}
      {showDropOverlay && <div className={styles.dropOverlay} data-acp-drop-overlay="" aria-hidden="true">
        <div className={styles.dropCard}>
          <span className={styles.dropGlyph}><Icon name="upload" size={22} /></span>
          <strong>{t('sessions.acpDropHint')}</strong>
          <span>{t('sessions.acpDropHintDetail')}</span>
        </div>
      </div>}
    </div>
    {historyOpen && createPortal(<AcpHistoryDialog open={historyOpen} snapshot={snapshot} toolName={toolName} onClose={() => setHistoryOpen(false)} onList={onNativeSessions} onDelete={onDeleteNativeSession} onResume={onResumeNative} onNewConversation={onNewConversation} />, document.body)}
  </div>;
});
