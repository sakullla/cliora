import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../../components/Icon';
import { diffLines, diffRows, splitLines, type DiffOp, type DiffPiece } from '../../../lib/textDiff';
import { AcpCopyButton } from './AcpCopyButton';
import { splitMatchRuns } from './acpSearch';
import { insideDirectory, visibleControls } from './acpView';
import styles from './acp.module.css';

/** Line budget for an exact line diff; beyond it only the totals are shown. */
const DIFF_LINE_LIMIT = 4000;
/** Rows drawn per increment; remaining rows can be expanded on demand. */
const ROW_LIMIT = 400;

type NumberedDiffRow =
  | { kind: 'skip'; count: number }
  | { kind: DiffOp; text: string; pieces?: DiffPiece[]; oldLine: number | null; newLine: number | null };

type Computed = { rows: NumberedDiffRow[]; added: number; removed: number; tooLarge: boolean };

function compute(oldText: string | null, newText: string): Computed {
  const after = splitLines(newText);
  if (oldText == null) {
    // A new file is all additions: no edit script is needed.
    const rows: NumberedDiffRow[] = after.map((text, index) => ({
      kind: 'insert',
      text,
      oldLine: null,
      newLine: index + 1,
    }));
    return { rows, added: after.length, removed: 0, tooLarge: false };
  }
  const before = splitLines(oldText);
  if (before.length + after.length > DIFF_LINE_LIMIT) {
    return { rows: [], added: after.length, removed: before.length, tooLarge: true };
  }
  const lines = diffLines(oldText, newText);
  const rawRows = diffRows(lines);
  let oldNo = 1;
  let newNo = 1;
  const rows: NumberedDiffRow[] = rawRows.map((row) => {
    if (row.kind === 'skip') {
      oldNo += row.count;
      newNo += row.count;
      return row;
    }
    if (row.kind === 'delete') {
      const current = oldNo;
      oldNo += 1;
      return { ...row, oldLine: current, newLine: null };
    }
    if (row.kind === 'insert') {
      const current = newNo;
      newNo += 1;
      return { ...row, oldLine: null, newLine: current };
    }
    const oldCurrent = oldNo;
    const newCurrent = newNo;
    oldNo += 1;
    newNo += 1;
    return { ...row, oldLine: oldCurrent, newLine: newCurrent };
  });
  return {
    rows,
    added: lines.filter((line) => line.op === 'insert').length,
    removed: lines.filter((line) => line.op === 'delete').length,
    tooLarge: false,
  };
}

function renderHighlighted(text: string, query: string, caseSensitive: boolean) {
  const safe = visibleControls(text);
  if (!query.trim()) return safe || ' ';
  const runs = splitMatchRuns(safe, query, caseSensitive);
  if (!runs.length) return ' ';
  return runs.map((run, index) => run.hit
    ? <mark key={index} className={styles.findMark}>{run.text}</mark>
    : run.text);
}

function renderRowContent(row: Extract<NumberedDiffRow, { text: string }>, query: string, caseSensitive: boolean) {
  if (query.trim()) return renderHighlighted(row.text, query, caseSensitive);
  if (!row.pieces?.length) return visibleControls(row.text) || ' ';
  return row.pieces.map((piece, index) => {
    const text = visibleControls(piece.text);
    if (piece.op === 'insert') return <span key={index} className={styles.diffWordIns}>{text}</span>;
    if (piece.op === 'delete') return <span key={index} className={styles.diffWordDel}>{text}</span>;
    return text;
  });
}

/**
 * A file change: its path (clickable when inside the session directory), added
 * and removed line counts, copy-updated-text action, line-number gutters, and
 * incremental row expansion for long diffs.
 */
