import { CodeEditor } from '../../components/CodeEditor';
import { open } from '@tauri-apps/plugin-dialog';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import type { AdapterDescriptor, Scope } from '../../types/native';
import type { McpDefinition, McpDraft, McpTargetRequest, McpTargetResult, NativeMcpEntry, NativeSkillEntry, SkillImportPreview, SkillInstallation, SkillPackage, SkillRecoveryIssue, SkillTargetPreview, SkillTargetResult } from '../../types/resources';
import { displayPath, shortPath } from '../../lib/paths';
import { ToolIcon } from '../../components/ToolIcon';
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
  const [savedFingerprint, setSavedFingerprint] = useState(JSON.stringify([blank(), '', '',true]));
  const [nativeEntries, setNativeEntries] = useState<NativeMcpEntry[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [previewState, setPreview] = useState<{ context: string; epoch: number; items: McpTargetResult[] } | null>(null);
  const [results, setResults] = useState<McpTargetResult[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [nativeOrigin, setNativeOrigin] = useState<NativeMcpEntry | null>(null);
  const [currentConflict, setCurrentConflict] = useState<{ id: string; items: McpTargetResult[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const project = scope === 'project' ? projectPath || null : null;
  const dirty = JSON.stringify([draft, envText, headerText,enabled]) !== savedFingerprint;
  const latestForm = useRef(''); latestForm.current = JSON.stringify([draft, envText, headerText, enabled]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current=true;return () => { mounted.current=false; }; },[]);
  const previewContext = JSON.stringify([draft, envText, headerText, toolId, scope, project, enabled, selected]);
  const previewEpochRef = useRef({ context: previewContext, epoch: 0 });
  if (previewEpochRef.current.context !== previewContext) {
    previewEpochRef.current = { context: previewContext, epoch: previewEpochRef.current.epoch + 1 };
  }
  const previewRequestRef = useRef(0);
  const preview = previewState?.context === previewContext && previewState.epoch === previewEpochRef.current.epoch ? previewState.items : null;
  useLayoutEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
  const target = useMemo<McpTargetRequest>(() => ({ toolId, scope, projectPath: project, enabled }), [toolId, scope, project, enabled]);
  useEffect(() => { setPreview(null); setPreviewBusy(false); }, [toolId, scope, project, enabled, selected]);
  useEffect(() => { setPreview(null); setPreviewBusy(false); }, [draft, envText, headerText]);

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

  function select(item: McpDefinition, nextEnabled = true) {
    const next = draftOf(item);
    setNativeOrigin(null); setCurrentConflict(null);
    setDraft(next); setEnvText(lines(item.env)); setHeaderText(lines(item.headers));
    setEnabled(nextEnabled);setSavedFingerprint(JSON.stringify([next, lines(item.env), lines(item.headers),nextEnabled]));
    latestForm.current=JSON.stringify([next,lines(item.env),lines(item.headers),nextEnabled]);
    setPreview(null); setResults(null); setError('');
  }
  async function selectDefinition(item: McpDefinition) {
    if (!await canReplace()) return;
    const started=latestForm.current;setBusy(true);setError('');
    try {
      const current=nativeEntries.find(entry=>entry.name===item.name);
      const nextEnabled=current?.enabled ?? await native.getManagedMcpEnabled(item.id,target) ?? true;
      if (mounted.current && started===latestForm.current) select(item,nextEnabled);
    } catch (value) {setError(errorText(value));} finally {setBusy(false);}
  }
  async function canReplace() {
    const started = previewEpochRef.current;
    return !dirty || confirmAction('MCP 草稿尚未保存，切换后会丢失修改。', () => mounted.current && started === previewEpochRef.current, { title: '放弃未保存修改？', confirmLabel: '放弃修改' });
  }
  async function importNative(item: NativeMcpEntry) {
    if (!await canReplace()) return;
    setNativeOrigin(item); setCurrentConflict(null);
    const found = definitions.find((definition) => definition.name === item.name);
    const next: McpDraft = { id: found?.id ?? null, name: item.name, transport: item.transport, command: item.command, args: item.args, url: item.url,
      env: item.env, headers: item.headers, expectedVersion: found?.version ?? null };
    setSavedFingerprint(JSON.stringify([next, lines(item.env), lines(item.headers),item.enabled]));
    setDraft(next);
    setEnvText(lines(item.env)); setHeaderText(lines(item.headers)); setEnabled(item.enabled); setPreview(null);
    setNotice(item.protectedValues ? '原生条目有受保护凭据值未导入；保存前请改用环境变量引用。' : found ? '已读取本工具原生条目；保存会更新同名 MCP 资料。' : '已读取原生条目，保存后可分发。');
  }
  async function applyItems(id: string, items: McpTargetResult[], replace: boolean) {
    const targets = items.filter(item => item.status === 'ready' || item.status === 'conflict').map((item): McpTargetRequest => ({ toolId: item.toolId, scope: item.scope,
      projectPath: item.projectPath, enabled, baselineHash: item.baselineHash, previewToken: item.previewToken, allowReplace: replace && item.status === 'conflict' }));
    const outcome = await native.distributeMcp(id, targets);
    setResults(outcome); setNativeEntries(await native.listNativeMcp(target)); setCurrentConflict(null);
    setNotice(outcome.every(item => item.status === 'written') ? '已保存到当前 CLI。' : '部分写入失败，可重试。');
  }
  async function save(libraryOnly = false) {
    if (scope === 'project' && !project && !libraryOnly) { setError('请选择项目。'); return; }
    const origin = nativeOrigin; const started = latestForm.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await native.saveMcpDefinition({ ...draft, env: parseLines(envText), headers: parseLines(headerText) });
      setDefinitions(await native.listMcpDefinitions());
      if (!mounted.current || started !== latestForm.current) { setNotice('定义已保存，继续编辑的修改已保留。'); return; }
      select(saved,enabled);
      if (libraryOnly) { setNotice('已保存到资料库。'); return; }
      const savedForm=JSON.stringify([draftOf(saved),lines(saved.env),lines(saved.headers),enabled]);
      const items = await native.previewMcpTargets(saved.id, [target]);
      const fresh = origin ? await native.listNativeMcp(target) : [];
      if (!mounted.current || savedForm!==latestForm.current) {setNotice('定义已保存，继续编辑的修改已保留，尚未写入 CLI。');return;}
      const sameOrigin = !!origin && JSON.stringify(fresh.find(item => item.name === origin.name)) === JSON.stringify(origin);
      if (items.some(item => item.status === 'conflict') && !sameOrigin) { setCurrentConflict({ id: saved.id, items }); return; }
      if (!items.some(item => item.status === 'ready' || item.status === 'conflict')) { setResults(items); setError(items.map(item => item.detail).join('；')); return; }
      await applyItems(saved.id, items, sameOrigin);
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  function requests(ids = selected): McpTargetRequest[] {
    return ids.map((id) => ({ toolId: id, scope, projectPath: project, enabled }));
  }
  async function inspect(ids = selected) {
    if (!draft.id) { setError('请先保存 MCP 资料。'); return; }
    if (dirty) { setError('请先保存 MCP 草稿，再预览分发目标。'); return; }
    if (scope === 'project' && !project) { setError('请先在工具页打开项目目录。'); return; }
    const context = previewContext;
    const epoch = previewEpochRef.current.epoch;
    const request = ++previewRequestRef.current;
    setPreviewBusy(true); setPreview(null); setResults(null); setError('');
    try {
      const items = await native.previewMcpTargets(draft.id, requests(ids));
      if (mounted.current && request === previewRequestRef.current && epoch === previewEpochRef.current.epoch && context === previewEpochRef.current.context) {
        if (items.some(item=>item.status==='conflict')) {setPreview({ context, epoch, items });}
        else { await applyItems(draft.id,items,false); }
      }
    } catch (value) {
      if (request === previewRequestRef.current && epoch === previewEpochRef.current.epoch) setError(errorText(value));
    } finally {
      if (request === previewRequestRef.current && epoch === previewEpochRef.current.epoch) setPreviewBusy(false);
    }
  }
  async function distribute() {
    if (!draft.id || !preview || dirty) return;
    const active = preview.filter((item) => item.status === 'ready' || item.status === 'conflict');
    if (!active.length) return;
    const collisions = active.filter((item) => item.status === 'conflict');
    const started = previewEpochRef.current;
    if (collisions.length && !await confirmAction(`将向 ${active.length} 个 CLI 分发“${draft.name}”，其中 ${collisions.length} 个同名原生条目会被替换。`, () => mounted.current && started === previewEpochRef.current, { title: '替换同名 MCP？', confirmLabel: '替换并分发' })) return;
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
      <div className={styles.listHead}><strong>MCP 资料</strong><button type="button" onClick={async () => { if (!await canReplace()) return; setDraft(blank()); setEnvText(''); setHeaderText('');setEnabled(true);setNativeOrigin(null);setCurrentConflict(null); setSavedFingerprint(JSON.stringify([blank(), '', '',true])); setPreview(null); }}>＋ 新建</button></div>
      {definitions.map((item) => <button key={item.id} type="button" disabled={busy} className={draft.id === item.id ? styles.active : ''} onClick={() => void selectDefinition(item)}><strong>{item.name}</strong><small>{item.transport === 'http' ? item.url : item.command}</small></button>)}
      <div className={styles.listHead}><strong>当前 CLI 原生条目</strong></div>
      {nativeEntries.length ? nativeEntries.map((item) => <button key={item.name} type="button" onClick={() => importNative(item)}><strong>{item.name}</strong><small>{item.enabled ? '已启用' : '已停用'}{item.protectedValues ? ' · 凭据已隐藏' : ''}</small></button>) : <p>尚无原生 MCP，或此工具不提供该格式。</p>}
    </aside>
    <div className={styles.panel}>
      <div className={styles.heading}><div><small>原生 MCP</small><h2>{draft.name || '新定义'}</h2></div></div>
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
      <label className={styles.inline}><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用 MCP</label>
      <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy || !draft.name.trim()} onClick={() => void save()}>保存到当前 CLI</button><button type="button" disabled={busy || !draft.name.trim()} onClick={() => void save(true)}>只保存到资料库</button></div>
      {currentConflict && <div className={styles.resultList} role="group" aria-label="MCP 写入冲突"><strong>当前同名条目与读取时不同，请比较后选择</strong>{currentConflict.items.map(item => <div className={styles.fileDiff} key={item.toolId}><CodeEditor compact label="当前 MCP" format="json" readOnly value={JSON.stringify(item.existing, null, 2)} /><CodeEditor compact label="本次 MCP 修改" format="json" readOnly value={JSON.stringify(item.proposed, null, 2)} /></div>)}<div className={styles.actions}><button type="button" onClick={() => setCurrentConflict(null)}>保留当前文件</button><button type="button" disabled={busy} onClick={() => { setBusy(true); void applyItems(currentConflict.id, currentConflict.items, true).catch(value => setError(errorText(value))).finally(() => setBusy(false)); }}>使用本次修改</button></div></div>}
      {draft.id && <details className={styles.distribution}><summary>分发到其他 CLI</summary>
        <div className={styles.heading}><div><strong>分发到 CLI</strong><p>每个目标独立写入。已有同名原生条目会先显示冲突。</p></div></div>
        <div className={styles.targetGrid}>{tools.map((item) => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => { setSelected(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id)); setPreview(null); }} /><ToolIcon toolId={item.id} size={22} />{item.name}</label>)}</div>

        <button type="button" disabled={busy || previewBusy || !selected.length} onClick={() => void inspect()}>分发所选工具</button>
        {preview && <div className={styles.resultList}>{preview.map((item) => <div key={item.toolId}><p><strong>{tools.find((tool) => tool.id === item.toolId)?.name ?? item.toolId}</strong> · {item.status === 'conflict' ? '同名冲突' : item.status === 'ready' ? '可写入' : '不可写入'} · {item.path ?? ''} <small>{item.detail}</small></p>{(item.existing !== null || item.proposed !== null) && <details className={styles.fileChange} open={item.status === 'conflict'}><summary>查看当前与写入后的原生条目</summary><div className={styles.fileDiff}><div><strong>当前原生条目</strong><CodeEditor compact label="当前 MCP 原生条目" format="json" readOnly value={item.existing === null ? 'null' : JSON.stringify(item.existing, null, 2)} /></div><div><strong>写入后</strong><CodeEditor compact label="写入后 MCP 条目" format="json" readOnly value={item.proposed === null ? 'null' : JSON.stringify(item.proposed, null, 2)} /></div></div></details>}</div>)}<button type="button" className={styles.primary} disabled={busy || !preview.some((item) => item.status === 'ready' || item.status === 'conflict')} onClick={() => void distribute()}>确认分发</button></div>}
        {results && <div className={styles.resultList} role="status">{results.map((item) => <p key={item.toolId}>{item.toolId}：{item.status === 'written' ? '已写入' : item.detail}</p>)}{results.some((item) => item.status === 'failed') && <button type="button" onClick={() => void retryFailed()}>重新预览失败目标</button>}</div>}
      </details>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
    </div>
  </div>;
}

export function SkillsWorkspace({ toolId, scope, projectPath, onDirtyChange }: { toolId: string; scope: Scope; projectPath: string; onDirtyChange?: (dirty: boolean) => void }) {
  const [packages, setPackages] = useState<SkillPackage[]>([]);
  const [nativeEntries, setNativeEntries] = useState<NativeSkillEntry[]>([]);
  const [recoveryIssues, setRecoveryIssues] = useState<SkillRecoveryIssue[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installations, setInstallations] = useState<SkillInstallation[]>([]);
  const [url, setUrl] = useState('');
  const [archiveSelection, setArchiveSelection] = useState<{ source: string; local: boolean; entries: string[]; chosen: string | null } | null>(null);
  const [pendingImport, setPendingImport] = useState<{ preview: SkillImportPreview; kind: 'local' | 'zip' | 'local_zip'; source: string; subdirectory: string | null } | null>(null);
  const [dependencyChecked, setDependencyChecked] = useState(false);
  const [skillEnabled, setSkillEnabled] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<SkillTargetPreview | null>(null);
  useLayoutEffect(() => { onDirtyChange?.(!!url.trim() || !!archiveSelection || !!pendingImport); }, [url, archiveSelection, pendingImport, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SkillTargetResult | null>(null);
  const selected = packages.find((item) => item.id === selectedId);
  const project = scope === 'project' ? projectPath || null : null;
  const visibleIssues = recoveryIssues.filter((issue) => issue.toolId === toolId);
  useEffect(() => { setPendingTarget(null); }, [toolId, scope, project, selectedId]);
  useEffect(() => {
    let live = true;
    void native.listSkillRecoveryIssues().then((issues) => { if (live) setRecoveryIssues(issues); })
      .catch((value) => { if (live) setError(errorText(value)); });
    return () => { live = false; };
  }, [toolId, scope, project]);
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
    void Promise.all([native.listSkillInstallations(selectedId),native.getSkillEnabled(selectedId,toolId,scope,project)]).then(([items,enabled]) => { if (live) {setInstallations(items);setSkillEnabled(enabled);} })
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
  async function archive(source: string, localZip: boolean, chosen?: string) {
    setBusy(true); setError('');
    try {
      let child = chosen ?? null;
      if (chosen === undefined) {
        const entries = await native.listSkillZipEntries(source, localZip);
        if (entries.length > 1) { setArchiveSelection({ source, local: localZip, entries, chosen: null }); return; }
        child = entries[0] || null;
      }
      const preview = localZip ? await native.previewSkillLocalZip(source, child) : await native.previewSkillHttpsZip(source, child);
      if (preview.existingDigest && preview.existingDigest !== preview.digest) {
        setPendingImport({ preview, kind: localZip ? 'local_zip' : 'zip', source, subdirectory: child }); setArchiveSelection(null); return;
      }
      const item = localZip ? await native.importSkillLocalZip(source, child, preview.digest, preview.existingDigest) : await native.importSkillHttpsZip(source, child, preview.digest, preview.existingDigest);
      setPackages(await native.listSkillPackages()); setSelectedId(item.id); setResult(null);
      if (!localZip) setUrl('');
      setArchiveSelection(null);
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function localZip() {
    try {
      const source = await open({ directory: false, multiple: false, title: '选择 Skills ZIP 文件', filters: [{ name: 'ZIP', extensions: ['zip'] }] });
      if (typeof source === 'string') await archive(source, true);
    } catch (value) { setError(errorText(value)); }
  }
  async function confirmImport() {
    if (!pendingImport) return;
    setBusy(true); setError('');
    try {
      const { preview, kind, source, subdirectory } = pendingImport;
      const item = kind === 'local'
        ? await native.importSkillLocal(source, preview.digest, preview.existingDigest)
        : kind === 'local_zip' ? await native.importSkillLocalZip(source, subdirectory, preview.digest, preview.existingDigest)
        : await native.importSkillHttpsZip(source, subdirectory, preview.digest, preview.existingDigest);
      setPackages(await native.listSkillPackages()); setSelectedId(item.id); setPendingImport(null);
      if (kind === 'zip') setUrl('');
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
      const targetPreview = !remove ? pendingTarget ?? await native.previewSkillTarget(selected.id, toolId, scope, project) : null;
      if (!remove && !pendingTarget && targetPreview?.status === 'conflict') { setPendingTarget(targetPreview); return; }
      const outcome = remove ? await native.removeSkill(selected.id, toolId, scope, project)
        : await native.installSkill(selected.id, toolId, scope, project, targetPreview?.previewToken ?? null, targetPreview?.status === 'conflict');
      setResult(outcome);
      setPendingTarget(null);
      setInstallations(await native.listSkillInstallations(selected.id));
      setNativeEntries(await native.scanNativeSkills(toolId, scope, project));
      setSkillEnabled(await native.getSkillEnabled(selected.id,toolId,scope,project));
      setRecoveryIssues(await native.listSkillRecoveryIssues());
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function toggleSkill(next: boolean) {
    if (!selected) return; setBusy(true);setError('');
    try {await native.setSkillEnabled(selected.id,toolId,scope,project,next);setSkillEnabled(await native.getSkillEnabled(selected.id,toolId,scope,project));setInstallations(await native.listSkillInstallations(selected.id));setNativeEntries(await native.scanNativeSkills(toolId,scope,project));}
    catch(value){setError(errorText(value));}finally{setBusy(false);}
  }
  async function checkRecovery() {
    try { setRecoveryIssues(await native.listSkillRecoveryIssues()); setError(''); }
    catch (value) { setError(errorText(value)); }
  }
  return <div className={styles.layout}>
    <aside className={styles.list}>
      <div className={styles.listHead}><strong>已保存的 Skills</strong></div><div className={styles.actions}><button type="button" disabled={busy} onClick={() => void local()}>导入文件夹</button><button type="button" disabled={busy} onClick={() => void localZip()}>导入 ZIP 文件</button></div>
      {packages.map((item) => <button type="button" key={item.id} className={selectedId === item.id ? styles.active : ''} onClick={() => { setSelectedId(item.id); setDependencyChecked(false); setResult(null); }}><strong>{item.name}</strong><small>{item.fileCount} 个文件 · {item.description || '完整资源包'}</small></button>)}
      {!packages.length && <p>导入包含 SKILL.md 的文件夹或 ZIP，保留全部资源文件。</p>}
      <div className={styles.listHead}><strong>本机 Skills</strong></div>
      {nativeEntries.map((entry) => <button type="button" key={entry.path} onClick={() => void openNative(entry)}><strong>{entry.name}</strong><small>{entry.state === 'managed' ? '已管理' : entry.state === 'external' ? '本机目录' : '暂不可读取'}</small></button>)}
      {!nativeEntries.length && <p>当前范围尚无原生 Skills。</p>}
    </aside>
    <div className={styles.panel}>
      <div className={styles.heading}><div><small>原生 Skills</small><h2>{selected?.name ?? '导入 Skills'}</h2></div></div>
      {!!visibleIssues.length && <div className={styles.error} role="alert"><strong>Skills 安装需要检查</strong><p>相关 CLI 启动会暂停。异常备份已保留；检查目录后可重新尝试恢复。</p>{visibleIssues.map((issue) => <div key={issue.operationId} className={styles.fileChange}><strong>{issue.scope === 'global' ? '全局' : `项目 ${issue.projectPath ?? ''}`}</strong><p>{issue.detail}</p><p>目标：{issue.targetPath}</p><p>备份：{issue.backupPath}</p><button type="button" onClick={() => void navigator.clipboard.writeText(issue.backupPath).catch((value) => setError(errorText(value)))}>复制备份路径</button></div>)}<button type="button" onClick={() => void checkRecovery()}>重新检查恢复状态</button></div>}
      {selected && <><p className={styles.muted}>{selected.description || '完整 Skills 包'} · {selected.fileCount} 个文件</p><details className={styles.source}><summary title={displayPath(selected.source)}>来源 · {shortPath(selected.source)}</summary><p>{displayPath(selected.source)}</p></details>
        {selected.compatibility && <label className={styles.inline}><input type="checkbox" checked={dependencyChecked} onChange={(event) => setDependencyChecked(event.target.checked)} />已检查所需环境：{selected.compatibility}</label>}
        <label className={styles.inline}><input type="checkbox" aria-label="启用 Skill" checked={skillEnabled} disabled={busy || !installed && !nativeEntries.some(item=>item.name===selected.name) && !skillEnabled} onChange={event => void toggleSkill(event.target.checked)} />启用 Skill</label><p className={styles.muted}>当前 {toolId}：{installed?.state === 'current' ? '已安装' : installed?.state === 'update_available' ? '有更新' : installed?.state === 'conflict' ? '原生目录有外部修改' : installed?.state === 'disabled' ? '已停用 · 内容已保留' : installed?.state === 'missing' ? '原生目录缺失' : '未安装'}</p>
        <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy || (scope === 'project' && !project)} onClick={() => void change(false)}>{installed?.state === 'update_available' ? '更新到当前 CLI' : '安装到当前 CLI'}</button>{installed && <button type="button" disabled={busy} onClick={() => void change(true)}>移除安装</button>}</div>
        {pendingTarget && <div className={styles.resultList} role="group" aria-label="Skills 目标预览"><strong>{pendingTarget.status === 'conflict' ? '原生 Skills 内容不同，请确认接管' : '确认安装内容'}</strong><p>{pendingTarget.detail} · {pendingTarget.path}</p>
          {pendingTarget.changes.map((change) => <details key={change.path} className={styles.fileChange}><summary>{change.path}</summary><div className={styles.fileDiff}><div><strong>当前</strong>{change.before !== null ? <pre>{change.before}</pre> : <small>{change.beforeSize === null ? '不存在' : `${change.beforeSize} 字节 · SHA-256 ${change.beforeDigest}`}</small>}</div><div><strong>安装后</strong>{change.after !== null ? <pre>{change.after}</pre> : <small>{change.afterSize === null ? '删除' : `${change.afterSize} 字节 · SHA-256 ${change.afterDigest}`}</small>}</div></div></details>)}
          <div className={styles.actions}><button type="button" onClick={() => setPendingTarget(null)}>取消</button><button type="button" className={styles.primary} disabled={busy} onClick={() => void change(false)}>{pendingTarget.status === 'conflict' ? '确认接管并替换' : '确认安装'}</button></div>
        </div>}
        {!!installations.length && <div className={styles.resultList}><strong>安装位置</strong>{installations.map((item) => <p key={`${item.toolId}:${item.targetPath}`}>{item.toolId} · {item.scope === 'global' ? '全局' : '项目'} · {item.state} <small>{item.targetPath}</small></p>)}</div>}
      </>}
      <details className={styles.distribution}><summary>从 HTTPS 地址导入 ZIP</summary>
        <label>归档地址<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/skill.zip" /></label>
        <button type="button" disabled={busy || !url.trim()} onClick={() => void archive(url.trim(), false)}>导入地址</button>
      </details>
      {archiveSelection && <div className={styles.distribution}><label>选择归档中的 Skill<select aria-label="归档中的 Skill" value={archiveSelection.chosen ?? '__choose__'} onChange={event => setArchiveSelection({ ...archiveSelection, chosen: event.target.value === '__choose__' ? null : event.target.value })}><option value="__choose__">选择 Skill…</option>{archiveSelection.entries.map(entry => <option key={entry} value={entry}>{entry || '归档根目录'}</option>)}</select></label><div className={styles.actions}><button type="button" onClick={() => setArchiveSelection(null)}>取消</button><button type="button" disabled={busy || archiveSelection.chosen === null} onClick={() => void archive(archiveSelection.source, archiveSelection.local, archiveSelection.chosen ?? undefined)}>导入所选 Skill</button></div></div>}
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
