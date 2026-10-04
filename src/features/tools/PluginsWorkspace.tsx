import { uiAdapterFor } from '../../adapters';
import { useEffect, useMemo, useRef, useState } from 'react';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import type { Scope } from '../../types/native';
import type { PluginAction, PluginEntry, PluginSnapshot, PluginTarget } from '../../types/resources';
import styles from './ManagementPanel.module.css';
import { useAccountLabels } from '../library/resourceContexts';

const labels: Record<PluginAction, string> = { install: '安装', update: '更新', enable: '启用', disable: '禁用', uninstall: '卸载' };
const states: Record<string, string> = { installed_load_unknown: '原生已安装 · 加载未验证', configured_load_unknown: '已配置 · 安装与加载未验证', discovered_load_unknown: '已发现 · 加载未验证', disabled: '已禁用', state_unknown: '声明已被外部修改 · 状态待核对', inventory_pending: '正在核对插件状态' };
function message(error: unknown) { return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error); }
function policyLabel(value: string) { return value.replaceAll('NOT_AVAILABLE', '安装策略：不可安装').replaceAll('AVAILABLE', '安装策略：允许安装').replaceAll('REQUIRED', '安装策略：组织要求').replaceAll('FORBIDDEN', '安装策略：禁止安装').replaceAll('ON_INSTALL', '安装时认证').replaceAll('NONE', '无需额外认证'); }
const scopeLabels: Record<string, string> = { user: '全局', project: '项目', local: '项目本地', managed: '组织管理', auto: '自动发现' };
const remembered = new Map<string, { snapshot: PluginSnapshot; at: number }>();
const pending = new Map<string, Promise<PluginSnapshot>>();
function scanOnce(target: PluginTarget) {
  const key = JSON.stringify(target);
  const existing = pending.get(key);
  if (existing) return existing;
  const request = native.scanNativePlugins(target).finally(() => { if (pending.get(key) === request) pending.delete(key); });
  pending.set(key, request);
  return request;
}
function remember(key: string, snapshot: PluginSnapshot) {
  remembered.delete(key);
  remembered.set(key, { snapshot, at: Date.now() });
  if (remembered.size > 24) remembered.delete(remembered.keys().next().value!);
}

