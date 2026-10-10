import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { resourceError, resourceSucceeded, runResourceOperations } from '../../lib/resources';
import type { ResourceItemResult, ResourceOperation } from '../../types/resources';
import { FeedbackRegion, useFeedback } from '../Feedback';
import type { FeedbackOperation } from '../../lib/notifications';
import styles from './ResourceList.module.css';

export type BatchJob = { id: string; name: string; operation?: ResourceOperation; run?: () => Promise<{ status: string; detail: string } | void> };
export function ResourceBatch({ context, jobs, action, destructive, onChanged }: { context: string; jobs: BatchJob[]; action: string; destructive?: boolean; onChanged: () => Promise<void> }) {
  const { t } = useTranslation();
  const feedback = useFeedback(context);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Array<ResourceItemResult & { name: string; job: BatchJob }>>([]);
  const control = useRef({ cancelled: false, active: null as string | null });
  const live = useRef(true);
  const previousResult = useRef<FeedbackOperation | null>(null);
  function cancel() {
    control.current.cancelled = true;
    if (control.current.active) {
      const result = feedback.begin('cancel');
      void native.cancelResourceBatch(control.current.active).then(() => result.complete()).catch(error => result.error(resourceError(error)));
    }
  }
  useEffect(() => { live.current = true; return () => { live.current = false; cancel(); }; }, []);
  async function run(items: BatchJob[], retry = false) {
    if (busy) return;
    if (destructive && !await confirmAction(t('library.experience.confirmBatch', { count: items.length, action }), () => live.current, { destructive: true, title: action, confirmLabel: action })) return;
    const result = retry && previousResult.current ? feedback.resume(previousResult.current) : feedback.begin(JSON.stringify(['batch', action, items.map(item => item.id)]));
    previousResult.current = result;
    const retained = retry ? results.filter(item => resourceSucceeded(item.status)) : [];
    setBusy(true); control.current = { cancelled: false, active: null };
    let outcomes: ResourceItemResult[] = [];
    const show = (values: ResourceItemResult[]) => { if (live.current) setResults([...retained, ...values.map(item => ({ ...item, name: items[item.index].name, job: items[item.index] }))]); };
    try {
      if (items.every(item => item.operation)) outcomes = await runResourceOperations(items.map(item => item.operation!), control.current, show);
      else {
        for (let index = 0; index < items.length; index++) {
          if (control.current.cancelled) { outcomes.push({ index, status: 'not_executed', detail: '', value: null }); continue; }
          if (items[index].operation) {
            const start = index;
            const chunk: ResourceOperation[] = [];
            while (index < items.length && items[index].operation && chunk.length < 50) chunk.push(items[index++].operation!);
            index--;
            const prefix = [...outcomes];
            const written = await runResourceOperations(chunk, control.current, values => show([...prefix, ...values.map(item => ({ ...item, index: start + item.index }))]));
            outcomes.push(...written.map(item => ({ ...item, index: start + item.index })));
            continue;
          }
          try { const value = await items[index].run?.(); outcomes.push({ index, status: value ? resourceSucceeded(value.status) ? 'written' : value.status === 'conflict' ? 'conflict' : 'failed' : 'written', detail: value?.detail ?? '', value: null }); }
          catch (error) { outcomes.push({ index, status: 'failed', detail: resourceError(error), value: null }); }
          show([...outcomes]);
        }
      }
      show(outcomes);
      const successful = retained.length + outcomes.filter(item => resourceSucceeded(item.status)).length;
      const failed = outcomes.filter(item => !resourceSucceeded(item.status)).length;
      const summary = t('library.experience.result', { count: successful, failed });
      if (failed) result.partial(t('library.experience.batchNeedsAttention'), { detail: summary }); else result.success(t('library.experience.batchComplete'));
      try { await onChanged(); } catch (error) { result.error(resourceError(error)); }
    } finally { if (live.current) setBusy(false); }
  }
  return <div className={styles.batch}>
    <div className={styles.actions}><span>{t('library.experience.batchScope', { count: jobs.length, action })}</span><button type="button" disabled={busy || !jobs.length} onClick={() => void run(jobs)}>{action}</button>{busy && <button type="button" onClick={cancel}>{t('library.experience.cancelBatch')}</button>}{!busy && results.some(item => !resourceSucceeded(item.status)) && <button type="button" onClick={() => void run(results.filter(item => !resourceSucceeded(item.status)).map(item => jobs.find(job => job.id === item.job.id) ?? item.job), true)}>{t('library.experience.retryFailed')}</button>}</div>
    {!!results.length && <><p>{t('library.experience.result', { count: results.filter(item => resourceSucceeded(item.status)).length, failed: results.filter(item => !resourceSucceeded(item.status)).length })}</p><details><summary>{t('library.experience.results')}</summary><ul className={styles.results}>{results.map((item, index) => <li key={index}>{item.name} · {t(`library.experience.status.${item.status}`)} {item.detail}</li>)}</ul></details></>}
    <FeedbackRegion context={feedback.context} />
  </div>;
}
