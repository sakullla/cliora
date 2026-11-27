import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../../../components/Icon';
import type { AcpAccess } from '../../../types/acp';
import { AcpDiff } from './AcpDiff';
import { accessAutomatic, accessDecisionKey, accessKindKey, accessTitleKey, visibleControls } from './acpView';
import styles from './acp.module.css';

export type AccessAnswer = 'once' | 'session' | 'deny';

function decisionIcon(access: AcpAccess): IconName {
  if (accessAutomatic(access)) return 'shield';
  switch (access.decision) {
    case 'denied': return 'ban';
    case 'withdrawn': return 'close';
    case 'inside': return 'pencil';
    default: return 'check';
  }
}

/**
 * One file or command access the host served for the agent. While it waits it is
 * Cliora's own approval card: the operation, the full path or command, and
 * "allow once", "allow for this session" or "deny", answered once. A card the
 * user's own drop raised offers only "allow once" and "deny": the user's picture
 * never widens what the agent may read. Afterwards it
 * is the record of that decision, automatic approvals included; a write keeps the
 * diff of what it changed and says the agent wrote it through Cliora.
 */
export function AcpAccessCard({ access, toolName, answerable, busy, onAnswer }: {
  access: AcpAccess;
  toolName: string;
  answerable: boolean;
  busy: boolean;
  onAnswer: (accessId: string, decision: AccessAnswer) => void;
}) {
  const { t } = useTranslation();
  const kind = t(accessKindKey(access.accessKind));
  const pending = access.decision === 'pending';
  if (pending && answerable && access.requestId) {
    const requestId = access.requestId;
    const byUser = access.userPath != null;
    return <section className={styles.card} role="group" aria-label={t(accessTitleKey(access.accessKind))} data-item-id={access.id} data-request-id={requestId} data-card="access" data-access-kind={access.accessKind} data-decision={access.decision} data-subagent={access.subagent ?? undefined} data-by-user={byUser || undefined}>
      <strong className={styles.cardTitle}><Icon name="shield" size={13} />{t(accessTitleKey(access.accessKind))}</strong>
      <dl className={styles.accessFacts}>
        <dt>{t('sessions.acpAccessPath')}</dt><dd><code>{visibleControls(access.path)}</code></dd>
        {access.detail && <><dt>{t('sessions.acpAccessCommand')}</dt><dd><code>{visibleControls(access.detail)}</code></dd></>}
      </dl>
      <p className={styles.note}>{byUser ? t('sessions.acpAccessUserHint', { tool: toolName }) : t('sessions.acpAccessOutsideHint')}</p>
      <div className={styles.cardActions}>
        <button type="button" className={styles.action} data-variant="primary" disabled={busy} onClick={() => onAnswer(requestId, 'once')}>{t('sessions.acpAccessOnce')}</button>
        {!byUser && <button type="button" className={styles.action} data-variant="secondary" disabled={busy} onClick={() => onAnswer(requestId, 'session')}>{t('sessions.acpAccessSession', { kind })}</button>}
        <button type="button" className={styles.action} data-variant="quiet" disabled={busy} onClick={() => onAnswer(requestId, 'deny')}>{t('sessions.acpAccessDeny')}</button>
      </div>
    </section>;
  }
  // A pending card the host no longer lists reads as waiting, not as answerable.
  const wrote = access.accessKind === 'write' && !!access.diff;
  return <div className={styles.accessRecord} data-item-id={access.id} data-card="access-record" data-access-kind={access.accessKind} data-decision={access.decision} data-automatic={accessAutomatic(access) || undefined} data-subagent={access.subagent ?? undefined}>
    <div className={styles.accessLine}>
      <Icon name={decisionIcon(access)} size={12} />
      <span className={styles.accessDecision}>{t(accessDecisionKey(access.decision))}</span>
      <span className={styles.accessKind}>{kind}</span>
      <code className={styles.accessPath} title={access.path}>{visibleControls(access.path)}</code>
    </div>
    {access.detail && <code className={styles.accessDetail}>{visibleControls(access.detail)}</code>}
    {wrote && access.diff && <AcpDiff path={access.diff.path} oldText={access.diff.oldText} newText={access.diff.newText} truncated={access.diff.truncated} previousOmitted={access.diff.previousOmitted} label={t('sessions.acpAccessWrote', { tool: toolName, path: access.diff.path })} />}
  </div>;
}
