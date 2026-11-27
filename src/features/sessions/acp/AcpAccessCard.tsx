import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../../../components/Icon';
import type { AcpAccess } from '../../../types/acp';
import { AcpDiff } from './AcpDiff';
import { splitMatchRuns } from './acpSearch';
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

function renderRuns(text: string, query: string, caseSensitive: boolean) {
  const safe = visibleControls(text);
  if (!query.trim()) return safe;
  return splitMatchRuns(safe, query, caseSensitive).map((run, index) => run.hit
    ? <mark key={index} className={styles.findMark}>{run.text}</mark>
    : run.text);
}

/**
 * One file or command access the host served for the agent. While it waits it is
 * Cliora's own approval card: the operation, the full path or command, and
 * "allow once", "allow for this session" or "deny", answered once. A card the
 * user's own drop raised offers only "allow once" and "deny": the user's picture
 * never widens what the agent may read. Afterwards it is the record of that
 * decision, automatic approvals included; a write keeps the diff of what it
 * changed and says the agent wrote it through Cliora.
 */
export function AcpAccessCard({
  access,
  toolName,
  answerable,
  busy,
  onAnswer,
  directory,
  onOpenPath,
  searchQuery = '',
  searchCase = false,
  findActive = false,
  located = false,
}: {
  access: AcpAccess;
  toolName: string;
  answerable: boolean;
  busy: boolean;
  onAnswer: (accessId: string, decision: AccessAnswer) => void;
  directory?: string;
  onOpenPath?: (target: string) => Promise<void>;
  searchQuery?: string;
  searchCase?: boolean;
  findActive?: boolean;
  located?: boolean;
}) {
  const { t } = useTranslation();
  const kind = t(accessKindKey(access.accessKind));
  const pending = access.decision === 'pending';
  if (pending && answerable && access.requestId) {
    const requestId = access.requestId;
    const byUser = access.userPath != null;
    return <section
      className={styles.card}
      role="group"
      aria-label={t(accessTitleKey(access.accessKind))}
      data-item-id={access.id}
      data-request-id={requestId}
      data-card="access"
      data-access-kind={access.accessKind}
      data-decision={access.decision}
      data-subagent={access.subagent ?? undefined}
      data-by-user={byUser || undefined}
      data-find-hit={findActive ? 'active' : undefined}
      data-located={located || undefined}
    >
      <div className={styles.cardHead}>
        <strong className={styles.cardTitle}><Icon name="shield" size={13} />{t(accessTitleKey(access.accessKind))}</strong>
        <span className={styles.cardTag}>{t('sessions.acpCardAccess')}</span>
      </div>
      <dl className={styles.accessFacts}>
        <dt>{t('sessions.acpAccessPath')}</dt><dd><code>{renderRuns(access.path, searchQuery, searchCase)}</code></dd>
        {access.detail && <><dt>{t('sessions.acpAccessCommand')}</dt><dd><code>{renderRuns(access.detail, searchQuery, searchCase)}</code></dd></>}
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
  return <div
    className={styles.accessRecord}
    data-item-id={access.id}
    data-card="access-record"
    data-access-kind={access.accessKind}
    data-decision={access.decision}
    data-automatic={accessAutomatic(access) || undefined}
    data-subagent={access.subagent ?? undefined}
    data-find-hit={findActive ? 'active' : undefined}
    data-located={located || undefined}
  >
    <div className={styles.accessLine}>
      <Icon name={decisionIcon(access)} size={12} />
      <span className={styles.accessDecision}>{t(accessDecisionKey(access.decision))}</span>
      <span className={styles.accessKind}>{kind}</span>
      <code className={styles.accessPath} title={access.path}>{renderRuns(access.path, searchQuery, searchCase)}</code>
    </div>
    {access.detail && <code className={styles.accessDetail}>{renderRuns(access.detail, searchQuery, searchCase)}</code>}
    {wrote && access.diff && <AcpDiff
      path={access.diff.path}
      oldText={access.diff.oldText}
      newText={access.diff.newText}
      truncated={access.diff.truncated}
      previousOmitted={access.diff.previousOmitted}
      label={t('sessions.acpAccessWrote', { tool: toolName, path: access.diff.path })}
      forceOpen={findActive}
      directory={directory}
      onOpenPath={onOpenPath}
      searchQuery={searchQuery}
      searchCase={searchCase}
    />}
  </div>;
}
