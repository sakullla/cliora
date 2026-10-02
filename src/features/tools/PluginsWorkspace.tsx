import { useEffect, useMemo, useRef, useState } from 'react';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import type { Scope } from '../../types/native';
import type { PluginAction, PluginEntry, PluginSnapshot, PluginTarget } from '../../types/resources';
import styles from './AccountsPanel.module.css';
import { useAccountLabels } from '../library/resourceContexts';

const labels: Record<PluginAction, string> = { install: '安装', update: '更新', enable: '启用', disable: '禁用', uninstall: '卸载' };
const states: Record<string, string> = { installed_load_unknown: '原生已安装 · 加载未验证', configured_load_unknown: '已配置 · 安装与加载未验证', discovered_load_unknown: '已发现 · 加载未验证', disabled: '已禁用', state_unknown: '声明已被外部修改 · 状态待核对' };
function message(error: unknown) { return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error); }
function policyLabel(value: string) { return value.replaceAll('NOT_AVAILABLE', '安装策略：不可安装').replaceAll('AVAILABLE', '安装策略：允许安装').replaceAll('REQUIRED', '安装策略：组织要求').replaceAll('FORBIDDEN', '安装策略：禁止安装').replaceAll('ON_INSTALL', '安装时认证').replaceAll('NONE', '无需额外认证'); }
const scopeLabels: Record<string, string> = { user: '全局', project: '项目', local: '项目本地', managed: '组织管理', auto: '自动发现' };

export function PluginsWorkspace({ toolId, scope, projectPath, contextId }: { toolId: string; scope: Scope; projectPath: string; contextId: string | null }) {
  const target = useMemo<PluginTarget>(() => ({ toolId, scope, projectPath: scope === 'project' ? projectPath : null, contextId }), [toolId, scope, projectPath, contextId]);
  const [snapshot, setSnapshot] = useState<PluginSnapshot | null>(null);
  const [source, setSource] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const accountLabel = useAccountLabels();
  useEffect(() => { const id = ++generation.current; setSnapshot(null); setError(''); setNotice(''); setBusy(true);
    void native.scanNativePlugins(target).then(value => { if (id === generation.current) setSnapshot(value); }).catch(value => { if (id === generation.current) setError(message(value)); }).finally(() => { if (id === generation.current) setBusy(false); });
    return () => { generation.current++; };
  }, [target]);
  async function refresh() { const id = ++generation.current; setBusy(true); setError('');
    try { const value = await native.scanNativePlugins(target); if (id === generation.current) setSnapshot(value); }
    catch (value) { if (id === generation.current) { setError(message(value)); setSnapshot(null); } }
    finally { if (id === generation.current) setBusy(false); }
  }
  async function operate(action: PluginAction, entry?: PluginEntry) {
    if (!snapshot || busy) return;
    const id = generation.current;
    if (action === 'uninstall' && !await confirmAction(`卸载 ${entry?.name} 及其包内资源？原生命令的下载和文件副作用不能保证自动回滚。`, () => id === generation.current, { title: '卸载原生插件', confirmLabel: '卸载' })) return;
    if (id !== generation.current) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await native.operateNativePlugin({ target, action, source: entry?.id ?? source.trim(), baseline: snapshot.baseline, trusted });
      if (id !== generation.current) return;
      setSnapshot(result.snapshot); setNotice(result.detail);
      if (result.status === 'failed_possible_side_effects') setError('操作失败，可能留下部分变更；请核对重新扫描的实际状态。');
      else if (action === 'install') { setSource(''); setTrusted(false); }
    } catch (value) { if (id === generation.current) setError(message(value)); }
    finally { if (id === generation.current) setBusy(false); }
  }
  return <section className={styles.panel} aria-label="原生插件管理">
    <div className={styles.actions}><h2>插件</h2><button disabled={busy} onClick={() => void refresh()}>重新扫描</button></div>
    <p>{scope === 'global' ? '全局' : projectPath} · {accountLabel(contextId)}</p>
    {busy && <p role="status">正在处理原生插件…</p>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {snapshot && <>
      <p>能力核验版本 {snapshot.capability.version} · {snapshot.capability.detail}</p><p>{snapshot.detail}</p>
      <div className={styles.create}><label>插件来源<input aria-label="插件来源" value={source} onChange={event => { setSource(event.target.value); setTrusted(false); }} placeholder={snapshot.capability.sources} disabled={busy} style={{ width: 'min(500px, 60vw)' }} /></label>
        <button disabled={busy || !source.trim() || !trusted || !snapshot.capability.actions.includes('install')} onClick={() => void operate('install')}>{toolId === 'open_code' ? '添加插件声明' : '安装插件'}</button></div>
      <p>支持来源：{snapshot.capability.sources}</p>
      <label><input type="checkbox" checked={trusted} onChange={event => setTrusted(event.target.checked)} disabled={busy} /> 我信任所选来源，允许安装或更新插件代码{toolId === 'pi' && scope === 'project' ? '并授予此次原生项目操作信任' : ''}</label>
      {!snapshot.entries.length && <p>此作用域尚未发现插件。</p>}
      <ul className={styles.list}>{snapshot.entries.map(entry => <li key={`${entry.scope}:${entry.id}`}>
        <div><strong>{entry.name}</strong><span>{entry.version ?? '版本未提供'}</span></div>
        <p>{entry.source} · {scopeLabels[entry.scope] ?? entry.scope} · {entry.enabled === null ? '启用状态未知' : entry.enabled ? '已启用' : '已禁用'}</p>
        <p>{states[entry.state] ?? entry.state} · {policyLabel(entry.policy)}{entry.readOnly ? ' · 只读' : ''}</p>
        {entry.root && <p>{entry.root}</p>}
        {!!entry.resources.length && <details><summary>包内资源（随插件管理）</summary><ul>{entry.resources.map(resource => <li key={resource.path}>{resource.kind} · {resource.path}</li>)}</ul></details>}
        <div className={styles.actions}>{(['update', entry.enabled === false ? 'enable' : 'disable', 'uninstall'] as PluginAction[]).filter(action => snapshot.capability.actions.includes(action)).map(action => <button key={action} disabled={busy || entry.readOnly || (action === 'update' && (!trusted || (toolId === 'pi' && scope === 'project')))} onClick={() => void operate(action, entry)}>{labels[action]}</button>)}</div>
      </li>)}</ul>
    </>}
  </section>;
}
