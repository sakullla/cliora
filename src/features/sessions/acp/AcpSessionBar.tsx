import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import type { AcpAccessKind, AcpSessionSnapshot } from '../../../types/acp';
import { acpIsLive, acpStateKey } from '../acpSession';
import { accessKindKey, compactNumber } from './acpView';
import styles from './acp.module.css';

/**
 * What the conversation is and how far it may reach: the agent, the directory,
 * the state in words, the title and usage the agent reported (absent until it
 * does), and whether it runs in YOLO or holds session grants. Each grant is a
 * badge that revokes itself on click; the next access of that kind asks again.
 */
export function AcpSessionBar({ snapshot, toolName, onRevoke, onHistory }: {
  snapshot: AcpSessionSnapshot;
  toolName: string;
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
  const agentLabel = agent?.title || agent?.name || toolName;
  const grants = live ? snapshot.grants ?? [] : [];

  function revoke(kind: AcpAccessKind) {
    if (revoking) return;
    setRevoking(kind);
    setError('');
    void onRevoke([kind])
      .catch((value) => setError(String((value as { message?: string })?.message ?? value)))
      .finally(() => setRevoking(''));
  }

  return <div className={styles.sessionBar} data-acp-bar="">
    <span className={styles.barItem} title={agent?.version ? `${agentLabel} ${agent.version}` : agentLabel}><Icon name="terminal" size={12} />{agentLabel}</span>
    <span className={`${styles.barItem} ${styles.barPath}`} title={snapshot.directory}><Icon name="folder" size={12} />{snapshot.directory}</span>
    {snapshot.info.title && <span className={`${styles.barItem} ${styles.barTitle}`} data-acp-title="" title={snapshot.info.title}>{snapshot.info.title}</span>}
    {usage && <span className={styles.barItem} data-acp-usage="" title={t('sessions.acpUsage', { used: usage.used.toLocaleString(), size: usage.size.toLocaleString() })}>
      <span className={styles.usageMeter} aria-hidden="true"><span style={{ width: `${usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : 0}%` }} /></span>
      {t('sessions.acpUsage', { used: compactNumber(usage.used, i18n.language), size: compactNumber(usage.size, i18n.language) })}
      {usage.cost && <span className={styles.barMuted}>{t('sessions.acpUsageCost', { amount: usage.cost.amount.toLocaleString(undefined, { maximumFractionDigits: 4 }), currency: usage.cost.currency })}</span>}
    </span>}
    <span className={styles.barBadges}>
      {snapshot.mode === 'yolo' && <span className={styles.badge} data-badge="yolo" title={t('sessions.acpYoloHint')}><Icon name="sparkle" size={11} />{t('sessions.acpYolo')}</span>}
      {grants.map((kind) => <button key={kind} type="button" className={styles.badge} data-badge="grant" data-grant={kind} disabled={!!revoking} aria-label={t('sessions.acpGrantRevoke', { kind: t(accessKindKey(kind)) })} title={t('sessions.acpGrantRevoke', { kind: t(accessKindKey(kind)) })} onClick={() => revoke(kind)}>
        <Icon name="shield" size={11} />{t('sessions.acpGrant', { kind: t(accessKindKey(kind)) })}<Icon name="close" size={10} />
      </button>)}
      {/* The stage bar above shows the session's state; this row keeps it for assistive
          tech only, so the pane never shows two differently worded states. */}
      <span className={styles.srOnly} data-acp-state={snapshot.state} role="status">{t(acpStateKey(snapshot.state))}</span>
      {onHistory && live && <button type="button" className={styles.iconAction} data-acp-history-open="" aria-label={t('sessions.acpHistoryOpen')} title={t('sessions.acpHistoryOpen')} onClick={onHistory}><Icon name="clock" size={13} /></button>}
    </span>
    {error && <p className={styles.error} role="alert">{error}</p>}
  </div>;
}
