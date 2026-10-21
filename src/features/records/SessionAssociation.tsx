import { useTranslation } from 'react-i18next';
import type { AssociationFacet } from '../../types/native';
import type { ChildSession, UsageAttribution, UsageEvent } from '../../types/history';
import i18n from '../../i18n';
import styles from './SessionAssociation.module.css';

const associationLocale = () => i18n.language === 'en' ? 'en-US' : 'zh-CN';

/** Native name only. An empty name stays unnamed; the session key is never a title. */
export function childTitle(name: string | null | undefined, unnamed: string) {
  const trimmed = name?.trim();
  return trimmed ? trimmed : unnamed;
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

function attributionText(item: UsageAttribution, main: string, subagent: string, unknown: string) {
  const kind = item.kind === 'main' ? main : item.kind === 'subagent' ? subagent : unknown;
  const name = item.name?.trim();
  return name ? `${kind} · ${name}` : kind;
}

export function SessionAssociation({ association, usage, children, onOpen }: {
  association: AssociationFacet | null | undefined;
  usage: UsageEvent[];
  children: readonly ChildSession[];
  onOpen: (key: string) => void;
}) {
  const { t } = useTranslation();
  const available = association?.state === 'available';
  const unavailable = association?.state === 'unavailable';
  const links = available ? children : [];
  const showLinks = links.length > 0;
  const showUsage = usage.length > 0;
  if (!unavailable && !showLinks && !showUsage) return null;
  const readable = new Map<string, ChildSession>();
  for (const item of links) {
    if (item.readable && item.key && !readable.has(item.key)) readable.set(item.key, item);
  }
  const unnamed = t('records.association.unnamed');
  return <section className={styles.association} aria-label={t('records.association.label')}>
    {unavailable && <p className={styles.notice} role="status">{association?.reason?.trim() || t('records.association.unavailable')}</p>}
    {showLinks && <div>
      <h3>{t('records.association.children')}</h3>
      <ul className={styles.children} aria-label={t('records.association.children')}>
        {links.map((item, index) => {
          const title = childTitle(item.name, unnamed);
          return <li key={`${item.key}:${index}`}>
            {item.readable
              ? <button type="button" onClick={() => onOpen(item.key)}>{title}</button>
              : <span className={styles.unreadable}>{title}<small>{t('records.association.unreadable')}</small></span>}
          </li>;
        })}
      </ul>
    </div>}
    {showUsage && <div>
      <h3>{t('records.association.usage')}</h3>
      <ul className={styles.usage} aria-label={t('records.association.usage')}>
        {usage.map((event) => {
          const marks = event.attributions?.length ? event.attributions : [null];
          return <li key={event.id}>
            <span>{event.model ?? t('records.page.modelUnknown')}</span>
            <time>{event.timestamp === null ? t('records.format.timeUnknown') : new Date(event.timestamp).toLocaleString(associationLocale())}</time>
            <div className={styles.marks}>
              {marks.map((item, index) => {
                const text = item ? attributionText(item, t('records.association.main'), t('records.association.subagent'), t('records.association.unknown')) : t('records.association.unknown');
                const target = item?.sessionKey ? readable.get(item.sessionKey) : undefined;
                return <span key={`${event.id}:${index}`}>
                  <span>{text}</span>
                  {target && <button type="button" onClick={() => onOpen(target.key)}>{t('records.association.open', { name: childTitle(target.name, unnamed) })}</button>}
                </span>;
              })}
            </div>
          </li>;
        })}
      </ul>
    </div>}
  </section>;
}
