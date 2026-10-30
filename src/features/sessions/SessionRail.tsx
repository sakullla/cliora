import { useTranslation } from 'react-i18next';
import type { KeyboardEvent, MouseEvent } from 'react';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/ui';
import { ToolIcon } from '../../components/ToolIcon';
import { modLabel } from '../../lib/shortcut';
import { SessionActivityIcon } from './SessionActivityIcon';
import { SessionTitle, stableTitle } from './SessionTitle';
import type { WorkbenchSession } from '../../types/launch';
import styles from './SessionWorkbench.module.css';

export type SessionTone = 'live' | 'idle' | 'bell' | 'error' | 'ended';

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
  /** 0 or 1 while the session is on screen in a split; null otherwise. */
  pane: number | null;
};

/** The search field only earns its room once the list is long enough to scan. */
export const RAIL_SEARCH_MIN = 4;

/** True when a double-click landed on a session's tool icon (the rail toggle target). */
function onIcon(event: MouseEvent<HTMLElement>): boolean {
  return event.target instanceof Element && !!event.target.closest('[data-rail-icon]');
}

export function SessionRail({ sessions, total, running, ended, search, selectedId, narrow, slim, docked = false, busy, canLaunch, endedCollapsed, onSearch, onSelect, onNewSession, onOpenMenu, onRemove, onClearEnded, onToggleSlim, onToggleEnded }: {
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
  onSearch: (query: string) => void;
  onSelect: (id: string, focusTerminal?: boolean) => void;
  onNewSession: () => void;
  onOpenMenu: (session: WorkbenchSession, x: number, y: number) => void;
  onRemove: (session: WorkbenchSession) => void;
  onClearEnded: () => void;
  onToggleSlim: () => void;
  onToggleEnded: () => void;
}) {
  const { t } = useTranslation();
  const compact = slim && !narrow;
  const showSearch = !compact && !narrow && (total >= RAIL_SEARCH_MIN || !!search);
  const toggleLabel = compact ? t('sessions.railExpand') : t('sessions.railCollapse');
  const toggleTitle = `${toggleLabel} (${modLabel}+Shift+B) · ${t('sessions.railToggleHint')}`;

  const activityLabel = (item: RailSession) => {
    if (item.attention) return t('sessions.bellBadge');
    if (!item.session.running) return item.tone === 'error' ? t('sessions.stateError') : t('sessions.ended');
    return item.tone === 'live' ? t('sessions.stateStreaming') : t('sessions.stateIdle');
  };

  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
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

  const pinnedSessions = sessions.filter((item) => item.pinned);
  const runningSessions = sessions.filter((item) => !item.pinned && item.session.running);
  const endedSessions = sessions.filter((item) => !item.pinned && !item.session.running);
  // A collapsed ended group still shows the session on screen, so the selection never vanishes.
  const endedVisible = endedCollapsed && !narrow ? endedSessions.filter((item) => item.session.id === selectedId) : endedSessions;
  const groups = [
    { key: 'pinned', label: t('sessions.pinSession'), items: pinnedSessions, count: pinnedSessions.length },
    { key: 'running', label: t('sessions.running'), items: runningSessions, count: runningSessions.length },
    { key: 'ended', label: t('sessions.ended'), items: endedVisible, count: endedSessions.length },
  ].filter((group) => group.count > 0);

  const renderSession = (item: RailSession) => {
    const { session } = item;
    const selected = session.id === selectedId;
    const failed = !session.running && session.exitCode != null && session.exitCode !== 0;
    const yolo = session.mode === 'yolo';
    const tooltip = [stableTitle(item.title), item.place, item.name, item.directory, activityLabel(item)].filter(Boolean).join('\n');
    return <div key={session.id} className={styles.row} data-running={session.running || undefined} data-attention={item.attention || undefined} data-selected={selected || undefined} data-on-screen={item.pane != null || undefined}>
      <button type="button" role="tab" data-session-id={session.id} className={styles.session} aria-selected={selected} aria-haspopup="menu" title={tooltip}
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
        <span className={styles.sessionIconWrap} data-rail-icon="" data-tone={item.tone}>
          <ToolIcon toolId={session.toolId} size={compact ? 20 : 18} />
          <SessionActivityIcon tone={item.tone} slot="rail" className={styles.sessionStateDot} />
          {compact && yolo && <span className={styles.yoloBadge} title={t('sessions.modeYolo')} aria-hidden="true"><Icon name="sparkle" size={9} /></span>}
          {compact && (item.unread || item.attention) && <span className={styles.slimNotice} data-attention={item.attention || undefined} aria-hidden="true" />}
        </span>
        <span className={styles.sessionBody}>
          <span className={styles.sessionTop}>
            {item.pinned && <span className={styles.pinBadge} title={t('sessions.unpinSession')}><Icon name="pin" size={12} /></span>}
            <strong>{item.title ? <SessionTitle title={item.title} /> : item.place}</strong>
            {item.unread && <span className={styles.unreadDot} title={t('sessions.unread')} aria-label={t('sessions.unread')} />}
          </span>
          <span className={styles.sessionSub}>
            <span className={styles.sessionPlace}>{item.title ? item.place : item.name}</span>
            {yolo && <span className={styles.yoloTag}>{t('sessions.modeYolo')}</span>}
            {item.pane != null && <span className={styles.paneTag} title={t('sessions.splitView')}><Icon name="columns" size={11} />{item.pane + 1}</span>}
            {item.attention && <span className={styles.attentionTag}>{t('sessions.bellBadge')}</span>}
            {failed && <span className={styles.exitTag}>{t('sessions.exitCode', { code: session.exitCode })}</span>}
          </span>
          <span className={styles.srOnly}>{[item.title ? item.name : '', yolo ? t('sessions.modeYolo') : '', activityLabel(item)].filter(Boolean).join(' · ')}</span>
        </span>
        <span className={styles.sessionTime} data-tone={item.tone}>{session.running ? (item.elapsed || t('sessions.running')) : t('sessions.ended')}</span>
      </button>
      <div className={styles.rowActions}>
        <IconButton size="sm" tabIndex={-1} className={styles.rowMenuBtn} aria-label={t('sessions.sessionMenu', { name: item.name })} title={t('sessions.moreActions')} icon={<Icon name="more" size={16} />} onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onOpenMenu(session, rect.left, rect.bottom + 5);
        }} />
        {!session.running && <IconButton size="sm" tabIndex={-1} className={styles.rowRemove} aria-label={t('sessions.removeSession') + '：' + item.name} title={t('sessions.removeSession')} disabled={busy} onClick={() => onRemove(session)} icon={<Icon name="close" size={12} />} />}
      </div>
    </div>;
  };

  return <aside className={styles.rail} aria-label={t('sessions.listLabel')} data-slim={compact || undefined} data-strip={narrow || undefined} data-docked={docked || undefined}>
    <div className={styles.railHead} onDoubleClick={(event) => { if (!narrow && event.target === event.currentTarget) onToggleSlim(); }}>
      <div className={styles.railTitleRow}>
        <h1 className={narrow || compact ? styles.srOnly : styles.railTitle} tabIndex={-1}>{t('common.pages.sessions.title')}</h1>
        {!compact && !narrow && total > 0 && <span className={styles.railCount} title={t('sessions.summary', { running, ended })}><span className={styles.liveDot} data-live={running > 0 || undefined} aria-hidden="true" />{running > 0 ? t('sessions.runningCount', { count: running }) : t('sessions.railQuiet')}</span>}
        <span className={styles.railCompactLabel} aria-hidden="true"><Icon name="terminal" size={16} /></span>
        {canLaunch && <IconButton size="sm" variant="primary" className={styles.newSessionBtn} aria-label={t('sessions.newSession')} title={t('sessions.newSession') + ' (Alt+N)'} onClick={onNewSession} icon={<Icon name="plus" size={16} />} />}
      </div>
      {showSearch && <div className={styles.railSearchField} data-field-frame="">
        <Icon name="search" size={14} />
        <input type="search" value={search} placeholder={t('sessions.searchPlaceholder')} aria-label={t('sessions.searchPlaceholder')} onChange={(event) => onSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && search) { event.preventDefault(); onSearch(''); } }} />
        {search && <button type="button" className={styles.railSearchClear} aria-label={t('sessions.clearFilter')} title={t('sessions.clearFilter')} onClick={() => onSearch('')}><Icon name="close" size={12} /></button>}
      </div>}
    </div>

    <div className={styles.list} role="tablist" aria-label={t('sessions.listLabel')} aria-orientation={narrow ? 'horizontal' : 'vertical'} onKeyDown={onListKeyDown}>
      {groups.map((group) => <div key={group.key} className={styles.sessionGroup} role="presentation" data-group={group.key}>
        {(groups.length > 1 || group.key === 'ended') && <div className={styles.groupLabel} role="presentation">
          {group.key === 'ended' && !compact && !narrow
            ? <button type="button" className={styles.groupToggle} aria-expanded={!endedCollapsed} title={endedCollapsed ? t('sessions.endedExpand') : t('sessions.endedCollapse')} onClick={onToggleEnded}><Icon name="chevronDown" size={12} /><span>{group.label}</span><em>{group.count}</em></button>
            : <><span>{group.label}</span>{!compact && <em>{group.count}</em>}</>}
          {group.key === 'ended' && !compact && !narrow && <button type="button" className={styles.groupAction} disabled={busy} aria-label={t('sessions.clearEnded')} title={t('sessions.clearEndedTitle')} onClick={onClearEnded}><Icon name="trash" size={12} /><span>{t('sessions.clearEndedShort')}</span></button>}
        </div>}
        {group.items.map(renderSession)}
      </div>)}
      {total > 0 && sessions.length === 0 && <div className={styles.railNoMatch}><Icon name="search" size={20} /><p>{t('sessions.noFilterMatch')}</p><button type="button" className={styles.railNoMatchClear} onClick={() => onSearch('')}>{t('sessions.clearFilter')}</button></div>}
    </div>

    {!narrow && !docked && <div className={styles.railFoot}>
      <IconButton size="sm" className={styles.railIconBtn} aria-label={toggleLabel} title={toggleTitle} onClick={onToggleSlim} icon={<Icon name={compact ? 'sidebarOpen' : 'sidebarClose'} size={16} />} />
      {!compact && <span className={styles.railSummary}>{ended > 0 ? t('sessions.summary', { running, ended }) : t('sessions.totalCount', { count: total })}</span>}
    </div>}
  </aside>;
}
