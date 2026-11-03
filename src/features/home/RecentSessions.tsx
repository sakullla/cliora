import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { ToolIcon } from '../../components/ToolIcon';
import { Button } from '../../components/ui';
import { ToastStack } from '../../components/Toast';
import { useToasts } from '../../lib/toast';
import { native, nativeAvailable } from '../../lib/native';
import { shortPath } from '../../lib/paths';
import type { HistorySession } from '../../types/history';
import type { AdapterDescriptor } from '../../types/native';
import styles from './RecentSessions.module.css';

const LIMIT = 6;

/** Recent conversations from the local index, so work can continue straight from home.
 *  Read-only: the list comes from the indexed snapshot and never triggers a scan. Sessions
 *  without a native id or whose CLI is not managed are left out instead of offering a
 *  resume that cannot work; an empty or failed read renders nothing rather than fake recents. */
export function RecentSessions({ tools, active, onResume, onOpenRecords }: { tools: AdapterDescriptor[]; active: boolean; onResume: (session: HistorySession) => Promise<'workbench' | 'terminal' | 'failed'>; onOpenRecords: () => void }) {
  const { t, i18n } = useTranslation();
  const toasts = useToasts();
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const managed = new Map(tools.filter((tool) => tool.launchForm !== 'desktop').map((tool) => [tool.id, tool]));
  const toolKey = [...managed.keys()].join('|');

  useEffect(() => {
    if (!nativeAvailable || !active) return;
    let live = true;
    void native.listHistorySessions({ limit: 24 }).then((result) => {
      if (!live || !Array.isArray(result)) return;
      setSessions(result
        .filter((item) => item.nativeId && managed.has(item.toolId))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, LIMIT));
    }).catch(() => { if (live) setSessions([]); });
    return () => { live = false; };
    // The managed set is compared by its ids; the map itself is rebuilt every render.
  }, [active, toolKey]);

  if (!sessions.length) return null;
  const relative = new Intl.RelativeTimeFormat(i18n.language || 'zh-CN', { numeric: 'auto' });
  const when = (stamp: number | null) => {
    if (!stamp) return null;
    const minutes = Math.round((stamp - Date.now()) / 60000);
    const abs = Math.abs(minutes);
    if (abs < 1) return t('home.recent.justNow');
    if (abs < 60) return relative.format(minutes, 'minute');
    if (abs < 1440) return relative.format(Math.round(minutes / 60), 'hour');
    return relative.format(Math.round(minutes / 1440), 'day');
  };

  async function resume(session: HistorySession) {
    if (busy) return;
    setBusy(session.id);
    try {
      // An external terminal only confirms the request; it never claims the CLI resumed.
      if (await onResume(session) === 'terminal') toasts.showNotice(t('home.recent.terminalRequested'));
    } finally { setBusy(null); }
  }

  return <section className={`${styles.recent} home-recent`} aria-labelledby="home-recent-title">
    <div className="section-heading">
      <h2 id="home-recent-title">{t('home.recent.title')}</h2>
      <Button variant="ghost" size="sm" onClick={onOpenRecords}>{t('home.recent.viewAll')} <span aria-hidden="true">→</span></Button>
    </div>
    <ul className={styles.grid}>
      {sessions.map((session, index) => {
        const title = session.title.trim() || t('home.recent.untitled');
        const tool = managed.get(session.toolId);
        const time = when(session.updatedAt);
        return <li key={session.id} className={styles.card} style={{ animationDelay: `${index * 30}ms` }}>
          <span className={styles.icon} aria-hidden="true"><ToolIcon toolId={session.toolId} size={22} /></span>
          <span className={styles.copy}>
            <strong title={title}>{title}</strong>
            <span className={styles.meta}>
              <span>{tool?.name ?? session.toolId}</span>
              {time && <time>{time}</time>}
              {session.cwd && <span className={styles.path} title={session.cwd}>{shortPath(session.cwd)}</span>}
            </span>
          </span>
          <Button size="sm" className={styles.resume} icon={<Icon name="play" size={13} />} loading={busy === session.id} disabled={!!busy && busy !== session.id} aria-label={t('home.recent.resumeAria', { title })} title={t('home.recent.resumeAria', { title })} onClick={() => void resume(session)}>{t('home.recent.resume')}</Button>
        </li>;
      })}
    </ul>
    <ToastStack status={toasts.notice} alert={toasts.error} onDismiss={toasts.dismiss} />
  </section>;
}
