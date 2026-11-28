import { forwardRef, memo, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import type { AcpElicitation, AcpSessionSnapshot, AcpSubagent, AcpTimelineItem } from '../../../types/acp';
import { acpCardAnswerable, acpIsLive, acpNeedsLogin, acpTurnKey } from '../acpSession';
import { AcpAccessCard, type AccessAnswer } from './AcpAccessCard';
import { AcpElicitationForm, type ElicitationAction } from './AcpElicitationForm';
import { AcpMessage } from './AcpMessage';
import { AcpProcess } from './AcpProcess';
import { AcpStartupGroup } from './AcpStartupGroup';
import { AcpToolCard } from './AcpToolCard';
import { AcpToolGroup } from './AcpToolGroup';
import { AcpSessionContext } from './acpImageCache';
import { readTimelineAnchor, useViewMemory, writeTimelineAnchor, type TimelineAnchor } from './acpRenderCache';
import { splitMatchRuns } from './acpSearch';
import { agentHeadIds, createSegmentBuilder, groupIdByItem, segmentKey, segmentOptions, type TimelineSegment } from './timelineModel';
import { subagentStateKey, visibleControls } from './acpView';
import styles from './acp.module.css';

/** How close to the bottom a reader may be and still follow new output. */
const FOLLOW_SLACK = 24;
/** How long the transient locate outline stays visible on a jumped-to item. */
const LOCATE_HIGHLIGHT_MS = 1400;
/**
 * Up to this many segments every one of them is rendered (R13). A short conversation
 * costs little to render whole, and it keeps everything in the DOM and in the
 * accessibility tree; beyond it only the segments near the viewport (plus OVERSCAN on
 * each side) are rendered, so a conversation of thousands of entries keeps a constant
 * DOM. Below the limit the DOM grows with the conversation, above it it does not.
 */
export const FULL_RENDER_MAX_SEGMENTS = 80;
/** Segments rendered beyond each edge of the viewport. */
const OVERSCAN = 6;
/** How many frames a locate or find waits for its target to be rendered. */
const REVEAL_FRAMES = 90;

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

const SubagentItem = memo(function SubagentItem({ item, forceOpen = false, searchQuery = '', searchCase = false, findActive = false, located = false }: {
  item: AcpSubagent;
  forceOpen?: boolean;
  searchQuery?: string;
  searchCase?: boolean;
  findActive?: boolean;
  located?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useViewMemory(`subagent:${item.id}`, false);
  const [prevForceOpen, setPrevForceOpen] = useState(false);
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
    onToggle={(event) => { if (event.currentTarget.open !== open) setOpen(event.currentTarget.open); }}
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
});

function findItemNode(container: HTMLElement, id: string): HTMLElement | null {
  return [...container.querySelectorAll<HTMLElement>('[data-item-id]')].find((element) => element.dataset.itemId === id) ?? null;
}

function focusItemAction(item: HTMLElement) {
  const card = item.matches('[data-card]') ? item : item.querySelector<HTMLElement>('[data-card]');
  (card ?? item).querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
}

const estimates = new WeakMap<TimelineSegment, number>();

/** A first guess at a segment's height before it is measured; measuring corrects it.
 *  Kept per segment object, so an unchanged segment is never estimated twice. */
function estimateSegment(segment: TimelineSegment): number {
  let estimate = estimates.get(segment);
  if (estimate === undefined) estimates.set(segment, estimate = guessSegment(segment));
  return estimate;
}

function guessSegment(segment: TimelineSegment): number {
  switch (segment.kind) {
    case 'startup': return 32;
    case 'toolGroup': return 36;
    case 'process': {
      if (segment.ended && !segment.interrupted) return 36 + 30 * segment.summary.failed;
      return 64 + 30 * Math.min(segment.items.length, 9);
    }
    default: break;
  }
  const item = segment.item;
  switch (item.kind) {
    case 'message': {
      if (item.role === 'thought') return 32;
      return Math.min(3000, (item.role === 'user' ? 40 : 34) + 22 * Math.ceil(item.text.length / 60));
    }
    case 'tool': return item.status === 'completed' && !item.permission ? 40 : 160;
    case 'access':
    case 'elicitation': return 140;
    case 'turn': return item.reason === 'end_turn' ? 1 : 24;
    default: return 32;
  }
}

/** The callbacks the rows get. They keep one identity for the life of the view, so a
 *  row does not render again because its parent did. */
type RowHandlers = {
  onAnswer: (requestId: string, optionId: string | null) => void;
  onAnswerAccess: (accessId: string, decision: AccessAnswer) => void;
  onKillTerminal: (terminalId: string) => Promise<void>;
  onOpenPath: (target: string) => Promise<void>;
  onRespondElicitation: (requestId: string, action: ElicitationAction, content: Record<string, unknown> | null) => Promise<void>;
  onReuseMessage: (text: string) => void;
};

type SegmentRowProps = {
  segment: TimelineSegment;
  /** The agent's name opens the round here. */
  head: boolean;
  toolName: string;
  /** The conversation as far as rows read it: state, pending requests, terminals, directory. */
  snapshot: AcpSessionSnapshot;
  busyKey: string;
  handlers: RowHandlers;
  canOpenPath: boolean;
  canReuse: boolean;
  renderMarkdown: boolean;
  /** The item streaming now, when this segment holds it. */
  streamingId: string | null;
  /** The find match and the located item, when this segment holds them. */
  activeFindItemId: string | null;
  locatedId: string | null;
  /** Find or locate targets something folded inside this segment. */
  forced: boolean;
  searchQuery: string;
  searchCase: boolean;
};

/**
 * One segment of the timeline, with the agent's name above it when it opens a round
 * (an agent reply carries the name itself). Memoized: it renders again only when its
 * segment object, its own find/locate/stream state or a shared setting changes.
 */
const SegmentRow = memo(function SegmentRow({
  segment,
  head,
  toolName,
  snapshot,
  busyKey,
  handlers,
  canOpenPath,
  canReuse,
  renderMarkdown,
  streamingId,
  activeFindItemId,
  locatedId,
  forced,
  searchQuery,
  searchCase,
}: SegmentRowProps) {
  const { t } = useTranslation();
  const onOpenPath = canOpenPath ? handlers.onOpenPath : undefined;

  function itemView(item: AcpTimelineItem) {
    const isFindActive = activeFindItemId === item.id;
    const isLocated = locatedId === item.id;
    switch (item.kind) {
      case 'message':
        return <AcpMessage
          message={item}
          renderMarkdown={renderMarkdown}
          toolName={toolName}
          head={item.role !== 'agent' || item.subagent != null || head}
          streaming={streamingId === item.id && item.role !== 'user'}
          canReuse={canReuse}
          onReuse={canReuse ? handlers.onReuseMessage : undefined}
          forceOpen={isFindActive || isLocated}
          searchQuery={searchQuery}
          searchCase={searchCase}
          findActive={isFindActive}
          located={isLocated}
        />;
      case 'tool': {
        const request = item.permission?.requestId;
        return <AcpToolCard
          call={item}
          snapshot={snapshot}
          busy={!!busyKey || (!!request && busyKey === request)}
          onAnswer={handlers.onAnswer}
          onKillTerminal={handlers.onKillTerminal}
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
          access={item}
          toolName={toolName}
          answerable={!!item.requestId && acpCardAnswerable(snapshot, item.requestId)}
          busy={!!busyKey}
          onAnswer={handlers.onAnswerAccess}
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
        // A normal end says nothing: the reply already ended the turn. The node keeps
        // the entry's place for locate and unread counts.
        if (item.reason === 'end_turn') return <span className={styles.srOnly} data-item-id={item.id} data-reason={item.reason} aria-hidden="true" />;
        // A stop the person asked for: a quiet mark, no rule across the column.
        if (item.reason === 'cancelled') {
          return <p className={styles.turnStopped} data-item-id={item.id} data-reason={item.reason}>
            <Icon name="square" size={10} />
            <span>{t('sessions.acpTurnStopped')}</span>
          </p>;
        }
        const key = acpTurnKey(item.reason);
        const icon = item.reason === 'limit' || item.reason === 'refusal' ? 'alert' : item.reason === 'unknown' ? 'info' : 'alert';
        return key ? <p className={styles.turn} data-item-id={item.id} data-reason={item.reason}><Icon name={icon} size={12} /><span>{t(key)}</span></p> : null;
      }
      case 'subagent':
        return <SubagentItem
          item={item}
          forceOpen={isFindActive || isLocated}
          searchQuery={searchQuery}
          searchCase={searchCase}
          findActive={isFindActive}
          located={isLocated}
        />;
      case 'elicitation':
        if (item.decision === 'pending' && item.requestId && snapshot.pending.includes(item.requestId)) {
          return <div className={styles.elicitationWrap} data-find-hit={isFindActive ? 'active' : undefined} data-located={isLocated || undefined}>
            <AcpElicitationForm item={item} toolName={toolName} answerable={acpCardAnswerable(snapshot, item.requestId)} onRespond={handlers.onRespondElicitation} />
          </div>;
        }
        return <section
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

  function body(): ReactNode {
    switch (segment.kind) {
      case 'item':
        return itemView(segment.item);
      case 'toolGroup':
        return <AcpToolGroup
          id={segment.id}
          items={segment.items}
          kindCounts={segment.kindCounts}
          snapshot={snapshot}
          busyKey={busyKey}
          onAnswer={handlers.onAnswer}
          onKillTerminal={handlers.onKillTerminal}
          onOpenPath={onOpenPath}
          forceOpen={forced}
          activeFindItemId={activeFindItemId}
          locatedId={locatedId}
          searchQuery={searchQuery}
          searchCase={searchCase}
        />;
      case 'startup':
        return <AcpStartupGroup
          id={segment.id}
          items={segment.items}
          toolName={toolName}
          renderMarkdown={renderMarkdown}
          forceOpen={forced}
          activeFindItemId={activeFindItemId}
          locatedId={locatedId}
          searchQuery={searchQuery}
          searchCase={searchCase}
        />;
      case 'process':
        return <AcpProcess
          segment={segment}
          snapshot={snapshot}
          streamingId={streamingId}
          onKillTerminal={handlers.onKillTerminal}
          onOpenPath={onOpenPath}
          forceOpen={forced}
          activeFindItemId={activeFindItemId}
          locatedId={locatedId}
          searchQuery={searchQuery}
          searchCase={searchCase}
        />;
      default:
        return null;
    }
  }

  const ownHead = segment.kind === 'item' && segment.item.kind === 'message' && segment.item.role === 'agent';
  return <>
    {head && !ownHead && <div className={styles.agentHead} data-acp-agent-head="">{t('sessions.acpRoleAgent', { tool: toolName })}</div>}
    {body()}
  </>;
});

/**
 * The ordered timeline. Every item keeps the place it first appeared in; the view
 * layer folds what came before the first prompt into the startup entry, each turn's
 * work between its prompt and its last tool call into a process of compact steps,
 * and (outside a turn) consecutive completed lightweight tool calls into a group.
 * The agent's name shows once per round.
 *
 * Segments are built incrementally and render as memoized rows. A long conversation
 * is virtualized (R13): only the rows near the viewport are in the DOM, each measured
 * as it renders, and a row's height change above the reader moves the scroll position
 * with it so the text being read stays put. A reader at the bottom follows new output
 * through a fixed two-target ResizeObserver; a reader who scrolled up is never moved
 * and sees "back to latest" with the unread count. Find and locate scroll a target
 * that is not rendered into the rendered range first. A hidden pane renders no rows;
 * where the reader was (a segment and the distance into it, or "following") and what
 * they opened are kept per session, and the pane comes back exactly there.
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
  const sessionId = useContext(AcpSessionContext) || snapshot.id;
  const logRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  /** Where this session's reader was, from an earlier mount of this view. */
  const [initialAnchor] = useState<TimelineAnchor | null>(() => readTimelineAnchor(sessionId));
  const followRef = useRef(initialAnchor?.following ?? true);
  const anchorRef = useRef<TimelineAnchor>(initialAnchor ?? { following: true, key: null, offset: 0 });
  const smoothScrollingRef = useRef(false);
  const smoothTimerRef = useRef<number | undefined>(undefined);
  const locateTimerRef = useRef<number | undefined>(undefined);
  const revealRef = useRef<{ id: string; frame: number; run: (item: HTMLElement) => void } | null>(null);
  const [following, setFollowing] = useState(followRef.current);
  /** The last item the reader had when leaving the bottom. */
  const [anchor, setAnchor] = useState<string | null>(null);
  const [locatedId, setLocatedId] = useState<string | null>(null);
  const [locatedGroupId, setLocatedGroupId] = useState<string | null>(null);
  /** The row holding keyboard focus stays rendered while the reader scrolls away. */
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [metrics, setMetrics] = useState({ gap: 12, margin: 8 });

  const timeline = snapshot.timeline;
  const last = timeline[timeline.length - 1];
  const running = snapshot.state === 'running';
  const live = acpIsLive(snapshot);
  const login = acpNeedsLogin(snapshot);
  const canReuse = live && !login && snapshot.state !== 'starting' && !!onReuseMessage;
  const pendingList = snapshot.pending;
  const [buildSegments] = useState(createSegmentBuilder);
  const segments = useMemo(
    () => buildSegments(timeline, segmentOptions({ state: snapshot.state, pending: pendingList })),
    [buildSegments, timeline, snapshot.state, pendingList],
  );
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const heads = useMemo(() => agentHeadIds(segments), [segments]);
  const lookingUp = !!activeFindItemId || !!locatedId;
  const groupByItem = useMemo(() => (lookingUp ? groupIdByItem(segments) : null), [segments, lookingUp]);
  // The segment that holds an item now; a match's own group id may predate a regrouping.
  const resolvedFindGroupId = activeFindItemId ? groupByItem?.get(activeFindItemId) ?? activeFindGroupId ?? null : activeFindGroupId;
  const streamingId = running && last && !(last.kind === 'message' && last.role === 'user') ? last.id : null;
  const renderMarkdown = active || !following;

  // The rows read only these fields of the conversation, so a streamed chunk (a new
  // timeline) does not re-render rows whose own segment did not change.
  const rowSnapshot = useMemo(
    () => snapshot,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot.id, snapshot.state, snapshot.pending, snapshot.terminals, snapshot.omittedTerminalIds, snapshot.directory],
  );
  const handlersRef = useRef({ onAnswer, onAnswerAccess, onKillTerminal, onOpenPath, onRespondElicitation, onReuseMessage });
  handlersRef.current = { onAnswer, onAnswerAccess, onKillTerminal, onOpenPath, onRespondElicitation, onReuseMessage };
  const [handlers] = useState<RowHandlers>(() => ({
    onAnswer: (requestId, optionId) => handlersRef.current.onAnswer(requestId, optionId),
    onAnswerAccess: (accessId, decision) => handlersRef.current.onAnswerAccess(accessId, decision),
    onKillTerminal: (terminalId) => handlersRef.current.onKillTerminal(terminalId),
    onOpenPath: (target) => handlersRef.current.onOpenPath?.(target) ?? Promise.resolve(),
    onRespondElicitation: (requestId, action, content) => handlersRef.current.onRespondElicitation(requestId, action, content),
    onReuseMessage: (text) => handlersRef.current.onReuseMessage?.(text),
  }));

  const keyIndex = useCallback((key: string | null) => (key ? segmentsRef.current.findIndex((segment) => segmentKey(segment) === key) : -1), []);
  const focusedIndex = focusedKey ? segments.findIndex((segment) => segmentKey(segment) === focusedKey) : -1;
  const rangeExtractor = useCallback((range: Range) => {
    if (range.count <= FULL_RENDER_MAX_SEGMENTS) return Array.from({ length: range.count }, (_, index) => index);
    const indexes = defaultRangeExtractor(range);
    if (focusedIndex < 0 || indexes.includes(focusedIndex)) return indexes;
    return [...indexes, focusedIndex].sort((a, b) => a - b);
  }, [focusedIndex]);
  // The virtualizer rebuilds every position when these change, so they keep their
  // identity while the segment keys stay the same: a streamed chunk or a merged tool
  // update then re-measures only the row that changed.
  const keysRef = useRef<{ keys: string[]; version: number }>({ keys: [], version: 0 });
  {
    const current = keysRef.current;
    let same = current.keys.length === segments.length;
    for (let index = 0; same && index < segments.length; index += 1) same = current.keys[index] === segmentKey(segments[index]);
    if (!same) keysRef.current = { keys: segments.map(segmentKey), version: current.version + 1 };
  }
  const keyVersion = keysRef.current.version;
  const getItemKey = useCallback((index: number) => keysRef.current.keys[index],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keyVersion]);
  const estimateSize = useCallback((index: number) => estimateSegment(segmentsRef.current[index]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keyVersion]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: segments.length,
    getScrollElement: () => logRef.current,
    estimateSize,
    getItemKey,
    rangeExtractor,
    overscan: OVERSCAN,
    // Heights as laid out, not rounded: the rows not rendered stand in as padding, and
    // rounding each one would add up to a visible shift over a long conversation.
    measureElement: (element, entry, instance) => {
      const box = entry?.borderBoxSize?.[0];
      if (box) return box.blockSize;
      if (!entry) {
        const cached = instance.itemSizeCache.get(instance.options.getItemKey(instance.indexFromElement(element)));
        if (cached !== undefined) return cached;
      }
      return element.getBoundingClientRect().height;
    },
    gap: metrics.gap,
    scrollMargin: metrics.margin,
    // Start near where the reader will be, so the first rows rendered are the ones shown.
    initialOffset: () => {
      const saved = anchorRef.current;
      const list = segmentsRef.current;
      if (!saved.following && saved.key) {
        let start = metrics.margin;
        for (const segment of list) {
          if (segmentKey(segment) === saved.key) return Math.max(0, start + saved.offset);
          start += estimateSegment(segment) + metrics.gap;
        }
      }
      const total = list.reduce((sum, segment) => sum + estimateSegment(segment) + metrics.gap, metrics.margin);
      return Math.max(0, total - 2000);
    },
  });
  const virtualRef = useRef(virtualizer);
  virtualRef.current = virtualizer;
  // A row that changes height above the reader moves the scroll position with it, so
  // the text being read stays put; a row still entering at the top is not corrected
  // while the reader scrolls up into it. A reader following the latest output is kept
  // at the bottom by the follow observer instead: a correction there would read as a
  // scroll away from it.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange ??= (item, _delta, instance) => {
    if (followRef.current) return false;
    const offset = logRef.current?.scrollTop ?? 0;
    if (!instance.itemSizeCache.has(item.key)) return item.start < offset;
    return item.end <= offset && instance.scrollDirection !== 'backward';
  };

  useLayoutEffect(() => {
    const log = logRef.current;
    const inner = innerRef.current;
    if (!log || !inner) return;
    const gap = parseFloat(getComputedStyle(inner).rowGap) || 0;
    const margin = parseFloat(getComputedStyle(log).paddingTop) || 0;
    setMetrics((current) => (current.gap === gap && current.margin === margin ? current : { gap, margin }));
  }, []);

  useEffect(() => () => {
    window.clearTimeout(smoothTimerRef.current);
    window.clearTimeout(locateTimerRef.current);
    if (revealRef.current) window.cancelAnimationFrame(revealRef.current.frame);
  }, []);

  /** Remembers where the reader is: following, or a segment and the distance into it. */
  const rememberPosition = useCallback((node: HTMLElement, atBottom: boolean) => {
    const item = virtualRef.current.getVirtualItemForOffset(node.scrollTop);
    const next: TimelineAnchor = { following: atBottom, key: item ? String(item.key) : null, offset: item ? node.scrollTop - item.start : 0 };
    anchorRef.current = next;
    writeTimelineAnchor(sessionId, next);
  }, [sessionId]);

  // Coming back to a hidden pane (or mounting again): the rows render at the remembered
  // place, then the scroll position is put exactly there.
  useLayoutEffect(() => {
    const node = logRef.current;
    if (!node || !active) return;
    const saved = anchorRef.current;
    if (followRef.current || !saved.key) {
      node.scrollTop = node.scrollHeight;
    } else {
      const index = keyIndex(saved.key);
      const item = index >= 0 ? virtualRef.current.measurementsCache[index] : undefined;
      if (item) node.scrollTop = item.start + saved.offset;
    }
    // The virtualizer reads the new position at once, so the frame shows the right rows.
    queueMicrotask(() => node.dispatchEvent(new Event('scroll')));
  }, [active, keyIndex]);

  // A host trim drops the oldest entries (and republishes the conversation): a reader
  // who scrolled up keeps the segment they were reading where it was.
  const firstKey = segments.length ? segmentKey(segments[0]) : null;
  const firstKeyRef = useRef(firstKey);
  useLayoutEffect(() => {
    const previous = firstKeyRef.current;
    firstKeyRef.current = firstKey;
    const node = logRef.current;
    const saved = anchorRef.current;
    if (previous === firstKey || !node || !active || followRef.current || !saved.key) return;
    const index = keyIndex(saved.key);
    const item = index >= 0 ? virtualRef.current.measurementsCache[index] : undefined;
    if (!item) return;
    const target = item.start + saved.offset;
    if (Math.abs(node.scrollTop - target) > 1) node.scrollTop = target;
  }, [firstKey, active, keyIndex]);

  // New output (appended text, a merged tool update, a new item, a row measured, Markdown
  // or highlighting that loads, a card that opens) grows the column; only a reader
  // already at the bottom follows it. Observing only the scroll viewport and the single
  // inner column, after layout, avoids scanning every child node or forcing a layout
  // on every event.
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

  /**
   * Brings one item into view and then runs `run` on it. A row outside the rendered
   * range is scrolled to first; the item (inside a group that opens on the next
   * render, possibly) is then looked for over the following frames.
   */
  const reveal = useCallback((id: string, segmentId: string | null, run: (item: HTMLElement) => void) => {
    const node = logRef.current;
    if (!node) return;
    if (revealRef.current) window.cancelAnimationFrame(revealRef.current.frame);
    const found = findItemNode(node, id);
    if (!found) {
      // Scrolled like a reader would: the rows there render and are measured, and the
      // item is then brought exactly into view.
      const index = keyIndex(segmentId ?? id);
      const target = index >= 0 ? virtualRef.current.measurementsCache[index] : undefined;
      if (target) {
        // Leaving the bottom on purpose: the follow observer must not pull it back
        // while the rows there render. Arriving at the bottom turns following on again.
        if (followRef.current) {
          followRef.current = false;
          setFollowing(false);
          setAnchor(timelineRef.current[timelineRef.current.length - 1]?.id ?? null);
        }
        node.scrollTop = Math.max(0, target.start + target.size / 2 - node.clientHeight / 2);
      }
    }
    let frames = 0;
    const attempt = () => {
      const item = logRef.current && findItemNode(logRef.current, id);
      if (item) {
        revealRef.current = null;
        run(item);
        return;
      }
      frames += 1;
      if (frames > REVEAL_FRAMES) { revealRef.current = null; return; }
      if (revealRef.current) revealRef.current.frame = window.requestAnimationFrame(attempt);
    };
    revealRef.current = { id, frame: window.requestAnimationFrame(attempt), run };
  }, [keyIndex]);

  // When find navigation targets an item, scroll to the matching mark (or container) once expanded.
  useEffect(() => {
    if (!activeFindItemId || !active) return;
    reveal(activeFindItemId, resolvedFindGroupId, (item) => {
      const marks = item.querySelectorAll<HTMLElement>('mark');
      const mark = marks[activeFindOccurrence] ?? marks[0] ?? null;
      (mark ?? item).scrollIntoView({ block: 'center' });
    });
  }, [activeFindItemId, activeFindOccurrence, resolvedFindGroupId, searchQuery, searchCase, active, reveal]);

  useImperativeHandle(ref, () => ({
    scrollToItem(id: string, options?: { focus?: boolean; groupId?: string }) {
      if (!logRef.current) return;
      const shouldFocus = options?.focus !== false;
      const groupId = groupIdByItem(segmentsRef.current).get(id) ?? options?.groupId ?? null;
      setLocatedId(id);
      setLocatedGroupId(groupId);
      window.clearTimeout(locateTimerRef.current);
      locateTimerRef.current = window.setTimeout(() => {
        setLocatedId((current) => (current === id ? null : current));
        setLocatedGroupId((current) => (current === groupId ? null : current));
      }, LOCATE_HIGHLIGHT_MS);
      reveal(id, groupId, (item) => {
        item.scrollIntoView({ block: 'center' });
        if (shouldFocus) focusItemAction(item);
      });
    },
  }), [reveal]);

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
      const mentionAvailable = !!onQuickTrigger && !snapshot.projectId?.startsWith('remote:');
      const hasQuickActions = (hasCommands && onQuickTrigger) || mentionAvailable || onOpenPromptPicker;
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
          {mentionAvailable && <button type="button" className={styles.emptyAction} onClick={() => onQuickTrigger('@')}>
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

  // A hidden pane renders no rows; its scroll container stays, with its full height.
  const rows = active ? virtualizer.getVirtualItems() : [];
  const total = virtualizer.getTotalSize();
  const padTop = rows.length ? rows[0].start - metrics.margin : 0;
  const padBottom = rows.length ? Math.max(0, total - (rows[rows.length - 1].end - metrics.margin)) : total;
  const lastIndex = segments.length - 1;
  const contains = (key: string, id: string | null) => !!id && (key === id || groupByItem?.get(id) === key);

  return <div className={styles.timelineFrame}>
    <div
      ref={logRef}
      className={styles.timeline}
      role="log"
      // Rows that render while the reader scrolls back are not news: only a reader
      // following the latest output hears what arrives.
      aria-live={following ? 'polite' : 'off'}
      aria-label={t('sessions.acpLog', { tool: toolName })}
      tabIndex={0}
      onWheel={cancelSmoothScroll}
      onPointerDown={cancelSmoothScroll}
      onScroll={(event) => {
        const node = event.currentTarget;
        // A hidden pane has no layout: there is nothing to read or remember.
        if (!active || node.clientHeight === 0) return;
        const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK;
        if (atBottom) {
          cancelSmoothScroll();
        } else if (smoothScrollingRef.current) {
          return;
        }
        rememberPosition(node, atBottom);
        if (atBottom === followRef.current) return;
        followRef.current = atBottom;
        setFollowing(atBottom);
        setAnchor(atBottom ? null : timeline[timeline.length - 1]?.id ?? null);
      }}
    >
      <div
        ref={innerRef}
        className={styles.timelineInner}
        data-acp-rows={rows.length}
        style={timeline.length ? { paddingTop: padTop, paddingBottom: padBottom } : undefined}
        onFocus={(event) => {
          const row = (event.target as HTMLElement).closest<HTMLElement>('[data-acp-row]');
          const key = row?.dataset.acpRow ?? null;
          if (key !== focusedKey) setFocusedKey(key);
        }}
        onBlur={(event) => {
          if (!innerRef.current?.contains(event.relatedTarget as Node | null)) setFocusedKey(null);
        }}
      >
        {!timeline.length && renderEmptyState()}
        {rows.map((row) => {
          const segment = segments[row.index];
          if (!segment) return null;
          const key = String(row.key);
          const forced = segment.kind !== 'item' && (resolvedFindGroupId === key || locatedGroupId === key);
          return <div key={key} ref={virtualizer.measureElement} data-index={row.index} data-acp-row={key} className={styles.segmentRow}>
            <SegmentRow
              segment={segment}
              head={heads.has(key)}
              toolName={toolName}
              snapshot={rowSnapshot}
              busyKey={busyKey}
              handlers={handlers}
              canOpenPath={!!onOpenPath}
              canReuse={canReuse}
              renderMarkdown={renderMarkdown}
              streamingId={row.index === lastIndex ? streamingId : null}
              activeFindItemId={contains(key, activeFindItemId) ? activeFindItemId : null}
              locatedId={contains(key, locatedId) ? locatedId : null}
              forced={forced}
              searchQuery={searchQuery}
              searchCase={searchCase}
            />
          </div>;
        })}
      </div>
    </div>
    {!following && timeline.length > 0 && <button type="button" className={styles.jumpLatest} data-acp-jump="" onClick={jumpToLatest}>
      <Icon name="arrowDown" size={13} />
      <span>{t('sessions.acpJumpLatest')}</span>
      {unread > 0 && <span className={styles.unread} aria-label={t('sessions.acpUnread', { count: unread })}>{unread > 99 ? '99+' : unread}</span>}
    </button>}
  </div>;
});
