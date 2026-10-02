import { CodeEditor } from '../../components/CodeEditor';
import { open } from '@tauri-apps/plugin-dialog';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { native } from '../../lib/native';
import { confirmAction } from '../../lib/confirm';
import type { Scope } from '../../types/native';
import type { McpDefinition, McpDraft, McpTargetRequest, McpTargetResult, NativeMcpEntry, NativeSkillEntry, SkillImportPreview, SkillInstallation, SkillPackage, SkillRecoveryIssue, SkillTargetPreview, SkillTargetResult } from '../../types/resources';
import { displayPath, shortPath } from '../../lib/paths';
import { GuideDialog } from '../../components/GuideDialog';
import { saveShortcutHint } from '../../lib/shortcut';
import styles from './ResourceWorkspace.module.css';

function errorText(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : '操作失败，请重试';
}
function blank(): McpDraft {
  return { id: null, name: '', transport: 'stdio', command: '', args: [], url: '', env: {}, headers: {}, inLibrary: false, expectedVersion: null };
}
function draftOf(item: McpDefinition): McpDraft {
  return { id: item.id, name: item.name, transport: item.transport, command: item.command, args: item.args, url: item.url, env: item.env, headers: item.headers, inLibrary: item.inLibrary !== false, expectedVersion: item.version };
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

export function McpWorkspace({ toolId, scope, projectPath, contextId, onDirtyChange }: { toolId: string; scope: Scope; projectPath: string; contextId?: string | null; onDirtyChange?: (dirty: boolean) => void }) {
  const [definitions, setDefinitions] = useState<McpDefinition[]>([]);
  const [draft, setDraft] = useState<McpDraft>(blank);
  const [envText, setEnvText] = useState('');
  const [headerText, setHeaderText] = useState('');
  const [savedFingerprint, setSavedFingerprint] = useState(JSON.stringify([blank(), '', '',true]));
  const [nativeEntries, setNativeEntries] = useState<NativeMcpEntry[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [nativeOrigin, setNativeOrigin] = useState<NativeMcpEntry | null>(null);
  const [currentConflict, setCurrentConflict] = useState<{ id: string; items: McpTargetResult[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [capabilityBlocked, setCapabilityBlocked] = useState('');
  const [composing, setComposing] = useState(false);
  const [syncLibrary, setSyncLibrary] = useState(false);
  const project = scope === 'project' ? projectPath || null : null;
  const dirty = JSON.stringify([draft, envText, headerText,enabled]) !== savedFingerprint;
  const latestForm = useRef(''); latestForm.current = JSON.stringify([draft, envText, headerText, enabled]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current=true;return () => { mounted.current=false; }; },[]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const previewContext = JSON.stringify([draft, envText, headerText, toolId, scope, project, enabled]);
  const previewEpochRef = useRef({ context: previewContext, epoch: 0 });
  if (previewEpochRef.current.context !== previewContext) {
    previewEpochRef.current = { context: previewContext, epoch: previewEpochRef.current.epoch + 1 };
  }
  useLayoutEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
  const target = useMemo<McpTargetRequest>(() => ({ toolId, scope, projectPath: project, enabled, contextId }), [toolId, scope, project, enabled, contextId]);

  useEffect(() => {
    void native.listMcpDefinitions().then(setDefinitions).catch((value) => setError(errorText(value)));
  }, []);
  useEffect(() => {
    if (!toolId || (scope === 'project' && !project)) { setNativeEntries([]); setCapabilityBlocked(''); return; }
    let live = true;
    setCapabilityBlocked('');
    void native.listNativeMcp(target).then((value) => { if (live) { setNativeEntries(value); setCapabilityBlocked(''); } })
      .catch((value) => { if (live) { setNativeEntries([]); setCapabilityBlocked(errorText(value)); } });
    return () => { live = false; };
  }, [target, toolId, scope, project]);

  const empty = !nativeEntries.length && !composing && !draft.id && !nativeOrigin;

  function select(item: McpDefinition, nextEnabled = true) {
    const next = draftOf(item);
    setNativeOrigin(null); setCurrentConflict(null); setComposing(true);
    setDraft(next); setEnvText(lines(item.env)); setHeaderText(lines(item.headers));
    setEnabled(nextEnabled);setSavedFingerprint(JSON.stringify([next, lines(item.env), lines(item.headers),nextEnabled]));
    latestForm.current=JSON.stringify([next,lines(item.env),lines(item.headers),nextEnabled]);
    setError('');
  }
  async function canReplace() {
    const started = previewEpochRef.current;
    return !dirty || confirmAction('MCP 草稿尚未保存，切换后会丢失修改。', () => mounted.current && started === previewEpochRef.current, { title: '放弃未保存修改？', confirmLabel: '放弃修改' });
  }
  async function importNative(item: NativeMcpEntry) {
    if (!await canReplace()) return;
    setNativeOrigin(item); setCurrentConflict(null); setComposing(true);
    const found = definitions.find((definition) => definition.name === item.name);
    const next: McpDraft = { id: found?.id ?? null, name: item.name, transport: item.transport, command: item.command, args: item.args, url: item.url,
      env: item.env, headers: item.headers, inLibrary: found?.inLibrary === true, expectedVersion: found?.version ?? null };
    setSavedFingerprint(JSON.stringify([next, lines(item.env), lines(item.headers),item.enabled]));
    setDraft(next);
    setEnvText(lines(item.env)); setHeaderText(lines(item.headers)); setEnabled(item.enabled);
    setNotice(item.protectedValues ? '原生条目有受保护凭据值未导入；保存前请改用环境变量引用。' : '已读取当前工具上的条目。保存只更新这个 CLI。');
  }
  async function startNew() {
    if (!await canReplace()) return;
    setDraft(blank()); setEnvText(''); setHeaderText(''); setEnabled(true); setNativeOrigin(null); setCurrentConflict(null); setSyncLibrary(false);
    setSavedFingerprint(JSON.stringify([blank(), '', '', true])); setComposing(true); setNotice(''); setError('');
  }
  async function closeCompose() {
    if (!await canReplace()) return;
    const next = blank();
    setDraft(next); setEnvText(''); setHeaderText(''); setEnabled(true); setNativeOrigin(null); setCurrentConflict(null);
    setSavedFingerprint(JSON.stringify([next, '', '', true])); setComposing(false); setNotice(''); setError('');
  }
  function leaveComposer() {
    const next = blank();
    setDraft(next); setEnvText(''); setHeaderText(''); setEnabled(true); setNativeOrigin(null); setCurrentConflict(null);
    setSavedFingerprint(JSON.stringify([next, '', '', true])); setComposing(false);
  }
  async function applyItems(id: string, items: McpTargetResult[], replace: boolean) {
    const targets = items.filter(item => item.status === 'ready' || item.status === 'conflict').map((item): McpTargetRequest => ({ toolId: item.toolId, scope: item.scope,
      projectPath: item.projectPath, contextId: item.contextId ?? contextId, enabled, baselineHash: item.baselineHash, previewToken: item.previewToken, allowReplace: replace && item.status === 'conflict' }));
    const outcome = await native.distributeMcp(id, targets);
    setNativeEntries(await native.listNativeMcp(target)); setCurrentConflict(null);
    const written = outcome.every(item => item.status === 'written');
    setNotice(written ? '已写入当前工具。' : '部分写入失败，可重试。');
    return written;
  }
  async function save() {
    if (scope === 'project' && !project) { setError('请选择项目。'); return; }
    const origin = nativeOrigin; const started = latestForm.current;
    const editing = !!(draft.id || nativeOrigin);
    const linked = definitions.find((item) => item.id === draft.id) ?? definitions.find((item) => item.name === draft.name.trim());
    const inLibrary = editing ? linked?.inLibrary !== false : syncLibrary || linked?.inLibrary === true;
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await native.saveMcpDefinition({ ...draft, id: linked?.id ?? draft.id, expectedVersion: linked?.version ?? draft.expectedVersion, inLibrary, env: parseLines(envText), headers: parseLines(headerText) });
      setDefinitions(await native.listMcpDefinitions());
      if (!mounted.current || started !== latestForm.current) { setNotice('已写入当前工具前，表单又有改动，请再保存一次。'); return; }
      select(saved,enabled);
      const savedForm=JSON.stringify([draftOf(saved),lines(saved.env),lines(saved.headers),enabled]);
      const items = await native.previewMcpTargets(saved.id, [target]);
      const fresh = origin ? await native.listNativeMcp(target) : [];
      if (!mounted.current || savedForm!==latestForm.current) {setNotice('定义已保存，继续编辑的修改已保留，尚未写入当前工具。');return;}
      const sameOrigin = !!origin && JSON.stringify(fresh.find(item => item.name === origin.name)) === JSON.stringify(origin);
      if (items.some(item => item.status === 'conflict') && !sameOrigin) { setCurrentConflict({ id: saved.id, items }); return; }
      if (!items.some(item => item.status === 'ready' || item.status === 'conflict')) { setError(items.map(item => item.detail).join('；')); return; }
      if (await applyItems(saved.id, items, sameOrigin)) leaveComposer();
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function removeSaved() {
    const onTool = !!nativeOrigin || nativeEntries.some((entry) => entry.name === draft.name);
    const inLibrary = definitions.find((item) => item.id === draft.id)?.inLibrary === true;
    if (!onTool && !inLibrary) return;
    const name = draft.name || nativeOrigin?.name || '这个 MCP';
    const message = inLibrary
      ? `从当前工具移除「${name}」？资料库里的定义会保留，其他 CLI 不受影响。`
      : `从当前工具移除「${name}」？`;
    if (!await confirmAction(message, () => mounted.current, { title: '删除 MCP', confirmLabel: '删除', destructive: true })) return;
    setBusy(true); setError('');
    try {
      if (onTool) await native.removeNativeMcp({ ...target, enabled }, name);
      if (!inLibrary && draft.id && draft.expectedVersion !== null) await native.deleteMcpDefinition(draft.id, draft.expectedVersion);
      if (mounted.current) {
        setDefinitions(await native.listMcpDefinitions());
        setNativeEntries(await native.listNativeMcp(target).catch(() => []));
        setNotice('已删除。');
        leaveComposer();
      }
    } catch (value) { if (mounted.current) setError(errorText(value)); }
    finally { if (mounted.current) setBusy(false); }
  }

  if (capabilityBlocked) {
    return <div className={styles.taskEmpty}><p className={styles.error} role="alert">{capabilityBlocked}</p><p className={styles.muted}>当前工具不能添加可提交的 MCP，请查看上方原因。</p></div>;
  }

  if (empty) {
    return <div className={styles.taskEmpty}>
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      <button type="button" className={styles.primary} disabled={busy || (scope === 'project' && !project)} onClick={() => void startNew()}>添加 MCP</button>
      <p>添加后只写进当前这个 CLI。要给其他 CLI 用，勾选快速同步，再到资料库分发。</p>
      {scope === 'project' && !project && <p className={styles.muted}>请先选择项目目录。</p>}
    </div>;
  }

  return <>
    {!composing && notice && <p className={styles.notice} role="status">{notice}</p>}
    <div className={styles.layout}>
    <aside className={styles.list}>
      <div className={styles.listHead}><strong>当前生效 · {nativeEntries.length}</strong><button type="button" className={styles.primary} disabled={busy || (scope === 'project' && !project)} onClick={() => void startNew()}>添加</button></div>
      {nativeEntries.map((item) => <button key={`native-${item.name}`} type="button" title="点击修改" onClick={() => void importNative(item)}><strong>{item.name}<span className={styles.state} data-on={item.enabled || undefined}>{item.enabled ? '已启用' : '已停用'}</span></strong><small className={styles.mono}>{(item.transport === 'http' ? item.url : [item.command, ...item.args].join(' ')) || item.transport}{item.protectedValues ? ' · 凭据已隐藏' : ''}</small></button>)}
      {!nativeEntries.length && <p>这个 CLI 上还没有生效的 MCP。</p>}
    </aside>
    <GuideDialog open={composing} title={draft.id || nativeOrigin ? '修改 MCP' : '添加 MCP'} hint="写入当前这个 CLI。远程服务用 HTTP，本机进程用 stdio。SSE 不单独保存。" onClose={() => void closeCompose()}>
    <div className={styles.panel}>
      <label>MCP 服务器名称<input aria-label="名称" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如 chrome-devtools" /></label>
      <div className={styles.typeField}><span>MCP 服务器类型</span><div className={styles.typeSwitch} role="radiogroup" aria-label="连接方式">{([['http', 'HTTP'], ['stdio', 'stdio']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={draft.transport === value} onClick={() => setDraft({ ...draft, transport: value })}>{label}</button>)}</div></div>
      {draft.transport === 'stdio' ? <>
        <label>命令<input aria-label="命令" value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx" /></label>
        <label>参数，每行一项<textarea rows={3} value={draft.args.join('\n')} onChange={(event) => setDraft({ ...draft, args: event.target.value.split('\n').filter(Boolean) })} placeholder={'-y\nchrome-devtools-mcp@latest'} /></label>
        <label>环境变量<textarea rows={4} value={envText} onChange={(event) => setEnvText(event.target.value)} placeholder={'KEY=value\nAPI_TOKEN=${API_TOKEN}'} /></label>
      </> : <>
        <label>URL<input aria-label="网址" value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp" /></label>
        <label>请求头<textarea rows={4} value={headerText} onChange={(event) => setHeaderText(event.target.value)} placeholder="Authorization=Bearer ${API_TOKEN}" /></label>
      </>}
      <label className={styles.inline}><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用</label>
      {!(draft.id || nativeOrigin) && <label className={styles.inline}><input type="checkbox" checked={syncLibrary} onChange={(event) => setSyncLibrary(event.target.checked)} />快速同步<small className={styles.fieldHint}>同时放进资料库。分发到其他 CLI 请到资料库。</small></label>}
      {currentConflict && <div className={styles.resultList} role="group" aria-label="MCP 写入冲突"><strong>当前同名条目与读取时不同，请比较后选择</strong>{currentConflict.items.map(item => <div className={styles.fileDiff} key={item.toolId}><CodeEditor compact label="当前 MCP" format="json" readOnly value={JSON.stringify(item.existing, null, 2)} /><CodeEditor compact label="本次 MCP 修改" format="json" readOnly value={JSON.stringify(item.proposed, null, 2)} /></div>)}<div className={styles.actions}><button type="button" onClick={() => setCurrentConflict(null)}>保留当前文件</button><button type="button" disabled={busy} onClick={() => { setBusy(true); void applyItems(currentConflict.id, currentConflict.items, true).then(ok => { if (ok) leaveComposer(); }).catch(value => setError(errorText(value))).finally(() => setBusy(false)); }}>使用本次修改</button></div></div>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      <div className="dialog-footer">{(draft.id || nativeOrigin) && <button type="button" disabled={busy} onClick={() => void removeSaved()}>从当前工具移除</button>}<span className="dialog-footer-gap" /><button type="button" className={styles.primary} data-dialog-save title={saveShortcutHint} disabled={busy || !draft.name.trim() || (scope === 'project' && !project)} onClick={() => void save()}>{draft.id || nativeOrigin ? '保存' : '添加'}</button></div>
    </div>
    </GuideDialog>
  </div>
  </>;
}

export function SkillsWorkspace({ toolId, scope, projectPath, contextId, onDirtyChange }: { toolId: string; scope: Scope; projectPath: string; contextId?: string | null; onDirtyChange?: (dirty: boolean) => void }) {
  const [packages, setPackages] = useState<SkillPackage[]>([]);
  const [nativeEntries, setNativeEntries] = useState<NativeSkillEntry[]>([]);
  const [recoveryIssues, setRecoveryIssues] = useState<SkillRecoveryIssue[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installations, setInstallations] = useState<SkillInstallation[]>([]);
  const [url, setUrl] = useState('');
  const [archiveSelection, setArchiveSelection] = useState<{ source: string; local: boolean; entries: string[]; chosen: string | null } | null>(null);
  const [pendingImport, setPendingImport] = useState<{ preview: SkillImportPreview; kind: 'local' | 'zip' | 'local_zip'; source: string; subdirectory: string | null; installAfter: boolean } | null>(null);
  const [dependencyChecked, setDependencyChecked] = useState(false);
  const [skillEnabled, setSkillEnabled] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<SkillTargetPreview | null>(null);
  const [adding, setAdding] = useState(false);
  const [guide, setGuide] = useState(false);
  const [syncLibrary, setSyncLibrary] = useState(false);
  const [external, setExternal] = useState<NativeSkillEntry | null>(null);
  useLayoutEffect(() => { onDirtyChange?.(!!url.trim() || !!archiveSelection || !!pendingImport || adding); }, [url, archiveSelection, pendingImport, adding, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SkillTargetResult | null>(null);
  useEffect(() => {
    if (!result || result.status === 'failed') return;
    const timer = window.setTimeout(() => setResult(null), 5000);
    return () => window.clearTimeout(timer);
  }, [result]);
  const selected = packages.find((item) => item.id === selectedId);
  const project = scope === 'project' ? projectPath || null : null;
  const visibleIssues = recoveryIssues.filter((issue) => issue.toolId === toolId && (issue.scope === 'project' || (issue.contextId ?? null) === (contextId ?? null)));
  const empty = !nativeEntries.length && !adding && !guide && !pendingImport && !archiveSelection;
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
  const installed = installations.find((item) => item.toolId === toolId && item.scope === scope && item.projectPath === project && (item.contextId ?? null) === (scope === 'global' ? contextId ?? null : null));
  useEffect(() => { void native.listSkillPackages().then(setPackages).catch((value) => setError(errorText(value))); }, []);
  useEffect(() => {
    if (!selectedId) return;
    let live = true;
    void Promise.all([native.listSkillInstallations(selectedId),native.getSkillEnabled(selectedId,toolId,scope,project)]).then(([items,enabled]) => { if (live) {setInstallations(items);setSkillEnabled(enabled);} })
      .catch((value) => { if (live) setError(errorText(value)); });
    return () => { live = false; };
  }, [selectedId, toolId, scope, project]);

  async function installPackage(packageId: string) {
    if (scope === 'project' && !project) { setError('请先在工具页打开项目目录。'); return; }
    const item = (await native.listSkillPackages()).find((entry) => entry.id === packageId);
    if (!item) return;
    if (item.compatibility && !dependencyChecked) { setError('请先检查并确认 Skills 的环境依赖要求。'); setSelectedId(packageId); return; }
    const targetPreview = await native.previewSkillTarget(packageId, toolId, scope, project);
    if (targetPreview.status === 'conflict') { setPendingTarget(targetPreview); setSelectedId(packageId); return; }
    const outcome = await native.installSkill(packageId, toolId, scope, project, targetPreview.previewToken, false);
    setResult(outcome);
    setInstallations(await native.listSkillInstallations(packageId));
    setNativeEntries(await native.scanNativeSkills(toolId, scope, project));
    setSkillEnabled(await native.getSkillEnabled(packageId, toolId, scope, project));
    setRecoveryIssues(await native.listSkillRecoveryIssues());
    if (outcome.status !== 'failed') { setGuide(false); setAdding(false); }
  }

  async function place(item: SkillPackage, existed: boolean) {
    if (syncLibrary) await native.setSkillInLibrary(item.id, true);
    else if (!existed) await native.setSkillInLibrary(item.id, false);
    await finishImported(item, true);
  }

  async function finishImported(item: SkillPackage, installAfter: boolean) {
    setPackages(await native.listSkillPackages());
    setSelectedId(item.id);
    setResult(null);
    setAdding(false);
    if (installAfter) await installPackage(item.id);
    else setGuide(false);
  }

  async function local() {
    try {
      const source = await open({ directory: true, multiple: false, title: '选择包含 SKILL.md 的目录' });
      if (typeof source !== 'string') return;
      setBusy(true); setError('');
      const preview = await native.previewSkillLocal(source);
      if (preview.existingDigest && preview.existingDigest !== preview.digest) {
        setPendingImport({ preview, kind: 'local', source, subdirectory: null, installAfter: true }); return;
      }
      const item = await native.importSkillLocal(source, preview.digest, preview.existingDigest);
      await place(item, !!preview.existingDigest);
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
        setPendingImport({ preview, kind: localZip ? 'local_zip' : 'zip', source, subdirectory: child, installAfter: true }); setArchiveSelection(null); return;
      }
      const item = localZip ? await native.importSkillLocalZip(source, child, preview.digest, preview.existingDigest) : await native.importSkillHttpsZip(source, child, preview.digest, preview.existingDigest);
      await place(item, !!preview.existingDigest);
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
      const { preview, kind, source, subdirectory, installAfter } = pendingImport;
      const item = kind === 'local'
        ? await native.importSkillLocal(source, preview.digest, preview.existingDigest)
        : kind === 'local_zip' ? await native.importSkillLocalZip(source, subdirectory, preview.digest, preview.existingDigest)
        : await native.importSkillHttpsZip(source, subdirectory, preview.digest, preview.existingDigest);
      setPendingImport(null);
      if (kind === 'zip') setUrl('');
      if (installAfter) await place(item, !!preview.existingDigest);
      else { await native.setSkillInLibrary(item.id, true); setGuide(false); setExternal(null); setResult({ toolId, scope, projectPath: project, path: item.name, status: 'installed', detail: '已放进资料库' }); }
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function openNative(entry: NativeSkillEntry) {
    if (entry.state === 'unreadable') { setError(entry.detail); return; }
    setAdding(false);
    setExternal(entry.packageId ? null : entry);
    setSelectedId(entry.packageId);
    setGuide(true);
  }
  async function syncExternal() {
    if (!external) return;
    setBusy(true); setError('');
    try {
      const preview = await native.previewSkillLocal(external.path);
      if (preview.existingDigest && preview.existingDigest !== preview.digest) {
        setPendingImport({ preview, kind: 'local', source: external.path, subdirectory: null, installAfter: false }); return;
      }
      const item = await native.importSkillLocal(external.path, preview.digest, preview.existingDigest);
      await native.setSkillInLibrary(item.id, true);
      setResult({ toolId, scope, projectPath: project, path: item.name, status: 'installed', detail: '已放进资料库' });
      setGuide(false); setExternal(null);
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
      const outcome = remove ? await native.removeSkill(selected.id, toolId, scope, project, contextId)
        : await native.installSkill(selected.id, toolId, scope, project, targetPreview?.previewToken ?? null, targetPreview?.status === 'conflict');
      setResult(outcome);
      setPendingTarget(null);
      setInstallations(await native.listSkillInstallations(selected.id));
      setNativeEntries(await native.scanNativeSkills(toolId, scope, project));
      setSkillEnabled(await native.getSkillEnabled(selected.id,toolId,scope,project));
      setRecoveryIssues(await native.listSkillRecoveryIssues());
      if (outcome.status !== 'failed') { setGuide(false); setAdding(false); }
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }
  async function toggleSkill(next: boolean) {
    if (!selected) return; setBusy(true);setError('');
    try {await native.setSkillEnabled(selected.id,toolId,scope,project,next,contextId);setSkillEnabled(await native.getSkillEnabled(selected.id,toolId,scope,project));setInstallations(await native.listSkillInstallations(selected.id));setNativeEntries(await native.scanNativeSkills(toolId,scope,project));}
    catch(value){setError(errorText(value));}finally{setBusy(false);}
  }
  async function checkRecovery() {
    try { setRecoveryIssues(await native.listSkillRecoveryIssues()); setError(''); }
    catch (value) { setError(errorText(value)); }
  }

  const recovery = !!visibleIssues.length && <div className={styles.error} role="alert"><strong>Skills 安装需要检查</strong><p>相关 CLI 启动会暂停。异常备份已保留；检查目录后可重新尝试恢复。</p>{visibleIssues.map((issue) => <div key={issue.operationId} className={styles.fileChange}><strong>{issue.scope === 'global' ? '全局' : `项目 ${issue.projectPath ?? ''}`}</strong><p>{issue.detail}</p><p>目标：{issue.targetPath}</p><p>备份：{issue.backupPath}</p><button type="button" onClick={() => void navigator.clipboard.writeText(issue.backupPath).catch((value) => setError(errorText(value)))}>复制备份路径</button></div>)}<button type="button" onClick={() => void checkRecovery()}>重新检查恢复状态</button></div>;
  const outcome = result && (result.status === 'failed' ? result.detail : result.detail === '已放进资料库' ? '已放进资料库。分发请到资料库。' : result.status === 'removed' ? `已从当前工具移除：${result.path ?? ''}` : `已安装到当前工具：${result.path ?? ''}`);
  const installState: { label: string; tone: 'on' | 'warn' | undefined } = installed?.state === 'current' ? { label: '已安装', tone: 'on' }
    : installed?.state === 'update_available' ? { label: '有更新', tone: 'warn' }
    : installed?.state === 'conflict' ? { label: '原生目录有外部修改', tone: 'warn' }
    : installed?.state === 'disabled' ? { label: '已停用 · 内容已保留', tone: undefined }
    : installed?.state === 'missing' ? { label: '原生目录缺失', tone: 'warn' }
    : { label: '未安装', tone: undefined };

  if (empty) {
    return <div className={styles.taskEmpty}>
      {recovery}
      {outcome && <p role="status" className={result?.status === 'failed' ? styles.error : styles.notice}>{outcome}</p>}
      <button type="button" className={styles.primary} disabled={busy || (scope === 'project' && !project)} onClick={() => { setAdding(true); setSyncLibrary(false); setExternal(null); setGuide(true); }}>添加 Skill</button>
      <p>添加后只装进当前这个 CLI。勾选快速同步后，可以在资料库里分发。</p>
      {scope === 'project' && !project && <p className={styles.muted}>请先选择项目目录。</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>;
  }

  return <>
    {recovery}
    {!guide && outcome && <p role="status" className={result?.status === 'failed' ? styles.error : styles.notice}>{outcome}</p>}
    <div className={styles.layout}>
    <aside className={styles.list}>
      <div className={styles.listHead}><strong>当前生效 · {nativeEntries.length}</strong><button type="button" className={styles.primary} disabled={busy || (scope === 'project' && !project)} onClick={() => { setAdding(true); setSyncLibrary(false); setExternal(null); setGuide(true); }}>添加</button></div>
      {nativeEntries.map((entry) => <button type="button" key={entry.path} title={entry.state === 'unreadable' ? entry.detail : entry.path} onClick={() => void openNative(entry)}><strong>{entry.name}<span className={styles.state} data-on={entry.state === 'managed' || undefined} data-warn={entry.state === 'unreadable' || undefined}>{entry.state === 'managed' ? '已安装' : entry.state === 'external' ? '本机目录' : '暂不可读取'}</span></strong><small className={styles.mono}>{displayPath(entry.path)}</small></button>)}
      {!nativeEntries.length && <p>这个 CLI 上还没有生效的 Skill。</p>}
    </aside>
    <GuideDialog open={guide} title={adding ? '添加 Skill' : '当前 Skill'} hint={adding ? '装进当前这个 CLI。快速同步会同时放进资料库。' : '这里只改当前这个 CLI 上已经生效的 Skill。'} onClose={() => { setGuide(false); setAdding(false); setSyncLibrary(false); setExternal(null); setArchiveSelection(null); setPendingImport(null); }}>
    <div className={styles.panel}>
      {!adding && <div className={styles.heading}><div><small>Skill</small><h2>{selected?.name ?? 'Skill'}</h2></div></div>}
      {adding && <>
        <label className={styles.inline}><input type="checkbox" checked={syncLibrary} onChange={(event) => setSyncLibrary(event.target.checked)} />快速同步<small className={styles.fieldHint}>同时放进资料库。分发到其他 CLI 请到资料库。</small></label>
        <div className={styles.sources}>
          <button type="button" aria-label="选择文件夹" disabled={busy} onClick={() => void local()}><strong>选择文件夹</strong><span>目录里要有 SKILL.md</span></button>
          <button type="button" aria-label="导入 ZIP 文件" disabled={busy} onClick={() => void localZip()}><strong>导入 ZIP 文件</strong><span>本机上的 .zip</span></button>
        </div>
        <label className={styles.urlField}>ZIP 地址<span className={styles.urlRow}><input aria-label="归档地址" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/skill.zip" /><button type="button" disabled={busy || !url.trim()} onClick={() => void archive(url.trim(), false)}>导入地址</button></span></label>
      </>}
      {external && !adding && <div className={styles.addChooser}><p className={styles.muted}>这是当前工具上已有的目录。放进资料库后，再到资料库分发。</p><button type="button" className={styles.primary} disabled={busy} onClick={() => void syncExternal()}>放进资料库</button></div>}
      {outcome && <p role="status" className={result?.status === 'failed' ? styles.error : styles.notice}>{outcome}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {selected && !adding && <>
        <p className={styles.muted}>{selected.description || '完整 Skills 包'} · {selected.fileCount} 个文件</p><details className={styles.source}><summary title={displayPath(selected.source)}>来源 · {shortPath(selected.source)}</summary><p>{displayPath(selected.source)}</p></details>
        {selected.compatibility && <label className={styles.inline}><input type="checkbox" checked={dependencyChecked} onChange={(event) => setDependencyChecked(event.target.checked)} />已检查所需环境：{selected.compatibility}</label>}
        <label className={styles.inline}><input type="checkbox" aria-label="启用 Skill" checked={skillEnabled} disabled={busy || !installed && !nativeEntries.some(item=>item.name===selected.name) && !skillEnabled} onChange={event => void toggleSkill(event.target.checked)} />{skillEnabled ? '这个工具会使用它' : '已停用'}</label>
        <p className={styles.muted}><span className={styles.state} data-on={installState.tone === 'on' || undefined} data-warn={installState.tone === 'warn' || undefined}>{installState.label}</span>{skillEnabled ? '启用不表示进程已启动。' : '已停用，内容仍保留在当前范围。'}</p>
        {pendingTarget && <div className={styles.resultList} role="group" aria-label="Skills 目标预览"><strong>{pendingTarget.status === 'conflict' ? '原生 Skills 内容不同，请确认接管' : '确认安装内容'}</strong><p>{pendingTarget.detail} · {pendingTarget.path}</p>
          {pendingTarget.changes.map((change) => <details key={change.path} className={styles.fileChange}><summary>{change.path}</summary><div className={styles.fileDiff}><div><strong>当前</strong>{change.before !== null ? <pre>{change.before}</pre> : <small>{change.beforeSize === null ? '不存在' : `${change.beforeSize} 字节 · SHA-256 ${change.beforeDigest}`}</small>}</div><div><strong>安装后</strong>{change.after !== null ? <pre>{change.after}</pre> : <small>{change.afterSize === null ? '删除' : `${change.afterSize} 字节 · SHA-256 ${change.afterDigest}`}</small>}</div></div></details>)}
          <div className={styles.actions}><button type="button" onClick={() => setPendingTarget(null)}>取消</button><button type="button" className={styles.primary} disabled={busy} onClick={() => void change(false)}>{pendingTarget.status === 'conflict' ? '确认接管并替换' : '确认安装'}</button></div>
        </div>}
        <div className="dialog-footer">{installed && <button type="button" disabled={busy} onClick={() => void change(true)}>从当前工具移除</button>}<span className="dialog-footer-gap" />{installed?.state === 'update_available' && <button type="button" className={styles.primary} disabled={busy || (scope === 'project' && !project)} onClick={() => void change(false)}>更新到当前范围</button>}</div>
      </>}
      {archiveSelection && <div className={styles.distribution}><label>选择归档中的 Skill<select aria-label="归档中的 Skill" value={archiveSelection.chosen ?? '__choose__'} onChange={event => setArchiveSelection({ ...archiveSelection, chosen: event.target.value === '__choose__' ? null : event.target.value })}><option value="__choose__">选择 Skill…</option>{archiveSelection.entries.map(entry => <option key={entry} value={entry}>{entry || '归档根目录'}</option>)}</select></label><div className={styles.actions}><button type="button" onClick={() => setArchiveSelection(null)}>取消</button><button type="button" disabled={busy || archiveSelection.chosen === null} onClick={() => void archive(archiveSelection.source, archiveSelection.local, archiveSelection.chosen ?? undefined)}>导入所选 Skill</button></div></div>}
      {pendingImport && <div className={styles.resultList} role="group" aria-label="Skills 同名更新预览">
        <strong>同名 Skill「{pendingImport.preview.name}」内容不同</strong>
        <p>{pendingImport.installAfter ? '确认后会替换这一份，并安装到当前这个 CLI。' : '确认后只放进资料库，不改当前工具上的文件。'}</p>
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
        <div className={styles.actions}><button type="button" onClick={() => setPendingImport(null)}>取消，保留现有包</button><button type="button" className={styles.primary} disabled={busy} onClick={() => void confirmImport()}>{pendingImport.installAfter ? '确认并安装到当前工具' : '确认放入资料库'}</button></div>
      </div>}
    </div>
    </GuideDialog>
  </div>
  </>;
}