export function AcpDiff({
  path,
  oldText,
  newText,
  truncated,
  previousOmitted = false,
  label,
  open = true,
  forceOpen = false,
  directory,
  onOpenPath,
  searchQuery = '',
  searchCase = false,
}: {
  path: string;
  oldText: string | null;
  newText: string;
  truncated: boolean;
  previousOmitted?: boolean;
  /** The heading; defaults to "new" or "edit" with the path. */
  label?: string;
  open?: boolean;
  /** Forces the diff open when search or navigation lands inside it. */
  forceOpen?: boolean;
  /** Session working directory; enables direct file opening when `path` lies inside. */
  directory?: string;
  onOpenPath?: (target: string) => Promise<void>;
  searchQuery?: string;
  searchCase?: boolean;
}) {
  const { t } = useTranslation();
  const bodyId = useId();
  const [expanded, setExpanded] = useState(open || forceOpen);
  const [prevForceOpen, setPrevForceOpen] = useState(forceOpen);
  if (forceOpen !== prevForceOpen) {
    setPrevForceOpen(forceOpen);
    if (forceOpen) setExpanded(true);
  }
  const [rowLimit, setRowLimit] = useState(ROW_LIMIT);
  const [openError, setOpenError] = useState('');
  const diff = useMemo(() => compute(oldText, newText), [oldText, newText]);

  useEffect(() => {
    setRowLimit(ROW_LIMIT);
  }, [path, oldText, newText]);

  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!forceOpen || !trimmed || diff.rows.length <= rowLimit) return;
    const needle = searchCase ? trimmed : trimmed.toLowerCase();
    const hitIndex = diff.rows.findIndex((row) => {
      if (row.kind === 'skip') return false;
      const hay = visibleControls(row.text);
      return (searchCase ? hay : hay.toLowerCase()).includes(needle);
    });
    if (hitIndex >= rowLimit) {
      setRowLimit(Math.ceil((hitIndex + 1) / ROW_LIMIT) * ROW_LIMIT);
    }
  }, [forceOpen, searchQuery, searchCase, diff.rows, rowLimit]);

  const shown = diff.rows.slice(0, rowLimit);
  const hidden = diff.rows.length - shown.length;
  const heading = label ?? (oldText == null ? t('sessions.acpDiffNew', { path }) : t('sessions.acpDiffEdit', { path }));
  const canOpenPath = !!onOpenPath && !!directory && insideDirectory(directory, path);

  return <div className={styles.diff} data-content="diff" data-open={expanded || undefined}>
    <div className={styles.diffHead}>
      <button
        type="button"
        className={styles.diffToggle}
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((value) => !value)}
      >
        <Icon name="chevronRight" size={12} className={styles.disclosure} />
        <span className={styles.diffPath} title={path}>
          {renderHighlighted(heading, searchQuery, searchCase)}
        </span>
      </button>
      <span className={styles.diffHeadTools}>
        <span className={styles.diffStats}>
          <span className={styles.diffAdded}>{t('sessions.acpDiffAdded', { count: diff.added })}</span>
          <span className={styles.diffRemoved}>{t('sessions.acpDiffRemoved', { count: diff.removed })}</span>
        </span>
        {canOpenPath && <button
          type="button"
          className={styles.iconAction}
          data-diff-open=""
          aria-label={t('sessions.acpLocationOpen', { path })}
          title={t('sessions.acpLocationOpen', { path })}
          onClick={() => {
            setOpenError('');
            void onOpenPath(path).catch((value) => setOpenError(String((value as { message?: string })?.message ?? value)));
          }}
        >
          <Icon name="arrowUpRight" size={12} />
        </button>}
        <AcpCopyButton text={newText} label={t('sessions.acpDiffCopyNew')} />
      </span>
    </div>
    {expanded && <div id={bodyId} className={styles.diffBody}>
      {openError && <p className={styles.error} role="alert">{openError}</p>}
      {previousOmitted && <p className={styles.note}>{t('sessions.acpDiffPreviousOmitted')}</p>}
      {diff.tooLarge
        ? <p className={styles.note}>{t('sessions.acpDiffTooLarge')}</p>
        : <div className={styles.diffRows} role="table" aria-label={heading}>
          {shown.map((row, index) => row.kind === 'skip'
            ? <div key={index} className={styles.diffSkip} role="row">
              <span role="cell">{t('sessions.acpDiffSkip', { count: row.count })}</span>
            </div>
            : <div key={index} className={styles.diffRow} data-op={row.kind} role="row">
              <span className={styles.diffLineNo} role="cell" aria-label={t('sessions.acpDiffOldLine')}>{row.oldLine ?? ''}</span>
              <span className={styles.diffLineNo} role="cell" aria-label={t('sessions.acpDiffNewLine')}>{row.newLine ?? ''}</span>
              <span className={styles.diffSign} role="cell" aria-label={t(row.kind === 'insert' ? 'sessions.acpDiffInsertLine' : row.kind === 'delete' ? 'sessions.acpDiffDeleteLine' : 'sessions.acpDiffSameLine')}>
                {row.kind === 'insert' ? '+' : row.kind === 'delete' ? '−' : ' '}
              </span>
              <span className={styles.diffText} role="cell">{renderRowContent(row, searchQuery, searchCase)}</span>
            </div>)}
          {hidden > 0 && <div className={styles.diffMoreBar}>
            <span className={styles.note}>{t('sessions.acpDiffMoreRows', { count: hidden })}</span>
            <button
              type="button"
              className={styles.linkAction}
              data-diff-more=""
              onClick={() => setRowLimit((current) => current + ROW_LIMIT)}
            >
              {t('sessions.acpDiffShowMore', { count: hidden })}
            </button>
          </div>}
        </div>}
      {truncated && <p className={styles.truncatedNote}>{t('sessions.acpDiffTruncated')}</p>}
    </div>}
  </div>;
}
