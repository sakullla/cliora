import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { CodeEditor } from '../../components/CodeEditor';
import type { Scope } from '../../types/native';
import type { AgentEntry, AgentRequest, AgentResult, AgentSnapshot, PluginTarget } from '../../types/resources';
import { useAccountLabels } from '../library/resourceContexts';
import { DocumentWorkspace } from './DocumentWorkspace';
import styles from './AgentsWorkspace.module.css';
import { StatusBanner } from '../../components/StatusBanner';
import { SearchField } from '../../components/SearchField';
import { SkeletonRows } from '../../components/Skeleton';
import { EmptyState } from '../../components/EmptyState';

function message(error: unknown) { return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error); }

export function AgentsWorkspace({ toolId, scope, projectPath, contextId, onDirtyChange }: { toolId: string; scope: Scope; projectPath: string; contextId: string | null; onDirtyChange: (value: boolean) => void }) {
  const { t } = useTranslation();
  const target = useMemo<PluginTarget>(() => ({ toolId, scope, projectPath: scope === 'project' ? projectPath : null, contextId }), [toolId, scope, projectPath, contextId]);
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [selected, setSelected] = useState<AgentEntry | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('reviewer');
  const [content, setContent] = useState('');
  const [initial, setInitial] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [last, setLast] = useState<AgentResult | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const importInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const accountLabel = useAccountLabels();
  const dirty = editing && !selected?.readOnly && (selected ? content !== initial : !!content);
  const entries = snapshot?.entries ?? [];
  const supported = !!snapshot?.capability.supported;
  const filtered = entries.filter(entry => `${entry.name} ${entry.description} ${entry.owner}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) && (filter === 'all' || (filter === 'readonly' ? entry.readOnly : filter === 'enabled' ? entry.enabled : !entry.enabled)));
  const opened = !creating && selected && filtered.some(item => item.id === selected.id) ? selected : null;
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    const id = ++generation.current;
    setBusy(true); setSnapshot(null); setError(''); setEditing(false); setCreating(false); setSelected(null); setLast(null);
    void native.scanNativeAgents(target).then(value => { if (generation.current === id) setSnapshot(value); }).catch(value => { if (generation.current === id) setError(message(value)); }).finally(() => { if (generation.current === id) setBusy(false); });
    return () => { generation.current += 1; };
  }, [target]);

  function applyEntry(entry: AgentEntry | null) {
    setSelected(entry);
    if (!entry) return;
    setName(entry.name);
    setContent(entry.content);
    setInitial(entry.content);
  }
  async function abandon() {
    const id = generation.current;
    return !dirty || await confirmAction(t('tools.agents.confirmAbandon'), () => generation.current === id, { title: t('tools.agents.abandonTitle'), confirmLabel: t('tools.agents.abandonConfirm') });
  }
  async function refresh() {
    if (!await abandon()) return;
    const currentId = selected?.id ?? null;
    const id = ++generation.current;
    setBusy(true); setError('');
    try {
      const value = await native.scanNativeAgents(target);
      if (id !== generation.current) return;
      setSnapshot(value);
      setEditing(false);
      setCreating(false);
      applyEntry(currentId ? value.entries.find(item => item.id === currentId) ?? null : null);
    } catch (e) { if (id === generation.current) setError(message(e)); }
    finally { if (id === generation.current) setBusy(false); }
  }
  async function openEntry(entry: AgentEntry) {
    if (!creating && selected?.id === entry.id) return;
    if (!await abandon()) return;
    setCreating(false);
    setEditing(false);
    setError('');
    applyEntry(entry);
  }
  async function createNew() {
    if (!snapshot?.capability.supported || busy || !await abandon()) return;
    const text = snapshot.capability.template ?? '';
    setSelected(null);
    setCreating(true);
    setEditing(true);
    setName('reviewer');
    setContent(text);
    setInitial(text);
    setError('');
  }
  async function closeEditor() {
    if (!await abandon()) return;
    if (selected) { setContent(initial); setEditing(false); return; }
    setEditing(false);
    setCreating(false);
    setContent('');
    setInitial('');
  }
  async function closeDocument() {
    if (!await abandon()) return;
    setEditing(false);
    setCreating(false);
    setSelected(null);
    setContent('');
    setInitial('');
  }
  async function operate(action: AgentRequest['action'], entry?: AgentEntry) {
    if (!snapshot || busy) return;
    const id = generation.current;
    if ((action === 'delete' || action === 'restore') && !await confirmAction(action === 'delete' ? t('tools.agents.confirmDelete', { name: entry?.name }) : t('tools.agents.confirmRestore', { paths: last?.changedPaths.join('\n') }), () => generation.current === id, { title: action === 'delete' ? t('tools.agents.deleteTitle') : t('tools.agents.restoreTitle'), confirmLabel: action === 'delete' ? t('tools.agents.delete') : t('tools.agents.restore') })) return;
    if (id !== generation.current) return;
    setBusy(true); setError('');
    try {
      const result = await native.operateNativeAgent({ target, action, id: action === 'restore' ? last?.restorePath ?? null : entry?.id ?? selected?.id ?? null, name, content, baseline: snapshot.baseline, transactionId: action === 'restore' ? last?.transactionId ?? null : null });
      if (id !== generation.current) return;
      setSnapshot(result.snapshot);
      setLast(action === 'create' || action === 'restore' ? null : result);
      setEditing(false);
      setCreating(false);
      if (action === 'delete' || action === 'restore') { setSelected(null); return; }
      if (action === 'create') {
        const previous = new Set(snapshot.entries.map(item => item.id));
        const created = result.snapshot.entries.find(item => !previous.has(item.id)) ?? result.snapshot.entries.find(item => item.name === name) ?? null;
        applyEntry(created);
        return;
      }
      const focusId = entry?.id ?? selected?.id ?? null;
      applyEntry(focusId ? result.snapshot.entries.find(item => item.id === focusId) ?? null : null);
    } catch (e) { if (id === generation.current) setError(message(e)); }
    finally { if (id === generation.current) setBusy(false); }
  }
  async function importFile(file: File | undefined) {
    if (!file || !snapshot || !await abandon()) return;
    const id = generation.current;
    if (file.size > 256 * 1024) { setError(t('tools.agents.tooLarge')); return; }
    const extension = snapshot.capability.format === 'toml' ? '.toml' : '.md';
    if (!file.name.endsWith(extension)) { setError(t('tools.agents.wrongFormat', { extension })); return; }
    try {
      const text = await file.text();
      if (id !== generation.current) return;
      setSelected(null);
      setCreating(true);
      setEditing(true);
      setName(file.name.slice(0, -extension.length));
      setContent(text);
      setInitial('');
      setError('');
    } catch (e) { if (id === generation.current) setError(message(e)); }
  }

  const statusText = (entry: AgentEntry) => entry.builtin ? entry.enabled ? t('tools.agents.builtin') : t('tools.agents.override') : entry.enabled ? t('tools.plugins.enabled') : t('tools.plugins.disabled');
  const reasonFor = (entry: AgentEntry) => entry.detail || (entry.readOnly ? t('tools.agents.managedTitle') : '');
  const restoreNode = last ? <div className={styles.restore} role="status">
    <p>{last.detail}</p>
    <details><summary>{t('tools.agents.lastFiles')}</summary>{last.changedPaths.map(path => <p key={path}>{path}</p>)}</details>
    <button type="button" disabled={busy || dirty} onClick={() => void operate('restore')}>{t('tools.agents.restoreLast')}</button>
  </div> : null;
  const notices = (busy && snapshot) || error ? <>
    {busy && snapshot && <p role="status">{t('tools.agents.busy')}</p>}
    {error && <StatusBanner tone="error" onDismiss={() => setError('')}>{error}</StatusBanner>}
  </> : null;
  const account = accountLabel(contextId);

  return <DocumentWorkspace label={t('tools.agents.label')} backLabel={t('common.dialog.back')} onBack={() => { void closeDocument(); }}
    toolbar={<>
      {supported && <span className={styles.filters} data-document-hide>
        <SearchField type="search" className={styles.search} label={t('tools.agents.searchLabel')} placeholder={t('tools.agents.searchPlaceholder')} value={search} onChange={setSearch} />
        <select aria-label={t('tools.agents.filterLabel')} value={filter} onChange={event => setFilter(event.target.value)}>
          <option value="all">{t('tools.agents.filterAll')}</option>
          <option value="enabled">{t('tools.plugins.enabled')}</option>
          <option value="disabled">{t('tools.plugins.disabled')}</option>
          <option value="readonly">{t('tools.agents.filterReadonly')}</option>
        </select>
        <span className={styles.count}>{filtered.length === entries.length ? t('tools.agents.count', { count: entries.length }) : t('tools.agents.countFiltered', { filtered: filtered.length, total: entries.length })}</span>
      </span>}
      <span className={styles.account} title={account}>{account}</span>
      <span className={styles.headActions}>
        <button type="button" disabled={busy} onClick={() => void refresh()}>{t('tools.agents.rescan')}</button>
        <button type="button" disabled={busy || !supported} onClick={() => importInput.current?.click()}>{t('tools.agents.import')}</button>
        <button type="button" className="button primary" disabled={busy || !supported} onClick={() => void createNew()}>{t('tools.agents.create')}</button>
        <input ref={importInput} hidden aria-label={t('tools.agents.importAria')} type="file" accept={snapshot?.capability.format === 'toml' ? '.toml' : '.md'} disabled={busy || !supported} onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} />
      </span>
    </>}
    notices={notices}
    list={!snapshot && busy
      ? <div className={styles.listWrap} role="status" aria-label={t('tools.agents.loading')}><SkeletonRows count={3} /></div>
      : !snapshot
        ? <div className={styles.listWrap} />
        : <div className={styles.listWrap}>
          {!supported && <EmptyState icon="alert" title={t('library.resources.installState.unavailable')} detail={[snapshot.capability.detail, snapshot.detail].filter(Boolean).join(' ')} />}
          {supported && !entries.length && <EmptyState icon="sparkle" title={t('tools.agents.emptyTitle')} detail={t('tools.agents.empty')} action={<button type="button" className="button primary" disabled={busy} onClick={() => void createNew()}>{t('tools.agents.create')}</button>} />}
          {supported && entries.length > 0 && filtered.length === 0 && <div className={styles.noMatch}><p>{t('tools.agents.noMatch')}</p><button type="button" onClick={() => { setSearch(''); setFilter('all'); }}>{t('tools.plugins.clearFilter')}</button></div>}
          {supported && filtered.length > 0 && <ul className={styles.list} aria-label={t('tools.agents.title')}>{filtered.map(entry => <li key={entry.id}>
            <button type="button" className={styles.item} aria-current={opened?.id === entry.id ? 'true' : undefined} disabled={busy} onClick={() => void openEntry(entry)}>
              <span className={styles.itemTitle}><strong>{entry.name}</strong></span>
              <span className={styles.itemSummary}>{entry.description || t('tools.agents.noDescription')}</span>
              <span className={styles.itemMeta}>
                <span className={styles.badge} data-state={entry.enabled ? 'signed_in' : 'signed_out'} title={t('tools.agents.badgeTitle')}>{statusText(entry)}</span>
                {entry.readOnly && <span className={styles.badge}>{t('tools.plugins.readonly')}</span>}
              </span>
            </button>
          </li>)}</ul>}
          {supported && entries.length > 0 && <p className={styles.listNote}>{t('tools.agents.listNote')}</p>}
          <details className={styles.compat}><summary>{t('tools.agents.compatSummary')}</summary><p>{t('tools.plugins.compatVersion', { version: snapshot.capability.version, detail: snapshot.capability.detail })}</p><p>{snapshot.detail}</p></details>
        </div>}
    placeholder={!creating && !opened && (entries.length > 0 || last) ? <div className={styles.placeholder}>
      {entries.length > 0 && <p>{t('tools.agents.description')}</p>}
      {restoreNode}
    </div> : null}
    document={creating ? <article className={styles.detail} aria-label={t('tools.agents.createTitle')}>
      <div className={styles.titleBar}><h3>{t('tools.agents.createTitle')}</h3></div>
      <label className={styles.fileName}>{t('tools.agents.fileName')}<input aria-label={t('tools.agents.fileNameAria')} value={name} onChange={event => setName(event.target.value)} disabled={busy} /></label>
      <p className={styles.hint}>{t('tools.agents.editorNote')}</p>
      <div className={styles.editorArea}><CodeEditor label={t('tools.agents.editorLabel')} format={snapshot?.capability.format ?? 'text'} value={content} onChange={setContent} readOnly={busy} documentId="create" /></div>
      <div className={styles.foot}>
        <button type="button" disabled={busy} onClick={() => void closeEditor()}>{t('tools.agents.closeEditor')}</button>
        <button type="button" className="button primary" disabled={busy || !content.trim() || !name.trim()} onClick={() => void operate('create')}>{t('tools.agents.save')}</button>
      </div>
      {restoreNode}
    </article> : opened ? <article className={styles.detail} aria-label={opened.name}>
      <div className={styles.titleBar}>
        <h3>{opened.name}</h3>
        <div className={styles.titleTools}>
          {opened.readOnly
            ? <span className={styles.readOnlyPill}>{t('tools.agents.viewReadonly')}</span>
            : !editing && <button type="button" disabled={busy} onClick={() => setEditing(true)}>{t('tools.agents.editButton')}</button>}
          {!editing && <>
            <button type="button" disabled={busy || opened.readOnly} title={opened.readOnly ? t('tools.agents.managedTitle') : undefined} onClick={() => void operate(opened.enabled ? 'disable' : 'enable', opened)}>{opened.enabled ? t('tools.plugins.action.disable') : t('tools.plugins.action.enable')}</button>
            <button type="button" className={styles.danger} disabled={busy || opened.readOnly} title={opened.readOnly ? t('tools.agents.managedTitle') : undefined} onClick={() => void operate('delete', opened)}>{t('tools.agents.delete')}</button>
          </>}
        </div>
      </div>
      {reasonFor(opened) && <p className={styles.reason}>{reasonFor(opened)}</p>}
      <details className={styles.meta}><summary>{t('tools.agents.detail')}</summary><p>{opened.description}</p>{opened.path && <p>{opened.path}</p>}{opened.detail && <p>{opened.detail}</p>}<p>{opened.owner}</p><p>{t('tools.agents.editorNote')}</p></details>
      {opened.builtin
        ? <div className={styles.readBody}><p>{opened.description}</p>{opened.detail && <p>{opened.detail}</p>}</div>
        : <div className={styles.editorArea}><CodeEditor label={t('tools.agents.editorLabel')} format={opened.format} value={content} onChange={setContent} readOnly={busy || !editing || opened.readOnly} documentId={opened.id} /></div>}
      {editing && !opened.readOnly && <div className={styles.foot}>
        <button type="button" disabled={busy} onClick={() => void closeEditor()}>{t('tools.agents.closeEditor')}</button>
        <button type="button" className="button primary" disabled={busy || !content.trim()} onClick={() => void operate('save', opened)}>{t('tools.agents.save')}</button>
      </div>}
      {restoreNode}
    </article> : null}
  />;
}
