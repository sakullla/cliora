import { useState } from 'react';
import { native } from '../../lib/native';
import type { Project } from '../../types/launch';
import type { LibraryItem } from '../../types/library';
import type { AdapterDescriptor, Scope } from '../../types/native';
import type { RuleApplyResult, RulePreview, RuleTarget } from '../../types/resources';
import styles from './RuleDistribution.module.css';

function text(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : '操作失败，请重试';
}

export function RuleDistribution({ rule, tools, projects }: { rule: LibraryItem; tools: AdapterDescriptor[]; projects: Project[] }) {
  const [scope, setScope] = useState<Scope>('global');
  const [projectId, setProjectId] = useState(rule.projectId ?? '');
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<RulePreview[] | null>(null);
  const [results, setResults] = useState<RuleApplyResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const project = projects.find((item) => item.id === projectId);

  function target(toolId: string): RuleTarget {
    return { toolId, scope, projectPath: scope === 'project' ? project?.path ?? null : null };
  }
  function clear() { setPreview(null); setResults(null); setError(''); }
  async function inspect() {
    if (!selected.length) return;
    if (scope === 'project' && (!project?.available || !project.path)) { setError('请先选择可用的项目目录。'); return; }
    setBusy(true); clear();
    try { setPreview(await native.previewRuleTargets(rule.id, selected.map(target))); }
    catch (value) { setError(text(value)); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!preview) return;
    const ready = preview.filter((item) => item.status === 'ready' && item.changed);
    if (!ready.length || !window.confirm(`确认覆盖 ${ready.length} 个目标的原生规则文件？下方已展示每个文件的完整前后内容。`)) return;
    setBusy(true); setError('');
    try { setResults(await native.applyRuleTargets(rule.id, rule.version, ready.map((item) => item.target))); setPreview(null); }
    catch (value) { setError(text(value)); }
    finally { setBusy(false); }
  }

  return <section className={styles.distribution} aria-label="应用长期规则">
    <div className={styles.distributionHead}><div><strong>应用到 CLI 原生规则</strong><p>选择目标，比较完整正文，再一次确认覆盖。</p></div><button type="button" onClick={() => void inspect()} disabled={busy || !selected.length}>预览差异</button></div>
    <div className={styles.ruleChoices}>
      <label>范围<select value={scope} onChange={(event) => { setScope(event.target.value as Scope); clear(); }}><option value="global">全局</option><option value="project">项目</option></select></label>
      {scope === 'project' && <label>项目<select value={projectId} onChange={(event) => { setProjectId(event.target.value); clear(); }}><option value="">选择项目</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}{item.available ? '' : ' · 目录失效'}</option>)}</select></label>}
    </div>
    <div className={styles.ruleTools}>{tools.map((tool) => <label key={tool.id}><input type="checkbox" checked={selected.includes(tool.id)} onChange={(event) => { setSelected(event.target.checked ? [...selected, tool.id] : selected.filter((item) => item !== tool.id)); clear(); }} />{tool.name}</label>)}</div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {preview && <div className={styles.previewList}>
      {preview.map((item) => <div key={item.target.toolId} className={styles.previewItem}>
        <strong>{tools.find((tool) => tool.id === item.target.toolId)?.name ?? item.target.toolId} · {item.status === 'ready' ? item.changed ? '将覆盖' : '已一致' : '不可写'}</strong>
        <small>{item.path ?? item.detail}</small>
        {item.status === 'ready' && item.changed && <div className={styles.diff}><div><span>当前文件</span><pre>{item.existing || '（空文件）'}</pre></div><div><span>应用后</span><pre>{item.proposed}</pre></div></div>}
      </div>)}
      <button type="button" className={styles.primary} disabled={busy || !preview.some((item) => item.status === 'ready' && item.changed)} onClick={() => void apply()}>确认覆盖这些文件</button>
    </div>}
    {results && <div role="status" className={styles.previewList}>{results.map((item) => <p key={item.target.toolId}>{tools.find((tool) => tool.id === item.target.toolId)?.name ?? item.target.toolId}：{item.status === 'written' ? '已完成' : item.detail}</p>)}{results.some((item) => item.status === 'failed') && <button type="button" onClick={() => void inspect()}>重新预览失败目标</button>}</div>}
  </section>;
}
