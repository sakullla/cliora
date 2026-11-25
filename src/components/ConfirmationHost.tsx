import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { answerConfirmation, answerSecretApproval, confirmationSnapshot, dismissSecretApproval, presentSecretApproval, secretApprovalSnapshot, subscribeConfirmation, subscribeSecretApproval } from '../lib/confirm';
import { nativeAvailable, SECRET_APPROVAL_EVENT } from '../lib/native';
import type { PromptSecretApprovalRequest } from '../types/secrets';
import { Icon } from './Icon';
import { Button } from './ui';

/**
 * The application dialog host. It owns two queues: ordinary confirmations requested
 * by a window action, and secret read approvals requested by the broker. An approval
 * shows the aliases requiring consent and the request source.
 */
export function ConfirmationHost() {
  const { t } = useTranslation();
  const request = useSyncExternalStore(subscribeConfirmation, confirmationSnapshot);
  const approval = useSyncExternalStore(subscribeSecretApproval, secretApprovalSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => () => {
    const pending = confirmationSnapshot();
    if (pending) answerConfirmation(pending.id, false);
    dismissSecretApproval();
  }, []);

  // A batch shares one approval id. Only the broker resolves the references.
  useEffect(() => {
    if (!nativeAvailable || typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    const pending = listen<PromptSecretApprovalRequest>(SECRET_APPROVAL_EVENT, event => {
      presentSecretApproval(event.payload);
    });
    void pending.catch(() => {});
    return () => {
      void pending.then(unlisten => unlisten()).catch(() => {});
    };
  }, []);

  useLayoutEffect(() => {
    if (!request || !dialog.current) return;
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    try { element.showModal(); }
    catch { answerConfirmation(request.id, false); }
    return () => {
      element.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [request]);

  return <>
    {request && <dialog ref={dialog} className="confirmation-dialog" aria-labelledby="confirmation-title" aria-describedby="confirmation-message"
      onCancel={event => { event.preventDefault(); answerConfirmation(request.id, false); }}>
      <div className="confirmation-head">
        <span className="confirmation-icon" data-destructive={!!request.destructive} aria-hidden="true"><Icon name={request.destructive ? 'trash' : 'info'} size={18} /></span>
        <div><h2 id="confirmation-title">{request.title ?? t('common.dialog.confirmTitle')}</h2>
        <p id="confirmation-message">{request.message}</p></div>
      </div>
      <div className="confirmation-actions" onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (current < 0 || buttons.length < 2) return;
        event.preventDefault();
        buttons[(current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length].focus();
      }}>
        <Button autoFocus onClick={() => answerConfirmation(request.id, false)}>{t('common.dialog.cancel')}</Button>
        <Button variant={request.destructive ? 'danger' : 'primary'} onClick={() => answerConfirmation(request.id, true)}>{request.confirmLabel ?? t('common.dialog.confirm')}</Button>
      </div>
    </dialog>}
    {approval && <SecretApprovalDialog key={approval.approvalId} approval={approval} />}
  </>;
}

function SecretApprovalDialog({ approval }: { approval: PromptSecretApprovalRequest & { expiresAt: number } }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const [rememberSession, setRememberSession] = useState(false);
  const remainingSeconds = () => Math.max(0, Math.ceil((approval.expiresAt - Date.now()) / 1000));
  const [secondsLeft, setSecondsLeft] = useState(remainingSeconds);
  const aliases = approval.aliases?.length ? approval.aliases : [approval.alias];

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    try {
      element.showModal();
      element.querySelector<HTMLButtonElement>('[data-secret-approval-decline]')?.focus({ preventScroll: true });
    } catch { void answerSecretApproval(approval.approvalId, false); }
    return () => { element.close(); };
  }, [approval.approvalId]);

  useEffect(() => {
    const timer = window.setInterval(() => setSecondsLeft(remainingSeconds()), 1000);
    const expiry = window.setTimeout(() => dismissSecretApproval(approval.approvalId), Math.max(0, approval.expiresAt - Date.now()));
    return () => { window.clearInterval(timer); window.clearTimeout(expiry); };
  }, [approval]);

  return <dialog ref={dialog} className="confirmation-dialog secret-approval-dialog" aria-labelledby="secret-approval-title"
    aria-describedby="secret-approval-source secret-approval-aliases secret-approval-risk secret-approval-scope"
    data-secret-approval={approval.approvalId}
    onCancel={event => { event.preventDefault(); void answerSecretApproval(approval.approvalId, false); }}>
    <div className="secret-approval-body">
      <h2 id="secret-approval-title">{t('common.secretApproval.title')}</h2>
      <p className="secret-approval-source" id="secret-approval-source">
        {t('common.secretApproval.sourceLabel')} <strong>{approval.source}</strong>
      </p>
      <ul className="secret-approval-aliases" id="secret-approval-aliases" aria-label={t('common.secretApproval.secretLabel')}>
        {aliases.map((alias, index) => <li key={index}><Icon name="lock" size={16} /><bdi>{alias}</bdi></li>)}
      </ul>
      <p className="secret-approval-risk" id="secret-approval-risk" data-secret-approval-risk>{t('common.secretApproval.risk')}</p>
      {approval.sessionAvailable ? <div className="secret-approval-choice">
        <input type="checkbox" id="secret-approval-remember" data-secret-approval-session
          checked={rememberSession} onChange={event => setRememberSession(event.currentTarget.checked)} aria-describedby="secret-approval-scope" />
        <label htmlFor="secret-approval-remember">{t('common.secretApproval.remember')}</label>
        <p id="secret-approval-scope">{t('common.secretApproval.sessionHint')}</p>
      </div> : <p className="secret-approval-once" id="secret-approval-scope">{t('common.secretApproval.onceHint')}</p>}
    </div>
    <div className="confirmation-actions">
      <span className="secret-approval-timeout" data-secret-approval-timeout data-urgent={secondsLeft <= 15 || undefined} role="timer" aria-live="off">
        {secondsLeft === 0 ? t('common.secretApproval.expired') : t('common.secretApproval.timeout', { seconds: secondsLeft })}
      </span>
      <Button data-secret-approval-decline onClick={() => void answerSecretApproval(approval.approvalId, false)}>{t('common.secretApproval.decline')}</Button>
      <Button variant="primary" data-secret-approval-accept onClick={() => void answerSecretApproval(approval.approvalId, true, rememberSession)}>
        {t(rememberSession ? 'common.secretApproval.session' : 'common.secretApproval.accept')}
      </Button>
    </div>
  </dialog>;
}
