import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import { Icon } from '../../components/Icon';
import { Button, IconButton } from '../../components/ui';
import { ToolIcon } from '../../components/ToolIcon';
import { altLabel, modLabel } from '../../lib/shortcut';
import { SessionActivityIcon } from './SessionActivityIcon';
import { SessionTitle, stableTitle } from './SessionTitle';
import { placeParts, type PlaceParts } from './railTitle';
import type { WorkbenchSession } from '../../types/launch';
import { remoteSessionMayExist, sessionConfirmedEnded } from './sessionState';
import { partitionCollapsed, type TaskBucket, type TaskState } from './sessionTaskState';
import styles from './SessionWorkbench.module.css';

export type SessionTone = 'live' | 'idle' | 'bell' | 'error' | 'ended' | 'warning';

/** What a session row or badge shows: the task state, or the command fact that replaces it. */
export type SessionCommand = {
  /** The semantic slot of the command fact, for styling and tests. */
  tone: string;
  label: string;
  /** The activity icon and colour that belong to that fact; one mapping for rail and stage. */
  activityTone: SessionTone;
};

/** Progress moves like output, a warning is amber, a failure is the error tone. */
export function commandActivityTone(tone: string): SessionTone {
  if (tone === 'progress' || tone === 'indeterminate' || tone === 'running') return 'live';
  if (tone === 'warning') return 'warning';
  if (tone === 'error' || tone === 'failed') return 'error';
  return 'idle';
}

/**
 * A command fact may replace the task state only while the task is neutral. Waiting for a person,
 * a review, a failure and an ended session stay visible: a progress bar must never hide them.
 */
export function commandReplacesTask(task: TaskState): boolean {
  return task === 'working' || task === 'unknown';
}

export type RailSession = {
  session: WorkbenchSession;
  name: string;
  title: string;
  place: string;
  directory: string;
  elapsed: string;
  tone: SessionTone;
  pinned: boolean;
  attention: boolean;
  unread: boolean;
  /** The shared task state, computed once for the rail, the stage and the attention entry. */
  task: TaskState;
  bucket: TaskBucket;
  taskLabel: string;
  taskHint: string | null;
  /** The terminal's own command phase or program progress, worded; null when there is nothing to say. */
  command: SessionCommand | null;
  collapsed: boolean;
  /** The user marked this round for review; a display mark only. */
  marked: boolean;
  /** 0 or 1 while the session is on screen in a split; null otherwise. */
  pane: number | null;
};
/** The search field only earns its room once the list is long enough to scan. */
export const RAIL_SEARCH_MIN = 4;

/** A folder label that folds its shared head first, so sibling checkouts stay distinguishable. */
export function PlaceLabel({ text, parts }: { text: string; parts?: PlaceParts }) {
  if (!parts?.head) return <span className={styles.placeTail}>{text}</span>;
  return <><span className={styles.placeHead}>{parts.head}</span><span className={styles.placeTail}>{parts.tail}</span></>;
}

/** Pointer travel before a press on a session becomes a drag instead of a click. */
const DRAG_THRESHOLD = 5;
/** Distance from the list edge where a drag scrolls the list. */
const DRAG_EDGE = 28;

type DragPress = { id: string; group: string; pointerId: number; startY: number; startScroll: number; node: HTMLElement; active: boolean };
type DragView = { id: string; group: string; offset: number; target: string | null; after: boolean };

/** Insert `id` before or after `target` inside `ids`; null target means the end. */
export function moveWithin(ids: string[], id: string, target: string | null, after: boolean): string[] {
  const rest = ids.filter((item) => item !== id);
  if (target === null || !rest.includes(target)) return [...rest, id];
  const index = rest.indexOf(target) + (after ? 1 : 0);
  return [...rest.slice(0, index), id, ...rest.slice(index)];
}

/** True when a double-click landed on a session's tool icon (the rail toggle target). */
function onIcon(event: MouseEvent<HTMLElement>): boolean {
  return event.target instanceof Element && !!event.target.closest('[data-rail-icon]');
}

