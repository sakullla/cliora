import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import type { AcpPlanEntry } from '../../../types/acp';
import { planPriorityKey, planStatusIcon, planStatusKey } from './acpView';
import styles from './acp.module.css';

/**
 * The agent's current plan, pinned above the timeline and foldable: progress as
 * done/total, each entry with its status (icon and word) and priority. A new plan
 * replaces the old one whole; an empty plan hides the panel. A plan whose every
 * entry is done folds to its one-line progress (the reader may open it); any
 * update that brings an unfinished entry opens it again. Nothing here infers that
 * the task itself is done.
 */
export function AcpPlan({ entries }: { entries: AcpPlanEntry[] }) {
  const { t } = useTranslation();
  const done = entries.filter((entry) => entry.status === 'completed').length;
  const finished = entries.length > 0 && done === entries.length;
  const [open, setOpen] = useState(!finished);
  // Each plan update decides afresh: finished folds, unfinished opens.
  useEffect(() => { setOpen(!finished); }, [entries, finished]);
  if (!entries.length) return null;
  return <details className={styles.plan} open={open} data-acp-plan="" data-finished={finished || undefined} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className={styles.planHead}>
      <Icon name="chevronRight" size={12} className={styles.disclosure} />
      <Icon name="list" size={12} />
      <span>{t('sessions.acpPlan', { done, total: entries.length })}</span>
      <span className={styles.planMeter} role="progressbar" aria-label={t('sessions.acpPlanProgress')} aria-valuemin={0} aria-valuemax={entries.length} aria-valuenow={done}>
        <span style={{ width: `${Math.round((done / entries.length) * 100)}%` }} />
      </span>
    </summary>
    <ol className={styles.planList}>
      {entries.map((entry, index) => <li key={index} data-status={entry.status} data-priority={entry.priority}>
        <span className={styles.planStatus}><Icon name={planStatusIcon(entry.status)} size={11} /></span>
        <span className={styles.planText}>{entry.content}</span>
        <span className={styles.planPriority} data-priority={entry.priority}>{t(planPriorityKey(entry.priority))}</span>
        <span className={styles.planState}>{t(planStatusKey(entry.status))}</span>
      </li>)}
    </ol>
  </details>;
}
