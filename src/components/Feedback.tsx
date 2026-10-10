import { useEffect, useId, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { notifications, type FeedbackEvent } from '../lib/notifications';
import { formatFailure } from '../lib/feedback';
import { Icon } from './Icon';

const regions = new Map<string, { context: string; node: HTMLElement }>();
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
  const candidates = [...regions].filter(([, region]) => region.context === event.context && region.node.getClientRects().length && !region.node.closest('[hidden]'));
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
  const set = (tone: 'error' | 'success', value: SetStateAction<string>, operation?: string) => {
    const text = typeof value === 'function' ? value(latest(tone)?.text ?? '') : value;
    // Legacy clears at operation start must never clear a different unresolved result.
    if (text) begin(operation ?? `${tone}:${text}`)[tone](text);
  };
  return {
    context, begin, events: scoped,
    error: latest('error')?.text ?? '', notice: latest('success')?.text ?? '',
    setError: ((value) => set('error', value)) as Dispatch<SetStateAction<string>>,
    setNotice: ((value) => set('success', value)) as Dispatch<SetStateAction<string>>,
    showError: (text: string, operation?: string) => set('error', text, operation),
    showNotice: (text: string, _protect = false, operation?: string) => set('success', text, operation),
    showFailure: (value: unknown, object: string, next: string, _keep = false) => set('error', formatFailure(value, object, next)),
    showMixed: (text: string, detail: string) => begin(`partial:${text}`).partial(text, { detail }),
    dismiss: (id: number) => notifications.dismiss(id),
  };
}

function FeedbackItem({ event }: { event: FeedbackEvent }) {
  const { t } = useTranslation();
  const [recoveryError, setRecoveryError] = useState('');
  const [busy, setBusy] = useState(false);
  const pause = () => notifications.pause(event.id);
  return <div className="feedback-item" data-feedback-id={event.id} data-tone={event.tone} onMouseEnter={pause} onMouseLeave={pause} onFocus={pause} onBlur={pause}>
    <Icon name={event.tone === 'success' ? 'check' : event.tone === 'pending' ? 'info' : 'alert'} size={14} />
    <span title={event.text} role={event.tone === 'error' || event.tone === 'partial' ? 'alert' : 'status'}>{event.tone === 'partial' && <strong>{t('common.feedback.partial')} </strong>}{event.text}</span>
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
export function FeedbackRegion({ context }: { context: string }) {
  const id = useId();
  const node = useRef<HTMLDivElement>(null);
  const events = useSyncExternalStore(notifications.subscribe, notifications.getSnapshot);
  useRegions();
  useEffect(() => {
    if (!node.current) return;
    regions.set(id, { context, node: node.current }); updateRegions();
    return () => { regions.delete(id); updateRegions(); };
  }, [id, context]);
  return <div ref={node} className="feedback-region" data-feedback-context={context}>
    {events.filter((event) => owner(event) === id).reverse().map((event) => <FeedbackItem key={event.id} event={event} />)}
  </div>;
}

export function FeedbackCenter() {
  const { t } = useTranslation();
  const events = useSyncExternalStore(notifications.subscribe, notifications.getSnapshot);
  const [open, setOpen] = useState(false);
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
  const unresolved = events.filter((event) => event.tone === 'error' || event.tone === 'partial').length;
  return <div className="feedback-center">
    <button type="button" className="feedback-center-toggle" aria-label={t('common.feedback.title')} aria-expanded={open} onClick={() => toggle(!open)} title={t('common.feedback.summary', { count: unresolved })}><Icon name="info" size={16} /><span>{t('common.feedback.title')}</span><span>{unresolved || hidden.length || ''}</span></button>
    {open && <div className="feedback-center-panel" aria-label={t('common.feedback.title')}>
      <strong>{t('common.feedback.summary', { count: unresolved })}</strong>
      {hidden.length ? [...hidden].reverse().map((event) => <FeedbackItem key={event.id} event={event} />) : <p>{t('common.feedback.empty')}</p>}
      <button type="button" onClick={() => toggle(false)}>{t('common.dialog.close')}</button>
    </div>}
  </div>;
}
