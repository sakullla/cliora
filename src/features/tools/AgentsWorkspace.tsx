import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { CodeEditor } from '../../components/CodeEditor';
import type { Scope } from '../../types/native';
import type { AgentEntry, AgentRequest, AgentResult, AgentSnapshot, PluginTarget } from '../../types/resources';
import { useAccountLabels } from '../library/resourceContexts';
import styles from './ManagementPanel.module.css';
import editorStyles from './AgentsWorkspace.module.css';
import { StatusBanner } from '../../components/StatusBanner';
import { SearchField } from '../../components/SearchField';

function message(error: unknown) { return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error); }
export function AgentsWorkspace({ toolId, scope, projectPath, contextId, onDirtyChange }: { toolId: string; scope: Scope; projectPath: string; contextId: string | null; onDirtyChange: (value: boolean) => void }) {
  const { t } = useTranslation();
  const target = useMemo<PluginTarget>(() => ({ toolId, scope, projectPath: scope === 'project' ? projectPath : null, contextId }), [toolId, scope, projectPath, contextId]);
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [selected, setSelected] = useState<AgentEntry | null>(null);
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
  const filtered = entries.filter(entry => `${entry.name} ${entry.description} ${entry.owner}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) && (filter === 'all' || (filter === 'readonly' ? entry.readOnly : filter === 'enabled' ? entry.enabled : !entry.enabled)));
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { const id = ++generation.current; setBusy(true); setSnapshot(null); setError(''); setEditing(false); setLast(null);
    void native.scanNativeAgents(target).then(value => { if (generation.current === id) setSnapshot(value); }).catch(value => { if (generation.current === id) setError(message(value)); }).finally(() => { if (generation.current === id) setBusy(false); });
    return () => { generation.current++; };
  }, [target]);
  async function abandon() { const id = generation.current; return !dirty || await confirmAction(t('tools.agents.confirmAbandon'), () => generation.current === id, { title: t('tools.agents.abandonTitle'), confirmLabel: t('tools.agents.abandonConfirm') }); }
  async function refresh() { if (!await abandon()) return; const id = ++generation.current; setBusy(true); setError('');
    try { const value = await native.scanNativeAgents(target); if (id === generation.current) { setSnapshot(value); setEditing(false); } }
    catch (e) { if (id === generation.current) setError(message(e)); }
    finally { if (id === generation.current) setBusy(false); }
  }
  async function edit(entry: AgentEntry | null) { if (!await abandon()) return; setSelected(entry); setName(entry?.name ?? 'reviewer'); const text = entry?.content ?? snapshot?.capability.template ?? ''; setContent(text); setInitial(text); setEditing(true); setError(''); }
  async function operate(action: AgentRequest['action'], entry?: AgentEntry) {
    if (!snapshot || busy) return; const id = generation.current;
    if ((action === 'delete' || action === 'restore') && !await confirmAction(action === 'delete' ? t('tools.agents.confirmDelete', { name: entry?.name }) : t('tools.agents.confirmRestore', { paths: last?.changedPaths.join('\n') }), () => generation.current === id, { title: action === 'delete' ? t('tools.agents.deleteTitle') : t('tools.agents.restoreTitle'), confirmLabel: action === 'delete' ? t('tools.agents.delete') : t('tools.agents.restore') })) return;
    if (id !== generation.current) return;
    setBusy(true); setError('');
    try {
      const result = await native.operateNativeAgent({ target, action, id: action === 'restore' ? last?.restorePath ?? null : entry?.id ?? selected?.id ?? null, name, content, baseline: snapshot.baseline, transactionId: action === 'restore' ? last?.transactionId ?? null : null });
      if (id !== generation.current) return;
      setSnapshot(result.snapshot); setLast(action === 'create' || action === 'restore' ? null : result); setEditing(false);
    } catch (e) { if (id === generation.current) setError(message(e)); }
    finally { if (id === generation.current) setBusy(false); }
  }
  async function importFile(file: File | undefined) {
    if (!file || !snapshot || !await abandon()) return;
    const id = generation.current;
    if (file.size > 256 * 1024) { setError(t('tools.agents.tooLarge')); return; }
    const extension = snapshot.capability.format === 'toml' ? '.toml' : '.md';
    if (!file.name.endsWith(extension)) { setError(t('tools.agents.wrongFormat', { extension })); return; }
    try { const text = await file.text(); if (id !== generation.current) return; setSelected(null); setName(file.name.slice(0, -extension.length)); setContent(text); setInitial(''); setEditing(true); setError(''); }
    catch (e) { if (id === generation.current) setError(message(e)); }
  }
  return <section className={styles.panel} aria-label={t('tools.agents.label')}>
    <div className={styles.header}><div><h2>{t('tools.agents.title')}</h2><p>{t('tools.agents.description')}</p></div><div className={styles.actions}><button disabled={busy} onClick={() => void refresh()}>{t('tools.agents.rescan')}</button><button disabled={busy || !snapshot?.capability.supported} onClick={() => importInput.current?.click()}>{t('tools.agents.import')}</button><button className={styles.primary} disabled={busy || !snapshot?.capability.supported} onClick={() => void edit(null)}>{t('tools.agents.create')}</button>
      <input ref={importInput} hidden aria-label={t('tools.agents.importAria')} type="file" accept={snapshot?.capability.format === 'toml' ? '.toml' : '.md'} disabled={busy || !snapshot?.capability.supported} onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} /></div></div>
    <div className={styles.context}><span>{scope === 'global' ? t('tools.apply.global') : projectPath}</span><span>{accountLabel(contextId)}</span></div>
    {busy && <p role="status">{t('tools.agents.busy')}</p>}{error && <StatusBanner tone="error" onDismiss={() => setError('')}>{error}</StatusBanner>}
    {last && <div role="status"><p>{last.detail}</p><details><summary>{t('tools.agents.lastFiles')}</summary>{last.changedPaths.map(path => <p key={path}>{path}</p>)}</details><button disabled={busy || dirty} onClick={() => void operate('restore')}>{t('tools.agents.restoreLast')}</button></div>}
    {editing ? <div className={editorStyles.editor}>
      <h3>{selected?.readOnly ? t('tools.agents.viewReadonly') : selected ? t('tools.agents.edit') : t('tools.agents.createTitle')}</h3>
      {!selected && <label>{t('tools.agents.fileName')}<input aria-label={t('tools.agents.fileNameAria')} value={name} onChange={e => setName(e.target.value)} disabled={busy} /></label>}
      <p>{t('tools.agents.editorNote')}{selected?.owner}</p>
      {selected?.builtin ? <><p>{selected.description}</p><p>{selected.detail}</p></> : <CodeEditor label={t('tools.agents.editorLabel')} format={selected?.format ?? snapshot?.capability.format ?? 'text'} value={content} onChange={setContent} readOnly={busy || selected?.readOnly} />}
      <div className={styles.actions}><button disabled={busy} onClick={async () => { if (await abandon()) setEditing(false); }}>{t('tools.agents.closeEditor')}</button>{!selected?.readOnly && <button className={styles.primary} disabled={busy || !content.trim() || (!selected && !name.trim())} onClick={() => void operate(selected ? 'save' : 'create')}>{t('tools.agents.save')}</button>}</div>
    </div> : <><div className={styles.listToolbar}><SearchField type="search" label={t('tools.agents.searchLabel')} placeholder={t('tools.agents.searchPlaceholder')} value={search} onChange={setSearch} /><select aria-label={t('tools.agents.filterLabel')} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">{t('tools.agents.filterAll')}</option><option value="enabled">{t('tools.plugins.enabled')}</option><option value="disabled">{t('tools.plugins.disabled')}</option><option value="readonly">{t('tools.agents.filterReadonly')}</option></select><span>{filtered.length === entries.length ? t('tools.agents.count', { count: entries.length }) : t('tools.agents.countFiltered', { filtered: filtered.length, total: entries.length })}</span></div>{filtered.length > 0 && <ul className={styles.resourceList}>{filtered.map(entry => <li key={entry.id}>
      <div className={styles.resourceBody}><div className={styles.resourceTitle}><strong>{entry.name}</strong><span className={styles.badge} data-state={entry.enabled ? 'signed_in' : 'signed_out'} title={t('tools.agents.badgeTitle')}>{entry.builtin ? entry.enabled ? t('tools.agents.builtin') : t('tools.agents.override') : entry.enabled ? t('tools.plugins.enabled') : t('tools.plugins.disabled')}</span>{entry.readOnly && <span className={styles.badge}>{t('tools.plugins.readonly')}</span>}</div><p className={styles.description}>{entry.description || t('tools.agents.noDescription')}</p><div className={styles.resourceMeta}><span>{entry.owner}</span></div></div>
      <div className={styles.actions}><button disabled={busy} onClick={() => void edit(entry)}>{entry.readOnly ? t('tools.agents.view') : t('tools.agents.editButton')}</button><button disabled={busy || entry.readOnly} title={entry.readOnly ? t('tools.agents.managedTitle') : undefined} onClick={() => void operate(entry.enabled ? 'disable' : 'enable', entry)}>{entry.enabled ? t('tools.plugins.action.disable') : t('tools.plugins.action.enable')}</button><button className={styles.danger} disabled={busy || entry.readOnly} title={entry.readOnly ? t('tools.agents.managedTitle') : undefined} onClick={() => void operate('delete', entry)}>{t('tools.agents.delete')}</button></div>
      <details><summary>{t('tools.agents.detail')}</summary><p>{entry.description}</p>{entry.path && <p>{entry.path}</p>}{entry.detail && <p>{entry.detail}</p>}</details>
    </li>)}</ul>}{entries.length > 0 && filtered.length === 0 && <p className={styles.empty}>{t('tools.agents.noMatch')}<button onClick={() => { setSearch(''); setFilter('all'); }}>{t('tools.plugins.clearFilter')}</button></p>}{entries.length > 0 && <p className={styles.listNote}>{t('tools.agents.listNote')}</p>}</>}
    {snapshot?.capability.supported && !snapshot.entries.length && !editing && <p className={styles.empty}>{t('tools.agents.empty')}</p>}
    {snapshot && <details className={styles.compatibility}><summary>{t('tools.agents.compatSummary')}</summary><p>{t('tools.plugins.compatVersion', { version: snapshot.capability.version, detail: snapshot.capability.detail })}</p><p>{snapshot.detail}</p></details>}
  </section>;
}
