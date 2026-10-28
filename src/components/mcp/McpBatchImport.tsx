import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hasMcpIssues, keptMcpArgs, mcpDraftIssues, mcpSummary } from '../../lib/mcp';
import type { McpCommitResult, McpDraft, McpDraftPreview } from '../../types/resources';
import { CodeEditor } from '../CodeEditor';
import { Icon } from '../Icon';
import styles from './McpBatchImport.module.css';
import { Badge, Button } from '../ui';

function failure(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
}

export type McpBatchItem = { key: string; draft: McpDraft; blocked?: string };
type Row = McpBatchItem & {
  selected: boolean;
  preview: McpDraftPreview | null;
  replace: boolean;
  result: McpCommitResult | null;
  error: string;
  pending: boolean;
};

function isComplete(row: Pick<Row, 'result'>) {
  return !!row.result && row.result.targets.every(target => target.status === 'written');
}

export function McpBatchImport({ items, onPreview, onCommit, onCancel, onDefinitionSaved, onComplete }: {
  items: McpBatchItem[];
  onPreview: (draft: McpDraft) => Promise<McpDraftPreview>;
  onCommit: (draft: McpDraft, preview: McpDraftPreview, allowReplace: boolean) => Promise<McpCommitResult>;
  onCancel: () => void;
  onDefinitionSaved?: (result: McpCommitResult) => void;
  onComplete?: () => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[]>(() => items.map(item => ({ ...item, selected: !item.blocked && !hasMcpIssues(mcpDraftIssues(item.draft)), preview: null, replace: false, result: null, error: '', pending: false })));
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const selectedCount = rows.filter(row => row.selected && !isComplete(row)).length;
  const confirmable = useMemo(() => rows.filter(row => row.selected && !isComplete(row) && row.preview && !row.error && row.preview.targets.every(target =>
    target.status === 'ready' || target.status === 'conflict' && row.replace)), [rows]);

  function patch(key: string, value: Partial<Row>) {
    setRows(current => current.map(row => row.key === key ? { ...row, ...value } : row));
  }
  async function preview() {
    setBusy(true); setReviewed(true);
    for (const row of rows.filter(item => item.selected && !isComplete(item))) {
      patch(row.key, { pending: true, error: '', preview: null, replace: false });
      try {
        const value = await onPreview({ ...row.draft, name: row.draft.name.trim(), args: keptMcpArgs(row.draft.args) });
        patch(row.key, { preview: value, pending: false });
      } catch (error) {
        patch(row.key, { error: failure(error), pending: false });
      }
    }
    setBusy(false);
  }
  async function commit() {
    setBusy(true);
    const incomplete = new Set(rows.filter(row => !isComplete(row)).map(row => row.key));
    for (const row of confirmable) {
      patch(row.key, { pending: true, error: '' });
      try {
        const result = await onCommit(row.preview!.draft, row.preview!, row.replace);
        const complete = result.targets.every(target => target.status === 'written');
        if (complete) incomplete.delete(row.key);
        patch(row.key, { result, selected: !complete, preview: complete ? row.preview : null, error: complete ? '' : t('tools.mcp.partialFailed'),
          draft: { ...row.draft, id: result.definition.id, expectedVersion: result.definition.version, inLibrary: result.definition.inLibrary !== false }, pending: false });
        onDefinitionSaved?.(result);
      } catch (error) {
        patch(row.key, { error: failure(error), pending: false });
      }
    }
    setBusy(false);
    if (incomplete.size === 0) onComplete?.();
  }
  const canConfirm = reviewed && confirmable.length > 0 && confirmable.length === selectedCount;
  const needsPreview = rows.some(row => row.selected && !isComplete(row) &&
    (!row.preview || !!row.error || row.preview.targets.some(target => target.status === 'failed' || target.status === 'unsupported')));

  return <div className={styles.batch}>
    <p className={styles.intro}>{t('tools.mcp.batchIntro')}</p>
    <ul className={styles.list} aria-label={t('tools.mcp.batchList')}>{rows.map((row, index) => {
      const issues = mcpDraftIssues(row.draft);
      const invalid = hasMcpIssues(issues);
      const issue = row.blocked || (invalid ? Object.values(issues).map(value => t('tools.mcp.issue.' + value)).join(' ') : '');
      const conflicts = row.preview?.targets.filter(target => target.status === 'conflict') ?? [];
      const unavailable = row.preview?.targets.filter(target => target.status === 'unsupported' || target.status === 'failed') ?? [];
      const complete = isComplete(row);
      const partial = !!row.result && !complete && row.result.targets.some(target => target.status === 'written');
      return <li className={styles.item} key={row.key} data-state={complete ? 'written' : row.error ? 'failed' : row.pending ? 'pending' : undefined}>
        <div className={styles.rowHead}>
          <label className={styles.choose}>
            <input type="checkbox" aria-label={t('tools.mcp.batchSelect', { name: row.draft.name || index + 1 })} checked={row.selected} disabled={busy || !!issue || complete} onChange={event => patch(row.key, { selected: event.target.checked, preview: null, error: '', replace: false })} />
            <span><strong>{row.draft.name || t('tools.mcp.batchUnnamed', { index: index + 1 })}</strong><small>{row.draft.transport === 'http' ? 'HTTP' : 'stdio'} · {mcpSummary(row.draft) || '—'}</small></span>
          </label>
          <Badge className={styles.state} tone={row.pending ? 'info' : complete ? 'success' : partial ? 'warning' : row.error ? 'danger' : issue ? 'warning' : row.preview ? 'accent' : 'neutral'}>{row.pending ? t('tools.mcp.batchPending') : complete ? t('tools.mcp.batchDone') : partial ? t('tools.mcp.batchPartial') : row.error ? t('tools.mcp.batchFailed') : issue ? t('tools.mcp.batchNeedsInput') : row.preview ? t('tools.mcp.batchReady') : t('tools.mcp.batchWaiting')}</Badge>
        </div>
        {issue && <p className={styles.error}>{issue}</p>}
        {row.error && <p className={styles.error} role="alert">{row.error}</p>}
        {unavailable.map((target, targetIndex) => <p className={styles.error} key={targetIndex}>{target.detail}</p>)}
        {conflicts.length > 0 && <div className={styles.conflicts}>
          {conflicts.map((target, targetIndex) => <div className={styles.diff} key={targetIndex}>
            <CodeEditor compact label={t('tools.mcp.conflictCurrent')} format="json" readOnly value={JSON.stringify(target.existing, null, 2)} />
            <CodeEditor compact label={t('tools.mcp.conflictNext')} format="json" readOnly value={JSON.stringify(target.proposed, null, 2)} />
          </div>)}
          <label className={styles.replace}><input type="checkbox" checked={row.replace} disabled={busy} onChange={event => patch(row.key, { replace: event.target.checked })} />{t('tools.mcp.batchReplace')}</label>
        </div>}
        {row.result && <div className={styles.results} aria-label={t('tools.mcp.batchResults', { name: row.result.definition.name })}>
          <p role="status"><Icon name="check" size={13} />{t('tools.mcp.batchSaved', { name: row.result.definition.name })}</p>
          {row.result.targets.map((target, targetIndex) => <p key={targetIndex} data-status={target.status}>{target.status === 'written' ? t('tools.mcp.batchWritten') : t('tools.mcp.batchTargetFailed', { detail: target.detail })}</p>)}
        </div>}
      </li>;
    })}</ul>
    {reviewed && !busy && selectedCount > 0 && !canConfirm && <p className={styles.hint} role="status">{t('tools.mcp.batchResolve')}</p>}
    <div className="dialog-footer">
      <button type="button" disabled={busy} onClick={onCancel}>{t('library.resources.back')}</button>
      <span className="dialog-footer-gap" />
      {!reviewed || needsPreview ? <Button variant="primary" data-dialog-save disabled={busy || !selectedCount} onClick={() => void preview()}>{t('tools.mcp.batchPreview', { count: selectedCount })}</Button>
        : <Button variant="primary" data-dialog-save disabled={busy || !canConfirm} onClick={() => void commit()}>{t('tools.mcp.batchConfirm', { count: confirmable.length })}</Button>}
    </div>
  </div>;
}
