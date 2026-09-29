import { open } from '@tauri-apps/plugin-dialog';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { native } from '../../lib/native';
import type { AdapterDescriptor, Scope } from '../../types/native';
import type { McpDefinition, McpDraft, McpTargetRequest, McpTargetResult, NativeMcpEntry, NativeSkillEntry, SkillImportPreview, SkillInstallation, SkillPackage, SkillTargetPreview, SkillTargetResult } from '../../types/resources';
import styles from './ResourceWorkspace.module.css';

function errorText(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : '操作失败，请重试';
}
function blank(): McpDraft {
  return { id: null, name: '', transport: 'stdio', command: '', args: [], url: '', env: {}, headers: {}, expectedVersion: null };
}
function draftOf(item: McpDefinition): McpDraft {
  return { id: item.id, name: item.name, transport: item.transport, command: item.command, args: item.args, url: item.url, env: item.env, headers: item.headers, expectedVersion: item.version };
}
function lines(value: Record<string, string>): string {
  return Object.entries(value).map(([key, item]) => `${key}=${item}`).join('\n');
}
function parseLines(value: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const line of value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const equals = line.indexOf('=');
    if (equals < 1) throw new Error('变量和请求头请每行填写 KEY=value');
    output[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
  }
  return output;
}

export function McpWorkspace({ toolId, scope, projectPath, tools, onDirtyChange }: { toolId: string; scope: Scope; projectPath: string; tools: AdapterDescriptor[]; onDirtyChange?: (dirty: boolean) => void }) {
  const [definitions, setDefinitions] = useState<McpDefinition[]>([]);
  const [draft, setDraft] = useState<McpDraft>(blank);
  const [envText, setEnvText] = useState('');
  const [headerText, setHeaderText] = useState('');
  const [savedFingerprint, setSavedFingerprint] = useState(JSON.stringify([blank(), '', '']));
  const [nativeEntries, setNativeEntries] = useState<NativeMcpEntry[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<McpTargetResult[] | null>(null);
  const [results, setResults] = useState<McpTargetResult[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const project = scope === 'project' ? projectPath || null : null;
  const dirty = JSON.stringify([draft, envText, headerText]) !== savedFingerprint;
  useLayoutEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
  const target = useMemo<McpTargetRequest>(() => ({ toolId, scope, projectPath: project, enabled }), [toolId, scope, project, enabled]);
  useEffect(() => { setPreview(null); }, [toolId, scope, project, enabled]);
  useEffect(() => { setPreview(null); }, [draft, envText, headerText]);

  useEffect(() => {
    void native.listMcpDefinitions().then(setDefinitions).catch((value) => setError(errorText(value)));
  }, []);
  useEffect(() => {
    if (!toolId || (scope === 'project' && !project)) { setNativeEntries([]); return; }
    let live = true;
    void native.listNativeMcp(target).then((value) => { if (live) setNativeEntries(value); })
      .catch((value) => { if (live) { setNativeEntries([]); setError(errorText(value)); } });
    return () => { live = false; };
  }, [target, toolId, scope, project]);

  function select(item: McpDefinition) {
    const next = draftOf(item);
    setDraft(next); setEnvText(lines(item.env)); setHeaderText(lines(item.headers));
    setSavedFingerprint(JSON.stringify([next, lines(item.env), lines(item.headers)]));
    setPreview(null); setResults(null); setError('');
  }
  function canReplace() { return !dirty || window.confirm('MCP 草稿尚未保存，切换后会丢失修改。继续吗？'); }
  function importNative(item: NativeMcpEntry) {
    if (!canReplace()) return;
    const found = definitions.find((definition) => definition.name === item.name);
    if (found) { select(found); setNotice('已打开同名资料；原生条目若由外部修改，会在分发预览中显示冲突。'); return; }
    setSavedFingerprint(JSON.stringify([blank(), '', '']));
    setDraft({ id: null, name: item.name, transport: item.transport, command: item.command, args: item.args, url: item.url,
      env: item.env, headers: item.headers, expectedVersion: null });
    setEnvText(lines(item.env)); setHeaderText(lines(item.headers)); setEnabled(item.enabled); setPreview(null);
    setNotice(item.protectedValues ? '原生条目有受保护凭据值未导入；保存前请改用环境变量引用。' : '已读取原生条目，保存后可分发。');
  }
  async function save() {
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await native.saveMcpDefinition({ ...draft, env: parseLines(envText), headers: parseLines(headerText) });
      select(saved);
      setDefinitions(await native.listMcpDefinitions());
      setNotice('MCP 定义已保存。');
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  function requests(ids = selected): McpTargetRequest[] {
    return ids.map((id) => ({ toolId: id, scope, projectPath: project, enabled }));
  }
  async function inspect(ids = selected) {
    if (!draft.id) { setError('请先保存 MCP 定义。'); return; }
    if (dirty) { setError('请先保存 MCP 草稿，再预览分发目标。'); return; }
    if (scope === 'project' && !project) { setError('请先在工具页打开项目目录。'); return; }
    setBusy(true); setPreview(null); setResults(null); setError('');
    try { setPreview(await native.previewMcpTargets(draft.id, requests(ids))); }
    catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function distribute() {
    if (!draft.id || !preview || dirty) return;
    const active = preview.filter((item) => item.status === 'ready' || item.status === 'conflict');
    if (!active.length) return;
    const collisions = active.filter((item) => item.status === 'conflict');
    if (!window.confirm(collisions.length
      ? `将向 ${active.length} 个 CLI 分发“${draft.name}”，其中 ${collisions.length} 个同名原生条目会被替换。确定继续？`
      : `将向 ${active.length} 个 CLI 分发“${draft.name}”。确定继续？`)) return;
    setBusy(true); setError('');
    try {
      const targets = active.map((item): McpTargetRequest => ({ toolId: item.toolId, scope: item.scope,
        projectPath: item.projectPath, enabled, baselineHash: item.baselineHash, previewToken: item.previewToken, allowReplace: item.status === 'conflict' }));
      setResults(await native.distributeMcp(draft.id, targets));
      setPreview(null);
      const current = await native.listNativeMcp(target).catch(() => []);
      setNativeEntries(current);
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function retryFailed() {
    const failed = results?.filter((item) => item.status === 'failed').map((item) => item.toolId) ?? [];
    if (failed.length) await inspect(failed);
  }

  return <div className={styles.layout}>
    <aside className={styles.list}>
      <div className={styles.listHead}><strong>MCP 定义</strong><button type="button" onClick={() => { if (!canReplace()) return; setDraft(blank()); setEnvText(''); setHeaderText(''); setSavedFingerprint(JSON.stringify([blank(), '', ''])); setPreview(null); }}>＋ 新建</button></div>
      {definitions.map((item) => <button key={item.id} type="button" className={draft.id === item.id ? styles.active : ''} onClick={() => { if (canReplace()) select(item); }}><strong>{item.name}</strong><small>{item.transport === 'http' ? item.url : item.command}</small></button>)}
      <div className={styles.listHead}><strong>当前 CLI 原生条目</strong></div>
      {nativeEntries.length ? nativeEntries.map((item) => <button key={item.name} type="button" onClick={() => importNative(item)}><strong>{item.name}</strong><small>{item.enabled ? '已启用' : '已停用'}{item.protectedValues ? ' · 凭据已隐藏' : ''}</small></button>) : <p>尚无原生 MCP，或此工具不提供该格式。</p>}
    </aside>
    <div className={styles.panel}>
      <div className={styles.heading}><div><small>原生 MCP</small><h2>{draft.name || '新定义'}</h2></div><span>{scope === 'global' ? '全局' : '项目'}</span></div>
      <div className={styles.fields}>
        <label>名称<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如 filesystem" /></label>
        <label>传输格式<select value={draft.transport} onChange={(event) => setDraft({ ...draft, transport: event.target.value as 'stdio' | 'http' })}><option value="stdio">本地命令 · stdio</option><option value="http">远程地址 · HTTP</option></select></label>
      </div>
      {draft.transport === 'stdio' ? <>
        <label>命令<input value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx" /></label>
        <label>参数，每行一项<textarea rows={3} value={draft.args.join('\n')} onChange={(event) => setDraft({ ...draft, args: event.target.value.split('\n').filter(Boolean) })} /></label>
        <label>环境变量，每行 KEY=value<textarea rows={3} value={envText} onChange={(event) => setEnvText(event.target.value)} placeholder="API_TOKEN=${API_TOKEN}" /></label>
      </> : <>
        <label>HTTP 地址<input value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp" /></label>
        <label>请求头，每行 KEY=value<textarea rows={3} value={headerText} onChange={(event) => setHeaderText(event.target.value)} placeholder="Authorization=Bearer ${API_TOKEN}" /></label>
      </>}
      <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy || !draft.name.trim()} onClick={() => void save()}>保存定义</button></div>
      {draft.id && <div className={styles.distribution}>
        <div className={styles.heading}><div><strong>分发到 CLI</strong><p>每个目标独立写入。已有同名原生条目会先显示冲突。</p></div></div>
        <div className={styles.targetGrid}>{tools.map((item) => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => { setSelected(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id)); setPreview(null); }} />{item.name}</label>)}</div>
        <label className={styles.inline}><input type="checkbox" checked={enabled} onChange={(event) => { setEnabled(event.target.checked); setPreview(null); }} />启用 MCP</label>
        <button type="button" disabled={busy || !selected.length} onClick={() => void inspect()}>预览目标</button>
        {preview && <div className={styles.resultList}>{preview.map((item) => <div key={item.toolId}><p><strong>{tools.find((tool) => tool.id === item.toolId)?.name ?? item.toolId}</strong> · {item.status === 'conflict' ? '同名冲突' : item.status === 'ready' ? '可写入' : '不可写入'} · {item.path ?? ''} <small>{item.detail}</small></p>{(item.existing !== null || item.proposed !== null) && <details className={styles.fileChange} open={item.status === 'conflict'}><summary>查看当前与写入后的原生条目</summary><div className={styles.fileDiff}><div><strong>当前原生条目</strong><pre>{item.existing === null ? '无' : JSON.stringify(item.existing, null, 2)}</pre></div><div><strong>写入后</strong><pre>{item.proposed === null ? '移除' : JSON.stringify(item.proposed, null, 2)}</pre></div></div></details>}</div>)}<button type="button" className={styles.primary} disabled={busy || !preview.some((item) => item.status === 'ready' || item.status === 'conflict')} onClick={() => void distribute()}>确认分发</button></div>}
        {results && <div className={styles.resultList} role="status">{results.map((item) => <p key={item.toolId}>{item.toolId}：{item.status === 'written' ? '已写入' : item.detail}</p>)}{results.some((item) => item.status === 'failed') && <button type="button" onClick={() => void retryFailed()}>重新预览失败目标</button>}</div>}
      </div>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
    </div>
  </div>;
}

export function SkillsWorkspace({ toolId, scope, projectPath, onDirtyChange }: { toolId: string; scope: Scope; projectPath: string; onDirtyChange?: (dirty: boolean) => void }) {
  const [packages, setPackages] = useState<SkillPackage[]>([]);
  const [nativeEntries, setNativeEntries] = useState<NativeSkillEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installations, setInstallations] = useState<SkillInstallation[]>([]);
  const [url, setUrl] = useState('');
  const [subdirectory, setSubdirectory] = useState('');
  const [pendingImport, setPendingImport] = useState<{ preview: SkillImportPreview; kind: 'local' | 'zip'; source: string; subdirectory: string | null } | null>(null);
  const [dependencyChecked, setDependencyChecked] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<SkillTargetPreview | null>(null);
  useLayoutEffect(() => { onDirtyChange?.(!!url.trim() || !!subdirectory.trim() || !!pendingImport); }, [url, subdirectory, pendingImport, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SkillTargetResult | null>(null);
  const selected = packages.find((item) => item.id === selectedId);
  const project = scope === 'project' ? projectPath || null : null;
  useEffect(() => { setPendingTarget(null); }, [toolId, scope, project, selectedId]);
  useEffect(() => {
    if (!toolId || (scope === 'project' && !project)) { setNativeEntries([]); return; }
    let live = true;
    void native.scanNativeSkills(toolId, scope, project).then((entries) => { if (live) setNativeEntries(entries); })
      .catch((value) => { if (live) setError(errorText(value)); });
    return () => { live = false; };
  }, [toolId, scope, project]);
  const installed = installations.find((item) => item.toolId === toolId && item.scope === scope && item.projectPath === project);
  useEffect(() => { void native.listSkillPackages().then((items) => { setPackages(items); setSelectedId((old) => old ?? items[0]?.id ?? null); }).catch((value) => setError(errorText(value))); }, []);
  useEffect(() => {
    if (!selectedId) return;
    let live = true;
    void native.listSkillInstallations(selectedId).then((items) => { if (live) setInstallations(items); })
      .catch((value) => { if (live) setError(errorText(value)); });
    return () => { live = false; };
  }, [selectedId, toolId, scope, project]);

  async function local() {
    try {
      const source = await open({ directory: true, multiple: false, title: '选择包含 SKILL.md 的目录' });
      if (typeof source !== 'string') return;
      setBusy(true); setError('');
      const preview = await native.previewSkillLocal(source);
      if (preview.existingDigest && preview.existingDigest !== preview.digest) {
        setPendingImport({ preview, kind: 'local', source, subdirectory: null }); return;
      }
      const item = await native.importSkillLocal(source, preview.digest, preview.existingDigest);
      setPackages(await native.listSkillPackages()); setSelectedId(item.id); setResult(null);
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function remote() {
    setBusy(true); setError('');
    try {
      const source = url.trim();
      const child = subdirectory.trim() || null;
      const preview = await native.previewSkillHttpsZip(source, child);
      if (preview.existingDigest && preview.existingDigest !== preview.digest) {
        setPendingImport({ preview, kind: 'zip', source, subdirectory: child }); return;
      }
      const item = await native.importSkillHttpsZip(source, child, preview.digest, preview.existingDigest);
      setPackages(await native.listSkillPackages()); setSelectedId(item.id); setResult(null);
      setUrl(''); setSubdirectory('');
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function confirmImport() {
    if (!pendingImport) return;
    setBusy(true); setError('');
    try {
      const { preview, kind, source, subdirectory } = pendingImport;
      const item = kind === 'local'
        ? await native.importSkillLocal(source, preview.digest, preview.existingDigest)
        : await native.importSkillHttpsZip(source, subdirectory, preview.digest, preview.existingDigest);
      setPackages(await native.listSkillPackages()); setSelectedId(item.id); setPendingImport(null);
      if (kind === 'zip') { setUrl(''); setSubdirectory(''); }
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function openNative(entry: NativeSkillEntry) {
    if (entry.state === 'unreadable') { setError(entry.detail); return; }
    if (entry.packageId) { setSelectedId(entry.packageId); return; }
    setBusy(true); setError('');
    try {
      const preview = await native.previewSkillLocal(entry.path);
      if (preview.existingDigest && preview.existingDigest !== preview.digest) {
        setPendingImport({ preview, kind: 'local', source: entry.path, subdirectory: null }); return;
      }
      const item = await native.importSkillLocal(entry.path, preview.digest, preview.existingDigest);
      setPackages(await native.listSkillPackages()); setSelectedId(item.id); setResult(null);
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function change(remove: boolean) {
    if (!selected) return;
    if (scope === 'project' && !project) { setError('请先在工具页打开项目目录。'); return; }
    if (!remove && selected.compatibility && !dependencyChecked) { setError('请先检查并确认 Skills 的环境依赖要求。'); return; }
    setBusy(true); setError(''); setResult(null);
    try {
      if (!remove && !pendingTarget) { setPendingTarget(await native.previewSkillTarget(selected.id, toolId, scope, project)); return; }
      const outcome = remove ? await native.removeSkill(selected.id, toolId, scope, project)
        : await native.installSkill(selected.id, toolId, scope, project, pendingTarget?.previewToken ?? null, pendingTarget?.status === 'conflict');
      setResult(outcome);
      setPendingTarget(null);
      setInstallations(await native.listSkillInstallations(selected.id));
      setNativeEntries(await native.scanNativeSkills(toolId, scope, project));
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  return <div className={styles.layout}>
    <aside className={styles.list}>
      <div className={styles.listHead}><strong>Skills 包</strong><button type="button" disabled={busy} onClick={() => void local()}>＋ 本地导入</button></div>
      {packages.map((item) => <button type="button" key={item.id} className={selectedId === item.id ? styles.active : ''} onClick={() => { setSelectedId(item.id); setDependencyChecked(false); setResult(null); }}><strong>{item.name}</strong><small>{item.fileCount} 个文件 · {item.description || '完整资源包'}</small></button>)}
      {!packages.length && <p>选择包含 SKILL.md 的目录，或导入 HTTPS ZIP。</p>}
      <div className={styles.listHead}><strong>当前 CLI 原生 Skills</strong></div>
      {nativeEntries.map((entry) => <button type="button" key={entry.path} onClick={() => void openNative(entry)}><strong>{entry.name}</strong><small>{entry.state === 'managed' ? '已管理' : entry.state === 'external' ? '原生目录 · 点击查看或导入' : '暂不可读取'} · {entry.detail}</small></button>)}
      {!nativeEntries.length && <p>当前范围尚无原生 Skills。</p>}
    </aside>
    <div className={styles.panel}>
      <div className={styles.heading}><div><small>原生 Skills</small><h2>{selected?.name ?? '导入 Skills'}</h2></div><span>{scope === 'global' ? '全局' : '项目'}</span></div>
      {selected && <><p className={styles.muted}>{selected.description || '完整 Skills 包'} · {selected.fileCount} 个文件</p><p className={styles.source}>来源：{selected.source}</p>
        {selected.compatibility && <label className={styles.inline}><input type="checkbox" checked={dependencyChecked} onChange={(event) => setDependencyChecked(event.target.checked)} />已检查所需环境：{selected.compatibility}</label>}
        <p className={styles.muted}>当前 {toolId}：{installed?.state === 'current' ? '已安装' : installed?.state === 'update_available' ? '有更新' : installed?.state === 'conflict' ? '原生目录有外部修改' : installed?.state === 'missing' ? '原生目录缺失' : '未安装'}</p>
        <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy || (scope === 'project' && !project)} onClick={() => void change(false)}>{installed?.state === 'update_available' ? '更新到当前 CLI' : '安装到当前 CLI'}</button>{installed && <button type="button" disabled={busy} onClick={() => void change(true)}>移除安装</button>}</div>
        {pendingTarget && <div className={styles.resultList} role="group" aria-label="Skills 目标预览"><strong>{pendingTarget.status === 'conflict' ? '原生 Skills 内容不同，请确认接管' : '确认安装内容'}</strong><p>{pendingTarget.detail} · {pendingTarget.path}</p>
          {pendingTarget.changes.map((change) => <details key={change.path} className={styles.fileChange}><summary>{change.path}</summary><div className={styles.fileDiff}><div><strong>当前</strong>{change.before !== null ? <pre>{change.before}</pre> : <small>{change.beforeSize === null ? '不存在' : `${change.beforeSize} 字节 · SHA-256 ${change.beforeDigest}`}</small>}</div><div><strong>安装后</strong>{change.after !== null ? <pre>{change.after}</pre> : <small>{change.afterSize === null ? '删除' : `${change.afterSize} 字节 · SHA-256 ${change.afterDigest}`}</small>}</div></div></details>)}
          <div className={styles.actions}><button type="button" onClick={() => setPendingTarget(null)}>取消</button><button type="button" className={styles.primary} disabled={busy} onClick={() => void change(false)}>{pendingTarget.status === 'conflict' ? '确认接管并替换' : '确认安装'}</button></div>
        </div>}
        {!!installations.length && <div className={styles.resultList}><strong>安装位置</strong>{installations.map((item) => <p key={`${item.toolId}:${item.targetPath}`}>{item.toolId} · {item.scope === 'global' ? '全局' : '项目'} · {item.state} <small>{item.targetPath}</small></p>)}</div>}
      </>}
      <div className={styles.distribution}><strong>从 HTTPS ZIP 导入完整资源包</strong><p className={styles.muted}>归档中只有一个 SKILL.md 时自动定位。多包归档填写 Skill 子目录。</p>
        <label>归档地址<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/skill.zip" /></label>
        <label>Skill 子目录（可选）<input value={subdirectory} onChange={(event) => setSubdirectory(event.target.value)} placeholder="repo-main/skills/my-skill" /></label>
        <button type="button" disabled={busy || !url.trim()} onClick={() => void remote()}>导入 ZIP</button>
      </div>
      {pendingImport && <div className={styles.resultList} role="group" aria-label="Skills 同名更新预览">
        <strong>同名包“{pendingImport.preview.name}”已有不同内容</strong>
        <p>来源：{pendingImport.preview.source} · {pendingImport.preview.fileCount} 个文件</p>
        {pendingImport.preview.compatibility && <p>环境依赖：{pendingImport.preview.compatibility}</p>}
        <p>以下文件将新增、变更或删除。文本显示前后内容；二进制及超过 256 KiB 的文件显示大小与 SHA-256。</p>
        {pendingImport.preview.changes.map((change) => <details key={change.path} className={styles.fileChange}>
          <summary>{change.path}</summary>
          <div className={styles.fileDiff}>
            <div><strong>当前</strong>{change.before !== null ? <pre>{change.before}</pre> : <small>{change.beforeSize === null ? '不存在' : `${change.beforeSize} 字节 · SHA-256 ${change.beforeDigest}`}</small>}</div>
            <div><strong>导入后</strong>{change.after !== null ? <pre>{change.after}</pre> : <small>{change.afterSize === null ? '删除' : `${change.afterSize} 字节 · SHA-256 ${change.afterDigest}`}</small>}</div>
          </div>
        </details>)}
        <div className={styles.actions}><button type="button" onClick={() => setPendingImport(null)}>取消，保留现有包</button><button type="button" className={styles.primary} disabled={busy} onClick={() => void confirmImport()}>确认更新资料库包</button></div>
      </div>}
      {result && <p role="status" className={result.status === 'failed' ? styles.error : styles.notice}>{result.status === 'failed' ? result.detail : `${result.status === 'removed' ? '已移除' : '已安装'}：${result.path}`}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  </div>;
}
