import { useTranslation } from 'react-i18next';
import type { KeyboardEvent } from 'react';
import { Icon } from '../../components/Icon';
import { ToolIcon } from '../../components/ToolIcon';
import { SessionActivityIcon } from './SessionActivityIcon';
import type { WorkbenchSession } from '../../types/launch';
import styles from './SessionWorkbench.module.css';

export type SessionTone = 'live' | 'idle' | 'bell' | 'error' | 'ended';
export type RailFilter = 'all' | 'running' | 'ended';

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

export function SessionRail({ sessions, total, running, ended, filter, search, selectedId, narrow, slim, busy, canLaunch, onFilter, onSearch, onSelect, onNewSession, onOpenMenu, onRemove, onClearEnded, onToggleSlim }: {
  sessions: RailSession[];
  total: number;
  running: number;
  ended: number;
  filter: RailFilter;
  search: string;
  selectedId: string | null;
  narrow: boolean;
  slim: boolean;
  busy: boolean;
  canLaunch: boolean;
  onFilter: (filter: RailFilter) => void;
  onSearch: (query: string) => void;
  onSelect: (id: string, focusTerminal?: boolean) => void;
  onNewSession: () => void;
  onOpenMenu: (session: WorkbenchSession, x: number, y: number) => void;
  onRemove: (session: WorkbenchSession) => void;
  onClearEnded: () => void;
  onToggleSlim: () => void;
}) {
  const { t } = useTranslation();
  const compact = slim && !narrow;

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
  const groups = [
    { key: 'pinned', label: t('sessions.pinSession'), items: pinnedSessions },
    { key: 'running', label: t('sessions.running'), items: runningSessions },
    { key: 'ended', label: t('sessions.ended'), items: endedSessions },
  ].filter((group) => group.items.length > 0);

  const renderSession = (item: RailSession) => {
    const { session } = item;
    const selected = session.id === selectedId;
    const failed = !session.running && session.exitCode != null && session.exitCode !== 0;
    const tooltip = [item.title, item.place, item.name, item.directory, activityLabel(item)].filter(Boolean).join('\n');
    return <div key={session.id} className={styles.row} data-running={session.running || undefined} data-attention={item.attention || undefined} data-selected={selected || undefined} data-on-screen={item.pane != null || undefined}>
      <button type="button" role="tab" data-session-id={session.id} className={styles.session} aria-selected={selected} aria-haspopup="menu" title={tooltip}
        onClick={() => onSelect(session.id)}
        onContextMenu={(event) => { event.preventDefault(); onOpenMenu(session, event.clientX, event.clientY); }}
        onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            onOpenMenu(session, rect.left + 24, rect.bottom - 6);
          }
        }}>
        <span className={styles.sessionIconWrap}><ToolIcon toolId={session.toolId} size={compact ? 20 : 18} /><SessionActivityIcon tone={item.tone} slot="rail" className={styles.sessionStateDot} />{session.mode === 'yolo' && <span className={styles.yoloBadge} title={t('sessions.modeYolo')} aria-hidden="true"><Icon name="sparkle" size={9} /></span>}</span>
        <span className={styles.sessionBody}>
          <span className={styles.sessionTop}>
            {item.pinned && <span className={styles.pinBadge} title={t('sessions.unpinSession')}><Icon name="pin" size={12} /></span>}
            <strong>{item.title || item.place}</strong>
            {item.unread && <span className={styles.unreadDot} title={t('sessions.unread')} aria-label={t('sessions.unread')} />}
          </span>
          <span className={styles.sessionSub}>
            <span className={styles.sessionPlace}>{item.title ? item.place : item.name}</span>
            {item.pane != null && <span className={styles.paneTag} title={t('sessions.splitView')}><Icon name="columns" size={11} />{item.pane + 1}</span>}
            {item.attention && <span className={styles.attentionTag}>{t('sessions.bellBadge')}</span>}
            {failed && <span className={styles.exitTag}>{t('sessions.exitCode', { code: session.exitCode })}</span>}
          </span>
          <span className={styles.srOnly}>{[item.title ? item.name : '', session.mode === 'yolo' ? t('sessions.modeYolo') : '', activityLabel(item)].filter(Boolean).join(' · ')}</span>
        </span>
        <span className={styles.sessionTime} data-tone={item.tone}>{session.running ? (item.elapsed || t('sessions.running')) : t('sessions.ended')}</span>
      </button>
      <div className={styles.rowActions}>
        <button type="button" tabIndex={-1} className={styles.rowMenuBtn} aria-label={t('sessions.sessionMenu', { name: item.name })} title={t('sessions.moreActions')} onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onOpenMenu(session, rect.left, rect.bottom + 5);
        }}><Icon name="more" size={16} /></button>
        {!session.running && <button type="button" tabIndex={-1} className={styles.rowRemove} aria-label={t('sessions.removeSession') + '：' + item.name} title={t('sessions.removeSession')} disabled={busy} onClick={() => onRemove(session)}><Icon name="close" size={12} /></button>}
      </div>
    </div>;
  };

  return <aside className={styles.rail} aria-label={t('sessions.listLabel')} data-slim={compact || undefined}>
    <div className={styles.railHead}>
      <div className={styles.railTitleRow}>
        <h1 className={narrow || compact ? styles.srOnly : styles.railTitle} tabIndex={-1}>{t('common.pages.sessions.title')}</h1>
        {!compact && !narrow && <span className={styles.railLive} title={t('sessions.summary', { running, ended })}><span className={styles.liveDot} data-live={running > 0 || undefined} aria-hidden="true" />{running > 0 ? t('sessions.runningCount', { count: running }) : t('sessions.railQuiet')}</span>}
        <span className={styles.railCompactLabel} aria-hidden="true"><Icon name="terminal" size={16} /></span>
        <span className={styles.railHeadActions}>
          {!narrow && <button type="button" className={styles.railIconBtn} aria-label={compact ? t('sessions.railExpand') : t('sessions.railCollapse')} title={compact ? t('sessions.railExpand') : t('sessions.railCollapse')} onClick={onToggleSlim}><Icon name={compact ? 'sidebarOpen' : 'sidebarClose'} size={16} /></button>}
          {canLaunch && <button type="button" className={styles.newSessionBtn} aria-label={t('sessions.newSession')} title={t('sessions.newSession') + ' (Alt+N)'} onClick={onNewSession}>
            <Icon name="plus" size={14} /><span>{t('sessions.newSessionShort')}</span>
          </button>}
        </span>
      </div>
      {total > 1 && !compact && <div className={styles.railSearchField}>
        <Icon name="search" size={14} />
        <input type="search" value={search} placeholder={t('sessions.searchPlaceholder')} aria-label={t('sessions.searchPlaceholder')} onChange={(event) => onSearch(event.target.value)} />
        {search && <button type="button" className={styles.railSearchClear} aria-label={t('sessions.clearFilter')} title={t('sessions.clearFilter')} onClick={() => onSearch('')}><Icon name="close" size={12} /></button>}
      </div>}
      {total > 1 && !compact && (ended > 0 || filter !== 'all') && <div className={styles.segmented} role="group" aria-label={t('sessions.filterLabel')}>
        <button type="button" aria-pressed={filter === 'all'} onClick={() => onFilter('all')}><span>{t('sessions.filterAll')}</span><em>{total}</em></button>
        <button type="button" aria-pressed={filter === 'running'} onClick={() => onFilter('running')}><span>{t('sessions.filterRunning')}</span><em>{running}</em></button>
        {ended > 0 && <button type="button" aria-pressed={filter === 'ended'} onClick={() => onFilter('ended')}><span>{t('sessions.filterEnded')}</span><em>{ended}</em></button>}
      </div>}
    </div>

    <div className={styles.list} role="tablist" aria-label={t('sessions.listLabel')} aria-orientation={narrow ? 'horizontal' : 'vertical'} onKeyDown={onListKeyDown}>
      {groups.map((group) => <div key={group.key} className={styles.sessionGroup} role="presentation">
        {groups.length > 1 && <div className={styles.groupLabel} role="presentation"><span>{group.label}</span></div>}
        {group.items.map(renderSession)}
      </div>)}
      {total > 0 && sessions.length === 0 && <div className={styles.railNoMatch}><Icon name="search" size={20} /><p>{t('sessions.noFilterMatch')}</p><button type="button" className={styles.ghostButton} onClick={() => { onFilter('all'); onSearch(''); }}>{t('sessions.clearFilter')}</button></div>}
    </div>

    {ended > 0 && !compact && <div className={styles.railFoot}>
      <span className={styles.railSummary}>{t('sessions.summary', { running, ended })}</span>
      <button type="button" className={styles.clearEndedBtn} disabled={busy} title={t('sessions.clearEndedTitle')} onClick={onClearEnded}><Icon name="trash" size={12} /><span>{t('sessions.clearEnded')}</span></button>
    </div>}
  </aside>;
}
