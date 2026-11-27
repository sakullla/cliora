import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import type { AcpElicitation, AcpSessionSnapshot, AcpSubagent, AcpTimelineItem } from '../../../types/acp';
import { acpCardAnswerable, acpIsLive, acpNeedsLogin, acpTurnKey } from '../acpSession';
import { AcpAccessCard, type AccessAnswer } from './AcpAccessCard';
import { AcpElicitationForm, type ElicitationAction } from './AcpElicitationForm';
import { AcpMessage } from './AcpMessage';
import { AcpToolCard } from './AcpToolCard';
import { AcpToolGroup } from './AcpToolGroup';
import { splitMatchRuns } from './acpSearch';
import { groupTimelineItems, toolGroupIdByItem } from './timelineModel';
import { subagentStateKey, visibleControls } from './acpView';
import styles from './acp.module.css';

/** How close to the bottom a reader may be and still follow new output. */
const FOLLOW_SLACK = 24;
/** How long the transient locate outline stays visible on a jumped-to item. */
const LOCATE_HIGHLIGHT_MS = 1400;

export type AcpTimelineHandle = {
  /** Bring one item into view, briefly highlight it, and optionally focus its first answer button. */
  scrollToItem: (id: string, options?: { focus?: boolean; groupId?: string }) => void;
};

function elicitationKey(decision: AcpElicitation['decision']): string {
  switch (decision) {
    case 'accepted': return 'sessions.acpElicitationAccepted';
    case 'declined': return 'sessions.acpElicitationDeclined';
    case 'cancelled': return 'sessions.acpElicitationCancelled';
    case 'withdrawn': return 'sessions.acpElicitationWithdrawn';
    default: return 'sessions.acpElicitationPending';
  }
}

function renderRuns(text: string, query: string, caseSensitive: boolean) {
  const safe = visibleControls(text);
  if (!query.trim()) return safe;
  return splitMatchRuns(safe, query, caseSensitive).map((run, index) => run.hit
    ? <mark key={index} className={styles.findMark}>{run.text}</mark>
    : run.text);
}

