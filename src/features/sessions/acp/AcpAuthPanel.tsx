import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import type { AcpSessionSnapshot } from '../../../types/acp';
import { acpProtocolLoginMethods } from '../acpSession';
import { visibleControls } from './acpView';
import styles from './acpComposer.module.css';

function errorText(value: unknown): string {
  return String((value as { message?: string })?.message ?? value);
}

/**
 * Stands in for the composer while the agent waits for a login. Each method the
 * agent can complete over the protocol is a button; a failed login says why and
 * stays here to be tried again. A login the agent runs in its own terminal flow
 * opens a terminal session in the same directory. Cliora never reads or keeps the
 * credentials.
 */
export function AcpAuthPanel({ snapshot, toolName, onAuthenticate, onLoginTerminal }: {
  snapshot: AcpSessionSnapshot;
  toolName: string;
  onAuthenticate: (methodId: string) => Promise<void>;
  /** Absent where no terminal can be opened. */
  onLoginTerminal?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const methods = acpProtocolLoginMethods(snapshot);
  const others = (snapshot.agent?.authMethods ?? []).filter((method) => method.type !== 'agent');
  const reason = error || snapshot.authError || '';

  async function login(methodId: string) {
    if (busy) return;
    setBusy(methodId);
    setError('');
    try { await onAuthenticate(methodId); }
    catch (value) { setError(t('sessions.acpLoginFailed', { reason: errorText(value) })); }
    finally { setBusy(''); }
  }

  async function terminal() {
    if (busy || !onLoginTerminal) return;
    setBusy('terminal');
    setError('');
    try { await onLoginTerminal(); }
    catch (value) { setError(errorText(value)); }
    finally { setBusy(''); }
  }

  return <section className={styles.auth} data-acp-auth="" aria-label={t('sessions.acpLoginTitle', { tool: toolName })}>
    <strong className={styles.authTitle}><Icon name="lock" size={13} />{t('sessions.acpLoginTitle', { tool: toolName })}</strong>
    <p className={styles.authHint}>{t('sessions.acpLoginHint')}</p>
    {reason && <p className={styles.error} role="alert" data-acp-auth-error="">{visibleControls(reason)}</p>}
    {methods.length > 0 ? <ul className={styles.authMethods}>
      {methods.map((method) => <li key={method.id} className={styles.authMethod}>
        <button type="button" className={styles.button} data-variant="primary" disabled={!!busy} aria-busy={busy === method.id || undefined} onClick={() => void login(method.id)}>
          {busy === method.id ? t('sessions.acpLoginRunning') : t('sessions.acpLoginWith', { name: method.name || method.id })}
        </button>
        {method.description && <span className={styles.authDetail}>{visibleControls(method.description)}</span>}
      </li>)}
    </ul> : <p className={styles.authHint}>{t('sessions.acpLoginNoMethods', { tool: toolName })}</p>}
    {others.length > 0 && <ul className={styles.authOthers}>
      {others.map((method) => <li key={method.id}>{t('sessions.acpLoginTerminalMethod', { name: method.name || method.id })}{method.description ? ` · ${visibleControls(method.description)}` : ''}</li>)}
    </ul>}
    {onLoginTerminal && <div className={styles.authTerminal}>
      <button type="button" className={styles.button} disabled={!!busy} onClick={() => void terminal()}><Icon name="terminal" size={12} />{t('sessions.acpLoginTerminal')}</button>
      <span className={styles.authDetail}>{t('sessions.acpLoginTerminalHint', { tool: toolName })}</span>
    </div>}
  </section>;
}
