import { useEffect, useRef, useState } from 'react';
import { open as pickPath } from '@tauri-apps/plugin-dialog';
import { GuideDialog } from '../../components/GuideDialog';
import { Icon } from '../../components/Icon';
import { ScopeMarks, samePath, scopeLabel } from './CliMarks';
import { ToolIcon } from '../../components/ToolIcon';
import { confirmAction } from '../../lib/confirm';
import { native } from '../../lib/native';
import { saveShortcutHint, searchShortcutHint } from '../../lib/shortcut';
import type { Project } from '../../types/launch';
import type { AdapterDescriptor, Scope } from '../../types/native';
import type { McpDefinition, McpDraft, McpPlacement, McpTargetRequest, SkillImportPreview, SkillInstallation, SkillPackage } from '../../types/resources';
import { McpDistribution, type McpDistributeHandle } from './McpDistribution';
import { SkillDistribution } from './SkillDistribution';
import styles from './LibraryPage.module.css';

function blank(): McpDraft {
  return { id: null, name: '', transport: 'stdio', command: '', args: [], url: '', env: {}, headers: {}, inLibrary: true, expectedVersion: null };
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
function failure(error: unknown) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : '操作失败，请重试。';
}

const installState: Record<SkillInstallation['state'], string> = {
  current: '已安装',
  update_available: '有更新',
  missing: '目录缺失',
  conflict: '有外部修改',
  unavailable: '暂不可用',
  disabled: '已停用',
};

