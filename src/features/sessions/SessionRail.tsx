import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { ToolIcon } from '../../components/ToolIcon';
import { navigateChoices } from '../../lib/choiceNavigation';
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
};

export function SessionRail({ sessions, total, running, ended, filter, search, selectedId, narrow, busy, canLaunch, onFilter, onSearch, onSelect, onNewSession, onOpenMenu, onRemove, onClearEnded }: {
  sessions: RailSession[];
  total: number;
  running: number;
  ended: number;
  filter: RailFilter;
  search: string;
  selectedId: string | null;
  narrow: boolean;
  busy: boolean;
  canLaunch: boolean;
  onFilter: (filter: RailFilter) => void;
  onSearch: (query: string) => void;
  onSelect: (id: string) => void;
  onNewSession: () => void;
  onOpenMenu: (session: WorkbenchSession, x: number, y: number) => void;
  onRemove: (session: WorkbenchSession) => void;
  onClearEnded: () => void;
}) {
  const { t } = useTranslation();

  const activityLabel = (item: RailSession) => {
    if (item.attention) return t('sessions.bellBadge');
    if (!item.session.running) return item.tone === 'error' ? t('sessions.stateError') : t('sessions.ended');
    return item.tone === 'live' ? t('sessions.stateStreaming') : t('sessions.running');
  };

  return <aside className={styles.rail} aria-label={t('sessions.listLabel')}>
    <div className={styles.railHead}>
      <div className={styles.railTitleRow}>
        <div className={styles.railHeading}>
          <span className={styles.railEyebrow}>{t('sessions.workspaceEyebrow')}</span>
          <h1 className={narrow ? styles.srOnly : styles.railTitle} tabIndex={-1}>{t('common.pages.sessions.title')}</h1>
        </div>
        <span className={styles.railCompactLabel} aria-hidden="true"><Icon name="terminal" size={17} /></span>
        {canLaunch && <button type="button" className={styles.newSessionBtn} aria-label={t('sessions.newSession')} title={t('sessions.newSession') + ' (Alt+N)'} onClick={onNewSession}>
          <Icon name="plus" size={15} /><span>{t('sessions.newSessionShort')}</span>
        </button>}
      </div>
      <div className={styles.railOverview}>
        <span className={styles.railLive}><span className={styles.liveDot} data-live={running > 0 || undefined} aria-hidden="true" />{running > 0 ? t('sessions.runningCount', { count: running }) : t('sessions.railQuiet')}</span>
        <span>{t('sessions.totalCount', { count: total })}</span>
      </div>
      {total > 1 && <div className={styles.railSearchField}>
        <Icon name="search" size={14} />
        <input type="search" value={search} placeholder={t('sessions.searchPlaceholder')} aria-label={t('sessions.searchPlaceholder')} onChange={(event) => onSearch(event.target.value)} />
        {search && <button type="button" className={styles.railSearchClear} aria-label={t('sessions.clearFilter')} title={t('sessions.clearFilter')} onClick={() => onSearch('')}><Icon name="close" size={11} /></button>}
      </div>}
      {total > 1 && <div className={styles.segmented} role="group" aria-label={t('sessions.filterLabel')}>
        <button type="button" aria-pressed={filter === 'all'} onClick={() => onFilter('all')}><span>{t('sessions.filterAll')}</span><em>{total}</em></button>
        <button type="button" aria-pressed={filter === 'running'} onClick={() => onFilter('running')}><span>{t('sessions.filterRunning')}</span><em>{running}</em></button>
        {ended > 0 && <button type="button" aria-pressed={filter === 'ended'} onClick={() => onFilter('ended')}><span>{t('sessions.filterEnded')}</span><em>{ended}</em></button>}
      </div>}
    </div>

    <div className={styles.list} role="tablist" aria-label={t('sessions.listLabel')} title={t('sessions.shortcutsHint')} onKeyDown={navigateChoices}>
      {sessions.map((item) => {
        const { session } = item;
        const selected = session.id === selectedId;
        return <div key={session.id} className={styles.row} data-running={session.running || undefined} data-attention={item.attention || undefined} data-selected={selected || undefined}>
          <button type="button" role="tab" data-session-id={session.id} className={styles.session} aria-selected={selected} aria-haspopup="menu" title={[item.title, item.directory || item.place].filter(Boolean).join('\n')}
            onClick={() => onSelect(session.id)}
            onContextMenu={(event) => { event.preventDefault(); onOpenMenu(session, event.clientX, event.clientY); }}
            onKeyDown={(event) => {
              if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                onOpenMenu(session, rect.left + 24, rect.bottom - 6);
              }
            }}>
            <span className={styles.sessionIconWrap}><ToolIcon toolId={session.toolId} size={20} /><span className={styles.sessionStateDot} data-tone={item.tone} aria-hidden="true" /></span>
            <span className={styles.sessionBody}>
              <span className={styles.sessionTop}>
                {item.pinned && <span className={styles.pinBadge} title={t('sessions.unpinSession')}><Icon name="pin" size={11} /></span>}
                <strong>{item.title || item.name}</strong>
                <span className={styles.sessionTime} data-tone={item.tone}>{session.running ? (item.elapsed || t('sessions.running')) : t('sessions.ended')}</span>
              </span>
              <span className={styles.sessionSub}><span className={styles.sessionPlace}>{item.title ? item.name + ' · ' + item.place : item.place}</span></span>
              <span className={styles.sessionFoot}>
                <span className={styles.sessionActivity} data-tone={item.tone}>{activityLabel(item)}</span>
                <span className={styles.sessionBadges}>
                  {!session.running && session.exitCode != null && session.exitCode !== 0 && <span className={styles.exitTag}>{t('sessions.exitCode', { code: session.exitCode })}</span>}
                  <span className={styles.modeTag} data-mode={session.mode}>{session.mode === 'yolo' ? <Icon name="sparkle" size={10} /> : <Icon name="shield" size={10} />}{t(session.mode === 'yolo' ? 'sessions.modeYolo' : 'sessions.modeNormal')}</span>
                </span>
              </span>
            </span>
          </button>
          <div className={styles.rowActions}>
            <button type="button" tabIndex={-1} className={styles.rowMenuBtn} aria-label={t('sessions.sessionMenu', { name: item.name })} title={t('sessions.moreActions')} onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              onOpenMenu(session, rect.left, rect.bottom + 5);
            }}><Icon name="more" size={15} /></button>
            {!session.running && <button type="button" tabIndex={-1} className={styles.rowRemove} aria-label={t('sessions.removeSession') + '：' + item.name} title={t('sessions.removeSession')} disabled={busy} onClick={() => onRemove(session)}><Icon name="close" size={12} /></button>}
          </div>
        </div>;
      })}
      {total > 0 && sessions.length === 0 && <div className={styles.railNoMatch}><Icon name="search" size={20} /><p>{t('sessions.noFilterMatch')}</p><button type="button" className={styles.ghostButton} onClick={() => { onFilter('all'); onSearch(''); }}>{t('sessions.clearFilter')}</button></div>}
    </div>

    {total > 0 && <div className={styles.railFoot}>
      <span className={styles.railSummary}><span className={styles.summaryDot} data-live={running > 0 || undefined} aria-hidden="true" />{t('sessions.summary', { running, ended })}</span>
      {ended > 0 && <button type="button" className={styles.clearEndedBtn} disabled={busy} title={t('sessions.clearEndedTitle')} onClick={onClearEnded}><Icon name="trash" size={12} /><span>{t('sessions.clearEnded')}</span></button>}
    </div>}
  </aside>;
}
