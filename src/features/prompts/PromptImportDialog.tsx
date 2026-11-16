import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';
import { native } from '../../lib/native';
import { useRemoteIdentity } from '../../lib/remoteReads';
import { formatFailure } from '../../lib/feedback';
import { GuideDialog } from '../../components/GuideDialog';
import { FilterSelect } from '../../components/FilterSelect';
import { Button } from '../../components/ui';
import type { BusinessWorkspace } from '../../types/workspaces';
import type { PromptBatchResultItem, PromptContext, PromptScope, PromptImportPreview, PromptImportRow } from '../../types/prompts';
import { parseScope, scopeLabel, scopeOptions, scopeValue } from './promptScope';
import { notifyPromptsChanged, promptContextKey } from './usePromptQuery';
import styles from './Prompts.module.css';

const tagsOf = (value: string) => value.split(/[,，、]/).map(tag => tag.trim()).filter(Boolean);
export function PromptImportDialog({ context, workspaces, initialScope, onClose, onDone }: { initialScope: PromptScope; context: PromptContext; workspaces: BusinessWorkspace[]; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [scope, setScope] = useState(scopeValue(initialScope));
  const [tags, setTags] = useState('');
  const [preview, setPreview] = useState<PromptImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, PromptBatchResultItem>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const remoteIdentity = useRemoteIdentity(context.targetId ?? 'local');
  const source = `${promptContextKey(context)}:${remoteIdentity}`;
  const latest = useRef(source); latest.current = source;
  const origin = useRef(source);
  const options = scopeOptions(workspaces, t);
  const terminal = (id: string) => results[id]?.status === 'saved' || results[id]?.status === 'skipped';
  async function prepare() {
    if (busy) return;
    const identity = source; origin.current = identity; setBusy(true); setError('');
    try {
      const value = await native.previewPromptImport(context, { jsonText: input, files, scope: parseScope(scope), tags: tagsOf(tags) });
      if (latest.current !== identity) return;
      if (!value?.rows) throw new Error(t('prompts.readFailed'));
      setPreview(value); setResults({}); setSelected(new Set(value.rows.filter(row => !row.error).map(row => row.item.itemId))); setExpanded(value.rows[0]?.item.itemId ?? null);
    } catch (value) { if (latest.current === identity) setError(formatFailure(value, t('prompts.readFailed'), t('prompts.retry'))); }
    finally { setBusy(false); }
  }
  async function chooseFiles() {
    try { const picked = await open({ multiple: true, filters: [{ name: 'Prompts', extensions: ['json', 'md', 'markdown', 'txt'] }] }); if (picked) setFiles(Array.isArray(picked) ? picked : [picked]); }
    catch (value) { setError(formatFailure(value, t('prompts.readFailed'), t('prompts.retry'))); }
  }
  function update(id: string, change: (row: PromptImportRow) => PromptImportRow) {
    if (terminal(id) || busy) return;
    setPreview(previous => previous ? { ...previous, rows: previous.rows.map(row => row.item.itemId === id ? change(row) : row) } : previous);
    setResults(previous => { const next = { ...previous }; delete next[id]; return next; });
  }
  async function commit() {
    if (!preview || busy) return;
    if (source !== origin.current) { setError(t('prompts.sourceChanged')); return; }
    const pending = preview.rows.filter(row => selected.has(row.item.itemId) && !terminal(row.item.itemId));
    if (!pending.length) return;
    const identity = source; setBusy(true); setError('');
    try {
      const result = await native.applyPromptBatch(context, { operationId: preview.operationId, items: pending.map(row => row.item) });
      if (latest.current !== identity) return;
      setResults(previous => ({ ...previous, ...Object.fromEntries(result.items.map(item => [item.itemId, item])) }));
      if (result.items.some(item => item.status === 'failed' || item.status === 'conflict')) setError(t('prompts.errorsRemain'));
      onDone(); notifyPromptsChanged();
    } catch (value) { if (latest.current === identity) setError(formatFailure(value, t('prompts.readFailed'), t('prompts.retry'))); }
    finally { setBusy(false); }
  }
  const pendingCount = preview?.rows.filter(row => selected.has(row.item.itemId) && !terminal(row.item.itemId)).length ?? 0;
  return <GuideDialog open title={t(preview ? 'prompts.previewTitle' : 'prompts.importTitle')} hint={t(preview ? 'prompts.previewHint' : 'prompts.importHint')} wide closeDisabled={busy} onClose={onClose}>
    <div className={styles.batch}>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {!preview ? <div className={styles.form}>
        <div className={styles.actions}><Button onClick={() => setInput(JSON.stringify([{ title: t('prompts.exampleTitle'), body: t('prompts.exampleBody'), tags: ['review'] }], null, 2))}>{t('prompts.example')}</Button><Button onClick={() => void chooseFiles()}>{t('prompts.chooseFiles')}</Button><span className={styles.hint}>{t('prompts.selectedFiles', { count: files.length })}</span></div>
        {files.length > 0 && <div className={styles.preview}>{files.join('\n')}</div>}
        <label>{t('prompts.json')}<textarea value={input} onChange={event => setInput(event.target.value)} aria-label={t('prompts.json')} spellCheck={false} /></label>
        <div className={styles.scopeRow}><FilterSelect label={t('prompts.scope')} value={scope} options={options} onChange={setScope} /><label>{t('prompts.tags')}<input value={tags} onChange={event => setTags(event.target.value)} placeholder={t('prompts.tagHint')} /></label></div>
        <Button disabled={busy || (!input.trim() && !files.length)} onClick={() => void prepare()}>{t('prompts.prepare')}</Button>
      </div> : <>
        <div className={styles.actions}><Button disabled={busy} onClick={() => { setPreview(null); setResults({}); setError(''); }}>{t('prompts.returned')}</Button><span>{t('prompts.selectedCount', { count: selected.size })}</span></div>
        <div className={styles.scopeRow}><FilterSelect label={t('prompts.scope')} value={scope} options={options} disabled={busy} onChange={value => { setScope(value); setPreview(previous => previous ? { ...previous, rows: previous.rows.map(row => selected.has(row.item.itemId) && !terminal(row.item.itemId) ? { ...row, error: null, item: { ...row.item, draft: { ...row.item.draft, scope: parseScope(value) } } } : row) } : previous); }} /><label className={styles.form}>{t('prompts.tags')}<input value={tags} onChange={event => { const value = event.target.value; setTags(value); setPreview(previous => previous ? { ...previous, rows: previous.rows.map(row => selected.has(row.item.itemId) && !terminal(row.item.itemId) ? { ...row, item: { ...row.item, draft: { ...row.item.draft, tags: tagsOf(value) } } } : row) } : previous); }} placeholder={t('prompts.tagHint')} disabled={busy} /></label></div>
        <div className={styles.batchRows}>
          {preview.rows.map(row => {
            const id = row.item.itemId; const result = results[id]; const done = terminal(id); const draft = row.item.draft;
            return <article key={id} className={styles.batchRow} data-import-item={id}>
              <div className={styles.batchHeader}><input type="checkbox" aria-label={`${t('prompts.select')} ${draft.title}`} disabled={busy || done} checked={selected.has(id)} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(id); else next.delete(id); return next; })} /><strong>{draft.title || t('prompts.invalid')}</strong><span>{scopeLabel(draft.scope, workspaces, t)}</span><Button size="sm" variant="ghost" onClick={() => setExpanded(expanded === id ? null : id)}>{t('prompts.preview')}</Button></div>
              {row.matches.length > 0 && <p className={styles.hint}>{t('prompts.duplicate')}: {row.matches.map(item => item.title).join('、')}</p>}
              {(row.error || result?.error) && <p role="alert" className={styles.error}>{row.error || result?.error}</p>}
              {result && <span role="status">{t(`prompts.${result.status}`)}</span>}
              {!done && <select aria-label={`${t('prompts.action')} ${draft.title}`} disabled={busy} value={row.item.action} onChange={event => update(id, current => ({ ...current, item: { ...current.item, action: event.target.value as 'create' | 'replace' | 'skip', draft: { ...current.item.draft, id: null, expectedVersion: null } } }))}><option value="create">{t('prompts.createCopy')}</option><option value="replace" disabled={!row.matches.length}>{t('prompts.replace')}</option><option value="skip">{t('prompts.skip')}</option></select>}
              {row.item.action === 'replace' && !done && <FilterSelect label={t('prompts.target')} value={draft.id ?? ''} options={row.matches.map(item => ({ value: item.id, label: item.title, detail: scopeLabel(item.scope, workspaces, t) }))} onChange={target => { const match = row.matches.find(item => item.id === target); if (match) update(id, current => ({ ...current, item: { ...current.item, draft: { ...current.item.draft, id: match.id, expectedVersion: match.version } } })); }} />}
              {expanded === id && <div className={styles.form}><label>{t('prompts.name')}<input disabled={busy || done} value={draft.title} onChange={event => update(id, current => ({ ...current, error: null, item: { ...current.item, draft: { ...current.item.draft, title: event.target.value } } }))} /></label><label>{t('prompts.body')}<textarea aria-label={t('prompts.body')} disabled={busy || done} value={draft.body} onChange={event => update(id, current => ({ ...current, error: null, item: { ...current.item, draft: { ...current.item.draft, body: event.target.value } } }))} /></label></div>}
            </article>;
          })}
        </div>
        <Button disabled={busy || !pendingCount || source !== origin.current} onClick={() => void commit()}>{busy ? t('prompts.applying') : Object.keys(results).length ? t('prompts.batchRetry') : t('prompts.batchSave', { count: pendingCount })}</Button>
      </>}
    </div>
  </GuideDialog>;
}
