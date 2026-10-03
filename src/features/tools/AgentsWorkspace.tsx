import { useEffect, useMemo, useRef, useState } from 'react';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import { CodeEditor } from '../../components/CodeEditor';
import type { Scope } from '../../types/native';
import type { AgentEntry, AgentRequest, AgentResult, AgentSnapshot, PluginTarget } from '../../types/resources';
import { useAccountLabels } from '../library/resourceContexts';
import styles from './ManagementPanel.module.css';
import editorStyles from './AgentsWorkspace.module.css';

function message(error: unknown) { return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error); }
export function AgentsWorkspace({ toolId, scope, projectPath, contextId, onDirtyChange }: { toolId: string; scope: Scope; projectPath: string; contextId: string | null; onDirtyChange: (value: boolean) => void }) {
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
  async function abandon() { const id = generation.current; return !dirty || await confirmAction('放弃尚未保存的 agent 定义？', () => generation.current === id, { title: '未保存的定义', confirmLabel: '放弃修改' }); }
  async function refresh() { if (!await abandon()) return; const id = ++generation.current; setBusy(true); setError('');
    try { const value = await native.scanNativeAgents(target); if (id === generation.current) { setSnapshot(value); setEditing(false); } }
    catch (e) { if (id === generation.current) setError(message(e)); }
    finally { if (id === generation.current) setBusy(false); }
  }
  async function edit(entry: AgentEntry | null) { if (!await abandon()) return; setSelected(entry); setName(entry?.name ?? 'reviewer'); const text = entry?.content ?? snapshot?.capability.template ?? ''; setContent(text); setInitial(text); setEditing(true); setError(''); }
  async function operate(action: AgentRequest['action'], entry?: AgentEntry) {
    if (!snapshot || busy) return; const id = generation.current;
    if ((action === 'delete' || action === 'restore') && !await confirmAction(action === 'delete' ? `删除 ${entry?.name} 的这份原生定义？其他作用域同名定义可能重新生效。` : `恢复整个操作，涉及以下文件：\n${last?.changedPaths.join('\n')}\n任一文件被外部修改都会阻止恢复。`, () => generation.current === id, { title: action === 'delete' ? '删除原生定义' : '恢复原生定义操作', confirmLabel: action === 'delete' ? '删除' : '恢复' })) return;
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
    if (file.size > 256 * 1024) { setError('定义超过 256 KiB'); return; }
    const extension = snapshot.capability.format === 'toml' ? '.toml' : '.md';
    if (!file.name.endsWith(extension)) { setError(`此 CLI 导入 ${extension} 原生定义，不转换其他格式`); return; }
    try { const text = await file.text(); if (id !== generation.current) return; setSelected(null); setName(file.name.slice(0, -extension.length)); setContent(text); setInitial(''); setEditing(true); setError(''); }
    catch (e) { if (id === generation.current) setError(message(e)); }
  }
  return <section className={styles.panel} aria-label="原生 Agent 定义管理">
    <div className={styles.header}><div><h2>Agent 定义</h2><p>管理提示词、模型与工具权限，下次委派时生效。</p></div><div className={styles.actions}><button disabled={busy} onClick={() => void refresh()}>重新扫描</button><button disabled={busy || !snapshot?.capability.supported} onClick={() => importInput.current?.click()}>导入定义</button><button className={styles.primary} disabled={busy || !snapshot?.capability.supported} onClick={() => void edit(null)}>创建定义</button>
      <input ref={importInput} hidden aria-label="导入原生 agent 文件" type="file" accept={snapshot?.capability.format === 'toml' ? '.toml' : '.md'} disabled={busy || !snapshot?.capability.supported} onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }} /></div></div>
    <div className={styles.context}><span>{scope === 'global' ? '全局' : projectPath}</span><span>{accountLabel(contextId)}</span></div>
    {busy && <p role="status">正在处理原生定义…</p>}{error && <p role="alert">{error}</p>}
    {last && <div role="status"><p>{last.detail}</p><details><summary>此次操作涉及的文件</summary>{last.changedPaths.map(path => <p key={path}>{path}</p>)}</details><button disabled={busy || dirty} onClick={() => void operate('restore')}>恢复上次操作</button></div>}
    {editing ? <div className={editorStyles.editor}>
      <h3>{selected?.readOnly ? '查看定义（只读）' : selected ? '编辑定义' : '新建 / 导入定义'}</h3>
      {!selected && <label>文件名<input aria-label="Agent 文件名" value={name} onChange={e => setName(e.target.value)} disabled={busy} /></label>}
      <p>说明、提示词、模型与工具权限直接编辑原生字段；完整保留其余字段和注释。{selected?.owner}</p>
      <CodeEditor label="原生 Agent 定义" format={selected?.format ?? snapshot?.capability.format ?? 'text'} value={content} onChange={setContent} readOnly={busy || selected?.readOnly} />
      <div className={styles.actions}><button disabled={busy} onClick={async () => { if (await abandon()) setEditing(false); }}>关闭编辑</button>{!selected?.readOnly && <button className={styles.primary} disabled={busy || !content.trim() || (!selected && !name.trim())} onClick={() => void operate(selected ? 'save' : 'create')}>保存定义</button>}</div>
    </div> : <><div className={styles.listToolbar}><input type="search" aria-label="搜索 Agent 定义" placeholder="搜索名称、说明或所属插件" value={search} onChange={event => setSearch(event.target.value)} /><select aria-label="Agent 状态筛选" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已禁用</option><option value="readonly">只读定义</option></select><span>{filtered.length === entries.length ? `${entries.length} 个定义` : `${filtered.length} / ${entries.length} 个定义`}</span></div><ul className={styles.resourceList}>{filtered.map(entry => <li key={entry.id}>
      <div className={styles.resourceBody}><div className={styles.resourceTitle}><strong>{entry.name}</strong><span className={styles.badge} data-state={entry.enabled ? 'signed_in' : 'signed_out'} title="此处显示定义启停状态；当前会话加载情况未验证">{entry.enabled ? '已启用' : '已禁用'}</span>{entry.readOnly && <span className={styles.badge}>只读</span>}</div><p className={styles.description}>{entry.description || '暂无说明，可编辑原生定义补充。'}</p><div className={styles.resourceMeta}><span>{entry.owner}</span></div></div>
      <div className={styles.actions}><button disabled={busy} onClick={() => void edit(entry)}>{entry.readOnly ? '查看' : '编辑'}</button><button disabled={busy || entry.readOnly} title={entry.readOnly ? '请通过所属插件或组织策略管理' : undefined} onClick={() => void operate(entry.enabled ? 'disable' : 'enable', entry)}>{entry.enabled ? '禁用' : '启用'}</button><button className={styles.danger} disabled={busy || entry.readOnly} title={entry.readOnly ? '请通过所属插件或组织策略管理' : undefined} onClick={() => void operate('delete', entry)}>删除</button></div>
      <details><summary>定义详情</summary><p>{entry.description}</p><p>{entry.path}</p>{entry.detail && <p>{entry.detail}</p>}</details>
    </li>)}</ul>{entries.length > 0 && filtered.length === 0 && <p className={styles.empty}>没有匹配的定义。<button onClick={() => { setSearch(''); setFilter('all'); }}>清除筛选</button></p>}{entries.length > 0 && <p className={styles.listNote}>启停状态来自原生定义。已运行会话的加载情况未验证；插件所属定义请通过插件管理。</p>}</>}
    {snapshot?.capability.supported && !snapshot.entries.length && !editing && <p className={styles.empty}>当前作用域还没有 Agent 定义。创建一个，或导入已有的原生文件。</p>}
    {snapshot && <details className={styles.compatibility}><summary>原生格式与加载说明</summary><p>参考核验版本 {snapshot.capability.version} · {snapshot.capability.detail}</p><p>{snapshot.detail}</p></details>}
  </section>;
}
