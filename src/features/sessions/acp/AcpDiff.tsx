import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import { diffLines, diffRows, splitLines, type DiffRow } from '../../../lib/textDiff';
import { visibleControls } from './acpView';
import styles from './acp.module.css';

/** Line budget for an exact line diff; beyond it only the totals are shown. */
const DIFF_LINE_LIMIT = 4000;
/** Rows drawn at once; the rest are counted, not drawn. */
const ROW_LIMIT = 400;

type Computed = { rows: DiffRow[]; added: number; removed: number; tooLarge: boolean };

function compute(oldText: string | null, newText: string): Computed {
  const after = splitLines(newText);
  if (oldText == null) {
    // A new file is all additions: no edit script is needed.
    const rows: DiffRow[] = after.map((text) => ({ kind: 'insert', text }));
    return { rows, added: after.length, removed: 0, tooLarge: false };
  }
  const before = splitLines(oldText);
  if (before.length + after.length > DIFF_LINE_LIMIT) {
    return { rows: [], added: after.length, removed: before.length, tooLarge: true };
  }
  const lines = diffLines(oldText, newText);
  return {
    rows: diffRows(lines),
    added: lines.filter((line) => line.op === 'insert').length,
    removed: lines.filter((line) => line.op === 'delete').length,
    tooLarge: false,
  };
}

/**
 * A file change: its path, added and removed line counts, and the changed lines
 * with a little context. Foldable; a change too large to diff here says so
 * instead of stalling the pane.
 */
export function AcpDiff({ path, oldText, newText, truncated, previousOmitted = false, label, open = true }: {
  path: string;
  oldText: string | null;
  newText: string;
  truncated: boolean;
  previousOmitted?: boolean;
  /** The heading; defaults to "new" or "edit" with the path. */
  label?: string;
  open?: boolean;
}) {
  const { t } = useTranslation();
  const diff = useMemo(() => compute(oldText, newText), [oldText, newText]);
  const shown = diff.rows.slice(0, ROW_LIMIT);
  const hidden = diff.rows.length - shown.length;
  const heading = label ?? (oldText == null ? t('sessions.acpDiffNew', { path }) : t('sessions.acpDiffEdit', { path }));
  return <details className={styles.diff} open={open} data-content="diff">
    <summary className={styles.diffHead}>
      <Icon name="chevronRight" size={12} className={styles.disclosure} />
      <span className={styles.diffPath} title={path}>{heading}</span>
      <span className={styles.diffStats}>
        <span className={styles.diffAdded}>{t('sessions.acpDiffAdded', { count: diff.added })}</span>
        <span className={styles.diffRemoved}>{t('sessions.acpDiffRemoved', { count: diff.removed })}</span>
      </span>
    </summary>
    {previousOmitted && <p className={styles.note}>{t('sessions.acpDiffPreviousOmitted')}</p>}
    {diff.tooLarge
      ? <p className={styles.note}>{t('sessions.acpDiffTooLarge')}</p>
      : <div className={styles.diffRows} role="table" aria-label={heading}>
        {shown.map((row, index) => row.kind === 'skip'
          ? <div key={index} className={styles.diffSkip} role="row"><span role="cell">{t('sessions.acpDiffSkip', { count: row.count })}</span></div>
          : <div key={index} className={styles.diffRow} data-op={row.kind} role="row">
            <span className={styles.diffSign} role="cell" aria-label={t(row.kind === 'insert' ? 'sessions.acpDiffInsertLine' : row.kind === 'delete' ? 'sessions.acpDiffDeleteLine' : 'sessions.acpDiffSameLine')}>{row.kind === 'insert' ? '+' : row.kind === 'delete' ? '−' : ' '}</span>
            <span className={styles.diffText} role="cell">{visibleControls(row.text) || ' '}</span>
          </div>)}
        {hidden > 0 && <p className={styles.note}>{t('sessions.acpDiffMoreRows', { count: hidden })}</p>}
      </div>}
    {truncated && <p className={styles.truncatedNote}>{t('sessions.acpDiffTruncated')}</p>}
  </details>;
}
