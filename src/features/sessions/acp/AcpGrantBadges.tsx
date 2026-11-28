import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import type { AcpAccessKind } from '../../../types/acp';
import { accessKindKey } from './acpView';
import styles from './acpComposer.module.css';

function errorText(value: unknown): string {
  return String((value as { message?: string })?.message ?? value);
}

/**
 * What this session already allowed without asking again (reads, writes or commands
 * outside the directory), as small shield marks in the input card. Each one revokes its
 * own kind when clicked; the next access of that kind asks again. Nothing is shown
 * while there is no grant. A refused revoke says why in the action row.
 */
export function AcpGrantBadges({ grants, onRevoke }: {
  grants: AcpAccessKind[];
  onRevoke: (kinds: AcpAccessKind[]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [revoking, setRevoking] = useState('');
  const [error, setError] = useState('');
  if (!grants.length && !error) return null;

  function revoke(kind: AcpAccessKind) {
    if (revoking) return;
    setRevoking(kind);
    setError('');
    void onRevoke([kind])
      .catch((value) => setError(t('sessions.acpGrantRevokeFailed', { reason: errorText(value) })))
      .finally(() => setRevoking(''));
  }

  return <>
    {grants.length > 0 && <span className={styles.grants} data-acp-grants="">
      {grants.map((kind) => {
        const word = t(accessKindKey(kind));
        return <button
          key={kind}
          type="button"
          className={styles.grant}
          data-badge="grant"
          data-grant={kind}
          disabled={!!revoking}
          aria-busy={revoking === kind || undefined}
          aria-label={t('sessions.acpGrantRevoke', { kind: word })}
          title={t('sessions.acpGrantRevokeHint', { kind: word })}
          onClick={() => revoke(kind)}
        >
          <Icon name="shield" size={12} />
          <span className={styles.grantKind} aria-hidden="true">{word}</span>
        </button>;
      })}
    </span>}
    {error && <p className={styles.actionsError} role="alert" data-acp-grant-error="">{error}</p>}
  </>;
}
