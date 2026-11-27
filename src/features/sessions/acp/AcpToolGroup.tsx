import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import type { AcpSessionSnapshot } from '../../../types/acp';
import { AcpToolCard } from './AcpToolCard';
import type { AcpToolItem, ToolGroupKindCount } from './timelineModel';
import { toolKindView } from './acpView';
import styles from './acp.module.css';

/**
 * View-layer foldable group for consecutive completed lightweight tool calls
 * within the same turn and subagent (R3). Starts collapsed as a single-line
 * summary of step count and tool-kind breakdown; expands on click or when find
 * / locate targets an item inside the group, preserving each original tool card.
 */
export function AcpToolGroup({
  id,
  items,
  kindCounts,
  snapshot,
  busyKey,
  onAnswer,
  onKillTerminal,
  onOpenPath,
  forceOpen = false,
  activeFindItemId = null,
  locatedId = null,
  searchQuery = '',
  searchCase = false,
}: {
  id: string;
  items: readonly AcpToolItem[];
  kindCounts: readonly ToolGroupKindCount[];
  snapshot: AcpSessionSnapshot;
  busyKey: string;
  onAnswer: (requestId: string, optionId: string | null) => void;
  onKillTerminal: (terminalId: string) => Promise<void>;
  onOpenPath?: (target: string) => Promise<void>;
  forceOpen?: boolean;
  activeFindItemId?: string | null;
  locatedId?: string | null;
  searchQuery?: string;
  searchCase?: boolean;
}) {
  const { t } = useTranslation();
  const bodyId = useId();
  const [open, setOpen] = useState(forceOpen);
  const [prevForceOpen, setPrevForceOpen] = useState(forceOpen);
  if (forceOpen !== prevForceOpen) {
    setPrevForceOpen(forceOpen);
    if (forceOpen) setOpen(true);
  }

  const toggleLabel = open
    ? t('sessions.acpToolGroupCollapse', { count: items.length })
    : t('sessions.acpToolGroupExpand', { count: items.length });

  return <div
    className={styles.toolGroup}
    data-acp-tool-group={id}
    data-count={items.length}
    data-open={open || undefined}
  >
    <button
      type="button"
      className={styles.toolGroupToggle}
      aria-expanded={open}
      aria-controls={bodyId}
      aria-label={toggleLabel}
      onClick={() => setOpen((value) => !value)}
    >
      <Icon name="chevronRight" size={12} className={styles.disclosure} />
      <span className={styles.toolGroupBadge} aria-hidden="true"><Icon name="check" size={11} /></span>
      <span className={styles.toolGroupTitle}>{t('sessions.acpToolGroupSummary', { count: items.length })}</span>
      <span className={styles.toolGroupKinds}>
        {kindCounts.map(({ kind, count }) => (
          <span key={kind} className={styles.toolGroupKind} data-tool-kind={kind}>
            {t('sessions.acpToolGroupKindCount', { kind: t(toolKindView(kind).key), count })}
          </span>
        ))}
      </span>
    </button>
    {open && <div id={bodyId} className={styles.toolGroupBody}>
      {items.map((item) => {
        const request = item.permission?.requestId;
        const isFindActive = activeFindItemId === item.id;
        const isLocated = locatedId === item.id;
        return <AcpToolCard
          key={item.id}
          call={item}
          snapshot={snapshot}
          busy={!!busyKey || (!!request && busyKey === request)}
          onAnswer={onAnswer}
          onKillTerminal={onKillTerminal}
          onOpenPath={onOpenPath}
          forceOpen={isFindActive || isLocated}
          searchQuery={searchQuery}
          searchCase={searchCase}
          findActive={isFindActive}
          located={isLocated}
        />;
      })}
    </div>}
  </div>;
}
