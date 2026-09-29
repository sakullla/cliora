import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { native, nativeAvailable } from '../../lib/native';
import { CLI_NAMES } from '../../types/domain';
import type { ApiError, CliId } from '../../types/domain';
import { emptyProfile } from '../../types/native';
import type { CommonConfig, Connection, ModelDirectory, NativePreview, NativeProfile, Scope, ToolWorkspace } from '../../types/native';
import styles from './ToolWorkspace.module.css';

type View = 'form' | 'native' | 'merged';
type Editor = 'profile' | 'common';

function errorText(value: unknown): string {
  if (value && typeof value === 'object' && 'message' in value) return String((value as ApiError).message);
  return '操作失败，请重试。';
}

function defaultConnection(formats: string[]): Connection {
  return { providerId: '', interfaceFormat: formats[0] ?? 'openai_responses', baseUrl: '', model: '', secretRef: null, authEnvVar: null };
}

function formatLabel(value: string): string {
  return ({ openai_completions: 'Chat Completions', openai_responses: 'Responses', anthropic_messages: 'Anthropic Messages' } as Record<string, string>)[value] ?? value;
}

export function ToolWorkspacePage({ managedTools, initialTool }: { managedTools: CliId[]; initialTool?: CliId }) {
  const [tool, setTool] = useState<CliId>(initialTool ?? managedTools[0] ?? 'codex');
  const [scope, setScope] = useState<Scope>('global');
  const [projectPath, setProjectPath] = useState('');
  const [projectInput, setProjectInput] = useState('');
  const [workspace, setWorkspace] = useState<ToolWorkspace | null>(null);
  const [editor, setEditor] = useState<Editor>('profile');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NativeProfile | null>(null);
  const [commonDraft, setCommonDraft] = useState<CommonConfig | null>(null);
  const [view, setView] = useState<View>('native');
  const [role, setRole] = useState('settings');
  const [preview, setPreview] = useState<NativePreview | null>(null);
  const [modelDirectory, setModelDirectory] = useState<ModelDirectory | null>(null);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [newSecret, setNewSecret] = useState('');
  const [customPath, setCustomPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [takeoverId, setTakeoverId] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const modelSequence = useRef(0);
  const previewSequence = useRef(0);
  const savedDraft = useRef('');

  const visibleTools = managedTools;
  const currentTool = visibleTools.includes(tool) ? tool : visibleTools[0];
  const connection = draft?.connection ?? null;
  const dirty = editor === 'profile' ? !!draft && JSON.stringify(draft) !== savedDraft.current : !!commonDraft && JSON.stringify(commonDraft) !== savedDraft.current;

  const reload = useCallback(async (nextTool: CliId, nextScope: Scope, nextProject: string, preferredId?: string | null) => {
    if (!nativeAvailable || (nextScope === 'project' && !nextProject.trim())) { loadSequence.current++; setWorkspace(null); return; }
    const sequence = ++loadSequence.current;
    setLoading(true); setError('');
    try {
      const result = await native.getToolWorkspace(nextTool, nextScope, nextProject);
      if (sequence !== loadSequence.current) return;
      setWorkspace(result);
      setEditor('profile');
      setCustomPath(result.customPath ?? '');
      const next = result.profiles.find((item) => item.id === preferredId) ?? result.profiles.find((item) => item.id === result.binding?.profileId) ?? result.profiles[0] ?? null;
      setSelectedId(next?.id ?? null);
      setDraft(next ? structuredClone(next) : null);
      savedDraft.current = next ? JSON.stringify(next) : '';
      setCommonDraft(result.common ? structuredClone(result.common) : { tool: nextTool, version: 0, files: {} });
      setRole(result.probe.nativeFiles.find((item) => !item.sensitive)?.role ?? 'settings');
    } catch (value) {
      if (sequence === loadSequence.current) { setWorkspace(null); setError(errorText(value)); }
    } finally { if (sequence === loadSequence.current) setLoading(false); }
  }, []);

  useEffect(() => { if (currentTool) void reload(currentTool, scope, projectPath); }, [currentTool, scope, projectPath, reload]);

  useEffect(() => {
    if (!nativeAvailable || view !== 'merged' || !draft || editor !== 'profile') return;
    const sequence = ++previewSequence.current;
    const timer = window.setTimeout(() => {
      void native.previewNativeProfile(draft, scope).then((result) => { if (sequence === previewSequence.current) { setPreview(result); setError(''); } }).catch((value) => { if (sequence === previewSequence.current) { setPreview(null); setError(errorText(value)); } });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [draft, editor, scope, view]);

  const refreshModels = useCallback(async (source: Connection, force: boolean) => {
    if (!nativeAvailable || !source.baseUrl.trim()) return;
    const sequence = ++modelSequence.current;
    setModelLoading(true);
    try {
      const result = await native.listProviderModels(source, force);
      if (sequence === modelSequence.current) setModelDirectory(result);
    } catch (value) {
      if (sequence === modelSequence.current) setModelDirectory({ models: [], status: 'error', fetchedAt: null, source: 'provider_directory', error: errorText(value) });
    } finally { if (sequence === modelSequence.current) setModelLoading(false); }
  }, []);

  useEffect(() => {
    modelSequence.current++;
    setModelLoading(false);
    if (!connection) { setModelDirectory(null); return; }
    setModelDirectory(null);
    const timer = window.setTimeout(() => { void refreshModels(connection, false); }, 500);
    return () => window.clearTimeout(timer);
  }, [connection?.providerId, connection?.interfaceFormat, connection?.baseUrl, connection?.secretRef, refreshModels]);

  const modelOptions = useMemo(() => (modelDirectory?.models ?? []).filter((id) => id.toLowerCase().includes(modelSearch.trim().toLowerCase())), [modelDirectory, modelSearch]);
  const availableRoles = workspace?.probe.nativeFiles.filter((item) => !item.sensitive).map((item) => item.role) ?? ['settings'];
  const activeFile = workspace?.probe.nativeFiles.find((item) => item.role === role);

  function selectProfile(profile: NativeProfile) {
    if (dirty && !window.confirm('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return;
    setEditor('profile'); setSelectedId(profile.id); setDraft(structuredClone(profile)); savedDraft.current = JSON.stringify(profile);
    setError(''); setNotice(''); setTakeoverId(null);
  }

  function createProfile() {
    if (!currentTool) return;
    if (dirty && !window.confirm('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return;
    const next = emptyProfile(currentTool);
    setEditor('profile'); setSelectedId(null); setDraft(next); savedDraft.current = JSON.stringify(next);
    setView('form'); setError(''); setNotice(''); setTakeoverId(null);
  }

  function editCommon() {
    if (!currentTool) return;
    if (dirty && !window.confirm('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return;
    const next = structuredClone(workspace?.common ?? { tool: currentTool, version: 0, files: {} });
    setEditor('common'); setCommonDraft(next); savedDraft.current = JSON.stringify(next);
    setView('native'); setError(''); setNotice('');
  }

  async function save(applyAfter: boolean) {
    if (!nativeAvailable || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (editor === 'common' && commonDraft) {
        const result = await native.saveCommonConfig(commonDraft, commonDraft.version || null);
        const saved = result.common;
        setCommonDraft(saved); savedDraft.current = JSON.stringify(saved);
        const failed = result.applications.filter((item) => item.status === 'failed');
        setNotice(failed.length ? `通用配置已保存；${failed.length} 个活动范围未能应用，请检查并重试。` : `通用配置已保存；${result.applications.length} 个活动范围已检查并应用。`);
        if (currentTool) await reload(currentTool, scope, projectPath, selectedId);
        setEditor('common');
        setCommonDraft(saved); savedDraft.current = JSON.stringify(saved);
      } else if (draft && currentTool) {
        const saved = await native.saveNativeProfile(draft, draft.version || null);
        setDraft(saved); savedDraft.current = JSON.stringify(saved);
        setSelectedId(saved.id);
        if (applyAfter) {
          const outcome = await native.applyNativeProfile(currentTool, saved.id, scope, projectPath, false);
          setNotice(outcome.status === 'already_matching' ? '原生文件已与配置一致。' : '原生文件已写入；下次启动时仍受 CLI 的配置优先级和项目信任规则影响。');
        } else setNotice('配置草稿已保存，当前原生文件尚未更改。');
        await reload(currentTool, scope, projectPath, saved.id);
      }
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }

  async function applySaved(profile: NativeProfile, allowTakeover = false) {
    if (!currentTool || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const outcome = await native.applyNativeProfile(currentTool, profile.id, scope, projectPath, allowTakeover);
      setTakeoverId(null);
      setNotice(outcome.status === 'already_matching' ? '原生文件已与配置一致。' : '原生文件已写入；下次启动时仍受 CLI 的配置优先级和项目信任规则影响。');
      await reload(currentTool, scope, projectPath, profile.id);
    } catch (value) {
      const message = errorText(value);
      setError(message);
      setTakeoverId(message.includes('请确认接管') ? profile.id : null);
    } finally { setBusy(false); }
  }

  async function saveSecret() {
    if (!newSecret || !draft?.connection) return;
    setBusy(true); setError('');
    try {
      const secretRef = await native.setConnectionSecret(newSecret);
      setDraft({ ...draft, connection: { ...draft.connection, secretRef } });
      setNewSecret(''); setNotice('目录密钥已保存到系统凭据库；请继续保存配置。');
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }

  async function choosePath() {
    if (!currentTool || busy) return;
    setBusy(true); setError('');
    try { await native.setCustomCliPath(currentTool, customPath.trim() || null); await reload(currentTool, scope, projectPath, selectedId); setNotice('CLI 路径已保存并重新检测。'); }
    catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }

  async function deleteCurrent() {
    if (!draft?.id || !currentTool || busy) return;
    if (!window.confirm(`删除命名配置“${draft.name}”？已经写入的原生文件不会自动删除。`)) return;
    setBusy(true); setError('');
    try {
      await native.deleteNativeProfile(draft.id, draft.version);
      await reload(currentTool, scope, projectPath);
      setNotice('命名配置已删除，原生文件保持原样。');
    } catch (value) { setError(errorText(value)); }
    finally { setBusy(false); }
  }

  if (!visibleTools.length) return <div className={styles.empty}>还没有管理中的 CLI。请先在设置里选择要管理的工具。</div>;

  return <section className={styles.workspace} aria-label="工具与连接">
    <div className={styles.toolbar}>
      <div className={styles.toolSwitcher} role="tablist" aria-label="CLI">{visibleTools.map((id) => <button key={id} type="button" role="tab" aria-selected={currentTool === id} className={currentTool === id ? styles.selected : ''} onClick={() => { if (dirty && !window.confirm('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return; setTool(id); }}>{CLI_NAMES[id]}</button>)}</div>
      <div className={styles.scopeBar}><label>配置范围 <select value={scope} onChange={(event) => { if (dirty && !window.confirm('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return; setScope(event.target.value as Scope); }}><option value="global">全局</option><option value="project">项目</option></select></label>{scope === 'project' && <><input aria-label="项目目录" placeholder="项目目录的完整路径" value={projectInput} onChange={(event) => setProjectInput(event.target.value)} /><button type="button" onClick={() => { if (dirty && !window.confirm('当前草稿尚未保存，切换后会丢失这些修改。继续吗？')) return; setProjectPath(projectInput.trim()); }}>打开项目</button></>}</div>
    </div>
    {scope === 'project' && !projectPath.trim() && <p className={styles.hint}>填写项目目录并点击打开后，才会读取该项目的原生配置。切换配置范围不会修改启动目录。</p>}
    {loading && <p className={styles.hint} role="status">正在检测 CLI 与原生文件…</p>}
    {error && <div className={styles.error} role="alert">{error}{takeoverId && workspace?.profiles.find((item) => item.id === takeoverId) && <button type="button" onClick={() => { const profile = workspace.profiles.find((item) => item.id === takeoverId); if (profile) void applySaved(profile, true); }}>确认接管该字段</button>}</div>}
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    {workspace && <>
      <div className={styles.installBar}>
        <span className={styles.statusDot} data-ok={workspace.probe.nativeWrites.state === 'supported'} />
        <span><strong>{workspace.probe.selectedPath ? `${CLI_NAMES[currentTool]} ${workspace.probe.installations.find((item) => item.path === workspace.probe.selectedPath)?.version ?? ''}` : `${CLI_NAMES[currentTool]} 未确认安装`}</strong><small>{workspace.probe.nativeWrites.reason}</small></span>
        <a href={workspace.probe.installUrl} target="_blank" rel="noreferrer">官方安装说明 ↗</a>
      </div>
      <details className={styles.pathControl}><summary>检测路径与升级</summary><div><input aria-label="CLI 可执行文件路径" value={customPath} onChange={(event) => setCustomPath(event.target.value)} placeholder="自定义可执行文件完整路径" /><button type="button" onClick={() => void choosePath()} disabled={busy}>保存并重检</button></div><p>{workspace.probe.upgradeHint}</p>{workspace.probe.installations.map((item) => <p key={item.path}>{item.status === 'available' ? '可用' : '检测失败'} · {item.path} {item.detail ?? ''}</p>)}</details>
      {!!workspace.recoveryNeeded.length && <div className={styles.error}>有 {workspace.recoveryNeeded.length} 项原生文件事务需要恢复。请检查目标文件和本机凭据库后重试。<button type="button" onClick={() => { void native.recoverNativeTransactions().then(() => currentTool && reload(currentTool, scope, projectPath, selectedId)); }}>重试恢复</button></div>}
      <div className={styles.columns}>
        <aside className={styles.profileList} aria-label="命名配置"><div className={styles.listHeading}><strong>命名配置</strong><button type="button" onClick={createProfile}>＋ 新建</button></div>
          <button type="button" className={editor === 'common' ? styles.activeProfile : ''} onClick={editCommon}><strong>通用配置</strong><small>供本工具的命名配置继承</small></button>
          {workspace.profiles.map((item) => <button key={item.id} type="button" className={editor === 'profile' && selectedId === item.id ? styles.activeProfile : ''} onClick={() => selectProfile(item)}><strong>{item.name}</strong><small>{workspace.binding?.profileId === item.id ? '✓ 当前已应用' : item.connection?.model || '未应用'}</small></button>)}
          {!workspace.profiles.length && <p>还没有命名配置。可以新建，或从下方原生文件开始。</p>}
        </aside>
        <div className={styles.editor}>
          <div className={styles.editorHead}><div><small>{editor === 'common' ? '同工具基础' : '命名原生配置'}</small><h2>{editor === 'common' ? '通用配置' : draft?.name || '新配置'}</h2></div><span>{scope === 'global' ? '全局' : '项目'}</span></div>
          {editor === 'profile' && !draft ? <div className={styles.empty}>选择一份配置，或新建一份。</div> : <>
            <div className={styles.views} role="tablist" aria-label="配置视图"><button type="button" className={view === 'form' ? styles.selected : ''} onClick={() => setView('form')} disabled={editor === 'common'}>常用设置</button><button type="button" className={view === 'native' ? styles.selected : ''} onClick={() => setView('native')}>原生文件</button><button type="button" className={view === 'merged' ? styles.selected : ''} onClick={() => setView('merged')} disabled={editor === 'common'}>合并结果</button></div>
            {view === 'form' && editor === 'profile' && draft && <div className={styles.form}>
              <label>配置名称<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：日常开发" /></label>
              <label className={styles.check}><input type="checkbox" checked={draft.inheritCommon} onChange={(event) => setDraft({ ...draft, inheritCommon: event.target.checked })} />继承本工具通用配置</label>
              <div className={styles.formDivider}><strong>连接与模型</strong><label className={styles.check}><input type="checkbox" checked={!!draft.connection} onChange={(event) => setDraft({ ...draft, connection: event.target.checked ? defaultConnection(workspace.probe.interfaceFormats) : null })} />配置供应商连接</label></div>
              {connection && <>
                <div className={styles.formGrid}><label>供应商 ID<input value={connection.providerId} onChange={(event) => setDraft({ ...draft, connection: { ...connection, providerId: event.target.value } })} placeholder="my-provider" /></label><label>接口格式<select value={connection.interfaceFormat} onChange={(event) => setDraft({ ...draft, connection: { ...connection, interfaceFormat: event.target.value } })}>{workspace.probe.interfaceFormats.includes(connection.interfaceFormat as never) ? null : <option value={connection.interfaceFormat}>未知格式 · 只读</option>}{workspace.probe.interfaceFormats.map((item) => <option key={item} value={item}>{formatLabel(item)}</option>)}</select></label></div>
                <label>API 地址<input value={connection.baseUrl} onChange={(event) => setDraft({ ...draft, connection: { ...connection, baseUrl: event.target.value } })} placeholder="https://api.example.com/v1" /></label>
                <div className={styles.formGrid}><label>模型 ID<input list="native-model-options" value={connection.model} onChange={(event) => setDraft({ ...draft, connection: { ...connection, model: event.target.value } })} placeholder="直接输入或从目录选择" /><datalist id="native-model-options">{modelOptions.map((model) => <option key={model} value={model} />)}</datalist></label><label>搜索已获取模型<input value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="筛选目录" /></label></div>
                <div className={styles.modelBar}><span>{modelLoading ? '正在读取供应商模型目录…' : modelDirectory?.status === 'ready' ? `目录列出 ${modelDirectory.models.length} 个模型` : modelDirectory?.status === 'empty' ? '供应商返回空目录，可直接填写' : modelDirectory?.status === 'stale' ? `显示旧缓存：${modelDirectory.error}` : modelDirectory?.error ?? '模型 ID 可直接填写'}</span><button type="button" disabled={modelLoading} onClick={() => void refreshModels(connection, true)}>刷新目录</button></div>
                <label>CLI 认证环境变量名<input value={connection.authEnvVar ?? ''} onChange={(event) => setDraft({ ...draft, connection: { ...connection, authEnvVar: event.target.value || null } })} placeholder="例如 MY_API_KEY；密钥不写进配置文件" /></label>
                <div className={styles.secretBar}><label>仅供目录请求使用的 API 密钥<input type="password" autoComplete="off" value={newSecret} onChange={(event) => setNewSecret(event.target.value)} placeholder={connection.secretRef ? '已存入系统凭据库' : '可选'} /></label><button type="button" disabled={!newSecret || busy} onClick={() => void saveSecret()}>保存密钥</button></div>
              </>}
            </div>}
            {view === 'native' && <div className={styles.nativeEditor}>
              <div className={styles.fileTabs}>{availableRoles.map((name) => <button key={name} type="button" className={role === name ? styles.selected : ''} onClick={() => setRole(name)}>{name === 'settings' ? activeFile?.path.split(/[\\/]/).at(-1) ?? 'settings' : name}</button>)}</div>
              <p className={styles.pathLabel}>{activeFile?.path ?? '原生文件尚未确定'} · {activeFile?.format?.toUpperCase() ?? ''}</p>
              <textarea spellCheck={false} aria-label={`${role} 配置草稿`} value={(editor === 'common' ? commonDraft?.files[role] : draft?.files[role]) ?? ''} onChange={(event) => editor === 'common' ? commonDraft && setCommonDraft({ ...commonDraft, files: { ...commonDraft.files, [role]: event.target.value } }) : draft && setDraft({ ...draft, files: { ...draft.files, [role]: event.target.value } })} placeholder="在这里编辑原生配置。留空表示本配置不覆盖该文件。" />
              <details className={styles.diskPreview}><summary>查看当前磁盘文件（只读）</summary><pre>{workspace.snapshots.find((item) => item.role === role)?.text ?? workspace.snapshots.find((item) => item.role === role)?.error ?? '文件尚不存在'}</pre><button type="button" onClick={() => { const text = workspace.snapshots.find((item) => item.role === role)?.text; if (text === null || text === undefined) return; if (editor === 'common') setCommonDraft((value) => value && ({ ...value, files: { ...value.files, [role]: text } })); else setDraft((value) => value && ({ ...value, files: { ...value.files, [role]: text } })); }}>以磁盘内容填入草稿</button></details>
            </div>}
            {view === 'merged' && <div className={styles.merged}><p>只读结构化预览：通用配置、命名配置和连接设置合并；CLI 仍可能受到环境变量、项目信任和更高优先级原生设置影响。</p><pre>{preview ? JSON.stringify(preview.documents[role] ?? {}, null, 2) : '等待有效配置…'}</pre>{preview && <details><summary>查看字段来源</summary><pre>{Object.entries(preview.sources[role] ?? {}).map(([path, source]) => `${path} ← ${source}`).join('\n') || '没有覆盖字段'}</pre></details>}</div>}
            <div className={styles.actions}>{editor === 'profile' && draft?.id && <button type="button" disabled={busy} onClick={() => void deleteCurrent()}>删除</button>}<span>{dirty ? '草稿尚未保存' : editor === 'profile' && workspace.binding?.profileId === draft?.id ? '当前范围已应用' : '保存草稿不会切换原生配置'}</span><button type="button" disabled={busy || !nativeAvailable} onClick={() => void save(false)}>保存</button>{editor === 'profile' && <button type="button" className={styles.primary} disabled={busy || !nativeAvailable || workspace.probe.nativeWrites.state !== 'supported'} onClick={() => void save(true)}>保存并应用到{scope === 'global' ? '全局' : '项目'}</button>}</div>
          </>}
        </div>
      </div>
      {editor === 'profile' && draft?.id && !dirty && workspace.binding?.profileId !== draft.id && <div className={styles.quickApply}><span>这份配置已保存，但尚未应用到当前范围。</span><button type="button" onClick={() => void applySaved(draft)} disabled={busy || workspace.probe.nativeWrites.state !== 'supported'}>应用这份配置</button></div>}
    </>}
  </section>;
}
