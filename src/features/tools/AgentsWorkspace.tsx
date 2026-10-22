import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { CodeEditor } from '../../components/CodeEditor';
import type { Scope } from '../../types/native';
import type { AgentEntry, AgentRequest, AgentResult, AgentSnapshot, PluginTarget } from '../../types/resources';
import { useAccountLabels } from '../library/resourceContexts';
import { DocumentFoot, DocumentHeader, DocumentWorkspace, ModeSwitch, PathLine, Toggle, documentStyles as doc, type DocumentMode } from './DocumentWorkspace';
import { DocumentReader, readModel } from './DocumentReader';
import styles from './AgentsWorkspace.module.css';
import { StatusBanner } from '../../components/StatusBanner';
import { SearchField } from '../../components/SearchField';
import { SkeletonRows } from '../../components/Skeleton';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { modLabel, saveShortcutHint, withMod } from '../../lib/shortcut';

function message(error: unknown) { return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error); }

export function AgentsWorkspace({ toolId, scope, projectPath, contextId, onDirtyChange }: { toolId: string; scope: Scope; projectPath: string; contextId: string | null; onDirtyChange: (value: boolean) => void }) {
  const { t } = useTranslation();
  const target = useMemo<PluginTarget>(() => ({ toolId, scope, projectPath: scope === 'project' ? projectPath : null, contextId }), [toolId, scope, projectPath, contextId]);
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [selected, setSelected] = useState<AgentEntry | null>(null);
  const [creating, setCreating] = useState(false);
  const [mode, setMode] = useState<DocumentMode>('read');
  const [infoOpen, setInfoOpen] = useState(false);
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
  const dirty = creating ? !!content : !!selected && !selected.readOnly && content !== initial;
  const entries = snapshot?.entries ?? [];
  const supported = !!snapshot?.capability.supported;
  const filtered = entries.filter(entry => `${entry.name} ${entry.description} ${entry.owner}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) && (filter === 'all' || (filter === 'readonly' ? entry.readOnly : filter === 'enabled' ? entry.enabled : !entry.enabled)));
  const opened = !creating && selected && filtered.some(item => item.id === selected.id) ? selected : null;
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    const id = ++generation.current;
    setBusy(true); setSnapshot(null); setError(''); setMode('read'); setCreating(false); setSelected(null); setLast(null);
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
      setMode('read');
      setCreating(false);
      applyEntry(currentId ? value.entries.find(item => item.id === currentId) ?? null : null);
    } catch (e) { if (id === generation.current) setError(message(e)); }
    finally { if (id === generation.current) setBusy(false); }
  }
  async function openEntry(entry: AgentEntry) {
    if (!creating && selected?.id === entry.id) return;
    if (!await abandon()) return;
    setCreating(false);
    setMode('read');
    setInfoOpen(false);
    setError('');
    applyEntry(entry);
  }
  async function createNew() {
    if (!snapshot?.capability.supported || busy || !await abandon()) return;
    const text = snapshot.capability.template ?? '';
    setSelected(null);
    setCreating(true);
    setMode('edit');
    setName('reviewer');
    setContent(text);
    setInitial(text);
    setError('');
  }
  async function closeEditor() {
    if (!await abandon()) return;
    if (selected) { setContent(initial); setMode('read'); return; }
    setMode('read');
    setCreating(false);
    setContent('');
    setInitial('');
  }
  async function closeDocument() {
    if (!await abandon()) return;
    setMode('read');
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
      setMode('read');
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
      setMode('edit');
      setName(file.name.slice(0, -extension.length));
      setContent(text);
      setInitial('');
      setError('');
    } catch (e) { if (id === generation.current) setError(message(e)); }
  }
  function onKey(event: KeyboardEvent<HTMLElement>) {
    if (!withMod(event) || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    if (event.repeat || busy || !content.trim()) return;
    if (creating && name.trim()) void operate('create');
    else if (opened && !opened.readOnly && dirty) void operate('save', opened);
  }

  const statusText = (entry: AgentEntry) => entry.builtin ? entry.enabled ? t('tools.agents.builtin') : t('tools.agents.override') : entry.enabled ? t('tools.plugins.enabled') : t('tools.plugins.disabled');
  const reasonFor = (entry: AgentEntry) => entry.detail || (entry.readOnly ? t('tools.agents.managedTitle') : '');
  const restoreNode = last ? <div className={styles.restore} role="status">
    <Icon name="info" size={14} />
    <p>{last.detail}</p>
    <details><summary>{t('tools.agents.lastFiles')}</summary>{last.changedPaths.map(path => <p key={path}>{path}</p>)}</details>
    <button type="button" disabled={busy || dirty} onClick={() => void operate('restore')}>{t('tools.agents.restoreLast')}</button>
  </div> : null;
  const notices = (busy && snapshot) || error ? <>
    {busy && snapshot && <p className={styles.busy} role="status">{t('tools.agents.busy')}</p>}
    {error && <StatusBanner tone="error" onDismiss={() => setError('')}>{error}</StatusBanner>}
  </> : null;
  const account = accountLabel(contextId);
  const format = snapshot?.capability.format ?? 'text';
  const readable = opened && !opened.builtin ? !!readModel(content, opened.format) : false;
  const foot = (save: () => void, disabled: boolean) => <DocumentFoot dirty={dirty} note={t('common.document.saveHint', { mod: modLabel })}>
    <button type="button" disabled={busy} onClick={() => void closeEditor()}>{dirty || creating ? t('tools.agents.closeEditor') : t('common.document.done')}</button>
    <button type="button" className="button primary" title={saveShortcutHint()} disabled={disabled} onClick={save}>{t('tools.agents.save')}</button>
  </DocumentFoot>;

  return <DocumentWorkspace label={t('tools.agents.label')} toolbarLabel={t('tools.agents.toolbar')} backLabel={t('common.dialog.back')} onBack={() => { void closeDocument(); }} onKeyDown={onKey}
    heading={t('tools.workspace.view.agents')}
    count={supported ? filtered.length === entries.length ? t('tools.agents.count', { count: entries.length }) : t('tools.agents.countFiltered', { filtered: filtered.length, total: entries.length }) : undefined}
    actions={<>
      <button type="button" className={doc.iconButton} aria-label={t('tools.agents.rescan')} title={t('tools.agents.rescan')} disabled={busy} data-spinning={(busy && !!snapshot) || undefined} onClick={() => void refresh()}><Icon name="refresh" size={15} /></button>
      <button type="button" className={doc.iconButton} aria-label={t('tools.agents.import')} title={t('tools.agents.import')} disabled={busy || !supported} onClick={() => importInput.current?.click()}><Icon name="upload" size={15} /></button>
      <button type="button" className={doc.accentButton} aria-label={t('tools.agents.create')} title={t('tools.agents.create')} disabled={busy || !supported} onClick={() => void createNew()}><Icon name="plus" size={16} /></button>
      <input ref={importInput} hidden aria-label={t('tools.agents.importAria')} type="file" accept={format === 'toml' ? '.toml' : '.md'} disabled={busy || !supported} onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} />
    </>}
    search={supported ? <SearchField type="search" label={t('tools.agents.searchLabel')} placeholder={t('tools.agents.searchPlaceholder')} value={search} onChange={setSearch} /> : undefined}
    filters={supported ? <select className={styles.filter} aria-label={t('tools.agents.filterLabel')} value={filter} onChange={event => setFilter(event.target.value)}>
      <option value="all">{t('tools.agents.filterAll')}</option>
      <option value="enabled">{t('tools.plugins.enabled')}</option>
      <option value="disabled">{t('tools.plugins.disabled')}</option>
      <option value="readonly">{t('tools.agents.filterReadonly')}</option>
    </select> : undefined}
    listFooterLabel={t('tools.agents.compatSummary')}
    listFooter={<>
      {account && <span className={styles.account} title={account}><Icon name="user" size={12} />{account}</span>}
      {snapshot && <details className={styles.compat}><summary>{t('tools.agents.compatSummary')}</summary><p>{t('tools.plugins.compatVersion', { version: snapshot.capability.version, detail: snapshot.capability.detail })}</p><p>{snapshot.detail}</p>{supported && entries.length > 0 && <p>{t('tools.agents.listNote')}</p>}</details>}
    </>}
    notices={notices}
    list={!snapshot && busy
      ? <div className={styles.listWrap} role="status" aria-label={t('tools.agents.loading')}><SkeletonRows count={3} /></div>
      : !snapshot
        ? <div className={styles.listWrap} />
        : <div className={styles.listWrap}>
          {!supported && <EmptyState icon="alert" title={t('library.resources.installState.unavailable')} detail={[snapshot.capability.detail, snapshot.detail].filter(Boolean).join(' ')} />}
          {supported && !entries.length && <EmptyState icon="sparkle" title={t('tools.agents.emptyTitle')} detail={t('tools.agents.empty')} action={<button type="button" className="button primary" disabled={busy} onClick={() => void createNew()}>{t('tools.agents.create')}</button>} />}
          {supported && entries.length > 0 && filtered.length === 0 && <div className={doc.noMatch}><Icon name="search" size={18} /><p>{t('tools.agents.noMatch')}</p><button type="button" onClick={() => { setSearch(''); setFilter('all'); }}>{t('tools.plugins.clearFilter')}</button></div>}
          {supported && filtered.length > 0 && <ul className={doc.rows} aria-label={t('tools.agents.title')}>{filtered.map(entry => <li key={entry.id}>
            <button type="button" className={doc.row} aria-current={opened?.id === entry.id ? 'true' : undefined} data-disabled={!entry.enabled || undefined} disabled={busy} onClick={() => void openEntry(entry)}>
              <span className={doc.rowTitle}><strong>{entry.name}</strong></span>
              <span className={doc.rowSummary}>{entry.description || t('tools.agents.noDescription')}</span>
              <span className={doc.rowMeta}>
                <span className={doc.chip} data-tone={entry.enabled ? 'on' : 'muted'} title={t('tools.agents.badgeTitle')}>{statusText(entry)}</span>
                {entry.readOnly && <span className={doc.chip}><Icon name="lock" size={10} />{t('tools.plugins.readonly')}</span>}
              </span>
            </button>
          </li>)}</ul>}
          {!creating && !opened && restoreNode}
        </div>}
    placeholder={!creating && !opened && entries.length > 0 ? <div className={doc.placeholder}>
      <span className={doc.placeholderIcon} aria-hidden="true"><Icon name="sparkle" size={22} /></span>
      <strong>{t('tools.agents.selectHint')}</strong>
      <p>{t('tools.agents.description')}</p>
    </div> : null}
    document={creating ? <article className={doc.doc} aria-label={t('tools.agents.createTitle')}>
      <DocumentHeader title={t('tools.agents.createTitle')} meta={t('tools.agents.editorNote')} />
      <div className={doc.form}>
        <label className={doc.field}>{t('tools.agents.fileName')}<input aria-label={t('tools.agents.fileNameAria')} value={name} spellCheck={false} onChange={event => setName(event.target.value)} disabled={busy} /></label>
      </div>
      <div className={doc.editor}><CodeEditor label={t('tools.agents.editorLabel')} format={format} value={content} onChange={setContent} readOnly={busy} documentId="create" /></div>
      {restoreNode}
      {foot(() => void operate('create'), busy || !content.trim() || !name.trim())}
    </article> : opened ? <article className={doc.doc} aria-label={opened.name}>
      <DocumentHeader
        title={opened.name}
        badges={<>
          <span className={doc.chip} data-tone={opened.enabled ? 'on' : 'muted'} title={t('tools.agents.badgeTitle')}>{statusText(opened)}</span>
          {opened.readOnly && <span className={doc.chip}><Icon name="lock" size={11} />{t('tools.plugins.readonly')}</span>}
        </>}
        tools={<>
          {!opened.builtin && <ModeSwitch mode={mode} editable={!opened.readOnly} disabled={busy} onChange={setMode} />}
          <Toggle checked={opened.enabled} label={t('tools.agents.enableAria')} text={opened.enabled ? t('tools.plugins.enabled') : t('tools.plugins.disabled')} disabled={busy || opened.readOnly || dirty} onChange={value => void operate(value ? 'enable' : 'disable', opened)} />
          <button type="button" className={doc.iconButton} aria-expanded={infoOpen} aria-label={t('tools.agents.detail')} title={t('tools.agents.detail')} onClick={() => setInfoOpen(value => !value)}><Icon name="info" size={15} /></button>
          <button type="button" className={doc.iconButton} data-tone="danger" aria-label={t('tools.agents.delete')} title={opened.readOnly ? t('tools.agents.managedTitle') : t('tools.agents.delete')} disabled={busy || opened.readOnly} onClick={() => void operate('delete', opened)}><Icon name="trash" size={15} /></button>
        </>}
        meta={opened.owner ? <span>{opened.owner}</span> : undefined}
      />
      {reasonFor(opened) && <p className={doc.strip} data-tone={opened.readOnly ? 'warn' : undefined}><Icon name={opened.readOnly ? 'lock' : 'info'} size={14} /><span>{reasonFor(opened)}</span></p>}
      {infoOpen && <div className={doc.info}>
        {opened.description && <p>{opened.description}</p>}
        {opened.path && <PathLine path={opened.path} label={t('common.document.path')} />}
        {opened.detail && <p>{opened.detail}</p>}
        <p>{t('tools.agents.editorNote')}</p>
      </div>}
      {opened.builtin
        ? <div className={doc.body}><div className={doc.readColumn}><p className={doc.lead}>{opened.description}</p>{opened.detail && <p className={doc.lead}>{opened.detail}</p>}</div></div>
        : mode === 'read' && readable
          ? <DocumentReader text={content} format={opened.format} label={t('tools.agents.previewRegion')} onEditRequest={opened.readOnly || busy ? undefined : () => setMode('edit')} />
          : <div className={doc.editor} data-readonly={opened.readOnly || mode === 'read' || undefined}><CodeEditor label={t('tools.agents.editorLabel')} format={opened.format} value={content} onChange={setContent} readOnly={busy || mode === 'read' || opened.readOnly} documentId={opened.id} /></div>}
      {restoreNode}
      {!opened.readOnly && !opened.builtin && (mode === 'edit' || dirty) && foot(() => void operate('save', opened), busy || !content.trim() || !dirty)}
    </article> : null}
  />;
}
