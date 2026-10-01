import { useEffect, useState } from 'react';
import { GuideDialog } from '../../components/GuideDialog';
import { confirmAction } from '../../lib/confirm';
import { native } from '../../lib/native';
import { saveShortcutHint } from '../../lib/shortcut';
import type { AdapterDescriptor } from '../../types/native';
import type { McpDefinition, McpDraft, SkillInstallation, SkillPackage } from '../../types/resources';
import styles from './LibraryPage.module.css';

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

export function LibraryResources({ section, active, tools }: { section: 'mcp' | 'skill'; active: boolean; tools: AdapterDescriptor[] }) {
  const [definitions, setDefinitions] = useState<McpDefinition[]>([]);
  const [packages, setPackages] = useState<SkillPackage[]>([]);
  const [installations, setInstallations] = useState<SkillInstallation[]>([]);
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [envText, setEnvText] = useState('');
  const [headerText, setHeaderText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialogError, setDialogError] = useState('');

  useEffect(() => {
    if (!active) return;
    let live = true;
    const load = section === 'mcp'
      ? native.listMcpDefinitions().then((items) => { if (live) setDefinitions(items); })
      : native.listSkillPackages().then(async (items) => {
        if (!live) return;
        setPackages(items);
        const found = (await Promise.all(items.map((item) => native.listSkillInstallations(item.id)))).flat();
        if (live) setInstallations(found);
      });
    void load.catch((value) => { if (live) setError(failure(value)); });
    return () => { live = false; };
  }, [active, section]);

  function open(item?: McpDefinition) {
    const next = item ? draftOf(item) : blank();
    setDraft(next);
    setEnvText(item ? lines(item.env) : '');
    setHeaderText(item ? lines(item.headers) : '');
    setDialogError('');
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

  async function removePackage(item: SkillPackage) {
    const placed = installations.some((entry) => entry.packageId === item.id);
    const message = placed ? `删除「${item.name}」？会从资料库移除，并卸下已安装到工具的副本。` : `从资料库删除「${item.name}」？`;
    if (busy || !await confirmAction(message, () => true, { title: '删除 Skill', confirmLabel: '删除', destructive: true })) return;
    setBusy(true); setError('');
    try {
      await native.deleteSkillPackage(item.id);
      const items = await native.listSkillPackages();
      setPackages(items);
      setInstallations((await Promise.all(items.map((entry) => native.listSkillInstallations(entry.id)))).flat());
      setNotice('已从资料库删除。');
    } catch (value) { setError(failure(value)); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!draft || busy) return;
    setBusy(true); setDialogError('');
    try {
      await native.saveMcpDefinition({ ...draft, env: parseLines(envText), headers: parseLines(headerText) });
      setDefinitions(await native.listMcpDefinitions());
      setDraft(null);
      setNotice('已保存在资料库。');
      setError('');
    } catch (value) { setDialogError(failure(value)); }
    finally { setBusy(false); }
  }

  if (section === 'skill') {
    return <div className={styles.layout}>
      {error && <div className={styles.error} role="alert">{error}</div>}
      {notice && <div className={styles.notice} role="status">{notice}</div>}
      <div className={styles.list} aria-label="Skill 列表">
        {packages.length ? packages.map((item) => {
          const placed = installations.filter((entry) => entry.packageId === item.id);
          return <article className={styles.card} key={item.id}>
            <small>{item.fileCount} 个文件</small>
            <strong>{item.name}</strong>
            <p>{item.description || '完整资源包'}{placed.length ? `\n${placed.map((entry) => `${tools.find((tool) => tool.id === entry.toolId)?.name ?? entry.toolId} · ${entry.scope === 'global' ? '全局' : '项目'} · ${installState[entry.state]}`).join('；')}` : '\n尚未安装到工具。到「工具与连接」的 Skill 页可以安装、停用或移除。'}</p>
            <div className={styles.cardActions}><button type="button" disabled={busy} onClick={() => void removePackage(item)}>删除</button></div>
          </article>;
        }) : <div className={styles.empty}><strong>还没有 Skill</strong>在「工具与连接」的 Skill 页导入文件夹或 ZIP。选择仅导入时，包会留在这里。</div>}
      </div>
    </div>;
  }

  return <div className={styles.layout}>
    <div className={styles.toolbar}><button type="button" className={styles.primary} style={{ marginLeft: 'auto' }} onClick={() => open()}>＋ 新建 MCP</button></div>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    <div className={styles.list} aria-label="MCP 列表">
      {definitions.length ? definitions.map((item) => <article className={styles.card} key={item.id}>
        <small>{item.transport}</small>
        <button className={styles.cardTitle} type="button" onClick={() => open(item)}>{item.name}</button>
        <p>{item.transport === 'http' ? item.url || '未填写网址' : item.command || '未填写命令'}</p>
        <div className={styles.cardActions}><button type="button" disabled={busy} onClick={() => void remove(item)}>删除</button><button type="button" onClick={() => open(item)}>修改</button></div>
      </article>) : <div className={styles.empty}><strong>还没有 MCP</strong>保存在这里的定义不会自动写进 CLI。写入某个工具请到「工具与连接」的 MCP 页。<button type="button" className={styles.primary} onClick={() => open()}>＋ 新建第一个 MCP</button></div>}
    </div>
    <GuideDialog open={!!draft} title={draft?.id ? '修改 MCP' : '新建 MCP'} hint="这里管理资料库中的定义。写到某个 CLI 请到工具与连接。" onClose={() => setDraft(null)}>
      {draft && <>
        <div className={styles.actions}>{draft.id && <button type="button" disabled={busy} onClick={() => { const current = definitions.find((item) => item.id === draft.id); if (current) void remove(current); }}>删除</button>}<button type="button" className={styles.primary} data-dialog-save title={saveShortcutHint} disabled={busy || !draft.name.trim()} onClick={() => void save()}>保存</button></div>
        <label>名称<input aria-label="名称" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如 filesystem" /></label>
        <label>连接方式<select aria-label="连接方式" value={draft.transport} onChange={(event) => setDraft({ ...draft, transport: event.target.value as 'stdio' | 'http' })}><option value="stdio">stdio</option><option value="http">http</option></select></label>
        {draft.transport === 'stdio'
          ? <label>启动命令<input aria-label="命令" value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx @modelcontextprotocol/server-filesystem" /></label>
          : <label>网址<input aria-label="网址" value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp" /></label>}
        {dialogError && <p className={styles.error} role="alert">{dialogError}</p>}
      </>}
    </GuideDialog>
  </div>;
}
