import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import type { AcpAccessKind, AcpSessionSnapshot } from '../../../types/acp';
import { acpIsLive, acpStateKey } from '../acpSession';
import { accessKindKey, compactNumber } from './acpView';
import styles from './acp.module.css';

/**
 * Compact ACP-specific metadata strip. In single-pane view the workbench stage
 * bar already shows the tool name, directory, title, state and YOLO badge, so
 * this bar renders only ACP-exclusive metadata (context usage/cost, revocable
 * session grants, history entry, and any supplementary agent name/version) and
 * collapses to zero visual height when none is present. In split view it keeps
 * pane-level YOLO and title identification so side-by-side panes stay distinct.
 */
export function AcpSessionBar({ snapshot, toolName, inSplit = false, onRevoke, onHistory }: {
  snapshot: AcpSessionSnapshot;
  toolName: string;
  /** Whether this conversation is displayed inside a split layout. */
  inSplit?: boolean;
  onRevoke: (kinds: AcpAccessKind[]) => Promise<void>;
  /** Opens the agent's own session history; absent when it cannot be read. */
  onHistory?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [revoking, setRevoking] = useState('');
  const [error, setError] = useState('');
  const usage = snapshot.info.usage;
  const live = acpIsLive(snapshot);
  const agent = snapshot.agent?.agentInfo;
  const reportedName = (agent?.title || agent?.name || '').trim();
  const differsFromTool = !!reportedName && reportedName.toLowerCase() !== toolName.trim().toLowerCase();
  const agentSupplement = differsFromTool
    ? (agent?.version ? `${reportedName} ${agent.version}` : reportedName)
    : agent?.version
      ? `${reportedName || toolName} ${agent.version}`
      : '';
  const grants = live ? snapshot.grants ?? [] : [];
  const showTitle = inSplit && !!snapshot.info.title;
  const showYolo = inSplit && snapshot.mode === 'yolo';
  const showHistory = !!onHistory && live;
  const hasVisible = Boolean(agentSupplement || showTitle || usage || showYolo || grants.length > 0 || showHistory || error);

  function revoke(kind: AcpAccessKind) {
    if (revoking) return;
    setRevoking(kind);
    setError('');
    void onRevoke([kind])
      .catch((value) => setError(String((value as { message?: string })?.message ?? value)))
      .finally(() => setRevoking(''));
  }

  const stateAnnouncement = (
    /* The stage bar above shows the session's state; this node keeps it for
       assistive tech only, so the pane never shows two differently worded states. */
    <span className={styles.srOnly} data-acp-state={snapshot.state} role="status">{t(acpStateKey(snapshot.state))}</span>
  );

  if (!hasVisible) {
    return <div className={styles.sessionBarEmpty} data-acp-bar="" data-empty="">
      {stateAnnouncement}
    </div>;
  }

  return <div className={styles.sessionBar} data-acp-bar="" data-split={inSplit || undefined} aria-label={t('sessions.acpSessionMeta')}>
    {agentSupplement && <span className={`${styles.barItem} ${styles.barAgent}`} title={agentSupplement}>
      <Icon name="terminal" size={11} />{agentSupplement}
    </span>}
    {showTitle && <span className={`${styles.barItem} ${styles.barTitle}`} data-acp-title="" title={snapshot.info.title!}>{snapshot.info.title}</span>}
    {usage && <span className={styles.barItem} data-acp-usage="" title={t('sessions.acpUsage', { used: usage.used.toLocaleString(), size: usage.size.toLocaleString() })}>
      <span className={styles.usageMeter} aria-hidden="true"><span style={{ width: `${usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : 0}%` }} /></span>
      {t('sessions.acpUsage', { used: compactNumber(usage.used, i18n.language), size: compactNumber(usage.size, i18n.language) })}
      {usage.cost && <span className={styles.barMuted}>{t('sessions.acpUsageCost', { amount: usage.cost.amount.toLocaleString(undefined, { maximumFractionDigits: 4 }), currency: usage.cost.currency })}</span>}
    </span>}
    <span className={styles.barBadges}>
      {showYolo && <span className={styles.badge} data-badge="yolo" title={t('sessions.acpYoloHint')}><Icon name="sparkle" size={11} />{t('sessions.acpYolo')}</span>}
      {grants.map((kind) => <button key={kind} type="button" className={styles.badge} data-badge="grant" data-grant={kind} disabled={!!revoking} aria-label={t('sessions.acpGrantRevoke', { kind: t(accessKindKey(kind)) })} title={t('sessions.acpGrantRevoke', { kind: t(accessKindKey(kind)) })} onClick={() => revoke(kind)}>
        <Icon name="shield" size={11} />{t('sessions.acpGrant', { kind: t(accessKindKey(kind)) })}<Icon name="close" size={10} />
      </button>)}
      {stateAnnouncement}
      {showHistory && <button type="button" className={styles.iconAction} data-acp-history-open="" aria-label={t('sessions.acpHistoryOpen')} title={t('sessions.acpHistoryOpen')} onClick={onHistory}><Icon name="clock" size={13} /></button>}
    </span>
    {error && <p className={styles.error} role="alert">{error}</p>}
  </div>;
}
