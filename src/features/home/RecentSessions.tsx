import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { ToolIcon } from '../../components/ToolIcon';
import { Badge, Button } from '../../components/ui';
import { ToastStack } from '../../components/Toast';
import { useToasts } from '../../lib/toast';
import { native, nativeAvailable } from '../../lib/native';
import { shortPath } from '../../lib/paths';
import type { HistorySession } from '../../types/history';
import type { AdapterDescriptor } from '../../types/native';
import styles from './RecentSessions.module.css';

const LIMIT = 6;

/** Indexed local conversations. Reads never trigger a scan, and an empty/failed read is explicit. */
export function RecentSessions({ tools, active, onResume, onOpenRecords }: { tools: AdapterDescriptor[]; active: boolean; onResume: (session: HistorySession) => Promise<'workbench' | 'terminal' | 'failed'>; onOpenRecords: () => void }) {
  const { t, i18n } = useTranslation();
  const toasts = useToasts();
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [readFailed, setReadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const managed = new Map(tools.filter((tool) => tool.launchForm !== 'desktop').map((tool) => [tool.id, tool]));
  const toolKey = [...managed.keys()].join('|');

  useEffect(() => {
    if (!nativeAvailable || !active) return;
    let live = true;
    setLoading(true);
    void native.listHistorySessions({ limit: 24 }).then((result) => {
      if (!live || !Array.isArray(result)) return;
      setSessions(result
        .filter((item) => item.nativeId && managed.has(item.toolId))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, LIMIT));
      setReadFailed(false);
    }).catch(() => { if (live) setReadFailed(true); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // The managed set is compared by its ids; the map itself is rebuilt every render.
  }, [active, toolKey, reload]);

  if (!nativeAvailable) return null;
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

  return <section className={`${styles.recent} home-recent`} aria-labelledby="home-recent-title" data-home-section="recent">
    <div className="section-heading">
      <h2 id="home-recent-title">{t('home.recent.title')}{sessions.length > 0 && <Badge className="heading-count" aria-hidden="true">{sessions.length}</Badge>}</h2>
      <Button variant="ghost" size="sm" onClick={onOpenRecords}>{t('home.recent.viewAll')} <span aria-hidden="true">→</span></Button>
    </div>
    {readFailed && <div className={styles.readState} data-tone="error" role="alert"><span>{t(sessions.length ? 'home.recent.refreshFailed' : 'home.recent.loadFailed')}</span><Button size="sm" variant="ghost" loading={loading} onClick={() => setReload((value) => value + 1)}>{t('home.recent.retry')}</Button></div>}
    {loading && !sessions.length && !readFailed ? <div className={styles.readState} role="status">{t('home.recent.loading')}</div>
      : sessions.length === 0 && !readFailed ? <div className={styles.readState}><span><strong>{t('home.recent.emptyTitle')}</strong><small>{t('home.recent.emptyDetail')}</small></span></div>
      : sessions.length > 0 && <ul className={styles.grid}>
        {sessions.map((session) => {
          const title = session.title.trim() || t('home.recent.untitled');
          const tool = managed.get(session.toolId);
          const time = when(session.updatedAt);
          return <li key={session.id} className={styles.card}>
            <span className={styles.icon} aria-hidden="true"><ToolIcon toolId={session.toolId} size={20} /></span>
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
      </ul>}
    <ToastStack status={toasts.notice} alert={toasts.error} onDismiss={toasts.dismiss} />
  </section>;
}