export function PluginsWorkspace({ toolId, scope, projectPath, contextId }: { toolId: string; scope: Scope; projectPath: string; contextId: string | null }) {
  const target = useMemo<PluginTarget>(() => ({ toolId, scope, projectPath: scope === 'project' ? projectPath : null, contextId }), [toolId, scope, projectPath, contextId]);
  const cacheKey = JSON.stringify(target);
  const [snapshot, setSnapshot] = useState<PluginSnapshot | null>(null);
  const [source, setSource] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const generation = useRef(0);
  const accountLabel = useAccountLabels();
  const entries = snapshot?.entries ?? [];
  const filtered = entries.filter(entry => `${entry.name} ${entry.source}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) && (filter === 'all' || (filter === 'readonly' ? entry.readOnly : filter === 'enabled' ? entry.enabled === true : entry.enabled === false)));
  useEffect(() => { const id = ++generation.current; setSnapshot(null); setError(''); setNotice(''); setBusy(true);
    const cached = remembered.get(cacheKey);
    if (cached && Date.now() - cached.at < 30_000) { setSnapshot(cached.snapshot); setBusy(false); return () => { generation.current++; }; }
    let completed = false;
    void native.previewNativePlugins(target).then(value => { if (value && !completed && id === generation.current) setSnapshot(value); }).catch(() => { /* The authoritative scan reports errors; preview is optional. */ });
    void scanOnce(target).then(value => { if (id === generation.current) { remember(cacheKey, value); setSnapshot(value); } }).catch(value => { if (id === generation.current) { remembered.delete(cacheKey); setError(message(value)); } }).finally(() => { completed = true; if (id === generation.current) setBusy(false); });
    return () => { generation.current++; };
  }, [target]);
  async function refresh() { const id = ++generation.current; setBusy(true); setError('');
    try { const value = await native.scanNativePlugins(target); if (id === generation.current) { remember(cacheKey, value); setSnapshot(value); } }
    catch (value) { if (id === generation.current) { remembered.delete(cacheKey); setError(message(value)); setSnapshot(null); } }
    finally { if (id === generation.current) setBusy(false); }
  }
  async function operate(action: PluginAction, entry?: PluginEntry) {
    if (!snapshot?.baseline || busy) return;
    const id = generation.current;
    if (action === 'uninstall' && !await confirmAction(`卸载 ${entry?.name} 及其包内资源？原生命令的下载和文件副作用不能保证自动回滚。`, () => id === generation.current, { title: '卸载原生插件', confirmLabel: '卸载' })) return;
    if (id !== generation.current) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await native.operateNativePlugin({ target, action, source: entry?.id ?? source.trim(), baseline: snapshot.baseline, trusted });
      if (id !== generation.current) return;
      remembered.delete(cacheKey);
      if (result.snapshot) remember(cacheKey, result.snapshot);
      setSnapshot(result.snapshot); setNotice(result.detail);
      if (result.status === 'failed_possible_side_effects') setError('操作失败，可能留下部分变更；请核对重新扫描的实际状态。');
      else if (action === 'install') { setSource(''); setTrusted(false); }
    } catch (value) { if (id === generation.current) setError(message(value)); }
    finally { if (id === generation.current) setBusy(false); }
  }
  return <section className={styles.panel} aria-label="原生插件管理">
    <div className={styles.header}><div><h2>插件</h2><p>安装和管理 CLI 扩展；插件内的 Agent、Skill 随插件一起管理。</p></div><div className={styles.actions}><button disabled={busy} onClick={() => void refresh()}>重新扫描</button></div></div>
    <div className={styles.context}><span>{scope === 'global' ? '全局' : projectPath}</span><span>{accountLabel(contextId)}</span></div>
    {busy && <p role="status">{snapshot ? snapshot.baseline ? '正在处理原生插件…' : '正在核对插件状态…' : '正在读取插件列表…'}</p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {snapshot && <>
      {snapshot.capability.actions.some(action => action === 'install' || action === 'update') && <div className={styles.installBox}><div className={styles.create}><label>插件来源<input aria-label="插件来源" value={source} onChange={event => { setSource(event.target.value); setTrusted(false); }} placeholder={snapshot.capability.sources} disabled={busy} /></label>
        <button className={styles.primary} disabled={busy || !source.trim() || !trusted || !snapshot.capability.actions.includes('install')} onClick={() => void operate('install')}>{uiAdapterFor(toolId).plugins?.installLabel ?? '安装插件'}</button></div>
      <label className={styles.trust}><input type="checkbox" checked={trusted} onChange={event => setTrusted(event.target.checked)} disabled={busy} /> 我信任所选来源，允许安装或更新插件代码{uiAdapterFor(toolId).plugins?.projectTrust && scope === 'project' ? '并授予此次原生项目操作信任' : ''}</label>
      <p>来源格式：{snapshot.capability.sources}。更改来源后需重新确认信任。</p></div>}
      <div className={styles.listToolbar}><input type="search" aria-label="搜索插件" placeholder="搜索插件名称或来源" value={search} onChange={event => setSearch(event.target.value)} /><select aria-label="插件状态筛选" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已禁用</option><option value="readonly">只读插件</option></select><span>{snapshot.baseline ? '' : '已发现 '}{filtered.length === entries.length ? `${entries.length} 个插件` : `${filtered.length} / ${entries.length} 个插件`}</span></div>
      {!snapshot.entries.length && !!snapshot.baseline && <p className={styles.empty}>{snapshot.capability.actions.includes('install') ? '此作用域还没有插件。填写来源并确认信任后即可安装。' : '此作用域没有发现用户插件。'}{!snapshot.capability.actions.includes('install') && <span>{snapshot.capability.detail}</span>}</p>}
      <ul className={styles.resourceList}>{filtered.map(entry => <li key={`${entry.scope}:${entry.id}`}>
        <div className={styles.resourceBody}><div className={styles.resourceTitle}><strong>{entry.name}</strong><span className={styles.badge} data-state={entry.enabled ? 'signed_in' : 'signed_out'}>{entry.enabled === null ? '状态未知' : entry.enabled ? '已启用' : '已禁用'}</span>{entry.readOnly && <span className={styles.badge}>{snapshot.baseline ? '只读' : '待核对'}</span>}<span className={styles.resourceMeta}>{entry.version ?? '版本未提供'}</span></div><p>{entry.source} · {scopeLabels[entry.scope] ?? entry.scope}</p><p>{states[entry.state] ?? entry.state}</p></div>
        <div className={styles.actions}>{(['update', entry.enabled === false ? 'enable' : 'disable', 'uninstall'] as PluginAction[]).filter(action => snapshot.capability.actions.includes(action)).map(action => <button key={action} className={action === 'uninstall' ? styles.danger : undefined} title={entry.readOnly ? policyLabel(entry.policy) : action === 'update' && !trusted ? '请先确认上方来源信任，再更新插件' : undefined} disabled={busy || entry.readOnly || (action === 'update' && (!trusted || (uiAdapterFor(toolId).plugins?.projectUpdate === false && scope === 'project')))} onClick={() => void operate(action, entry)}>{labels[action]}</button>)}</div>
        <details><summary>安装策略与说明</summary><p>{policyLabel(entry.policy)}{entry.readOnly ? ' · 只读' : ''}</p></details>
        {entry.root && <details><summary>安装位置</summary><p>{entry.root}</p></details>}
        {!!entry.resources.length && <details><summary>包内资源（随插件管理）</summary><ul>{entry.resources.map(resource => <li key={resource.path}>{resource.kind} · {resource.path}</li>)}</ul></details>}
      </li>)}</ul>
      {entries.length > 0 && filtered.length === 0 && <p className={styles.empty}>没有匹配的插件。<button onClick={() => { setSearch(''); setFilter('all'); }}>清除筛选</button></p>}
      <details className={styles.compatibility}><summary>兼容性与加载说明</summary><p>参考核验版本 {snapshot.capability.version} · {snapshot.capability.detail}</p><p>{snapshot.detail}</p></details>
    </>}
  </section>;
}
