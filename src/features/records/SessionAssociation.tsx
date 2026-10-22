import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import type { ChildSession } from '../../types/history';
import i18n from '../../i18n';
import { childSummary } from './sessionTimeline';
import styles from './SessionAssociation.module.css';

const associationLocale = () => i18n.language === 'en' ? 'en-US' : 'zh-CN';
const PREVIEW_COLLAPSE_THRESHOLD = 96;

/** Native name only. An empty name stays unnamed; the session key is never a title. */
export function childTitle(name: string | null | undefined, unnamed: string) {
  const trimmed = name?.trim();
  return trimmed ? trimmed : unnamed;
}

function formatChildTime(when: number | null, fallback: string) {
  return when === null ? fallback : new Date(when).toLocaleTimeString(associationLocale(), { hour: '2-digit', minute: '2-digit' });
}

/** One direct child on the chat timeline. Unreadable transcripts stay closed. */
export const ChildCard = memo(function ChildCard({
  child,
  onOpen,
  defaultExpanded = false,
}: {
  child: ChildSession;
  onOpen: (key: string) => void;
  defaultExpanded?: boolean;
}) {
  const { t } = useTranslation();
  const title = childTitle(child.name, t('records.association.unnamed'));
  const summary = childSummary(child);
  const ask = child.readable ? summary.ask : '';
  const reply = child.readable ? summary.reply : '';
  const when = summary.at;
  const hasFoldableDetail = Boolean(ask && reply)
    || ask.length > PREVIEW_COLLAPSE_THRESHOLD
    || reply.length > PREVIEW_COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const showFull = expanded || !hasFoldableDetail;
  const compactAsk = ask && !reply;

  return <article className={styles.card} data-expanded={showFull || undefined} aria-label={t('records.association.card', { name: title })}>
    <header className={styles.cardHead}>
      <span className={styles.badge}><Icon name="sparkle" size={12} />{t('records.association.children')}</span>
      <strong>{title}</strong>
      <time>{formatChildTime(when, t('records.format.timeUnknown'))}</time>
      <div className={styles.headActions}>
        {hasFoldableDetail && (
          <button
            type="button"
            className={styles.foldBtn}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <span>{expanded ? t('records.association.collapsePreview') : t('records.association.expandPreview')}</span>
            <Icon name="chevronDown" size={12} />
          </button>
        )}
        {child.readable && (
          <button
            type="button"
            className={styles.openBtn}
            aria-label={t('records.association.open', { name: title })}
            onClick={() => onOpen(child.key)}
          >
            <span>{t('records.association.openShort')}</span>
            <Icon name="chevronRight" size={12} />
          </button>
        )}
      </div>
    </header>
    {!child.readable ? (
      <p className={styles.closed}>{t('records.association.unreadable')}</p>
    ) : showFull ? (
      <div className={styles.detailBody}>
        {ask && (
          <div className={styles.block}>
            <span className={styles.blockLabel}>{t('records.association.prompt')}</span>
            <p className={styles.ask}>{ask}</p>
          </div>
        )}
        {reply && (
          <div className={`${styles.block} ${styles.replyBlock}`}>
            <span className={styles.blockLabel}>{t('records.association.reply')}</span>
            <p className={styles.reply}>{reply}</p>
          </div>
        )}
      </div>
    ) : (
      <div className={styles.compactPreview}>
        {reply ? (
          <p className={styles.reply}><span>{t('records.association.reply')}</span>{reply}</p>
        ) : compactAsk ? (
          <p className={styles.ask}><span>{t('records.association.prompt')}</span>{ask}</p>
        ) : null}
        {ask && reply && (
          <p className={styles.askSubtle}><span>{t('records.association.prompt')}</span>{ask}</p>
        )}
      </div>
    )}
  </article>;
});

/** Consecutive direct children grouped into one compact cluster on the timeline. */
export const ChildCluster = memo(function ChildCluster({
  items,
  onOpen,
}: {
  items: readonly ChildSession[];
  onOpen: (key: string) => void;
}) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  if (items.length === 1) {
    return <ChildCard child={items[0]} onOpen={onOpen} />;
  }
  const firstAt = childSummary(items[0]).at;
  const lastAt = childSummary(items[items.length - 1]).at;
  const timeRange = firstAt === null
    ? t('records.format.timeUnknown')
    : lastAt !== null && lastAt !== firstAt
      ? `${formatChildTime(firstAt, '')} – ${formatChildTime(lastAt, '')}`
      : formatChildTime(firstAt, t('records.format.timeUnknown'));

  return <section className={styles.cluster} aria-label={t('records.association.groupLabel', { count: items.length })}>
    <header className={styles.clusterHead}>
      <span className={styles.clusterTitle}>
        <Icon name="sparkle" size={14} />
        <strong>{t('records.association.groupTitle', { count: items.length })}</strong>
      </span>
      <time className={styles.clusterTime}>{timeRange}</time>
      <button
        type="button"
        className={styles.clusterToggle}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        <span>{collapsed ? t('records.association.expandGroup', { count: items.length }) : t('records.association.collapseGroup')}</span>
        <Icon name="chevronDown" size={12} />
      </button>
    </header>
    {!collapsed && (
      <div className={styles.clusterList}>
        {items.map((child) => <ChildCard key={child.key} child={child} onOpen={onOpen} />)}
      </div>
    )}
  </section>;
});

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
