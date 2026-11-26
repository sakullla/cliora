import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui';
import { modLabel } from '../../lib/shortcut';
import type { AcpPlanEntry, AcpSubagent, AcpTimelineItem, AcpToolCall, AcpToolContent } from '../../types/acp';
import type { AcpConversation as Conversation } from './acpSession';
import { acpCardAnswerable, acpIsLive, acpResumeKey, acpStateKey, acpTurnActive, acpTurnKey } from './acpSession';
import workbenchStyles from './SessionWorkbench.module.css';
import styles from './AcpConversation.module.css';

/** How close to the bottom a reader may be and still follow new output. */
const FOLLOW_SLACK = 24;

function toolStatusKey(status: AcpToolCall['status']): string {
  switch (status) {
    case 'in_progress': return 'sessions.acpToolRunning';
    case 'completed': return 'sessions.acpToolDone';
    case 'failed': return 'sessions.acpToolFailed';
    default: return 'sessions.acpToolPending';
  }
}

function planStatusKey(status: AcpPlanEntry['status']): string {
  switch (status) {
    case 'in_progress': return 'sessions.acpPlanRunning';
    case 'completed': return 'sessions.acpPlanDone';
    default: return 'sessions.acpPlanPending';
  }
}

function subagentStateKey(state: AcpSubagent['state']): string {
  switch (state) {
    case 'running': return 'sessions.acpSubagentRunning';
    case 'idle': return 'sessions.acpSubagentIdle';
    case 'requires_action': return 'sessions.acpSubagentAction';
    default: return 'sessions.acpSubagentUnknown';
  }
}

/** What changes when new output arrives: a new item, or more of the last one. */
function followKey(timeline: AcpTimelineItem[], pending: number): string {
  const last = timeline[timeline.length - 1];
  if (!last) return `0:${pending}`;
  const growth = last.kind === 'message' ? last.text.length : last.kind === 'tool' ? `${last.status}:${last.content.length}` : '';
  return `${timeline.length}:${last.id}:${growth}:${pending}`;
}

