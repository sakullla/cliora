import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';
import { native } from '../../lib/native';
import { useRemoteIdentity } from '../../lib/remoteReads';
import { formatFailure } from '../../lib/feedback';
import { GuideDialog } from '../../components/GuideDialog';
import { FilterSelect } from '../../components/FilterSelect';
import { Badge, Button } from '../../components/ui';
import { Icon } from '../../components/Icon';
import type { BusinessWorkspace } from '../../types/workspaces';
import type { PromptBatchResultItem, PromptContext, PromptScope, PromptImportPreview, PromptImportRow, PromptImportBatchMatch } from '../../types/prompts';
import { parseScope, scopeLabel, scopeOptions, scopeTone, scopeValue } from './promptScope';
import { notifyPromptsChanged, promptContextKey } from './usePromptQuery';
import styles from './Prompts.module.css';

const tagsOf = (value: string) => value.split(/[,，、]/).map(tag => tag.trim()).filter(Boolean);
// Recompute from editable, selected input. Native preview matches describe the initial
// batch; they must not hide duplicates introduced later by editing or selecting rows.
function currentBatchMatches(rows: PromptImportRow[], selected: Set<string>) {
  const titles = new Map<string, PromptImportRow[]>(); const bodies = new Map<string, PromptImportRow[]>();
  const titleKey = (title: string) => title.trim().replace(/[A-Z]/g, char => char.toLowerCase());
  const active = rows.filter(row => selected.has(row.item.itemId) && row.item.action !== 'skip');
  for (const row of active) {
    const title = titleKey(row.item.draft.title); const body = row.item.draft.body;
    if (!titles.has(title)) titles.set(title, []); if (!bodies.has(body)) bodies.set(body, []);
    titles.get(title)!.push(row); bodies.get(body)!.push(row);
  }
  const matches = new Map<string, PromptImportBatchMatch[]>();
  for (const row of active) {
    const candidates = new Map<string, PromptImportRow>();
    for (const group of [titles.get(titleKey(row.item.draft.title)), bodies.get(row.item.draft.body)]) {
      for (const other of group?.slice(0, 9) ?? []) if (other !== row) candidates.set(other.item.itemId, other);
    }
    matches.set(row.item.itemId, [...candidates.values()].slice(0, 8).map(other => ({ itemId: other.item.itemId, title: other.item.draft.title, sameBody: other.item.draft.body === row.item.draft.body })));
  }
  return matches;
}
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
  const batchMatches = useMemo(() => currentBatchMatches(preview?.rows ?? [], selected), [preview, selected]);
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
  const duplicateCount = preview?.rows.filter(row => row.matches.length > 0 || (batchMatches.get(row.item.itemId)?.length ?? 0) > 0).length ?? 0;
  const invalidCount = preview?.rows.filter(row => !!row.error).length ?? 0;
  const resultTone = { saved: 'success', skipped: 'neutral', conflict: 'warning', failed: 'danger' } as const;
  function applyBulk(change: (row: PromptImportRow) => PromptImportRow) {
    setPreview(previous => previous ? { ...previous, rows: previous.rows.map(row => selected.has(row.item.itemId) && !terminal(row.item.itemId) ? change(row) : row) } : previous);
  }
  return <GuideDialog open title={t(preview ? 'prompts.previewTitle' : 'prompts.importTitle')} hint={t(preview ? 'prompts.previewHint' : 'prompts.importHint')} wide closeDisabled={busy} onClose={onClose}>
    <div className={styles.batch}>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {!preview ? <div className={styles.form}>
        <div className={styles.importSources}>
          <Button size="sm" icon={<Icon name="file" size={13} />} onClick={() => void chooseFiles()}>{t('prompts.chooseFiles')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setInput(JSON.stringify([{ title: t('prompts.exampleTitle'), body: t('prompts.exampleBody'), tags: ['review'] }], null, 2))}>{t('prompts.example')}</Button>
          {files.length > 0 && <span className={styles.hint}>{t('prompts.selectedFiles', { count: files.length })}</span>}
        </div>
        {files.length > 0 && <ul className={styles.fileList}>{files.map(file => <li key={file} title={file}><Icon name="file" size={12} /><span>{file}</span><button type="button" aria-label={`${t('prompts.remove')} ${file}`} onClick={() => setFiles(previous => previous.filter(item => item !== file))}><Icon name="close" size={12} /></button></li>)}</ul>}
        <label>{t('prompts.json')}<textarea className={styles.code} rows={9} value={input} onChange={event => setInput(event.target.value)} aria-label={t('prompts.json')} spellCheck={false} placeholder={'[\n  { "title": "…", "body": "…", "tags": ["…"] }\n]'} /></label>
        <p className={styles.hint}>{t('prompts.formatHint')}</p>
        <div className={styles.scopeRow}><div className={styles.field}><span>{t('prompts.scope')}</span><FilterSelect label={t('prompts.scope')} triggerDetail={false} value={scope} options={options} onChange={setScope} /></div><label>{t('prompts.tags')}<input value={tags} onChange={event => setTags(event.target.value)} placeholder={t('prompts.tagHint')} /></label></div>
        <div className="dialog-footer"><Button variant="ghost" disabled={busy} onClick={onClose}>{t('prompts.cancel')}</Button><Button variant="primary" loading={busy} disabled={!input.trim() && !files.length} onClick={() => void prepare()}>{t('prompts.prepare')}</Button></div>
      </div> : <>
        <div className={styles.importSummary}>
          <span>{t('prompts.importSummary', { total: preview.rows.length, selected: selected.size })}</span>
          {duplicateCount > 0 && <Badge tone="warning">{t('prompts.importDuplicates', { count: duplicateCount })}</Badge>}
          {invalidCount > 0 && <Badge tone="danger">{t('prompts.importInvalid', { count: invalidCount })}</Badge>}
        </div>
        <fieldset className={`${styles.bulk} ${styles.form}`} disabled={busy}>
          <legend>{t('prompts.applyToSelected')}</legend>
          <div className={styles.scopeRow}>
            <div className={styles.field}><span>{t('prompts.scope')}</span><FilterSelect label={t('prompts.scope')} triggerDetail={false} value={scope} options={options} disabled={busy} onChange={value => { setScope(value); applyBulk(row => ({ ...row, error: null, item: { ...row.item, draft: { ...row.item.draft, scope: parseScope(value) } } })); }} /></div>
            <label>{t('prompts.tags')}<input value={tags} onChange={event => { const value = event.target.value; setTags(value); applyBulk(row => ({ ...row, item: { ...row.item, draft: { ...row.item.draft, tags: tagsOf(value) } } })); }} placeholder={t('prompts.tagHint')} disabled={busy} /></label>
          </div>
        </fieldset>
        <div className={styles.batchRows}>
          {preview.rows.map(row => {
            const id = row.item.itemId; const result = results[id]; const done = terminal(id); const draft = row.item.draft;
            const open = expanded === id; const sameBatch = batchMatches.get(id) ?? [];
            return <article key={id} className={styles.batchRow} data-import-item={id} data-state={result?.status ?? (row.error ? 'invalid' : undefined)} data-off={!selected.has(id) || row.item.action === 'skip' || undefined}>
              <div className={styles.batchHeader}>
                <input type="checkbox" aria-label={`${t('prompts.select')} ${draft.title}`} disabled={busy || done} checked={selected.has(id)} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(id); else next.delete(id); return next; })} />
                <strong>{draft.title || t('prompts.invalid')}</strong>
                <Badge tone={scopeTone(draft.scope, workspaces)}>{scopeLabel(draft.scope, workspaces, t)}</Badge>
                {draft.tags.map(tag => <span className={styles.tag} key={tag}>{tag}</span>)}
                {result && <span role="status"><Badge tone={resultTone[result.status]}>{t(`prompts.${result.status}`)}</Badge></span>}
                {!done && <select className={styles.actionSelect} aria-label={`${t('prompts.action')} ${draft.title}`} disabled={busy} value={row.item.action} onChange={event => update(id, current => ({ ...current, item: { ...current.item, action: event.target.value as 'create' | 'replace' | 'skip', draft: { ...current.item.draft, id: null, expectedVersion: null } } }))}><option value="create">{t('prompts.createCopy')}</option><option value="replace" disabled={!row.matches.length}>{t('prompts.replace')}</option><option value="skip">{t('prompts.skip')}</option></select>}
                <Button size="sm" variant="ghost" aria-expanded={open} icon={<Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />} onClick={() => setExpanded(open ? null : id)}>{t(open ? 'prompts.collapse' : 'prompts.expand')}</Button>
              </div>
              {row.matches.length > 0 && <p className={styles.dupe}><Icon name="alert" size={12} />{t('prompts.duplicate')}: {row.matches.map(item => item.title).join('、')}</p>}
              {sameBatch.length > 0 && <p className={styles.dupe}><Icon name="alert" size={12} />{t('prompts.batchDuplicate')}: {sameBatch.map(item => item.title).join('、')}</p>}
              {(row.error || result?.error) && <p role="alert" className={styles.error}>{row.error || result?.error}</p>}
              {row.item.action === 'replace' && !done && <div className={styles.field}><span>{t('prompts.target')}</span><FilterSelect label={t('prompts.target')} triggerDetail={false} value={draft.id ?? ''} placeholder={t('prompts.noTarget')} options={row.matches.map(item => ({ value: item.id, label: item.title, detail: scopeLabel(item.scope, workspaces, t) }))} onChange={target => { const match = row.matches.find(item => item.id === target); if (match) update(id, current => ({ ...current, item: { ...current.item, draft: { ...current.item.draft, id: match.id, expectedVersion: match.version } } })); }} /></div>}
              {!open && draft.body && <p className={styles.summary}>{draft.body}</p>}
              {open && <div className={styles.form}><label>{t('prompts.name')}<input disabled={busy || done} value={draft.title} onChange={event => update(id, current => ({ ...current, error: null, item: { ...current.item, draft: { ...current.item.draft, title: event.target.value } } }))} /></label><label>{t('prompts.body')}<textarea aria-label={t('prompts.body')} disabled={busy || done} value={draft.body} onChange={event => update(id, current => ({ ...current, error: null, item: { ...current.item, draft: { ...current.item.draft, body: event.target.value } } }))} /></label></div>}
            </article>;
          })}
        </div>
        <div className="dialog-footer">
          <Button variant="ghost" disabled={busy} onClick={() => { setPreview(null); setResults({}); setError(''); }}>{t('prompts.returned')}</Button>
          <span className="dialog-footer-gap" />
          <Button variant="primary" loading={busy} disabled={!pendingCount || source !== origin.current} onClick={() => void commit()}>{busy ? t('prompts.applying') : Object.keys(results).length ? t('prompts.batchRetry') : t('prompts.batchSave', { count: pendingCount })}</Button>
        </div>
      </>}
    </div>
  </GuideDialog>;
}