export function SessionRail({ sessions, total, running, ended, search, selectedId, narrow, slim, docked = false, busy, canLaunch, endedCollapsed, collapsedOpen, collapsedCount, onSearch, onSelect, onNewSession, onOpenMenu, onRemove, onClearEnded, onToggleSlim, onToggleEnded, onToggleCollapsedOpen, onReorder }: {
  sessions: RailSession[];
  total: number;
  running: number;
  ended: number;
  search: string;
  selectedId: string | null;
  /** A strip above the terminal (narrow windows) instead of a vertical list. */
  narrow: boolean;
  slim: boolean;
  /** Shown inside the app sidebar, whose own toggle folds it. */
  docked?: boolean;
  busy: boolean;
  canLaunch: boolean;
  endedCollapsed: boolean;
  /** The collapsed section is open; its own preference never reopens itself. */
  collapsedOpen: boolean;
  /** Collapsed rows kept even while a search filter hides them, so the section stays honest. */
  collapsedCount: number;
  onSearch: (query: string) => void;
  onSelect: (id: string, focusTerminal?: boolean) => void;
  onNewSession: () => void;
  onOpenMenu: (session: WorkbenchSession, x: number, y: number) => void;
  onRemove: (session: WorkbenchSession) => void;
  onClearEnded: () => void;
  onToggleSlim: () => void;
  onToggleEnded: () => void;
  onToggleCollapsedOpen: () => void;
  /** A vertical list was rearranged inside one group; `ids` is the group's new order. */
  onReorder?: (group: string, ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const press = useRef<DragPress | null>(null);
  const swallowClick = useRef(false);
  const [drag, setDrag] = useState<DragView | null>(null);
  // Dragging reorders the visible vertical list only: the narrow strip scrolls sideways and a
  // filtered list hides sessions whose place would be ambiguous.
  const canDrag = !!onReorder && !narrow && !search.trim();
  const compact = slim && !narrow;
  const showSearch = !compact && !narrow && (total >= RAIL_SEARCH_MIN || !!search);
  const toggleLabel = compact ? t('sessions.railExpand') : t('sessions.railCollapse');
  const toggleTitle = `${toggleLabel} (${modLabel}+Shift+B) · ${t('sessions.railToggleHint')}`;

  const places = placeParts(sessions.map((item) => item.place));

  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && press.current?.active) { event.preventDefault(); cancelDrag(); return; }
    // Alt+Shift+Up/Down moves the focused session inside its group, the keyboard twin of dragging.
    if (canDrag && event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const id = (document.activeElement as HTMLElement | null)?.dataset.sessionId;
      const group = groups.find((item) => item.items.some((entry) => entry.session.id === id));
      if (!id || !group || group.items.length < 2) return;
      event.preventDefault();
      const ids = group.items.map((item) => item.session.id);
      const index = ids.indexOf(id);
      const next = index + (event.key === 'ArrowUp' ? -1 : 1);
      if (next < 0 || next >= ids.length) return;
      onReorder?.(group.key, moveWithin(ids, id, ids[next], event.key === 'ArrowDown'));
      requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>(`[data-session-id="${CSS.escape(id)}"]`)?.focus());
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')];
    const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
        : (current + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const target = tabs[next];
    const sessionId = target.dataset.sessionId;
    if (sessionId) onSelect(sessionId, false);
    target.focus();
  }

  // A collapsed row leaves this list but keeps its state, process and restore record.
  const collapsedIds = new Set(sessions.filter((item) => item.collapsed).map((item) => item.session.id));
  const { active: activeSessions, collapsed: collapsedSessions } = partitionCollapsed(sessions, (item) => item.session.id, collapsedIds);
  // Tasks that need a person and are not on screen: one click brings the next one up.
  const waiting = activeSessions.filter((item) => item.bucket === 'attention' && item.session.id !== selectedId);
  const pinnedSessions = activeSessions.filter((item) => item.pinned);
  // A remote transport that may still hold a session is its own group: the connection, not the CLI, is unconfirmed.
  const pendingSessions = activeSessions.filter((item) => !item.pinned && !item.session.running && remoteSessionMayExist(item.session));
  const pendingIds = new Set(pendingSessions.map((item) => item.session.id));
  const bucketOf = (bucket: TaskBucket) => activeSessions.filter((item) => !item.pinned && !pendingIds.has(item.session.id) && item.bucket === bucket);
  const attentionSessions = bucketOf('attention');
  const reviewSessions = bucketOf('review');
  // Producing output and sitting quietly are both "running": splitting them moved a row between
  // groups every time a CLI paused, so the list kept jumping. The row's own mark shows activity.
  const runningSessions = activeSessions.filter((item) => !item.pinned && !pendingIds.has(item.session.id) && (item.bucket === 'working' || item.bucket === 'unknown'));
  const endedSessions = bucketOf('ended');
  // A collapsed ended group still shows the session on screen, so the selection never vanishes.
  const endedVisible = endedCollapsed && !narrow ? endedSessions.filter((item) => item.session.id === selectedId) : endedSessions;
  const groups = [
    { key: 'pinned', label: t('sessions.pinSession'), items: pinnedSessions, count: pinnedSessions.length },
    { key: 'pending', label: t('sessions.sshNeedsCheck'), items: pendingSessions, count: pendingSessions.length },
    { key: 'attention', label: t('sessions.taskAttentionGroup'), items: attentionSessions, count: attentionSessions.length },
    { key: 'review', label: t('sessions.taskReadyReview'), items: reviewSessions, count: reviewSessions.length },
    { key: 'working', label: t('sessions.running'), items: runningSessions, count: runningSessions.length },
    { key: 'ended', label: t('sessions.ended'), items: endedVisible, count: endedSessions.length },
  ].filter((group) => group.count > 0);

  function cancelDrag() {
    const current = press.current;
    if (current?.active && current.node.hasPointerCapture(current.pointerId)) current.node.releasePointerCapture(current.pointerId);
    press.current = null;
    setDrag(null);
  }

  function onPressStart(event: PointerEvent<HTMLButtonElement>, id: string, group: string) {
    if (!canDrag || event.button !== 0 || !event.isPrimary || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if ((groups.find((item) => item.key === group)?.items.length ?? 0) < 2) return;
    press.current = { id, group, pointerId: event.pointerId, startY: event.clientY, startScroll: listRef.current?.scrollTop ?? 0, node: event.currentTarget, active: false };
  }

  function onPressMove(event: PointerEvent<HTMLButtonElement>) {
    const current = press.current;
    const list = listRef.current;
    if (!current || !list || event.pointerId !== current.pointerId) return;
    if (!current.active) {
      if (Math.abs(event.clientY - current.startY) < DRAG_THRESHOLD) return;
      current.active = true;
      current.node.setPointerCapture(current.pointerId);
    }
    event.preventDefault();
    const box = list.getBoundingClientRect();
    if (event.clientY < box.top + DRAG_EDGE) list.scrollTop -= 8;
    else if (event.clientY > box.bottom - DRAG_EDGE) list.scrollTop += 8;
    // The drop slot is the first sibling whose middle sits below the pointer.
    const rows = [...list.querySelectorAll<HTMLElement>(`[data-drag-group="${current.group}"]`)].filter((row) => row.dataset.dragId !== current.id);
    let target: string | null = null;
    let after = false;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) { target = row.dataset.dragId ?? null; break; }
    }
    if (target === null && rows.length) { target = rows[rows.length - 1].dataset.dragId ?? null; after = true; }
    setDrag({ id: current.id, group: current.group, offset: event.clientY - current.startY + list.scrollTop - current.startScroll, target, after });
  }

  function onPressEnd(event: PointerEvent<HTMLButtonElement>) {
    const current = press.current;
    if (!current || event.pointerId !== current.pointerId) return;
    if (current.active && drag && drag.id === current.id) {
      const group = groups.find((item) => item.key === current.group);
      if (group) {
        const ids = group.items.map((item) => item.session.id);
        const next = moveWithin(ids, current.id, drag.target, drag.after);
        if (next.join('\n') !== ids.join('\n')) onReorder?.(current.group, next);
      }
      // The release still dispatches a click on the dragged card; it must not reselect.
      swallowClick.current = true;
      window.setTimeout(() => { swallowClick.current = false; }, 0);
    }
    cancelDrag();
  }

  const renderSession = (item: RailSession, group: string) => {
    const { session } = item;
    const selected = session.id === selectedId;
    // A command fact takes the row's state slot while the task is neutral; otherwise the task wins.
    const command = item.command && commandReplacesTask(item.task) ? item.command : null;
    const failed = sessionConfirmedEnded(session) && session.exitCode != null && session.exitCode !== 0;
    const yolo = session.mode === 'yolo';
    // YOLO stays discoverable in the tooltip and for assistive tech; the row itself spends its room on state.
    const tooltip = [stableTitle(item.title), item.place, [item.name, yolo ? t('sessions.modeYolo') : ''].filter(Boolean).join(' · '), item.directory, item.taskLabel, item.taskHint, item.command?.label ?? ''].filter(Boolean).join('\n');
    const pending = !session.running && remoteSessionMayExist(session);
    // The command's own wording replaces the task wording, and its icon replaces the task icon.
    const state = pending ? t('sessions.sshNeedsCheck') : command ? command.label : item.taskLabel;
    const rowTone: SessionTone = pending ? 'ended' : command ? command.activityTone : item.tone;
    // A running session that is only waiting for input already reads that way from its tool icon
    // and quiet state dot; repeating the label on every row would spend the room titles need.
    // A command fact is news, so it is never hidden as quiet.
    const quietState = !pending && !command && item.task === 'unknown' && item.session.running && item.taskLabel === t('sessions.stateIdle');
    const dragging = drag?.id === session.id;
    const dropMark = drag && !dragging && drag.group === group && drag.target === session.id ? (drag.after ? 'after' : 'before') : undefined;
    return <div key={session.id} className={styles.row} data-running={session.running || undefined} data-pending={pending || undefined} data-attention={item.attention || undefined} data-task={item.task} data-bucket={item.bucket} data-collapsed={item.collapsed || undefined} data-marked={item.marked || undefined} data-selected={selected || undefined} data-on-screen={item.pane != null || undefined}
      data-drag-group={group} data-drag-id={session.id} data-dragging={dragging || undefined} data-drop={dropMark}
      style={dragging ? { transform: `translateY(${drag.offset}px)` } : undefined}>
      <button type="button" role="tab" data-session-id={session.id} className={styles.session} aria-selected={selected} aria-haspopup="menu" title={tooltip}
        onPointerDown={(event) => onPressStart(event, session.id, group)}
        onPointerMove={onPressMove}
        onPointerUp={onPressEnd}
        onPointerCancel={cancelDrag}
        onLostPointerCapture={() => { if (press.current?.active) cancelDrag(); }}
        onClickCapture={(event) => { if (swallowClick.current) { swallowClick.current = false; event.preventDefault(); event.stopPropagation(); } }}
        onClick={() => onSelect(session.id)}
        onDoubleClick={(event) => { if (!narrow && onIcon(event)) { event.preventDefault(); onToggleSlim(); } }}
        // Middle-click closes like a browser tab; a running session still asks before ending.
        onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
        onAuxClick={(event) => { if (event.button === 1 && !busy) { event.preventDefault(); onRemove(session); } }}
        onContextMenu={(event) => { event.preventDefault(); onOpenMenu(session, event.clientX, event.clientY); }}
        onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            onOpenMenu(session, rect.left + 24, rect.bottom - 6);
          }
        }}>
        <span className={styles.sessionIconWrap} data-rail-icon="" data-tone={pending ? 'pending' : rowTone}>
          <ToolIcon toolId={session.toolId} size={compact ? 20 : 18} />
          <SessionActivityIcon tone={rowTone} slot="rail" className={styles.sessionStateDot} />
          {compact && (item.unread || item.attention) && <span className={styles.slimNotice} data-attention={item.attention || undefined} aria-hidden="true" />}
        </span>
        <span className={styles.sessionBody}>
          <span className={styles.sessionTop}>
            {item.pinned && <span className={styles.pinBadge} title={t('sessions.unpinSession')}><Icon name="pin" size={12} /></span>}
            <strong className={item.title ? undefined : styles.placeLine}>{item.title ? <SessionTitle title={item.title} /> : <PlaceLabel text={item.place} parts={places.get(item.place)} />}</strong>
            {item.unread && <span className={styles.unreadDot} title={t('sessions.unread')} aria-label={t('sessions.unread')} />}
          </span>
          <span className={styles.sessionSub}>
            <span className={styles.sessionPlace}>{item.title ? <PlaceLabel text={item.place} parts={places.get(item.place)} /> : <span className={styles.placeTail}>{item.name}</span>}</span>
            {item.pane != null && <span className={styles.paneTag} title={t('sessions.splitView')}><Icon name="columns" size={11} />{item.pane + 1}</span>}
            {failed && <span className={styles.exitTag}>{t('sessions.exitCode', { code: session.exitCode })}</span>}
          </span>
          <span className={styles.srOnly}>{[item.title ? item.name : '', yolo ? t('sessions.modeYolo') : '', item.taskLabel, item.taskHint, item.command?.label ?? ''].filter(Boolean).join(' · ')}</span>
        </span>
        {/* What the session is doing now — only when it needs saying — then how long it has run. */}
        <span className={styles.sessionMeta} data-tone={pending ? 'pending' : rowTone} data-task={item.task} data-command={command?.tone} data-quiet={quietState || undefined} aria-hidden="true">
          {item.marked && <span className={styles.markBadge} title={t('sessions.taskReviewMarked')}><Icon name="eye" size={11} /></span>}
          {!quietState && <span className={styles.sessionState}>{state}</span>}
          {session.running && item.elapsed && <span className={styles.sessionTime}>{item.elapsed}</span>}
        </span>
      </button>
      <div className={styles.rowActions}>
        <IconButton size="sm" className={styles.rowMenuBtn} aria-label={t('sessions.sessionMenu', { name: item.name })} title={t('sessions.moreActions')} icon={<Icon name="more" size={16} />} onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onOpenMenu(session, rect.left, rect.bottom + 5);
        }} />
        {!session.running && <IconButton size="sm" className={styles.rowRemove} aria-label={t('sessions.removeSessionLabel', { name: item.name })} title={t('sessions.removeSession')} disabled={busy} onClick={() => onRemove(session)} icon={<Icon name="close" size={12} />} />}
      </div>
    </div>;
  };

  return <aside className={styles.rail} aria-label={t('sessions.listLabel')} data-slim={compact || undefined} data-strip={narrow || undefined} data-docked={docked || undefined}>
    <div className={styles.railHead} onDoubleClick={(event) => { if (!narrow && event.target === event.currentTarget) onToggleSlim(); }}>
      <div className={styles.railTitleRow}>
        {/* Docked in the app sidebar, the page icon row already names the page and each group
            label carries its count, so the heading stays for assistive tech only. */}
        <h1 className={narrow || compact || docked ? styles.srOnly : styles.railTitle} tabIndex={-1}>{t('common.pages.sessions.title')}</h1>
        {!compact && !narrow && !docked && total > 0 && <span className={styles.railCount} title={t('sessions.summary', { running, ended })}><span className={styles.liveDot} data-live={running > 0 || undefined} aria-hidden="true" />{running > 0 ? t('sessions.runningCount', { count: running }) : t('sessions.railQuiet')}</span>}
        <span className={styles.railCompactLabel} aria-hidden="true"><Icon name="terminal" size={16} /></span>
        {canLaunch && (compact || narrow) && <IconButton size="sm" variant="primary" className={styles.newSessionBtn} aria-label={t('sessions.newSession')} title={`${t('sessions.newSession')} (${altLabel}+N)`} aria-keyshortcuts="Alt+N" onClick={onNewSession} icon={<Icon name="plus" size={16} />} />}
      </div>
      {canLaunch && !compact && !narrow && !showSearch && <Button variant="primary" className={styles.railNewBtn} aria-label={t('sessions.newSession')} title={`${t('sessions.newSession')} (${altLabel}+N)`} aria-keyshortcuts="Alt+N" onClick={onNewSession} icon={<Icon name="plus" size={15} />}><span>{t('sessions.newSession')}</span><kbd className={styles.railNewKbd} aria-hidden="true">{altLabel} N</kbd></Button>}
      {/* With enough sessions to search, search and new session share one row so the list starts higher. */}
      {showSearch && <div className={styles.railTools}>
        <div className={styles.railSearchField} data-field-frame="">
          <Icon name="search" size={14} />
          <input type="search" value={search} placeholder={t('sessions.searchPlaceholder')} aria-label={t('sessions.searchPlaceholder')} onChange={(event) => onSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && search) { event.preventDefault(); onSearch(''); } }} />
          {search && <button type="button" className={styles.railSearchClear} aria-label={t('sessions.clearFilter')} title={t('sessions.clearFilter')} onClick={() => onSearch('')}><Icon name="close" size={12} /></button>}
        </div>
        {canLaunch && <IconButton variant="primary" className={styles.railNewSquare} aria-label={t('sessions.newSession')} title={`${t('sessions.newSession')} (${altLabel}+N)`} aria-keyshortcuts="Alt+N" onClick={onNewSession} icon={<Icon name="plus" size={16} />} />}
      </div>}
      {!compact && !narrow && waiting.length > 0 && <button type="button" className={styles.railAttention} title={waiting.map((item) => item.title || item.name).join('\n')} onClick={() => onSelect(waiting[0].session.id)}>
        <SessionActivityIcon tone="bell" slot="rail" className={styles.railAttentionIcon} />
        <span>{t('sessions.attentionJump', { count: waiting.length })}</span>
        <Icon name="arrowRight" size={13} />
      </button>}
    </div>

    <div ref={listRef} className={styles.list} role="tablist" aria-label={t('sessions.listLabel')} aria-orientation={narrow ? 'horizontal' : 'vertical'} data-dragging={drag ? '' : undefined} onKeyDown={onListKeyDown}>
      {groups.map((group) => <div key={group.key} className={styles.sessionGroup} role="presentation" data-group={group.key}>
        {(groups.length > 1 || group.key === 'ended' || docked) && <div className={styles.groupLabel} role="presentation">
          {group.key === 'ended' && !compact && !narrow
            ? <button type="button" className={styles.groupToggle} aria-expanded={!endedCollapsed} title={endedCollapsed ? t('sessions.endedExpand') : t('sessions.endedCollapse')} onClick={onToggleEnded}><Icon name="chevronDown" size={12} /><span>{group.label}</span><em>{group.count}</em></button>
            : <>{group.key === 'working' && !compact && <span className={styles.liveDot} data-live="" aria-hidden="true" />}<span>{group.label}</span>{!compact && <em>{group.count}</em>}</>}
          {group.key === 'ended' && !compact && !narrow && <button type="button" className={styles.groupAction} disabled={busy} aria-label={t('sessions.clearEnded')} title={t('sessions.clearEndedTitle')} onClick={onClearEnded}><Icon name="trash" size={12} /><span>{t('sessions.clearEndedShort')}</span></button>}
        </div>}
        {group.items.map((item) => renderSession(item, group.key))}
      </div>)}
      {/* Collapsed rows keep their state, their process and their restore record; only the list moves them. */}
      {collapsedCount > 0 && <div className={styles.sessionGroup} role="presentation" data-group="collapsed">
        <div className={styles.groupLabel} role="presentation">
          <button type="button" className={styles.groupToggle} aria-expanded={collapsedOpen} title={collapsedOpen ? t('sessions.collapsedCollapse') : t('sessions.collapsedExpand')} onClick={onToggleCollapsedOpen}><Icon name="chevronDown" size={12} /><span>{t('sessions.collapsedGroup')}</span><em>{collapsedCount}</em></button>
        </div>
        {collapsedOpen && collapsedSessions.map((item) => renderSession(item, 'collapsed'))}
      </div>}
      {total > 0 && sessions.length === 0 && <div className={styles.railNoMatch}><Icon name="search" size={20} /><p>{t('sessions.noFilterMatch')}</p><button type="button" className={styles.railNoMatchClear} onClick={() => onSearch('')}>{t('sessions.clearFilter')}</button></div>}
    </div>

    {!narrow && !docked && <div className={styles.railFoot}>
      <IconButton size="sm" className={styles.railIconBtn} aria-label={toggleLabel} title={toggleTitle} onClick={onToggleSlim} icon={<Icon name={compact ? 'sidebarOpen' : 'sidebarClose'} size={16} />} />
      {!compact && <span className={styles.railSummary}>{ended > 0 ? t('sessions.summary', { running, ended }) : t('sessions.totalCount', { count: total })}</span>}
    </div>}
  </aside>;
}
