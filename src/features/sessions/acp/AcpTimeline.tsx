import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import type { AcpElicitation, AcpSessionSnapshot, AcpSubagent, AcpTimelineItem } from '../../../types/acp';
import { acpCardAnswerable, acpTurnKey } from '../acpSession';
import { AcpAccessCard, type AccessAnswer } from './AcpAccessCard';
import { AcpMessage } from './AcpMessage';
import { AcpToolCard } from './AcpToolCard';
import { subagentStateKey, visibleControls } from './acpView';
import styles from './acp.module.css';

/** How close to the bottom a reader may be and still follow new output. */
const FOLLOW_SLACK = 24;

export type AcpTimelineHandle = {
  /** Bring one item into view and focus its first answer button. */
  scrollToItem: (id: string) => void;
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

function SubagentItem({ item }: { item: AcpSubagent }) {
  const { t } = useTranslation();
  return <details className={styles.subagent} data-item-id={item.id} data-state={item.state ?? undefined}>
    <summary className={styles.subagentHead}>
      <Icon name="chevronRight" size={12} className={styles.disclosure} />
      <Icon name="branch" size={12} />
      <strong className={styles.toolTitle}>{item.title || t('sessions.acpSubagentFallback')}</strong>
      <span className={styles.toolStatus}>{t(subagentStateKey(item.state))}</span>
    </summary>
    <div className={styles.subagentBody}>
      {item.description && <p className={styles.plainText}>{visibleControls(item.description)}</p>}
      {item.summary && <p className={styles.subagentSummary}>{visibleControls(item.summary)}</p>}
      {item.stopReason && <p className={styles.note}>{t('sessions.acpSubagentStopped', { reason: item.stopReason })}</p>}
      <p className={styles.note}>{t('sessions.acpSubagentReadOnly')}</p>
    </div>
  </details>;
}

/**
 * The ordered timeline. Every item keeps the place it first appeared in. A reader
 * at the bottom follows new output, appended text included; a reader who scrolled
 * up is never moved, and sees "back to latest" with the number of items that
 * arrived since.
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
}>(function AcpTimeline({ snapshot, toolName, active, busyKey, onAnswer, onAnswerAccess, onKillTerminal, onOpenPath }, ref) {
  const { t } = useTranslation();
  const logRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const [following, setFollowing] = useState(true);
  /** The last item the reader had when leaving the bottom. */
  const [anchor, setAnchor] = useState<string | null>(null);
  const timeline = snapshot.timeline;
  const last = timeline[timeline.length - 1];
  const running = snapshot.state === 'running';

  // Every event moves the sequence, so appended text, a merged tool update and a
  // new item all count as new output. Only a reader already at the bottom follows.
  useLayoutEffect(() => {
    const node = logRef.current;
    if (!node || !active || !followRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [snapshot.seq, timeline.length, active]);

  // Content also grows after an event: a reply's Markdown loads, a code block is
  // highlighted, a card opens. A following reader stays at the bottom through it.
  const observerRef = useRef<ResizeObserver | null>(null);
  const observed = useRef(new Set<Element>());
  useEffect(() => {
    const tracked = observed.current;
    return () => { observerRef.current?.disconnect(); observerRef.current = null; tracked.clear(); };
  }, []);
  useLayoutEffect(() => {
    const node = logRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    let observer = observerRef.current;
    if (!observer) {
      observer = new ResizeObserver(() => {
        if (followRef.current && node.clientHeight > 0) node.scrollTop = node.scrollHeight;
      });
      observer.observe(node);
      observerRef.current = observer;
    }
    const present = new Set<Element>(node.children);
    for (const child of observed.current) {
      if (!present.has(child)) { observer.unobserve(child); observed.current.delete(child); }
    }
    for (const child of present) {
      if (!observed.current.has(child)) { observer.observe(child); observed.current.add(child); }
    }
  });

  useImperativeHandle(ref, () => ({
    scrollToItem(id: string) {
      const node = logRef.current;
      if (!node) return;
      const item = [...node.querySelectorAll<HTMLElement>('[data-item-id]')].find((element) => element.dataset.itemId === id);
      if (!item) return;
      item.scrollIntoView({ block: 'center' });
      const card = item.matches('[data-card]') ? item : item.querySelector<HTMLElement>('[data-card]');
      (card ?? item).querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    },
  }), []);

  function jumpToLatest() {
    const node = logRef.current;
    if (!node) return;
    followRef.current = true;
    setFollowing(true);
    setAnchor(null);
    node.scrollTop = node.scrollHeight;
  }

  const anchorIndex = anchor ? timeline.findIndex((item) => item.id === anchor) : -1;
  const unread = following ? 0 : anchor == null ? 0 : anchorIndex >= 0 ? timeline.length - 1 - anchorIndex : timeline.length;

  function itemView(item: AcpTimelineItem) {
    switch (item.kind) {
      case 'message':
        return <AcpMessage key={item.id} message={item} toolName={toolName} streaming={running && item === last && item.role !== 'user'} />;
      case 'tool': {
        const request = item.permission?.requestId;
        return <AcpToolCard key={item.id} call={item} snapshot={snapshot} busy={!!busyKey || (!!request && busyKey === request)} onAnswer={onAnswer} onKillTerminal={onKillTerminal} onOpenPath={onOpenPath} />;
      }
      case 'access':
        return <AcpAccessCard key={item.id} access={item} toolName={toolName} answerable={!!item.requestId && acpCardAnswerable(snapshot, item.requestId)} busy={!!busyKey} onAnswer={onAnswerAccess} />;
      case 'notice': {
        const icon = item.code === 'yolo_allowed' ? 'shield' : item.level === 'error' ? 'alert' : item.level === 'warning' ? 'alert' : 'info';
        return <p key={item.id} className={styles.notice} data-item-id={item.id} data-level={item.level} data-code={item.code || undefined}>
          <Icon name={icon} size={12} /><span>{item.code === 'trimmed' ? t('sessions.acpTrimmed') : visibleControls(item.text)}</span>
        </p>;
      }
      case 'turn': {
        const key = acpTurnKey(item.reason);
        return key ? <p key={item.id} className={styles.turn} data-item-id={item.id} data-reason={item.reason}><span>{t(key)}</span></p> : null;
      }
      case 'subagent':
        return <SubagentItem key={item.id} item={item} />;
      case 'elicitation':
        return <section key={item.id} className={item.decision === 'pending' ? styles.card : styles.accessRecord} data-item-id={item.id} data-card={item.decision === 'pending' ? 'elicitation' : undefined} data-decision={item.decision} data-request-id={item.requestId ?? undefined} aria-label={t('sessions.acpElicitationTitle', { tool: toolName })}>
          <strong className={styles.cardTitle}><Icon name="info" size={13} />{t('sessions.acpElicitationTitle', { tool: toolName })}</strong>
          <p className={styles.plainText}>{visibleControls(item.message)}</p>
          <span className={styles.note}>{t(elicitationKey(item.decision))}</span>
        </section>;
      default:
        return null;
    }
  }

  return <div className={styles.timelineFrame}>
    <div ref={logRef} className={styles.timeline} role="log" aria-live="polite" aria-label={t('sessions.acpLog', { tool: toolName })} tabIndex={0} onScroll={(event) => {
      const node = event.currentTarget;
      const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK;
      if (atBottom === followRef.current) return;
      followRef.current = atBottom;
      setFollowing(atBottom);
      setAnchor(atBottom ? null : timeline[timeline.length - 1]?.id ?? null);
    }}>
      {!timeline.length && <p className={styles.empty}>{t('sessions.acpEmpty', { tool: toolName })}</p>}
      {timeline.map(itemView)}
    </div>
    {!following && timeline.length > 0 && <button type="button" className={styles.jumpLatest} data-acp-jump="" onClick={jumpToLatest}>
      <Icon name="arrowDown" size={13} />
      <span>{t('sessions.acpJumpLatest')}</span>
      {unread > 0 && <span className={styles.unread} aria-label={t('sessions.acpUnread', { count: unread })}>{unread > 99 ? '99+' : unread}</span>}
    </button>}
  </div>;
});
