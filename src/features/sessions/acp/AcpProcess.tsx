import { memo, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import type { AcpSessionSnapshot } from '../../../types/acp';
import { AcpStep } from './AcpStep';
import { useViewMemory } from './acpRenderCache';
import type { ProcessActivity, TimelineSegment } from './timelineModel';
import { toolKindView, visibleControls } from './acpView';
import styles from './acp.module.css';

type ProcessSegment = Extract<TimelineSegment, { kind: 'process' }>;

/** A running turn shows its most recent steps; older ones fold into "N earlier steps". */
export const PROCESS_RECENT = 8;

function activityKey(activity: ProcessActivity): string {
  switch (activity.kind) {
    case 'waiting': return 'sessions.acpProcessWaiting';
    case 'replying': return 'sessions.acpProcessReplying';
    case 'thinking': return 'sessions.acpProcessThinking';
    case 'running': return 'sessions.acpProcessRunning';
    default: return 'sessions.acpProcessWorking';
  }
}

/**
 * A turn's work process (R14): its thoughts, tool calls and interim text as compact
 * steps. While the turn runs the process is open, shows its most recent steps and ends
 * with a line that says what the agent is doing. Once the turn ends it folds into a
 * single summary line (step counts by kind, failures, changed files), with failed
 * steps still listed under it; a stopped or disconnected turn stays open. The reader's
 * own choice to open or fold a process (and its earlier steps) is kept in the session's
 * view memory, so it survives the process leaving the rendered range or a hidden pane;
 * find or locate opens it (and the step) when they target something inside.
 */
export const AcpProcess = memo(function AcpProcess({
  segment,
  snapshot,
  streamingId = null,
  onKillTerminal,
  onOpenPath,
  forceOpen = false,
  activeFindItemId = null,
  locatedId = null,
  searchQuery = '',
  searchCase = false,
}: {
  segment: ProcessSegment;
  snapshot: AcpSessionSnapshot;
  /** The item the agent is streaming into, if any. */
  streamingId?: string | null;
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
  const [choice, setChoice] = useViewMemory<boolean | null>(segment.id, null);
  // Starts unforced, so a process that mounts already targeted opens too.
  const [prevForceOpen, setPrevForceOpen] = useState(false);
  if (forceOpen !== prevForceOpen) {
    setPrevForceOpen(forceOpen);
    if (forceOpen) setChoice(true);
  }
  const [earlierOpen, setEarlierOpen] = useViewMemory(`earlier:${segment.id}`, false);

  const { items, summary, ended, interrupted, activity } = segment;
  const open = choice ?? (!ended || interrupted);
  const targeted = (id: string) => id === activeFindItemId || id === locatedId;
  const running = !ended;
  const hiddenCount = running && items.length > PROCESS_RECENT ? items.length - PROCESS_RECENT : 0;
  const earlierTargeted = hiddenCount > 0 && items.slice(0, hiddenCount).some((item) => targeted(item.id));
  const hidden = earlierOpen || earlierTargeted ? 0 : hiddenCount;
  const latestId = running ? items[items.length - 1]?.id ?? null : null;
  const failedSteps = items.filter((item) => item.kind === 'tool' && item.status === 'failed');

  function toggle() {
    setChoice(!open);
  }

  function step(item: (typeof items)[number]) {
    return <AcpStep
      key={item.id}
      item={item}
      snapshot={snapshot}
      latest={item.id === latestId}
      ended={ended}
      streaming={item.id === streamingId}
      onKillTerminal={onKillTerminal}
      onOpenPath={onOpenPath}
      forceOpen={targeted(item.id)}
      searchQuery={searchQuery}
      searchCase={searchCase}
      findActive={item.id === activeFindItemId}
      located={item.id === locatedId}
    />;
  }

  const kinds = summary.kinds.map(({ kind, count }) => t('sessions.acpProcessKindCount', {
    kind: kind === 'thought' ? t('sessions.acpRoleThought') : t(toolKindView(kind).key),
    count,
  }));

  return <section
    className={styles.process}
    data-acp-process={segment.id}
    data-state={running ? 'running' : interrupted ? 'interrupted' : 'ended'}
    data-reason={segment.reason || undefined}
    data-open={open || undefined}
    aria-label={t('sessions.acpProcessTitle')}
  >
    <button type="button" className={styles.processToggle} aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
      <Icon name="chevronRight" size={12} className={styles.disclosure} />
      <span className={styles.processLine}>
        <span className={styles.processTitle}>{t('sessions.acpProcessSummary', { count: summary.steps })}</span>
        {kinds.length > 0 && <span>{t('sessions.acpProcessKinds', { kinds: kinds.join(' · ') })}</span>}
        {summary.failed > 0 && <>{' · '}<span className={styles.processFailed} data-acp-process-failed="">{t('sessions.acpProcessFailed', { count: summary.failed })}</span></>}
        {summary.files > 0 && <>{' · '}<span className={styles.processFiles}>{t('sessions.acpProcessFiles', { count: summary.files })}</span></>}
      </span>
    </button>
    {open
      ? <div id={bodyId} className={styles.processBody}>
          {hidden > 0 && <button type="button" className={styles.processEarlier} aria-expanded={false} onClick={() => setEarlierOpen(true)}>
            <Icon name="chevronRight" size={12} className={styles.disclosure} />
            {t('sessions.acpProcessEarlier', { count: hidden })}
          </button>}
          {items.slice(hidden).map(step)}
          {segment.tail && activity && <p className={styles.processActivity} data-acp-activity={activity.kind}>
            <span className={styles.stepPulse} aria-hidden="true" />
            <span className={styles.processActivityText}>{t(activityKey(activity), { title: activity.kind === 'running' ? visibleControls(activity.title) : '' })}</span>
          </p>}
        </div>
      : failedSteps.length > 0 && <div id={bodyId} className={styles.processBody} data-acp-process-failures="">
          {failedSteps.map(step)}
        </div>}
  </section>;
});
