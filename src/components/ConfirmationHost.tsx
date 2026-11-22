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
  const [countdown, setCountdown] = useState<{ id: string; seconds: number } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const approvalDialog = useRef<HTMLDialogElement>(null);

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

  useEffect(() => {
    if (!approval) { setCountdown(null); return; }
    const tick = () => setCountdown({ id: approval.approvalId, seconds: Math.max(0, Math.ceil((approval.expiresAt - Date.now()) / 1000)) });
    tick();
    const timer = setInterval(tick, 1000);
    const expiry = setTimeout(() => dismissSecretApproval(approval.approvalId), Math.max(0, approval.expiresAt - Date.now()));
    return () => { clearInterval(timer); clearTimeout(expiry); };
  }, [approval]);

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

  useLayoutEffect(() => {
    if (!approval || !approvalDialog.current) return;
    const element = approvalDialog.current;
    try { element.showModal(); }
    catch { void answerSecretApproval(approval.approvalId, false); }
    return () => { element.close(); };
  }, [approval]);

  const secondsLeft = approval ? (countdown?.id === approval.approvalId ? countdown.seconds : approval.expiresInSeconds) : 0;
  const aliases = approval?.aliases?.length ? approval.aliases : approval ? [approval.alias] : [];

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
    {approval && <dialog key={approval.approvalId} ref={approvalDialog} className="confirmation-dialog secret-approval-dialog" aria-labelledby="secret-approval-title" aria-describedby="secret-approval-message"
      data-secret-approval={approval.approvalId}
      onCancel={event => { event.preventDefault(); void answerSecretApproval(approval.approvalId, false); }}>
      <div className="confirmation-head">
        <span className="confirmation-icon" data-destructive="true" aria-hidden="true"><Icon name="lock" size={18} /></span>
        <div className="secret-approval-body">
          <h2 id="secret-approval-title">{t('common.secretApproval.title')}</h2>
          <dl className="secret-approval-facts" id="secret-approval-message">
            <div><dt>{t('common.secretApproval.sourceLabel')}</dt><dd>{approval.source}</dd></div>
            <div><dt>{t('common.secretApproval.secretLabel')}</dt><dd><ul className="secret-approval-aliases">
              {aliases.map((alias, index) => <li key={index}>{alias}</li>)}
            </ul></dd></div>
          </dl>
          <p className="secret-approval-risk" data-secret-approval-risk>{t('common.secretApproval.risk')}</p>
          {approval.sessionAvailable && <p>{t('common.secretApproval.sessionHint')}</p>}
          <p className="secret-approval-timeout" data-secret-approval-timeout>{secondsLeft === 0 && approval.expiresInSeconds > 0 ? t('common.secretApproval.expired') : t('common.secretApproval.timeout', { seconds: secondsLeft })}</p>
        </div>
      </div>
      <div className="confirmation-actions">
        <Button autoFocus data-secret-approval-decline onClick={() => void answerSecretApproval(approval.approvalId, false)}>{t('common.secretApproval.decline')}</Button>
        <Button variant="danger" data-secret-approval-accept onClick={() => void answerSecretApproval(approval.approvalId, true)}>{t('common.secretApproval.accept')}</Button>
        {approval.sessionAvailable && <Button data-secret-approval-session onClick={() => void answerSecretApproval(approval.approvalId, true, true)}>{t('common.secretApproval.session')}</Button>}
      </div>
    </dialog>}
  </>;
}
