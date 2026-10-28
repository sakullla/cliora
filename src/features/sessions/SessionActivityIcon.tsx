import type { SessionTone } from './SessionRail';
import { statusTone, type Tone } from '../../lib/statusTone';
import styles from './SessionWorkbench.module.css';

/** Badge tone of a session state; the shared session table owns streaming, idle and error. */
export function sessionBadgeTone(tone: SessionTone): Tone {
  if (tone === 'live') return statusTone('session', 'streaming').tone;
  if (tone === 'idle') return statusTone('session', 'idle').tone;
  if (tone === 'error') return statusTone('session', 'error').tone;
  return tone === 'bell' ? 'warning' : 'neutral';
}

type ActivitySlot = 'rail' | 'stage' | 'status' | 'footer' | 'pane';

export function SessionActivityIcon({ tone, slot, className, label }: {
  tone: SessionTone;
  slot: ActivitySlot;
  className?: string;
  label?: string;
}) {
  return <span
    className={className ? `${styles.activity} ${className}` : styles.activity}
    data-activity-icon={tone}
    data-activity-slot={slot}
    data-tone={tone}
    role={label ? 'img' : undefined}
    aria-label={label}
    aria-hidden={label ? undefined : true}
  >
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true" data-shape={tone}>
      {tone === 'idle' && <><circle cx="8" cy="8" r="5" /><path d="M8 5.5V8l1.8 1.2" /></>}
      {tone === 'live' && <path d="M1.5 8h2l1.7-4 2.4 8 2.1-6 1.6 4h3.2" />}
      {tone === 'bell' && <><path d="M4 11.5h8l-1.2-1.8V7a2.8 2.8 0 0 0-5.6 0v2.7L4 11.5Z" /><path d="M6.8 13a1.4 1.4 0 0 0 2.4 0" /></>}
      {tone === 'error' && <><circle cx="8" cy="8" r="5" /><path d="M8 4.8v3.8M8 11.2h.01" /></>}
      {tone === 'ended' && <><rect x="3" y="3" width="10" height="10" rx="2" /><path d="M5.5 8h5" /></>}
    </svg>
  </span>;
}
