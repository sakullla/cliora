import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { compareText, type DiffPiece, type FieldChange } from '../../lib/textDiff';
import type { CodeFormat } from '../CodeEditor';
import styles from './ConflictCompare.module.css';

/** What changed, in words, then only the changed lines.
 *  Multi-file views pass `banner` on the first file so the warning stays singular. */
export function ConflictCompare({ title, banner, status, currentContent, nextContent, format = 'text', busy, actions = true, onUseNext, onKeepCurrent }: {
  title?: string;
  banner?: string;
  status?: string;
  currentContent: string;
  nextContent: string;
  format?: CodeFormat;
  busy?: boolean;
  actions?: boolean;
  onUseNext: () => void;
  onKeepCurrent: () => void;
}) {
  const { t } = useTranslation();
  const compared = useMemo(() => compareText(currentContent, nextContent, format), [currentContent, nextContent, format]);
  const places = compared.changes.length + compared.hidden;
  const summary = compared.same
    ? t('common.conflict.same')
    : compared.whitespaceOnly
      ? t('common.conflict.whitespace')
      : places > 0
        ? t('common.conflict.fieldSummary', { places, removed: compared.removed, added: compared.added })
        : t('common.conflict.summary', { removed: compared.removed, added: compared.added });
  const diff = compared.rows.length > 0 && <div className={styles.diffBlock}>
    <p className={styles.legend}>
      <span data-side="current">− {t('common.conflict.current')}</span>
      <span data-side="next">+ {t('common.conflict.next')}</span>
    </p>
    <div className={styles.diff} role="table" aria-label={t('common.conflict.diffLabel')}>
      {compared.rows.map((row, index) => row.kind === 'skip'
        ? <div key={index} className={styles.skip}>{t('common.conflict.unchanged', { count: row.count })}</div>
        : <div key={index} className={styles.row} data-kind={row.kind} role="row">
          <span className={styles.mark} aria-hidden="true">{row.kind === 'delete' ? '−' : row.kind === 'insert' ? '+' : ''}</span>
          <span className={styles.code}>{row.text === '' ? <i>{t('common.conflict.emptyLine')}</i> : renderPieces(row.text, row.pieces)}</span>
        </div>)}
    </div>
  </div>;
  return <section className={styles.compare} aria-label={title ?? t('common.conflict.label')}>
    {banner && <p className={styles.banner} data-banner="conflict">{banner}</p>}
    <div className={styles.head}>
      <div className={styles.titleRow}>
        {title && <strong className={styles.title}>{title}{status ? ` · ${status}` : ''}</strong>}
        {!compared.same && !compared.whitespaceOnly && <p className={styles.stats} aria-hidden="true">
          <span className={styles.statRemove}>−{compared.removed}</span>
          <span className={styles.statAdd}>+{compared.added}</span>
        </p>}
      </div>
      <p className={styles.counts}>{summary}</p>
    </div>
    {compared.changes.length > 0 && <div className={styles.what}>
      <h3>{t('common.conflict.changes')}</h3>
      <ul aria-label={t('common.conflict.changes')}>
        {compared.changes.map((change, index) => <li key={`${change.kind}:${change.path}:${index}`}>
          <div className={styles.changeHead}>
            <span className={styles.kind} data-kind={change.kind}>{kindLabel(change, t)}</span>
            <code>{change.path || t('common.conflict.whole')}</code>
          </div>
          {change.kind !== 'add' && <div className={styles.pair} data-side="current">
            <span>{t('common.conflict.current')}</span>
            <code className={styles.before}>{change.before}</code>
          </div>}
          {change.kind !== 'remove' && <div className={styles.pair} data-side="next">
            <span>{t('common.conflict.next')}</span>
            <code className={styles.after}>{change.after}</code>
          </div>}
        </li>)}
        {compared.hidden > 0 && <li className={styles.more}>{t('common.conflict.more', { count: compared.hidden })}</li>}
      </ul>
    </div>}
    {diff && (places > 0 && compared.rows.length > 4
      ? <details className={styles.raw}><summary>{t('common.conflict.rawDiff')}</summary>{diff}</details>
      : diff)}
    {actions && <div className={styles.actions}>
      <button type="button" disabled={busy} onClick={onKeepCurrent}>{t('common.conflict.keepCurrent')}</button>
      <button type="button" disabled={busy} onClick={onUseNext}>{t('common.conflict.useNext')}</button>
    </div>}
  </section>;
}

function kindLabel(change: FieldChange, t: (key: string) => string) {
  if (change.kind === 'add') return t('common.conflict.added');
  if (change.kind === 'remove') return t('common.conflict.removed');
  return t('common.conflict.edited');
}

function renderPieces(text: string, pieces?: DiffPiece[]) {
  if (!pieces?.length) return text;
  return pieces.map((piece, index) => piece.op === 'equal' ? <span key={index}>{piece.text}</span> : <mark key={index}>{piece.text}</mark>);
}