export function LibraryResources({ section, active, tools, projects }: { section: 'mcp' | 'skill'; active: boolean; tools: AdapterDescriptor[]; projects: Project[] }) {
  const [definitions, setDefinitions] = useState<McpDefinition[]>([]);
  const [placements, setPlacements] = useState<McpPlacement[]>([]);
  const [willDistribute, setWillDistribute] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const distributeRef = useRef<McpDistributeHandle>(null);
  const [packages, setPackages] = useState<SkillPackage[]>([]);
  const [installations, setInstallations] = useState<SkillInstallation[]>([]);
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [envText, setEnvText] = useState('');
  const [headerText, setHeaderText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [skillOpen, setSkillOpen] = useState(false);
  const [skillUrl, setSkillUrl] = useState('');
  const [archiveSelection, setArchiveSelection] = useState<{ source: string; local: boolean; entries: string[]; chosen: string | null } | null>(null);
  const [pendingImport, setPendingImport] = useState<{ preview: SkillImportPreview; kind: 'local' | 'zip' | 'local_zip'; source: string; subdirectory: string | null } | null>(null);
  const [skillTarget, setSkillTarget] = useState<SkillPackage | null>(null);
  const [skillSeed, setSkillSeed] = useState<string[]>([]);
  const [installTools, setInstallTools] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  useEffect(() => { setSearch(''); }, [section]);

  useEffect(() => {
    if (!active) return;
    let live = true;
    const load = section === 'mcp'
      ? Promise.all([native.listMcpDefinitions(), native.listMcpPlacements()]).then(([items, placed]) => { if (live) { setDefinitions(items); setPlacements(placed); } })
      : native.listSkillPackages().then(async (items) => {
        if (!live) return;
        setPackages(items);
        const found = (await Promise.all(items.map((item) => native.listSkillInstallations(item.id)))).flat();
        if (live) setInstallations(found);
      });
    void load.catch((value) => { if (live) setError(failure(value)); });
    return () => { live = false; };
  }, [active, section]);

  function editMcp(item?: McpDefinition) {
    const next = item ? draftOf(item) : blank();
    setDraft(next);
    setEnvText(item ? lines(item.env) : '');
    setHeaderText(item ? lines(item.headers) : '');
    setDialogError('');
    setWillDistribute(false);
    setConflict(false);
    setFormKey((value) => value + 1);
  }

  async function remove(item: McpDefinition) {
    if (busy || !await confirmAction(`从资料库删除「${item.name}」？已写入 CLI 的条目不会一起删除。`, () => true, { title: '删除 MCP', confirmLabel: '删除', destructive: true })) return;
    setBusy(true); setError('');
    try {
      await native.deleteMcpDefinition(item.id, item.version);
      setDefinitions(await native.listMcpDefinitions());
      setDraft(null);
      setNotice('已从资料库删除。');
    } catch (value) { setError(failure(value)); }
    finally { setBusy(false); }
  }

  async function reloadSkills() {
    const items = await native.listSkillPackages();
    setPackages(items);
    setInstallations((await Promise.all(items.map((entry) => native.listSkillInstallations(entry.id)))).flat());
  }

  function closeSkill() {
    setSkillOpen(false);
    setArchiveSelection(null);
    setPendingImport(null);
    setDialogError('');
  }

  async function finishSkillImport(item?: SkillPackage) {
    const prior = item ? installations.filter((entry) => entry.packageId === item.id && entry.state !== 'conflict' && entry.state !== 'disabled' && entry.state !== 'unavailable') : [];
    const checked = installTools.filter((toolId) => !prior.some((entry) => entry.toolId === toolId && entry.scope === 'global'));
    await reloadSkills();
    closeSkill();
    setInstallTools([]);
    const targets = [
      ...prior.map((entry) => ({ toolId: entry.toolId, scope: entry.scope, projectPath: entry.projectPath })),
      ...checked.map((toolId) => ({ toolId, scope: 'global' as const, projectPath: null })),
    ];
    if (item && targets.length) {
      const notes: string[] = [];
      const conflicts: string[] = [];
      for (const target of targets) {
        const name = tools.find((tool) => tool.id === target.toolId)?.name ?? target.toolId;
        const preview = await native.previewSkillTarget(item.id, target.toolId, target.scope, target.projectPath);
        if (preview?.status === 'conflict') { conflicts.push(name); continue; }
        const outcome = await native.installSkill(item.id, target.toolId, target.scope, target.projectPath, preview?.previewToken ?? null, false);
        notes.push(`${name}：${outcome.status === 'failed' ? outcome.detail : '已同步'}`);
      }
      await reloadSkills();
      const failed = notes.filter((line) => !line.endsWith('已同步'));
      if (conflicts.length) {
        setSkillSeed([]);
        setSkillTarget(item);
        setNotice(`资料库已更新。${conflicts.join('、')} 上有外部修改，请在这个窗口确认替换。`);
      } else if (failed.length) setError(failed.join('；'));
      else setNotice(notes.join('；') || '已同步到已安装的 CLI。');
      if (!failed.length) setError('');
      return;
    }
    setNotice('已放进资料库。');
    setError('');
  }

  async function importPreview(preview: SkillImportPreview, kind: 'local' | 'zip' | 'local_zip', source: string, subdirectory: string | null) {
    if (preview.existingDigest && preview.existingDigest !== preview.digest) {
      setPendingImport({ preview, kind, source, subdirectory });
      setArchiveSelection(null);
      return;
    }
    const item = kind === 'local'
      ? await native.importSkillLocal(source, preview.digest, preview.existingDigest)
      : kind === 'local_zip'
        ? await native.importSkillLocalZip(source, subdirectory, preview.digest, preview.existingDigest)
        : await native.importSkillHttpsZip(source, subdirectory, preview.digest, preview.existingDigest);
    if (item) await finishSkillImport(item);
  }

  async function addFolder() {
    try {
      const source = await pickPath({ directory: true, multiple: false, title: '选择包含 SKILL.md 的目录' });
      if (typeof source !== 'string') return;
      setBusy(true); setDialogError('');
      await importPreview(await native.previewSkillLocal(source), 'local', source, null);
    } catch (value) { setDialogError(failure(value)); }
    finally { setBusy(false); }
  }

  async function addArchive(source: string, localZip: boolean, chosen?: string) {
    setBusy(true); setDialogError('');
    try {
      let child = chosen ?? null;
      if (chosen === undefined) {
        const entries = await native.listSkillZipEntries(source, localZip);
        if (entries.length > 1) { setArchiveSelection({ source, local: localZip, entries, chosen: null }); return; }
        child = entries[0] || null;
      }
      const preview = localZip ? await native.previewSkillLocalZip(source, child) : await native.previewSkillHttpsZip(source, child);
      await importPreview(preview, localZip ? 'local_zip' : 'zip', source, child);
      if (!localZip) setSkillUrl('');
    } catch (value) { setDialogError(failure(value)); }
    finally { setBusy(false); }
  }

  async function addZip() {
    try {
      const source = await pickPath({ directory: false, multiple: false, title: '选择 Skills ZIP 文件', filters: [{ name: 'ZIP', extensions: ['zip'] }] });
      if (typeof source === 'string') await addArchive(source, true);
    } catch (value) { setDialogError(failure(value)); }
  }

  async function confirmSkillImport() {
    if (!pendingImport) return;
    setBusy(true); setDialogError('');
    try {
      const { preview, kind, source, subdirectory } = pendingImport;
      const item = kind === 'local' ? await native.importSkillLocal(source, preview.digest, preview.existingDigest)
        : kind === 'local_zip' ? await native.importSkillLocalZip(source, subdirectory, preview.digest, preview.existingDigest)
        : await native.importSkillHttpsZip(source, subdirectory, preview.digest, preview.existingDigest);
      await finishSkillImport(item);
    } catch (value) { setDialogError(failure(value)); }
    finally { setBusy(false); }
  }

  async function removePackage(item: SkillPackage) {
    const placed = installations.some((entry) => entry.packageId === item.id);
    const message = placed ? `删除「${item.name}」？会从资料库移除，并卸下已安装到工具的副本。` : `从资料库删除「${item.name}」？`;
    if (busy || !await confirmAction(message, () => true, { title: '删除 Skill', confirmLabel: '删除', destructive: true })) return;
    setBusy(true); setError('');
    try {
      await native.deleteSkillPackage(item.id);
      await reloadSkills();
      setNotice('已从资料库删除。');
    } catch (value) { setError(failure(value)); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!draft || busy) return;
    setBusy(true); setDialogError('');
    try {
      const saved = await native.saveMcpDefinition({ ...draft, inLibrary: true, env: parseLines(envText), headers: parseLines(headerText) });
      setDefinitions(await native.listMcpDefinitions());
      setDraft(draftOf(saved));
      const alreadyPlaced = placements.some((item) => item.definitionId === saved.id);
      if (willDistribute || alreadyPlaced) {
        const outcome = await distributeRef.current?.run(saved);
        setPlacements(await native.listMcpPlacements().catch(() => []));
        if (outcome?.status === 'written') { setConflict(false); setDialogError(''); setDraft(null); setNotice(outcome.notice); }
        else if (outcome?.status === 'pending') setConflict(true);
        else {
          setConflict(false);
          setDialogError(outcome?.status === 'failed' ? outcome.message : '已保存在资料库，但没有重新写入 CLI。请再点一次保存并分发。');
        }
      } else {
        setPlacements(await native.listMcpPlacements().catch(() => []));
        setDraft(null);
        setNotice('已保存在资料库。');
      }
      setError('');
    } catch (value) { setDialogError(failure(value)); }
    finally { setBusy(false); }
  }

  async function replaceDistribution() {
    if (busy) return;
    setBusy(true); setDialogError('');
    try {
      const outcome = await distributeRef.current?.commit();
      setPlacements(await native.listMcpPlacements().catch(() => []));
      if (outcome?.status === 'written') { setConflict(false); setDraft(null); setNotice(outcome.notice); setError(''); }
    } catch (value) { setDialogError(failure(value)); }
    finally { setBusy(false); }
  }

  async function toggleMcp(item: McpDefinition, toolId: string, scope: Scope, projectPath: string | null) {
    if (busy) return;
    const toolName = tools.find((tool) => tool.id === toolId)?.name ?? toolId;
    const where = scope === 'project' ? `${scopeLabel(scope, projectPath, projects)} 的 ` : '';
    const place = placements.find((entry) => entry.definitionId === item.id && entry.toolId === toolId && entry.scope === scope && (scope === 'global' || samePath(entry.projectPath, projectPath)));
    setBusy(true); setError(''); setNotice('');
    try {
      if (place) {
        await native.removeNativeMcp({ toolId, scope, projectPath: place.projectPath, enabled: place.enabled }, item.name);
        setNotice(`已从 ${where}${toolName} 移除。`);
      } else {
        const target: McpTargetRequest = { toolId, scope, projectPath, enabled: true };
        const preview = await native.previewMcpTargets(item.id, [target]);
        const first = preview[0];
        if (!first || (first.status !== 'ready' && first.status !== 'conflict')) { setError(first?.detail || `${toolName} 现在不能写入。`); return; }
        if (first.status === 'conflict' && !await confirmAction(`「${item.name}」和 ${toolName} 里的同名内容不一致。确认后用这份替换。`, () => true, { title: '替换同名 MCP？', confirmLabel: '替换并写入' })) return;
        await native.distributeMcp(item.id, [{ ...target, baselineHash: first.baselineHash, previewToken: first.previewToken, allowReplace: first.status === 'conflict' }]);
        setNotice(`已写入 ${where}${toolName}。`);
      }
      setPlacements(await native.listMcpPlacements().catch(() => placements));
    } catch (value) { setError(failure(value)); }
    finally { setBusy(false); }
  }

  async function toggleSkill(item: SkillPackage, toolId: string, scope: Scope, projectPath: string | null) {
    if (busy) return;
    const toolName = tools.find((tool) => tool.id === toolId)?.name ?? toolId;
    const where = scope === 'project' ? `${scopeLabel(scope, projectPath, projects)} 的 ` : '';
    const place = installations.find((entry) => entry.packageId === item.id && entry.toolId === toolId && entry.scope === scope && (scope === 'global' || samePath(entry.projectPath, projectPath)));
    setBusy(true); setError(''); setNotice('');
    try {
      if (place) {
        await native.removeSkill(item.id, toolId, scope, place.projectPath);
        setNotice(`已从 ${where}${toolName} 移除。`);
      } else {
        const preview = await native.previewSkillTarget(item.id, toolId, scope, projectPath);
        if (preview?.status === 'conflict' && !await confirmAction(`「${item.name}」和 ${toolName} 里的同名内容不一致。确认后用这份替换。`, () => true, { title: '替换同名 Skill？', confirmLabel: '替换并安装' })) return;
        const outcome = await native.installSkill(item.id, toolId, scope, projectPath, preview?.previewToken ?? null, preview?.status === 'conflict');
        if (outcome.status === 'failed') { setError(outcome.detail); return; }
        setNotice(`已安装到 ${where}${toolName}。`);
      }
      await reloadSkills();
    } catch (value) { setError(failure(value)); }
    finally { setBusy(false); }
  }

  const needle = search.trim().toLowerCase();
  const libraryDefinitions = definitions.filter((item) => item.inLibrary !== false)
    .filter((item) => !needle || `${item.name} ${item.command} ${item.args.join(' ')} ${item.url ?? ''}`.toLowerCase().includes(needle));
  const libraryPackages = packages.filter((item) => item.inLibrary !== false)
    .filter((item) => !needle || `${item.name} ${item.description ?? ''}`.toLowerCase().includes(needle));

  if (section === 'skill') {
    return <div className={styles.layout}>
      <div className={styles.filters}>
        <div className={styles.searchBox}>
          <Icon name="search" size={14} />
          <input aria-label="搜索资料" data-page-search title={searchShortcutHint} value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && search) { event.preventDefault(); setSearch(''); } }} placeholder="搜索名称或描述" />
        </div>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => { setDialogError(''); setSkillOpen(true); }}>添加 Skill</button>
      </div>
      {error && <div className={styles.error} role="alert">{error}</div>}
      {notice && <div className={styles.notice} role="status">{notice}</div>}
      <div className={styles.list} aria-label="Skill 列表">
        {libraryPackages.length ? libraryPackages.map((item) => {
          return <article className={styles.card} key={item.id}>
            <div className={styles.cardHead}>
              <button className={styles.cardTitle} type="button" onClick={() => { setSkillSeed([]); setSkillTarget(item); }}>{item.name}</button>
              <span className={styles.badge}>{item.fileCount} 个文件</span>
            </div>
            <p>{item.description || '完整资源包'}</p>
            <div className={styles.cardBar}>
              <ScopeMarks label={`${item.name} 的 CLI`} tools={tools} places={installations.filter((entry) => entry.packageId === item.id)} projects={projects} busy={busy} onToggle={(toolId, scope, projectPath) => void toggleSkill(item, toolId, scope, projectPath)} mark={(place) => {
                if (!place) return { pressed: false, state: 'off', status: '未安装' };
                if (place.state === 'current') return { pressed: true, state: 'current', status: '已生效' };
                if (place.state === 'conflict' || place.state === 'update_available') return { pressed: true, state: 'drifted', status: installState[place.state] };
                return { pressed: true, state: 'unavailable', status: installState[place.state] };
              }} />
              <div className={styles.cardActions}><button type="button" disabled={busy} onClick={() => void removePackage(item)}>删除</button><button type="button" disabled={busy} onClick={() => { setSkillSeed([]); setSkillTarget(item); }}>修改</button></div>
            </div>
          </article>;
        }) : needle
          ? <div className={styles.empty}><Icon name="search" size={28} strokeWidth={1.3} />没有匹配「{search.trim()}」的 Skill。</div>
          : <div className={styles.empty}><Icon name="sparkle" size={28} strokeWidth={1.3} /><strong>还没有 Skill</strong>先放进资料库。导入时可以同时安装到 CLI。<button type="button" className={styles.primary} disabled={busy} onClick={() => { setDialogError(''); setSkillOpen(true); }}>添加 Skill</button></div>}
      </div>
      <GuideDialog open={skillOpen} title="添加 Skill" hint="先放进资料库。勾选 CLI 后，导入完成会直接安装。" onClose={closeSkill}>
        <div className={styles.skillAdd}>
          {!archiveSelection && !pendingImport && <>
            <section className={styles.skillSection}>
              <h3>导入后安装到</h3>
              <p>不勾选就只留在资料库。</p>
              <div className={styles.targets}>{tools.map((tool) => <label key={tool.id}><input type="checkbox" checked={installTools.includes(tool.id)} onChange={(event) => setInstallTools(event.target.checked ? [...installTools, tool.id] : installTools.filter((id) => id !== tool.id))} /><ToolIcon toolId={tool.id} size={18} />{tool.name}</label>)}</div>
            </section>
            <section className={styles.skillSection}>
              <h3>从哪里导入</h3>
              <div className={styles.sources}>
                <button type="button" aria-label="选择文件夹" disabled={busy} onClick={() => void addFolder()}><Icon name="folder" size={17} /><strong>选择文件夹</strong><span>目录里要有 SKILL.md</span></button>
                <button type="button" aria-label="导入 ZIP 文件" disabled={busy} onClick={() => void addZip()}><Icon name="archive" size={17} /><strong>导入 ZIP 文件</strong><span>本机上的 .zip</span></button>
              </div>
              <label>ZIP 地址<span className={styles.urlRow}><input aria-label="归档地址" value={skillUrl} onChange={(event) => setSkillUrl(event.target.value)} placeholder="https://example.com/skill.zip" /><button type="button" disabled={busy || !skillUrl.trim()} onClick={() => void addArchive(skillUrl.trim(), false)}>导入地址</button></span></label>
            </section>
          </>}
          {archiveSelection && <section className={styles.skillSection}>
            <h3>这个压缩包里有多个 Skill</h3>
            <label>选择要导入的一个<select aria-label="归档中的 Skill" value={archiveSelection.chosen ?? '__choose__'} onChange={(event) => setArchiveSelection({ ...archiveSelection, chosen: event.target.value === '__choose__' ? null : event.target.value })}><option value="__choose__">选择 Skill…</option>{archiveSelection.entries.map((entry) => <option key={entry} value={entry}>{entry || '归档根目录'}</option>)}</select></label>
            <div className={styles.actions}><button type="button" onClick={() => setArchiveSelection(null)}>返回</button><button type="button" className={styles.primary} disabled={busy || archiveSelection.chosen === null} onClick={() => void addArchive(archiveSelection.source, archiveSelection.local, archiveSelection.chosen ?? undefined)}>导入所选 Skill</button></div>
          </section>}
          {pendingImport && <section className={styles.skillSection} role="group" aria-label="Skills 同名更新预览">
            <h3>资料库里已有「{pendingImport.preview.name}」</h3>
            <p>来源：{pendingImport.preview.source} · {pendingImport.preview.fileCount} 个文件。确认后会换成这一份{installTools.length ? '，并安装到勾选的 CLI' : ''}。</p>
            <div className={styles.actions}><button type="button" onClick={() => setPendingImport(null)}>返回</button><button type="button" className={styles.primary} disabled={busy} onClick={() => void confirmSkillImport()}>{installations.some((entry) => packages.some((item) => item.id === entry.packageId && item.name === pendingImport.preview.name)) ? '更新并同步到已安装的 CLI' : '确认更新资料库包'}</button></div>
          </section>}
          {dialogError && <p className={styles.error} role="alert">{dialogError}</p>}
        </div>
      </GuideDialog>
      <GuideDialog open={!!skillTarget} title="修改 Skill" hint="上面是已经装上的 CLI。勾选后再安装，或从某个 CLI 移除。" onClose={() => { setSkillTarget(null); setSkillSeed([]); }}>
        {skillTarget && <SkillDistribution item={skillTarget} tools={tools} projects={projects} installations={installations} initialTools={skillSeed} autoRun={skillSeed.length > 0} onChanged={reloadSkills} />}
      </GuideDialog>
    </div>;
  }

  return <div className={styles.layout}>
    <div className={styles.filters}>
      <div className={styles.searchBox}>
        <Icon name="search" size={14} />
        <input aria-label="搜索资料" data-page-search title={searchShortcutHint} value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && search) { event.preventDefault(); setSearch(''); } }} placeholder="搜索名称、命令或网址" />
      </div>
      <button type="button" className={styles.primary} onClick={() => editMcp()}>＋ 新建 MCP</button>
    </div>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    <div className={styles.list} aria-label="MCP 列表">
      {libraryDefinitions.length ? libraryDefinitions.map((item) => {
        return <article className={styles.card} key={item.id}>
          <div className={styles.cardHead}>
            <button className={styles.cardTitle} type="button" onClick={() => editMcp(item)}>{item.name}</button>
            <span className={styles.badge} data-accent={item.transport === 'http' || undefined}>{item.transport === 'http' ? 'HTTP' : 'stdio'}</span>
          </div>
          <p className={styles.mono}>{item.transport === 'http' ? item.url || '未填写网址' : [item.command, ...item.args].filter(Boolean).join(' ') || '未填写命令'}</p>
          <div className={styles.cardBar}>
            <ScopeMarks label={`${item.name} 的 CLI`} tools={tools} places={placements.filter((entry) => entry.definitionId === item.id)} projects={projects} busy={busy} onToggle={(toolId, scope, projectPath) => void toggleMcp(item, toolId, scope, projectPath)} mark={(place) => {
              if (!place) return { pressed: false, state: 'off', status: '未写入' };
              if (!place.enabled) return { pressed: true, state: 'unavailable', status: '已写入但未启用' };
              return { pressed: true, state: 'current', status: '已生效' };
            }} />
            <div className={styles.cardActions}><button type="button" disabled={busy} onClick={() => void remove(item)}>删除</button><button type="button" onClick={() => editMcp(item)}>修改</button></div>
          </div>
        </article>;
      }) : needle
        ? <div className={styles.empty}><Icon name="search" size={28} strokeWidth={1.3} />没有匹配「{search.trim()}」的 MCP。</div>
        : <div className={styles.empty}><Icon name="connections" size={28} strokeWidth={1.3} /><strong>还没有 MCP</strong>新建时填写连接方式，并勾选要写入的 CLI。<button type="button" className={styles.primary} onClick={() => editMcp()}>＋ 新建第一个 MCP</button></div>}
    </div>
    <GuideDialog open={!!draft} title={draft?.id ? '修改 MCP' : '新建 MCP'} hint="名称、HTTP 或 stdio。已经写入的 CLI 会预先勾上。同名冲突留在这个窗口里比较，替换完成后回到列表。" onClose={() => { setDraft(null); setConflict(false); }}>
      {draft && <>
        <div className={styles.fields}>
          <label className={styles.span}>MCP 服务器名称<input aria-label="名称" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如 chrome-devtools" /></label>
          <div className={`${styles.typeField} ${styles.span}`}><span>MCP 服务器类型</span><div className={styles.typeSwitch} role="radiogroup" aria-label="连接方式">{([['http', 'HTTP'], ['stdio', 'stdio']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={draft.transport === value} onClick={() => setDraft({ ...draft, transport: value })}>{label}</button>)}</div></div>
          {draft.transport === 'stdio' ? <>
            <label className={styles.span}>命令<input aria-label="命令" value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx" /></label>
            <label className={styles.span}>参数，每行一项<textarea rows={3} value={draft.args.join('\n')} onChange={(event) => setDraft({ ...draft, args: event.target.value.split('\n').filter(Boolean) })} placeholder={'-y\nchrome-devtools-mcp@latest'} /></label>
            <label className={styles.span}>环境变量<textarea rows={4} value={envText} onChange={(event) => setEnvText(event.target.value)} placeholder={'KEY=value\nAPI_TOKEN=${API_TOKEN}'} /></label>
          </> : <>
            <label className={styles.span}>URL<input aria-label="网址" value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp" /></label>
            <label className={styles.span}>请求头<textarea rows={4} value={headerText} onChange={(event) => setHeaderText(event.target.value)} placeholder="Authorization=Bearer ${API_TOKEN}" /></label>
          </>}
        </div>
        <McpDistribution key={formKey} ref={distributeRef} definition={definitions.find((item) => item.id === draft.id) ?? { ...draft, id: draft.id ?? '', version: draft.expectedVersion ?? 0 }} tools={tools} projects={projects} placements={placements} formStamp={JSON.stringify([draft.name, draft.transport, draft.command, draft.args, draft.url, envText, headerText])} onWillDistribute={setWillDistribute} onConflictChange={setConflict} />
        {dialogError && <p className={styles.error} role="alert">{dialogError}</p>}
        <div className="dialog-footer">{draft.id && <button type="button" disabled={busy} onClick={() => { const current = definitions.find((item) => item.id === draft.id); if (current) void remove(current); }}>删除</button>}<span className="dialog-footer-gap" />{conflict && <button type="button" disabled={busy} onClick={() => { setConflict(false); distributeRef.current?.dismiss(); }}>保留当前文件</button>}<button type="button" className={styles.primary} data-dialog-save title={saveShortcutHint} disabled={busy || !draft.name.trim()} onClick={() => void (conflict ? replaceDistribution() : save())}>{conflict ? '替换并分发' : willDistribute ? '保存并分发' : '保存'}</button></div>
      </>}
    </GuideDialog>
  </div>;
}