function SubagentItem({ item, forceOpen = false, searchQuery = '', searchCase = false, findActive = false, located = false }: {
  item: AcpSubagent;
  forceOpen?: boolean;
  searchQuery?: string;
  searchCase?: boolean;
  findActive?: boolean;
  located?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(forceOpen);
  const [prevForceOpen, setPrevForceOpen] = useState(forceOpen);
  if (forceOpen !== prevForceOpen) {
    setPrevForceOpen(forceOpen);
    if (forceOpen) setOpen(true);
  }

  return <details
    className={styles.subagent}
    open={open}
    data-item-id={item.id}
    data-state={item.state ?? undefined}
    data-find-hit={findActive ? 'active' : undefined}
    data-located={located || undefined}
    onToggle={(event) => setOpen(event.currentTarget.open)}
  >
    <summary className={styles.subagentHead}>
      <Icon name="chevronRight" size={12} className={styles.disclosure} />
      <Icon name="branch" size={12} />
      <strong className={styles.toolTitle}>{renderRuns(item.title || t('sessions.acpSubagentFallback'), searchQuery, searchCase)}</strong>
      <span className={styles.toolStatus}>{t(subagentStateKey(item.state))}</span>
    </summary>
    <div className={styles.subagentBody}>
      {item.description && <p className={styles.plainText}>{renderRuns(item.description, searchQuery, searchCase)}</p>}
      {item.summary && <p className={styles.subagentSummary}>{renderRuns(item.summary, searchQuery, searchCase)}</p>}
      {item.stopReason && <p className={styles.note}>{t('sessions.acpSubagentStopped', { reason: item.stopReason })}</p>}
      <p className={styles.note}>{t('sessions.acpSubagentReadOnly')}</p>
    </div>
  </details>;
}

function findItemNode(container: HTMLElement, id: string): HTMLElement | null {
  return [...container.querySelectorAll<HTMLElement>('[data-item-id]')].find((element) => element.dataset.itemId === id) ?? null;
}

function focusItemAction(item: HTMLElement) {
  const card = item.matches('[data-card]') ? item : item.querySelector<HTMLElement>('[data-card]');
  (card ?? item).querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
}

/**
 * The ordered timeline. Every item keeps the place it first appeared in, while
 * consecutive completed lightweight tool calls fold into compact step groups in
 * the view layer. A reader at the bottom follows new output through a fixed
 * two-target ResizeObserver; a reader who scrolled up is never moved and sees
 * "back to latest" with the unread count.
 */
export const AcpTimeline = forwardRef<AcpTimelineHandle, {
  snapshot: AcpSessionSnapshot;
  toolName: string;
  active: boolean;
  busyKey: string;
  onAnswer: (requestId: string, optionId: string | null) => void;
  onAnswerAccess: (accessId: string, decision: AccessAnswer) => void;
  onKillTerminal: (terminalId: string) => Promise<void>;
  onOpenPath?: (target: string) => Promise<void>;
  /** Answers one elicitation form; rejects with the host's reason. */
  onRespondElicitation: (requestId: string, action: ElicitationAction, content: Record<string, unknown> | null) => Promise<void>;
  /** Reuses a previous user message in the composer draft (live sessions only). */
  onReuseMessage?: (text: string) => void;
  /** Inserts a '/' or '@' trigger into the composer from the ready empty state. */
  onQuickTrigger?: (prefix: '/' | '@') => void;
  /** Opens the prompt library picker from the ready empty state. */
  onOpenPromptPicker?: () => void;
  /** Active find-in-conversation query and match target (R6). */
  searchQuery?: string;
  searchCase?: boolean;
  activeFindItemId?: string | null;
  activeFindGroupId?: string | null;
  activeFindOccurrence?: number;
}>(function AcpTimeline({
  snapshot,
  toolName,
  active,
  busyKey,
  onAnswer,
  onAnswerAccess,
  onKillTerminal,
  onOpenPath,
  onRespondElicitation,
  onReuseMessage,
  onQuickTrigger,
  onOpenPromptPicker,
  searchQuery = '',
  searchCase = false,
  activeFindItemId = null,
  activeFindGroupId = null,
  activeFindOccurrence = 0,
}, ref) {
  const { t } = useTranslation();
  const logRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const smoothScrollingRef = useRef(false);
  const smoothTimerRef = useRef<number | undefined>(undefined);
  const locateTimerRef = useRef<number | undefined>(undefined);
  const pendingScrollRef = useRef<{ id: string; focus: boolean } | null>(null);
  const [following, setFollowing] = useState(true);
  /** The last item the reader had when leaving the bottom. */
  const [anchor, setAnchor] = useState<string | null>(null);
  const [locatedId, setLocatedId] = useState<string | null>(null);
  const [locatedGroupId, setLocatedGroupId] = useState<string | null>(null);

  const timeline = snapshot.timeline;
  const last = timeline[timeline.length - 1];
  const running = snapshot.state === 'running';
  const live = acpIsLive(snapshot);
  const login = acpNeedsLogin(snapshot);
  const canReuse = live && !login && snapshot.state !== 'starting' && !!onReuseMessage;
  const segments = useMemo(() => groupTimelineItems(timeline), [timeline]);
  const groupByItem = useMemo(() => toolGroupIdByItem(segments), [segments]);
  const resolvedFindGroupId = activeFindGroupId ?? (activeFindItemId ? groupByItem.get(activeFindItemId) ?? null : null);

  useEffect(() => () => {
    window.clearTimeout(smoothTimerRef.current);
    window.clearTimeout(locateTimerRef.current);
  }, []);

  // Every event moves the sequence, so appended text, a merged tool update and a
  // new item all count as new output. Only a reader already at the bottom follows.
  useLayoutEffect(() => {
    const node = logRef.current;
    if (!node || !active || !followRef.current || smoothScrollingRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [snapshot.seq, timeline.length, active]);

  // Content also grows after an event: Markdown loads, code highlights, cards open.
  // Observing only the scroll viewport and the single inner column avoids scanning
  // every child node on every render.
  useEffect(() => {
    const logNode = logRef.current;
    const innerNode = innerRef.current;
    if (!logNode || !innerNode || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (followRef.current && !smoothScrollingRef.current && logNode.clientHeight > 0) {
        logNode.scrollTop = logNode.scrollHeight;
      }
    });
    observer.observe(logNode);
    observer.observe(innerNode);
    return () => observer.disconnect();
  }, []);

  // After a locate call expands a folded tool group or card, finish scrolling & focusing.
  useLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    const node = logRef.current;
    if (!pending || !node) return;
    const item = findItemNode(node, pending.id);
    if (!item) return;
    pendingScrollRef.current = null;
    item.scrollIntoView({ block: 'center' });
    if (pending.focus) focusItemAction(item);
  }, [locatedId, locatedGroupId, segments]);

  // When find navigation targets an item, scroll to the matching mark (or container) once expanded.
  useEffect(() => {
    if (!activeFindItemId) return;
    const frame = window.requestAnimationFrame(() => {
      const node = logRef.current;
      if (!node) return;
      const item = findItemNode(node, activeFindItemId);
      if (!item) return;
      const marks = item.querySelectorAll<HTMLElement>('mark');
      const mark = marks[activeFindOccurrence] ?? marks[0] ?? null;
      (mark ?? item).scrollIntoView({ block: 'center' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeFindItemId, activeFindOccurrence, resolvedFindGroupId, searchQuery, searchCase]);

  useImperativeHandle(ref, () => ({
    scrollToItem(id: string, options?: { focus?: boolean; groupId?: string }) {
      const node = logRef.current;
      if (!node) return;
      const shouldFocus = options?.focus !== false;
      const groupId = options?.groupId ?? groupByItem.get(id) ?? null;
      setLocatedId(id);
      setLocatedGroupId(groupId);
      window.clearTimeout(locateTimerRef.current);
      locateTimerRef.current = window.setTimeout(() => {
        setLocatedId((current) => (current === id ? null : current));
        setLocatedGroupId((current) => (current === groupId ? null : current));
      }, LOCATE_HIGHLIGHT_MS);

      const item = findItemNode(node, id);
      if (item && !groupId) {
        pendingScrollRef.current = null;
        item.scrollIntoView({ block: 'center' });
        if (shouldFocus) focusItemAction(item);
      } else {
        pendingScrollRef.current = { id, focus: shouldFocus };
      }
    },
  }), [groupByItem]);

  function cancelSmoothScroll() {
    if (!smoothScrollingRef.current) return;
    smoothScrollingRef.current = false;
    window.clearTimeout(smoothTimerRef.current);
  }

  function jumpToLatest() {
    const node = logRef.current;
    if (!node) return;
    followRef.current = true;
    setFollowing(true);
    setAnchor(null);
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced || typeof node.scrollTo !== 'function') {
      cancelSmoothScroll();
      node.scrollTop = node.scrollHeight;
      return;
    }
    smoothScrollingRef.current = true;
    window.clearTimeout(smoothTimerRef.current);
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
    smoothTimerRef.current = window.setTimeout(() => {
      smoothScrollingRef.current = false;
      if (followRef.current && logRef.current) {
        logRef.current.scrollTop = logRef.current.scrollHeight;
      }
    }, 600);
  }

  const anchorIndex = anchor ? timeline.findIndex((item) => item.id === anchor) : -1;
  const unread = following ? 0 : anchor == null ? 0 : anchorIndex >= 0 ? timeline.length - 1 - anchorIndex : timeline.length;

  function itemView(item: AcpTimelineItem) {
    const isFindActive = activeFindItemId === item.id;
    const isLocated = locatedId === item.id;
    switch (item.kind) {
      case 'message':
        return <AcpMessage
          key={item.id}
          message={item}
          toolName={toolName}
          streaming={running && item === last && item.role !== 'user'}
          canReuse={canReuse}
          onReuse={onReuseMessage}
          forceOpen={isFindActive || isLocated}
          searchQuery={searchQuery}
          searchCase={searchCase}
          findActive={isFindActive}
          located={isLocated}
        />;
      case 'tool': {
        const request = item.permission?.requestId;
        return <AcpToolCard
          key={item.id}
          call={item}
          snapshot={snapshot}
          busy={!!busyKey || (!!request && busyKey === request)}
          onAnswer={onAnswer}
          onKillTerminal={onKillTerminal}
          onOpenPath={onOpenPath}
          forceOpen={isFindActive || isLocated}
          searchQuery={searchQuery}
          searchCase={searchCase}
          findActive={isFindActive}
          located={isLocated}
        />;
      }
      case 'access':
        return <AcpAccessCard
          key={item.id}
          access={item}
          toolName={toolName}
          answerable={!!item.requestId && acpCardAnswerable(snapshot, item.requestId)}
          busy={!!busyKey}
          onAnswer={onAnswerAccess}
          directory={snapshot.directory}
          onOpenPath={onOpenPath}
          searchQuery={searchQuery}
          searchCase={searchCase}
          findActive={isFindActive}
          located={isLocated}
        />;
      case 'notice': {
        const icon = item.code === 'yolo_allowed' ? 'shield' : item.level === 'error' ? 'alert' : item.level === 'warning' ? 'alert' : 'info';
        return <p
          key={item.id}
          className={styles.notice}
          data-item-id={item.id}
          data-level={item.level}
          data-code={item.code || undefined}
          data-find-hit={isFindActive ? 'active' : undefined}
          data-located={isLocated || undefined}
        >
          <Icon name={icon} size={12} />
          <span>{item.code === 'trimmed' ? t('sessions.acpTrimmed') : renderRuns(item.text, searchQuery, searchCase)}</span>
        </p>;
      }
      case 'turn': {
        const key = acpTurnKey(item.reason);
        return key ? <p key={item.id} className={styles.turn} data-item-id={item.id} data-reason={item.reason}><span>{t(key)}</span></p> : null;
      }
      case 'subagent':
        return <SubagentItem
          key={item.id}
          item={item}
          forceOpen={isFindActive || isLocated}
          searchQuery={searchQuery}
          searchCase={searchCase}
          findActive={isFindActive}
          located={isLocated}
        />;
      case 'elicitation':
        if (item.decision === 'pending' && item.requestId && snapshot.pending.includes(item.requestId)) {
          return <div key={item.id} className={styles.elicitationWrap} data-find-hit={isFindActive ? 'active' : undefined} data-located={isLocated || undefined}>
            <AcpElicitationForm item={item} toolName={toolName} answerable={acpCardAnswerable(snapshot, item.requestId)} onRespond={onRespondElicitation} />
          </div>;
        }
        return <section
          key={item.id}
          className={item.decision === 'pending' ? styles.card : styles.accessRecord}
          data-item-id={item.id}
          data-card={item.decision === 'pending' ? 'elicitation' : undefined}
          data-decision={item.decision}
          data-request-id={item.requestId ?? undefined}
          data-find-hit={isFindActive ? 'active' : undefined}
          data-located={isLocated || undefined}
          aria-label={t('sessions.acpElicitationTitle', { tool: toolName })}
        >
          <div className={styles.cardHead}>
            <strong className={styles.cardTitle}><Icon name="info" size={13} />{t('sessions.acpElicitationTitle', { tool: toolName })}</strong>
            {item.decision === 'pending' && <span className={styles.cardTag}>{t('sessions.acpCardElicitation')}</span>}
          </div>
          <p className={styles.plainText}>{renderRuns(item.message, searchQuery, searchCase)}</p>
          <span className={styles.note}>{t(elicitationKey(item.decision))}</span>
        </section>;
      default:
        return null;
    }
  }

  function renderEmptyState() {
    if (snapshot.state === 'starting') {
      return <div className={styles.emptyCard} data-acp-empty="starting" role="status">
        <div className={styles.emptyHead}>
          <span className={styles.emptySpinner} aria-hidden="true"><Icon name="refresh" size={15} /></span>
          <strong className={styles.emptyTitle}>{t('sessions.acpStartingTitle', { tool: toolName })}</strong>
        </div>
        <p className={styles.emptyHint}>{t('sessions.acpStartingHint')}</p>
        {snapshot.directory && <p className={styles.emptyDir} title={snapshot.directory}><Icon name="folder" size={12} /><span>{snapshot.directory}</span></p>}
      </div>;
    }
    if (login) {
      return <div className={styles.emptyCard} data-acp-empty="auth_required" role="status">
        <div className={styles.emptyHead}>
          <span className={styles.emptyLockDot} aria-hidden="true"><Icon name="lock" size={14} /></span>
          <strong className={styles.emptyTitle}>{t('sessions.acpLoginTitle', { tool: toolName })}</strong>
        </div>
        <p className={styles.emptyHint}>{t('sessions.acpLoginHint')}</p>
        {snapshot.directory && <p className={styles.emptyDir} title={snapshot.directory}><Icon name="folder" size={12} /><span>{snapshot.directory}</span></p>}
      </div>;
    }
    if (live) {
      const hasCommands = (snapshot.commands?.length ?? 0) > 0;
      const hasQuickActions = Boolean((hasCommands && onQuickTrigger) || onQuickTrigger || onOpenPromptPicker);
      return <div className={styles.emptyCard} data-acp-empty="ready">
        <div className={styles.emptyHead}>
          <span className={styles.emptyReadyDot} aria-hidden="true"><Icon name="sparkle" size={14} /></span>
          <strong className={styles.emptyTitle}>{t('sessions.acpReadyTitle', { tool: toolName })}</strong>
        </div>
        <p className={styles.emptyHint}>{t('sessions.acpReadyHint')}</p>
        {snapshot.directory && <p className={styles.emptyDir} title={snapshot.directory}><Icon name="folder" size={12} /><span>{snapshot.directory}</span></p>}
        {hasQuickActions && <div className={styles.emptyActions}>
          {hasCommands && onQuickTrigger && <button type="button" className={styles.emptyAction} onClick={() => onQuickTrigger('/')}>
            <Icon name="command" size={12} />{t('sessions.acpQuickCommand')}
          </button>}
          {onQuickTrigger && <button type="button" className={styles.emptyAction} onClick={() => onQuickTrigger('@')}>
            <Icon name="file" size={12} />{t('sessions.acpQuickMention')}
          </button>}
          {onOpenPromptPicker && <button type="button" className={styles.emptyAction} onClick={onOpenPromptPicker}>
            <Icon name="library" size={12} />{t('sessions.acpQuickPrompts')}
          </button>}
        </div>}
      </div>;
    }
    const failed = snapshot.state === 'failed';
    return <div className={styles.emptyCard} data-acp-empty={snapshot.state} role="status">
      <div className={styles.emptyHead}>
        <span className={failed ? styles.emptyFailedDot : styles.emptyEndedDot} aria-hidden="true">
          <Icon name={failed ? 'alert' : 'info'} size={14} />
        </span>
        <strong className={styles.emptyTitle}>{t(failed ? 'sessions.acpFailedTitle' : 'sessions.acpEndedTitle')}</strong>
      </div>
      <p className={styles.emptyHint}>{t('sessions.acpEndedHint')}</p>
      {snapshot.directory && <p className={styles.emptyDir} title={snapshot.directory}><Icon name="folder" size={12} /><span>{snapshot.directory}</span></p>}
    </div>;
  }

  return <div className={styles.timelineFrame}>
    <div
      ref={logRef}
      className={styles.timeline}
      role="log"
      aria-live="polite"
      aria-label={t('sessions.acpLog', { tool: toolName })}
      tabIndex={0}
      onWheel={cancelSmoothScroll}
      onPointerDown={cancelSmoothScroll}
      onScroll={(event) => {
        const node = event.currentTarget;
        const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK;
        if (atBottom) {
          cancelSmoothScroll();
        } else if (smoothScrollingRef.current) {
          return;
        }
        if (atBottom === followRef.current) return;
        followRef.current = atBottom;
        setFollowing(atBottom);
        setAnchor(atBottom ? null : timeline[timeline.length - 1]?.id ?? null);
      }}
    >
      <div ref={innerRef} className={styles.timelineInner}>
        {!timeline.length && renderEmptyState()}
        {segments.map((segment) => segment.kind === 'toolGroup'
          ? <AcpToolGroup
              key={segment.id}
              id={segment.id}
              items={segment.items}
              kindCounts={segment.kindCounts}
              snapshot={snapshot}
              busyKey={busyKey}
              onAnswer={onAnswer}
              onKillTerminal={onKillTerminal}
              onOpenPath={onOpenPath}
              forceOpen={resolvedFindGroupId === segment.id || locatedGroupId === segment.id}
              activeFindItemId={activeFindItemId}
              locatedId={locatedId}
              searchQuery={searchQuery}
              searchCase={searchCase}
            />
          : itemView(segment.item))}
      </div>
    </div>
    {!following && timeline.length > 0 && <button type="button" className={styles.jumpLatest} data-acp-jump="" onClick={jumpToLatest}>
      <Icon name="arrowDown" size={13} />
      <span>{t('sessions.acpJumpLatest')}</span>
      {unread > 0 && <span className={styles.unread} aria-label={t('sessions.acpUnread', { count: unread })}>{unread > 99 ? '99+' : unread}</span>}
    </button>}
  </div>;
});