/**
 * One ACP conversation: a native chat view, not a terminal. It renders the host's
 * ordered timeline — messages, tool calls (with the authorization card of the call
 * that asked), notices, turn ends and subagents — exactly in arrival order, plus the
 * agent's plan. The pane frame is the shared session card, so the rail, the title
 * bar, the split and the keyboard menu treat it like any other session.
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
  const timeline = snapshot.timeline;
  const lastItem = timeline[timeline.length - 1];
  const streaming = snapshot.state === 'running' && lastItem?.kind === 'message' && lastItem.role === 'agent';
  const resumeKey = acpResumeKey(snapshot.resume);
  const placement = pane != null && pane >= 0 ? { gridColumn: pane + 1, gridRow: 1 } : undefined;
  const planDone = snapshot.plan.filter((entry) => entry.status === 'completed').length;

  // New output follows only while the reader is already at the bottom: scrolling up
  // to read must not be undone by the next chunk. Appended text counts as new output.
  const follow = followKey(timeline, snapshot.pending.length);
  useEffect(() => {
    const node = logRef.current;
    if (!node || !followRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [follow, active]);

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

  function contentView(content: AcpToolContent, index: number) {
    switch (content.type) {
      case 'text':
        return <pre key={index} className={styles.acpToolDetail}>{content.text}{content.truncated && <span className={styles.acpTruncated}>{t('sessions.acpTruncated')}</span>}</pre>;
      case 'diff':
        return <div key={index} className={styles.acpToolEntry} data-content="diff">
          <span>{content.oldText == null ? t('sessions.acpDiffNew', { path: content.path }) : t('sessions.acpDiffEdit', { path: content.path })}</span>
          {content.truncated && <span className={styles.acpTruncated}>{t('sessions.acpTruncated')}</span>}
        </div>;
      case 'terminal':
        return <div key={index} className={styles.acpToolEntry} data-content="terminal">{t('sessions.acpTerminalContent', { id: content.terminalId })}</div>;
      case 'image':
        return <div key={index} className={styles.acpToolEntry} data-content="image">{t('sessions.acpImageContent', { type: content.mimeType })}</div>;
      case 'session':
        return <div key={index} className={styles.acpToolEntry} data-content="session">{t('sessions.acpSessionContent', { id: content.sessionId })}</div>;
      default:
        return null;
    }
  }

  function toolView(call: AcpToolCall) {
    const request = call.permission;
    const answerable = !!request && acpCardAnswerable(snapshot, request.requestId);
    return <div key={call.id} className={styles.acpTool} data-item-id={call.id} data-status={call.status} data-tool-kind={call.toolKind} data-subagent={call.subagent ?? undefined}>
      <span className={styles.acpToolHead}><Icon name="plug" size={12} /><strong>{call.title || call.callId}</strong><span className={styles.acpToolStatus}>{t(toolStatusKey(call.status))}</span></span>
      {call.rawInput && <pre className={styles.acpToolDetail} data-content="input">{call.rawInput}</pre>}
      {call.content.map(contentView)}
      {call.locations.length > 0 && <ul className={styles.acpLocations} aria-label={t('sessions.acpLocations')}>
        {call.locations.map((location, index) => <li key={index}>{location.line != null ? `${location.path}:${location.line}` : location.path}</li>)}
      </ul>}
      {request && answerable && <section className={styles.acpCard} role="group" aria-label={call.title} data-request-id={request.requestId}>
        <strong className={styles.acpCardTitle}><Icon name="shield" size={13} />{t('sessions.acpPermissionTitle')}</strong>
        <div className={styles.acpCardOptions}>
          {request.options.map((option) => <Button key={option.optionId} size="sm" variant={option.kind.includes('reject') ? 'ghost' : 'primary'} disabled={!!pending} onClick={() => void run(request.requestId, () => onAnswer(request.requestId, option.optionId))}>{option.name}</Button>)}
          <Button size="sm" variant="ghost" disabled={!!pending} onClick={() => void run(request.requestId, () => onAnswer(request.requestId, null))}>{t('sessions.acpPermissionDismiss')}</Button>
        </div>
      </section>}
    </div>;
  }

  function itemView(item: AcpTimelineItem) {
    switch (item.kind) {
      case 'message':
        return <div key={item.id} className={styles.acpMessage} data-item-id={item.id} data-role={item.role} data-subagent={item.subagent ?? undefined}>
          <span className={styles.acpRole}>{item.role === 'user' ? t('sessions.acpRoleUser') : item.role === 'thought' ? t('sessions.acpRoleThought') : item.role === 'session' ? t('sessions.acpRoleSession') : t('sessions.acpRoleAgent', { tool: toolName })}</span>
          <p className={styles.acpText}>{item.text || ' '}{item.truncated && <span className={styles.acpTruncated}>{t('sessions.acpTruncated')}</span>}</p>
        </div>;
      case 'tool':
        return toolView(item);
      case 'notice':
        return <p key={item.id} className={styles.acpNotice} data-item-id={item.id} data-level={item.level} data-code={item.code || undefined}>{item.code === 'trimmed' ? t('sessions.acpTrimmed') : item.text}</p>;
      case 'turn': {
        const key = acpTurnKey(item.reason);
        return key ? <p key={item.id} className={styles.acpTurn} data-item-id={item.id} data-reason={item.reason}>{t(key)}</p> : null;
      }
      case 'subagent':
        return <div key={item.id} className={styles.acpSubagent} data-item-id={item.id} data-state={item.state ?? undefined}>
          <span className={styles.acpToolHead}><Icon name="branch" size={12} /><strong>{item.title || t('sessions.acpSubagentFallback')}</strong><span className={styles.acpToolStatus}>{t(subagentStateKey(item.state))}</span></span>
          {item.description && <p className={styles.acpSubagentText}>{item.description}</p>}
          {item.summary && <p className={styles.acpSubagentText}>{item.summary}</p>}
        </div>;
      default:
        return null;
    }
  }

  const canCompose = live && !turnActive && snapshot.state !== 'starting';

  return <div className={workbenchStyles.terminalInstance} hidden={!active} style={placement} data-pane-session={snapshot.id} data-acp="true" data-focused={(active && focused) || undefined} data-running={live || undefined}>
    {header}
    <div className={styles.acpBody} data-acp-body={snapshot.id}>
      <div className={styles.acpMeta}>
        <span className={styles.acpMetaItem}><Icon name="terminal" size={12} />{toolName}</span>
        <span className={styles.acpMetaItem} title={snapshot.directory}><Icon name="folder" size={12} />{snapshot.directory}</span>
        {snapshot.info.title && <span className={styles.acpMetaItem} data-acp-title="">{snapshot.info.title}</span>}
        {snapshot.info.usage && <span className={styles.acpMetaItem} data-acp-usage="">{t('sessions.acpUsage', { used: snapshot.info.usage.used.toLocaleString(), size: snapshot.info.usage.size.toLocaleString() })}</span>}
        <span className={styles.acpState} data-state={snapshot.state} role="status">{t(acpStateKey(snapshot.state))}</span>
      </div>
      {snapshot.plan.length > 0 && <details className={styles.acpPlan} open data-acp-plan="">
        <summary>{t('sessions.acpPlan', { done: planDone, total: snapshot.plan.length })}</summary>
        <ol>
          {snapshot.plan.map((entry, index) => <li key={index} data-status={entry.status}><span className={styles.acpPlanStatus}>{t(planStatusKey(entry.status))}</span>{entry.content}</li>)}
        </ol>
      </details>}
      <div ref={logRef} className={styles.acpLog} role="log" aria-live="polite" aria-label={t('sessions.acpLog', { tool: toolName })} onScroll={(event) => {
        const node = event.currentTarget;
        followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK;
      }}>
        {!timeline.length && <p className={styles.acpEmpty}>{t('sessions.acpEmpty', { tool: toolName })}</p>}
        {timeline.map(itemView)}
        {streaming && <span className={styles.acpCursor} aria-hidden="true" />}
      </div>
      {(resumeKey || snapshot.diagnostics.length > 0) && <div className={styles.acpFooter}>
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
            submit();
          }}
        />
        <div className={styles.acpActions}>
          <span className={styles.acpHint}>{canCompose ? t('sessions.acpSendHint', { mod: modLabel }) : live ? t('sessions.acpBusyHint') : t('sessions.acpEnded')}</span>
          {turnActive && <Button size="sm" variant="secondary" disabled={!!pending || snapshot.state === 'stopping'} onClick={() => void run('stop', onStop)} icon={<Icon name="square" size={12} />}>{snapshot.state === 'stopping' ? t('sessions.acpStopping') : t('sessions.acpStop')}</Button>}
          {!live && <Button size="sm" variant="ghost" disabled={!!pending} onClick={() => void run('close', onClose)}>{t('sessions.acpClose')}</Button>}
          <Button size="sm" variant="primary" disabled={!canCompose || !draft.trim() || !!pending} onClick={submit}>{t('sessions.acpSend')}</Button>
        </div>
      </div>
    </div>
  </div>;
}
