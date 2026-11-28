import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../../../components/Icon';
import type { AcpSessionSnapshot, AcpToolCall } from '../../../types/acp';
import { AcpToolBody, renderRuns, toolSummaryOf } from './AcpToolBody';
import type { ProcessItem } from './timelineModel';
import { toolKindOf, toolKindView, toolStatusKey } from './acpView';
import styles from './acp.module.css';

type StepStatus = AcpToolCall['status'] | 'interrupted';

function statusIcon(status: StepStatus): IconName {
  switch (status) {
    case 'in_progress': return 'refresh';
    case 'completed': return 'check';
    case 'failed': return 'alert';
    case 'interrupted': return 'ban';
    default: return 'clock';
  }
}

/** Interim text longer than this folds to a few lines, with "show all". */
const LONG_NOTE = 360;
const LONG_NOTE_LINES = 4;

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * One step of a turn's work process, on one line (R14): a tool call (kind glyph,
 * title, status), a thought (a quiet one-line preview) or the agent's interim text
 * (plain text, never signed). A completed call shows only its check, with the word
 * for assistive tech; a failed, running or interrupted one says so. Clicking opens
 * the details in place: the tool body, the full thought or the full text. A quiet
 * notice reads as it does in the timeline.
 */
export function AcpStep({
  item,
  snapshot,
  latest = false,
  ended = false,
  streaming = false,
  onKillTerminal,
  onOpenPath,
  forceOpen = false,
  searchQuery = '',
  searchCase = false,
  findActive = false,
  located = false,
}: {
  item: ProcessItem;
  snapshot: AcpSessionSnapshot;
  /** The newest step of a running turn: the only one with an activity indicator. */
  latest?: boolean;
  /** The turn is over: a call still running was interrupted. */
  ended?: boolean;
  streaming?: boolean;
  onKillTerminal: (terminalId: string) => Promise<void>;
  onOpenPath?: (target: string) => Promise<void>;
  forceOpen?: boolean;
  searchQuery?: string;
  searchCase?: boolean;
  findActive?: boolean;
  located?: boolean;
}) {
  const { t } = useTranslation();
  const bodyId = useId();
  const [override, setOverride] = useState<boolean | null>(forceOpen ? true : null);
  const [prevForceOpen, setPrevForceOpen] = useState(forceOpen);
  if (forceOpen !== prevForceOpen) {
    setPrevForceOpen(forceOpen);
    if (forceOpen) setOverride(true);
  }
  const findState = findActive ? 'active' : undefined;

  if (item.kind === 'notice') {
    const icon = item.code === 'yolo_allowed' ? 'shield' : item.level === 'warning' ? 'alert' : 'info';
    return <p
      className={styles.notice}
      data-item-id={item.id}
      data-step="notice"
      data-level={item.level}
      data-code={item.code || undefined}
      data-find-hit={findState}
      data-located={located || undefined}
    >
      <Icon name={icon} size={12} />
      <span>{item.code === 'trimmed' ? t('sessions.acpTrimmed') : renderRuns(item.text, searchQuery, searchCase)}</span>
    </p>;
  }

  if (item.kind === 'message' && item.role !== 'thought') {
    // Interim text reads whole as plain text; only a long one folds to a few lines.
    const long = item.text.length > LONG_NOTE || item.text.split('\n').length > LONG_NOTE_LINES;
    const all = override ?? false;
    return <div
      className={styles.stepNoteRow}
      data-item-id={item.id}
      data-step="text"
      data-role={item.role}
      data-streaming={streaming || undefined}
      data-find-hit={findState}
      data-located={located || undefined}
    >
      <p id={bodyId} className={styles.stepNote} data-folded={(long && !all) || undefined}>
        {renderRuns(item.text, searchQuery, searchCase)}
        {item.truncated && <span className={styles.truncated}>{t('sessions.acpTruncated')}</span>}
      </p>
      {long && <button type="button" className={styles.linkAction} aria-expanded={all} aria-controls={bodyId} onClick={() => setOverride(!all)}>
        {all ? t('sessions.acpShowLess') : t('sessions.acpShowAll')}
      </button>}
    </div>;
  }

  if (item.kind === 'message') {
    const open = override ?? false;
    const preview = oneLine(item.text);
    return <div
      className={styles.step}
      data-item-id={item.id}
      data-step="thought"
      data-role={item.role}
      data-open={open || undefined}
      data-streaming={streaming || undefined}
      data-find-hit={findState}
      data-located={located || undefined}
    >
      <button type="button" className={styles.stepToggle} aria-expanded={open} aria-controls={bodyId} onClick={() => setOverride(!open)}>
        <span className={styles.stepIcon} role="img" aria-label={t('sessions.acpRoleThought')} title={t('sessions.acpRoleThought')}>
          <Icon name="sparkle" size={12} />
        </span>
        {latest && streaming && <span className={styles.stepPulse} aria-hidden="true" />}
        <span className={styles.stepPreview}>{open ? t('sessions.acpRoleThought') : preview ? renderRuns(preview, searchQuery, searchCase) : ' '}</span>
      </button>
      {open && <p id={bodyId} className={styles.stepThought}>
        {renderRuns(item.text, searchQuery, searchCase)}
        {item.truncated && <span className={styles.truncated}>{t('sessions.acpTruncated')}</span>}
      </p>}
    </div>;
  }

  const call = item;
  const kind = toolKindOf(call);
  const view = toolKindView(kind);
  const status: StepStatus = ended && (call.status === 'pending' || call.status === 'in_progress') ? 'interrupted' : call.status;
  const open = override ?? status === 'failed';
  const title = call.title || call.callId;
  const summary = toolSummaryOf(call);
  const statusWord = status === 'interrupted' ? t('sessions.acpStepInterrupted') : t(toolStatusKey(call.status));
  return <div
    className={styles.step}
    data-item-id={call.id}
    data-step="tool"
    data-status={call.status}
    data-step-status={status}
    data-tool-kind={kind}
    data-open={open || undefined}
    data-find-hit={findState}
    data-located={located || undefined}
  >
    <button type="button" className={styles.stepToggle} aria-expanded={open} aria-controls={bodyId} title={title} onClick={() => setOverride(!open)}>
      <span className={styles.stepIcon} role="img" aria-label={t(view.key)}><Icon name={view.icon} size={12} /></span>
      <span className={styles.stepTitle} data-mono={kind === 'execute' || undefined}>{renderRuns(title, searchQuery, searchCase)}</span>
      {!open && summary && summary !== title && <span className={styles.stepSummary}>{renderRuns(summary, searchQuery, searchCase)}</span>}
    </button>
    {status === 'completed'
      ? <span className={styles.stepStatus} data-status={status} role="img" aria-label={statusWord}><Icon name="check" size={12} /></span>
      : <span className={styles.stepStatus} data-status={status} data-active={(latest && status === 'in_progress') || undefined}>
          <Icon name={statusIcon(status)} size={12} />{statusWord}
        </span>}
    {open && <AcpToolBody
      id={bodyId}
      call={call}
      snapshot={snapshot}
      onKillTerminal={onKillTerminal}
      onOpenPath={onOpenPath}
      forceOpen={forceOpen}
      searchQuery={searchQuery}
      searchCase={searchCase}
    />}
  </div>;
}
