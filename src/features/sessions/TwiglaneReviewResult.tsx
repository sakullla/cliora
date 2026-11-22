import type { TFunction } from 'i18next';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GuideDialog } from '../../components/GuideDialog';
import { Button } from '../../components/ui';
import { native } from '../../lib/native';
import type { TwiglaneReviewState, WorkbenchCodeStatus } from '../../types/launch';
import styles from './SessionWorkbench.module.css';

function sameReviewCheckout(a: string | null, b: string): boolean {
  if (!a) return false;
  const key = (path: string) => {
    if (/^[a-z]:[\\/]/i.test(path) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(path)) {
      return path.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    }
    return path.replace(/\/+$/, '') || '/';
  };
  return key(a) === key(b);
}

/** Use the checked Git result for both the live workbench and the saved review. */
export function describeReturnedReview(t: TFunction, review: TwiglaneReviewState, status: WorkbenchCodeStatus | null, unknownStatus: boolean) {
  if (review.protocolVersion === 1) {
    status = review.remoteCheck ?? null;
    if (status?.reason === 'invalid_baseline' || (status?.state === 'ready' && (status.sessionBase ?? null) !== review.baseline)) {
      return { tone: 'unconfirmed', text: t('sessions.reviewInvalidBaseline') };
    }
    unknownStatus = !status || status.state !== 'ready';
  }
  // 每一个 returned（包括 reviewed）都用真实 Git 状态复核：outcome、headOid 与 worktreeState
  // 都只是待复核声明。读不到真实状态就是未确认，绝不显示成 0 个文件或成功。
  const files = !unknownStatus && status?.state === 'ready' && typeof status.uncommittedFiles === 'number'
    ? status.uncommittedFiles
    : null;
  if (files === null || !status || !sameReviewCheckout(status.worktreePath, review.worktreePath)) return { tone: 'unconfirmed', text: t('sessions.reviewReturnedStatusUnknown') };
  if (review.protocolVersion === 1 && review.headOid && review.headOid !== status.headOid) {
    return { tone: 'unconfirmed', text: t('sessions.reviewUnconfirmed') };
  }
  const merged = review.outcome === 'merged';
  if (review.outcome === 'committed' || merged) {
    // 提交/合入声明：OID 必须与基线不同且等于当前 HEAD。
    const confirmed = !!review.headOid
      && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(review.headOid)
      && review.headOid !== review.baseline
      && status.headOid === review.headOid;
    if (!confirmed) return { tone: 'unconfirmed', text: t('sessions.reviewUnconfirmed') };
  } else if (review.outcome !== 'reviewed') {
    return { tone: 'unconfirmed', text: t('sessions.reviewReturnedStatusUnknown') };
  }
  // 工作区声明与真实读取不一致也是未确认；unknown 只表示声明未知，以真实读取为准。
  const claim = review.worktreeState;
  if ((claim === 'clean' && files > 0) || (claim === 'dirty' && files === 0)) {
    return { tone: 'unconfirmed', text: t('sessions.reviewUnconfirmedWorktree') };
  }
  if (review.outcome === 'reviewed') {
    return files > 0
      ? { tone: 'returned', text: t('sessions.reviewReturnedDirty', { count: files }) }
      : { tone: 'returned', text: t('sessions.reviewReturnedClean') };
  }
  const oid = review.headOid!.slice(0, 7);
  const key = files > 0
    ? (merged ? 'sessions.reviewReturnedMergedDirty' : 'sessions.reviewReturnedCommittedDirty')
    : (merged ? 'sessions.reviewReturnedMerged' : 'sessions.reviewReturnedCommitted');
  return { tone: 'confirmed', text: t(key, { oid, count: files }) };
}

export function TwiglaneReviewResult({ sessionId, reviewId, host, onClose }: {
  sessionId: string;
  reviewId: string;
  host: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [review, setReview] = useState<TwiglaneReviewState | null>(null);
  const [error, setError] = useState<'expired' | 'read' | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    void native.twiglaneReviewState(sessionId).then((saved) => {
      if (!current) return;
      if (saved?.reviewId === reviewId && saved.sessionId === sessionId && saved.protocolVersion === 1 && saved.status === 'returned') {
        setReview(saved);
      } else {
        setError('expired');
      }
    }).catch(() => { if (current) setError('read'); });
    return () => { current = false; };
  }, [sessionId, reviewId, attempt]);
  const result = review && describeReturnedReview(t, review, null, true);
  return <GuideDialog open title={t('sessions.savedReviewResultTitle')} onClose={onClose}>
    <p className={styles.savedReviewSummary} role={error ? 'alert' : 'status'}>
      {result?.text ?? t(error === 'expired'
        ? 'sessions.reviewReturnExpired'
        : error === 'read' ? 'sessions.savedReviewReadFailed' : 'sessions.savedReviewLoading')}
    </p>
    <dl className={styles.savedReviewDetails}>
      <dt>{t('sessions.savedReviewHost')}</dt><dd>{host}</dd>
      {review && <><dt>{t('sessions.savedReviewWorktree')}</dt><dd><code>{review.worktreePath}</code></dd></>}
      <dt>{t('sessions.savedReviewSession')}</dt><dd><code>{sessionId}</code></dd>
      {result?.tone === 'confirmed' && <><dt>HEAD</dt><dd><code>{review?.headOid}</code></dd></>}
    </dl>
    {error === 'read' && <Button className={styles.savedReviewRetry} size="sm" onClick={() => { setError(null); setAttempt(value => value + 1); }}>
      {t('sessions.savedReviewReadRetry')}
    </Button>}
  </GuideDialog>;
}
