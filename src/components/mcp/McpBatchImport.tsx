import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hasMcpIssues, isRemoteMcp, keptMcpArgs, mcpCwdOf, mcpDraftIssues, mcpTransportBadge } from '../../lib/mcp';
import type { McpCommitResult, McpDraft, McpDraftPreview } from '../../types/resources';
import { CodeEditor } from '../CodeEditor';
import { Icon } from '../Icon';
import styles from './McpBatchImport.module.css';
import { Badge, Button } from '../ui';

function failure(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
}

/** locked carries parse diagnostics; generatedName marks a default name the user has not chosen. Name problems are derived live from the editable name. */
export type McpBatchItem = { key: string; draft: McpDraft; blocked?: string; generatedName?: boolean };
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

export function McpBatchImport({ items, reservedNames = [], onPreview, onCommit, onCancel, onDefinitionSaved, onComplete }: {
  items: McpBatchItem[];
  /** Names that already exist where the import lands; a row using one is held back instead of overwriting it. */
  reservedNames?: string[];
  onPreview: (draft: McpDraft) => Promise<McpDraftPreview>;
  onCommit: (draft: McpDraft, preview: McpDraftPreview, allowReplace: boolean) => Promise<McpCommitResult>;
  onCancel: () => void;
  onDefinitionSaved?: (result: McpCommitResult) => void;
  onComplete?: () => void;
}) {
  const { t } = useTranslation();
  // A snapshot from when the review opened: saving one row must not make its own retry look like a clash.
  const [reserved] = useState(() => new Set(reservedNames));
  // Everything that stops a row from being previewed: parse diagnostics, field issues and name clashes.
  // Names are editable, so this is derived from the current rows rather than fixed at import time.
  function issueOf(row: Pick<Row, 'key' | 'draft' | 'blocked'>, all: Array<Pick<Row, 'key' | 'draft'>>) {
    if (row.blocked) return row.blocked;
    const issues = mcpDraftIssues(row.draft);
    if (hasMcpIssues(issues)) return Object.values(issues).map(value => t('tools.mcp.issue.' + value)).join(' ');
    const name = row.draft.name.trim();
    const firstIndex = all.findIndex(other => other.draft.name.trim() === name);
    if (reserved.has(name) || all[firstIndex]?.key !== row.key) return t('tools.mcp.batchDuplicate', { name });
    return '';
  }
  const [rows, setRows] = useState<Row[]>(() => {
    const initial = items.map((item): Row => ({ ...item, selected: false, preview: null, replace: false, result: null, error: '', pending: false }));
    return initial.map(row => ({ ...row, selected: !issueOf(row, initial) }));
  });
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const issues = new Map(rows.map(row => [row.key, isComplete(row) ? '' : issueOf(row, rows)]));
  const active = (row: Row) => row.selected && !isComplete(row) && !issues.get(row.key);
  const selectedCount = rows.filter(active).length;
  const confirmable = rows.filter(row => active(row) && row.preview && !row.error && row.preview.targets.every(target =>
    target.status === 'ready' || target.status === 'conflict' && row.replace));

  function patch(key: string, value: Partial<Row>) {
    setRows(current => current.map(row => row.key === key ? { ...row, ...value } : row));
  }
  // A new name invalidates the preview, its conflict confirmation and any error, so the row is re-checked as typed.
  function rename(key: string, name: string) {
    setRows(current => current.map(row => row.key === key ? { ...row, draft: { ...row.draft, name }, generatedName: false, selected: true, preview: null, replace: false, error: '' } : row));
  }
  async function preview() {
    setBusy(true); setReviewed(true);
    for (const row of rows.filter(active)) {
      patch(row.key, { pending: true, error: '', preview: null, replace: false });
      try {
        const value = await onPreview({ ...row.draft, name: row.draft.name.trim(), args: keptMcpArgs(row.draft.args), cwd: mcpCwdOf(row.draft) });
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
  const needsPreview = rows.some(row => active(row) &&
    (!row.preview || !!row.error || row.preview.targets.some(target => target.status === 'failed' || target.status === 'unsupported')));

  return <div className={styles.batch}>
    <p className={styles.intro}>{t('tools.mcp.batchIntro')}</p>
    <ul className={styles.list} aria-label={t('tools.mcp.batchList')}>{rows.map((row, index) => {
      const issue = issues.get(row.key) ?? '';
      const conflicts = row.preview?.targets.filter(target => target.status === 'conflict') ?? [];
      const unavailable = row.preview?.targets.filter(target => target.status === 'unsupported' || target.status === 'failed') ?? [];
      const complete = isComplete(row);
      const partial = !!row.result && !complete && row.result.targets.some(target => target.status === 'written');
      const remote = isRemoteMcp(row.draft.transport);
      const args = keptMcpArgs(row.draft.args);
      const cwd = mcpCwdOf(row.draft);
      return <li className={styles.item} key={row.key} data-state={complete ? 'written' : row.error ? 'failed' : row.pending ? 'pending' : undefined}>
        <div className={styles.rowHead}>
          <label className={styles.choose}>
            <input type="checkbox" aria-label={t('tools.mcp.batchSelect', { name: row.draft.name || index + 1 })} checked={row.selected} disabled={busy || !!issue || complete} onChange={event => patch(row.key, { selected: event.target.checked, preview: null, error: '', replace: false })} />
            <span><strong>{row.draft.name || t('tools.mcp.batchUnnamed', { index: index + 1 })}</strong><small>{mcpTransportBadge(row.draft.transport)}</small></span>
          </label>
          <Badge className={styles.state} tone={row.pending ? 'info' : complete ? 'success' : partial ? 'warning' : row.error ? 'danger' : issue ? 'warning' : row.preview ? 'accent' : 'neutral'}>{row.pending ? t('tools.mcp.batchPending') : complete ? t('tools.mcp.batchDone') : partial ? t('tools.mcp.batchPartial') : row.error ? t('tools.mcp.batchFailed') : issue ? t('tools.mcp.batchNeedsInput') : row.preview ? t('tools.mcp.batchReady') : t('tools.mcp.batchWaiting')}</Badge>
        </div>
        {!complete && !row.result && <label className={styles.nameField}>{t('tools.mcp.batchNameLabel')}
          <input aria-label={t('tools.mcp.batchNameAria', { index: index + 1 })} aria-invalid={!!issue || undefined} value={row.draft.name} disabled={busy} spellCheck={false} autoComplete="off" onChange={event => rename(row.key, event.target.value)} />
          {row.generatedName && <small>{t('tools.mcp.batchNameDefault')}</small>}
        </label>}
        <dl className={styles.review} aria-label={t('tools.mcp.batchReview')}>
          <div><dt>{t('tools.mcp.type')}</dt><dd>{t('tools.mcp.transportName.' + row.draft.transport)}</dd></div>
          {remote ? <div><dt>{t('tools.mcp.urlAria')}</dt><dd><code>{row.draft.url.trim() || '—'}</code></dd></div> : <>
            <div><dt>{t('tools.mcp.command')}</dt><dd><code>{row.draft.command.trim() || '—'}</code></dd></div>
            <div><dt>{t('tools.mcp.args')}</dt><dd>{args.length ? <ol>{args.map((arg, argIndex) => <li key={argIndex}><code>{arg}</code></li>)}</ol> : '—'}</dd></div>
            <div><dt>{t('tools.mcp.cwd')}</dt><dd><code>{cwd || '—'}</code></dd></div>
          </>}
        </dl>
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
