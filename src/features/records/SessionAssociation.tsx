import { useTranslation } from 'react-i18next';
import type { ChildSession } from '../../types/history';
import i18n from '../../i18n';
import styles from './SessionAssociation.module.css';

const associationLocale = () => i18n.language === 'en' ? 'en-US' : 'zh-CN';

/** Native name only. An empty name stays unnamed; the session key is never a title. */
export function childTitle(name: string | null | undefined, unnamed: string) {
  const trimmed = name?.trim();
  return trimmed ? trimmed : unnamed;
}

function clip(text: string) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 180 ? `${flat.slice(0, 180)}…` : flat;
}

/** Earliest native timestamp, so a delegation sits on the parent timeline. */
export function childMoment(child: ChildSession) {
  let earliest: number | null = null;
  for (const message of child.messages) {
    if (message.timestamp === null) continue;
    if (earliest === null || message.timestamp < earliest) earliest = message.timestamp;
  }
  return earliest;
}

/** First user turn. Context rows are not the task the parent handed off. */
export function childAsk(child: ChildSession) {
  const message = child.messages.find((item) => item.role === 'user' && item.kind !== 'project_context' && item.kind !== 'environment_context');
  return clip(message?.text ?? '');
}

/** Last assistant turn: what the sub-agent returned. */
export function childReply(child: ChildSession) {
  let reply = '';
  for (const message of child.messages) {
    if (message.role === 'assistant' && message.text.trim()) reply = message.text;
  }
  return clip(reply);
}

/** One direct child on the chat timeline. Unreadable transcripts stay closed. */
export function ChildCard({ child, onOpen }: { child: ChildSession; onOpen: (key: string) => void }) {
  const { t } = useTranslation();
  const title = childTitle(child.name, t('records.association.unnamed'));
  const ask = child.readable ? childAsk(child) : '';
  const reply = child.readable ? childReply(child) : '';
  const when = childMoment(child);
  return <article className={styles.card} aria-label={t('records.association.card', { name: title })}>
    <header>
      <strong>{title}</strong>
      <span>{t('records.association.children')}</span>
      <time>{when === null ? t('records.format.timeUnknown') : new Date(when).toLocaleTimeString(associationLocale(), { hour: '2-digit', minute: '2-digit' })}</time>
    </header>
    {ask && <p className={styles.ask}>{ask}</p>}
    {reply && <p className={styles.reply}><span>{t('records.association.reply')}</span>{reply}</p>}
    {child.readable
      ? <button type="button" onClick={() => onOpen(child.key)}>{t('records.association.open', { name: title })}</button>
      : <p className={styles.closed}>{t('records.association.unreadable')}</p>}
  </article>;
}

/** Direct-child path. Returns null when a key is missing so the caller can leave the child view. */
export function childTrail(children: readonly ChildSession[] | undefined, path: readonly string[]): ChildSession[] | null {
  const trail: ChildSession[] = [];
  let level = children ?? [];
  for (const key of path) {
    const next = level.find((item) => item.key === key);
    if (!next) return null;
    trail.push(next);
    level = next.children ?? [];
  }
  return trail;
}
