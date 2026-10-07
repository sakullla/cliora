import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { answerConfirmation, confirmationSnapshot, subscribeConfirmation } from '../lib/confirm';
import { Icon } from './Icon';

export function ConfirmationHost() {
  const { t } = useTranslation();
  const request = useSyncExternalStore(subscribeConfirmation, confirmationSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => () => {
    const pending = confirmationSnapshot();
    if (pending) answerConfirmation(pending.id, false);
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

  if (!request) return null;
  return <dialog ref={dialog} className="confirmation-dialog" aria-labelledby="confirmation-title" aria-describedby="confirmation-message"
    onCancel={event => { event.preventDefault(); answerConfirmation(request.id, false); }}>
    <div className="confirmation-head">
      <span className="confirmation-icon" data-destructive={!!request.destructive} aria-hidden="true"><Icon name={request.destructive ? 'trash' : 'info'} size={18} /></span>
      <div><h2 id="confirmation-title">{request.title ?? t('common.dialog.confirmTitle')}</h2>
      <p id="confirmation-message">{request.message}</p></div>
    </div>
    <div className="confirmation-actions">
      <button type="button" className="button" autoFocus onClick={() => answerConfirmation(request.id, false)}>{t('common.dialog.cancel')}</button>
      <button type="button" className={`button ${request.destructive ? 'destructive' : 'primary'}`} onClick={() => answerConfirmation(request.id, true)}>{request.confirmLabel ?? t('common.dialog.confirm')}</button>
    </div>
  </dialog>;
}
