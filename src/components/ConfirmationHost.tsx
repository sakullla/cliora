import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { answerConfirmation, confirmationSnapshot, subscribeConfirmation } from '../lib/confirm';

export function ConfirmationHost() {
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
    <h2 id="confirmation-title">{request.title ?? '确认操作'}</h2>
    <p id="confirmation-message">{request.message}</p>
    <div className="confirmation-actions">
      <button type="button" className="button" autoFocus onClick={() => answerConfirmation(request.id, false)}>取消</button>
      <button type="button" className={`button ${request.destructive ? 'destructive' : 'primary'}`} onClick={() => answerConfirmation(request.id, true)}>{request.confirmLabel ?? '继续'}</button>
    </div>
  </dialog>;
}
