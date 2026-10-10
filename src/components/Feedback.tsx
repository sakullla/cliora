import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { notifications, type FeedbackEvent } from '../lib/notifications';
import { Icon } from './Icon';

const regions = new Map<string, { contexts: string[]; node: HTMLElement }>();
const regionListeners = new Set<() => void>();
let regionVersion = 0;
let centerExpanded = false;
const updateRegions = () => { regionVersion++; regionListeners.forEach((listener) => listener()); };
function useRegions() {
  return useSyncExternalStore((listener) => { regionListeners.add(listener); return () => { regionListeners.delete(listener); }; }, () => regionVersion);
}
function surface() { return document.activeElement?.closest('dialog')?.getAttribute('data-feedback-surface') ?? null; }
function owner(event: FeedbackEvent) {
  if (centerExpanded) return undefined;
  const candidates = [...regions].filter(([, region]) => region.contexts.includes(event.context) && region.node.getClientRects().length && !region.node.closest('[hidden]'));
  const modal = candidates.find(([, region]) => {
    const dialog = region.node.closest('dialog[open]');
    return dialog && (!event.surface || dialog.getAttribute('data-feedback-surface') === event.surface);
  });
  return (modal ?? candidates.find(([, region]) => !region.node.closest('dialog')))?.[0];
}

/** Context is captured by each render; async callbacks cannot publish into a later tool/project. */
export function useFeedback(context: string) {
  const events = useSyncExternalStore(notifications.subscribe, notifications.getSnapshot);
  const scoped = events.filter((event) => event.context === context);
  const latest = (tone: 'error' | 'success') => [...scoped].reverse().find((event) => event.tone === tone);
  const begin = (operation: string) => notifications.begin(context, operation, surface());
  return { context, begin, events: scoped,
    error: latest('error')?.text ?? '', notice: latest('success')?.text ?? '',
    dismiss: (id: number) => notifications.dismiss(id),
  };
}

function FeedbackItem({ event, announce = true }: { event: FeedbackEvent; announce?: boolean }) {
  const { t } = useTranslation();
  const [recoveryError, setRecoveryError] = useState('');
  const [busy, setBusy] = useState(false);
  const pause = () => notifications.pause(event.id);
  return <div className="feedback-item" data-feedback-id={event.id} data-tone={event.tone} onMouseEnter={pause} onMouseLeave={pause} onFocus={pause} onBlur={pause}>
    <Icon name={event.tone === 'success' ? 'check' : event.tone === 'pending' ? 'info' : 'alert'} size={14} />
    <span title={event.text} role={announce ? event.tone === 'error' || event.tone === 'partial' ? 'alert' : 'status' : undefined}>{event.tone === 'partial' && <strong>{t('common.feedback.partial')} </strong>}{event.text}</span>
    {event.detail && <details><summary>{t('common.feedback.details')}</summary><p>{event.detail}</p></details>}
    {event.recovery && <button type="button" disabled={busy} onClick={async () => {
      setBusy(true); setRecoveryError('');
      try { if (!await notifications.recover(event.id)) setRecoveryError(t('common.feedback.stale')); }
      catch { setRecoveryError(t('common.feedback.retryFailed')); }
      finally { setBusy(false); }
    }}>{event.recovery.label}</button>}
    {recoveryError && <span role="alert">{recoveryError}</span>}
    <button type="button" className="feedback-dismiss" aria-label={t('common.feedback.dismiss')} onClick={() => notifications.dismiss(event.id)}><Icon name="close" size={12} /></button>
  </div>;
}

/** A reserved, scrollable slot: results cannot move the controls around them. */
export function FeedbackRegion({ context, relatedContexts = [] }: { context: string; relatedContexts?: string[] }) {
  const contexts = JSON.stringify([context, ...relatedContexts]);
  const id = useId();
  const node = useRef<HTMLDivElement>(null);
  const events = useSyncExternalStore(notifications.subscribe, notifications.getSnapshot);
  useRegions();
  useEffect(() => {
    if (!node.current) return;
    regions.set(id, { contexts: JSON.parse(contexts) as string[], node: node.current }); updateRegions();
    return () => { regions.delete(id); updateRegions(); };
  }, [id, contexts]);
  return <div ref={node} className="feedback-region" data-feedback-context={context}>
    {events.filter((event) => owner(event) === id).reverse().map((event) => <FeedbackItem key={event.id} event={event} />)}
  </div>;
}

export function FeedbackCenter() {
  const { t } = useTranslation();
  const events = useSyncExternalStore(notifications.subscribe, notifications.getSnapshot);
  const [open, setOpen] = useState(false);
  const announced = useRef(new Map<number, string>());
  const [announcement, setAnnouncement] = useState({ error: '', polite: '' });
  const toggle = (value: boolean) => { centerExpanded = value; setOpen(value); updateRegions(); };
  useRegions();
  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (centerExpanded && document.querySelector('dialog[open]')) { centerExpanded = false; setOpen(false); }
      updateRegions();
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden', 'open'] });
    return () => { observer.disconnect(); centerExpanded = false; };
  }, []);
  useEffect(() => {
    if (!events.some((event) => event.expiresAt)) return;
    const timer = window.setInterval(() => {
      const paused = new Set([...document.querySelectorAll<HTMLElement>('.feedback-item:hover, .feedback-item:focus-within')].map((node) => Number(node.dataset.feedbackId)));
      notifications.expire(paused);
    }, 500);
    return () => window.clearInterval(timer);
  }, [events]);
  const hidden = events.filter((event) => !owner(event));
  useEffect(() => {
    const fresh = events.filter(event => {
      const signature = JSON.stringify([event.tone, event.text, event.detail]);
      const previous = announced.current.get(event.id);
      announced.current.set(event.id, signature);
      return !owner(event) && signature !== previous;
    });
    if (fresh.length) setAnnouncement({
      error: fresh.filter(event => event.tone === 'error' || event.tone === 'partial').map(event => event.tone === 'partial' ? `${t('common.feedback.partial')} ${event.text}` : event.text).join(' · '),
      polite: fresh.filter(event => event.tone === 'success' || event.tone === 'pending').map(event => event.text).join(' · '),
    });
    else if (!events.some(event => !owner(event))) setAnnouncement({ error: '', polite: '' });
  }, [events]);
  const unresolved = events.filter((event) => event.tone === 'error' || event.tone === 'partial').length;
  return <div className="feedback-center">
    <span className="sr-only" aria-live="assertive" aria-atomic="true">{announcement.error}</span>
    <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement.polite}</span>
    <button type="button" className="feedback-center-toggle" aria-label={t('common.feedback.title')} aria-expanded={open} onClick={() => toggle(!open)} title={t('common.feedback.summary', { count: unresolved })}><Icon name="info" size={16} /><span>{t('common.feedback.title')}</span><span>{unresolved || hidden.length || ''}</span></button>
    {open && <div className="feedback-center-panel" aria-label={t('common.feedback.title')}>
      <strong>{t('common.feedback.summary', { count: unresolved })}</strong>
      {hidden.length ? [...hidden].reverse().map((event) => <FeedbackItem key={event.id} event={event} announce={false} />) : <p>{t('common.feedback.empty')}</p>}
      <button type="button" onClick={() => toggle(false)}>{t('common.dialog.close')}</button>
    </div>}
  </div>;
}
