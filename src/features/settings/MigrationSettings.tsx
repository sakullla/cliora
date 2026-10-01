import { useEffect, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import type { PortableItem, PortablePreview } from '../../types/portable';
import type { Project } from '../../types/launch';
import { Icon } from '../../components/Icon';
import { GuideDialog } from '../../components/GuideDialog';
import styles from './MigrationSettings.module.css';
import { WebdavSettings } from './WebdavSettings';

function formatFailure(error: unknown, objectText: string, nextText: string): string {
  const fallback = `${objectText}。${nextText}`;
  if (typeof error === 'string') {
    const text = error.trim();
    return !text || text.replace(/[。！？，,\s]/g, '') === '操作失败请重试' ? fallback : text;
  }
  if (!error || typeof error !== 'object') return fallback;
  const value = error as { message?: unknown; action?: unknown };
  const raw = 'message' in value && value.message != null ? String(value.message).trim() : '';
  const action = typeof value.action === 'string' ? value.action.trim() : '';
  if (!raw || raw.replace(/[。！？，,\s]/g, '') === '操作失败请重试' || /^操作失败[。！]?$/.test(raw)) {
    const next = action && !/^请重试[。！]?$/.test(action) ? action : nextText;
    const step = /[。！？]$/.test(next) ? next : `${next}。`;
    return `${objectText}。${step}`;
  }
  const detail = raw.replace(/[。！？\s]+$/, '');
  const next = action || nextText;
  const bare = next.replace(/[。！？\s]+$/, '');
  if (!bare || detail.includes(bare)) return /[。！？]$/.test(raw) ? raw : `${detail}。`;
  return `${detail}。${/[。！？]$/.test(next) ? next : `${next}。`}`;
}

const KIND: Record<string, string> = {
  preferences: '偏好', profile: '命名配置', common: '通用配置', project: '项目',
  library: '资料', mcp: 'MCP', skill: 'Skill',
};

export function MigrationSettings({ active, onImported }: { active: boolean; onImported?: () => void }) {
  const [operation, setOperation] = useState<'export' | 'import' | 'webdav' | null>(null);
  const [items, setItems] = useState<PortableItem[]>([]);
  const [listReady, setListReady] = useState(false);
  const [listError, setListError] = useState('');
  const [exportSelected, setExportSelected] = useState<string[]>([]);
  const [exportPassword, setExportPassword] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [preview, setPreview] = useState<PortablePreview | null>(null);
  const [importSelected, setImportSelected] = useState<string[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectLinks, setProjectLinks] = useState<Record<string, string>>({});
  const [applyTargets, setApplyTargets] = useState<Record<string, string>>({});
  const [revealPassword, setRevealPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!active || !nativeAvailable) return;
    let alive = true;
    void native.listPortableItems().then((next) => {
      if (!alive) return;
      setItems(next);
      setExportSelected((old) => old.length ? old : next.map((item) => item.key));
      setListError('');
      setListReady(true);
    }).catch((reason) => {
      if (!alive) return;
      setListReady(false);
      setListError(formatFailure(reason, '读取可迁移资料失败', '可先离开再回到「迁移与同步」重新读取。'));
    });
    return () => { alive = false; };
  }, [active]);

  function setWebdavEditing(editing: boolean) {
    setOperation((current) => editing ? 'webdav' : current === 'webdav' ? null : current);
  }

  function toggle(key: string, values: string[], update: (next: string[]) => void) {
    update(values.includes(key) ? values.filter((value) => value !== key) : [...values, key]);
  }

  async function exportBundle() {
    if (busy || exportPassword.length < 12 || !exportSelected.length) return;
    const destination = await save({ title: '保存加密配置包',
      defaultPath: `cliora-${new Date().toISOString().slice(0, 10)}.cliora`,
      filters: [{ name: '栖点加密配置包', extensions: ['cliora'] }] });
    if (!destination) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const count = await native.exportPortableBundle(destination, exportPassword, exportSelected);
      setMessage(`已导出 ${count} 项资料。请单独保存口令；配置包不包含本机登录状态和会话记录。`);
      setExportPassword(''); setOperation(null); setRevealPassword(false);
    } catch (reason) { setError(formatFailure(reason, '导出配置包失败', '可再次点击导出配置包。')); }
    finally { setBusy(false); }
  }

  async function importBundle() {
    if (busy || !importPassword) return;
    const source = await open({ title: '打开加密配置包', multiple: false,
      filters: [{ name: '栖点加密配置包', extensions: ['cliora'] }] });
    if (typeof source !== 'string') return;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await native.previewPortableBundle(source, importPassword);
      setPreview(next);
      setImportSelected(next.items.filter((item) => item.status === 'new').map((item) => item.key));
      setProjects(await native.listProjects().catch(() => []));
      setProjectLinks({}); setApplyTargets({});
      setImportPassword('');
    } catch (reason) { setError(formatFailure(reason, '无法读取配置包', '可再次点击选择配置包并预览。')); }
    finally { setBusy(false); }
  }

  async function cancelPreview() {
    await native.cancelPortablePreview().catch(() => {});
    setPreview(null); setImportSelected([]); setProjectLinks({}); setApplyTargets({});
  }

  async function pickProjectDirectory(projectId: string) {
    const path = await open({ title: '选择这个项目在本机的目录', directory: true, multiple: false });
    if (typeof path === 'string') setProjectLinks((old) => ({ ...old, [projectId]: path }));
  }

  async function applyPreview() {
    if (!preview || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const links = Object.entries(projectLinks).filter(([id]) => importSelected.includes(`project:${id}`)).map(([projectId, path]) => ({ projectId, path }));
      const targets = Object.entries(applyTargets).filter(([key, value]) => value && importSelected.includes(key)).map(([key, value]) => ({
        profileId: key.slice('profile:'.length), projectId: value === 'global' ? null : value,
      }));
      const report = await native.applyPortableBundle(preview.previewId, importSelected, links, targets);
      setPreview(null); setImportSelected([]);
      setProjectLinks({}); setApplyTargets({});
      setMessage(`已恢复 ${report.imported} 项资料。${report.targets.map((target) => `${target.label}：${target.status === 'failed' ? `失败，${target.detail}` : target.status === 'linked' ? '已关联' : '已应用'}`).join('；') || '未选择本机应用目标，配置可稍后在工具页应用。'}`);
      setOperation(null); setRevealPassword(false);
      onImported?.();
      try {
        const next = await native.listPortableItems();
        setItems(next); setExportSelected(next.map((item) => item.key));
        setListError(''); setListReady(true);
      } catch (reason) {
        setListReady(false);
        setListError(formatFailure(reason, '读取可迁移资料失败', '可先离开再回到「迁移与同步」重新读取。'));
      }
    } catch (reason) { setError(formatFailure(reason, '导入配置包失败', '可再次点击确认恢复，或点击取消。')); }
    finally { setBusy(false); }
  }

  const projectChoices = [...new Map([
    ...projects.map((project) => [project.id, { id: project.id, name: project.name, path: project.path }] as const),
    ...(preview?.items.filter((item) => item.kind === 'project').map((item) => [item.key.slice('project:'.length), {
      id: item.key.slice('project:'.length), name: item.label, path: projectLinks[item.key.slice('project:'.length)] ?? projects.find((project) => `project:${project.id}` === item.key)?.path ?? null,
    }] as const) ?? []),
  ]).values()];

  const dialogOpen = operation === 'export' || operation === 'import';
  const allExportSelected = !!items.length && items.every((item) => exportSelected.includes(item.key));
  const revealButton = <button type="button" aria-label={revealPassword ? '隐藏口令' : '显示口令'} aria-pressed={revealPassword} onClick={() => setRevealPassword((value) => !value)}>{revealPassword ? '隐藏' : '显示'}</button>;
  const bannerError = error || listError;
  return <div className={styles.page}>
    {!dialogOpen && bannerError && <div className={styles.error} role="alert">{bannerError}</div>}
    {!dialogOpen && message && <div className={styles.message} role="status">{message}</div>}
    <section className="migration-card"><div className="migration-mark"><Icon name="migration" size={24} /></div><h2>让熟悉的工作方式，跟你一起走</h2><p>备份配置、API 密钥和资料，在另一台设备恢复。加密保护内容，本机登录与使用记录留在本机。</p><div className="migration-actions"><button className="button primary" type="button" onClick={() => setOperation('export')}>导出加密配置包</button><button className="button" type="button" onClick={() => setOperation('import')}>从配置包恢复</button></div><small>项目目录在新设备重新关联，活动配置由你决定。</small></section>
    <GuideDialog open={dialogOpen} title={operation === 'import' ? '从配置包恢复' : '导出加密配置包'} hint={operation === 'import' ? '先输入口令并预览，再决定哪些资料写回本机。' : '勾选要带走的资料，再设置至少 12 位的口令。'} onClose={() => { setOperation(null); setRevealPassword(false); }}>
    {bannerError && <div className={styles.error} role="alert">{bannerError}</div>}
    {message && <div className={styles.message} role="status">{message}</div>}
    {operation === 'export' && <section className="settings-group">
      <div className={styles.listBar}><span><strong>已选 {exportSelected.filter((key) => items.some((item) => item.key === key)).length} / {items.length} 项</strong>API 密钥包含在加密包内；本机登录、会话和使用记录不包含。</span>
        {!!items.length && <button type="button" className="text-button" disabled={busy} onClick={() => setExportSelected(allExportSelected ? [] : items.map((item) => item.key))}>{allExportSelected ? '全不选' : '全选'}</button>}</div>
      <div className={styles.list} aria-label="选择导出资料">
        {items.map((item) => <label className={styles.item} key={item.key}><input type="checkbox" checked={exportSelected.includes(item.key)}
          onChange={() => toggle(item.key, exportSelected, setExportSelected)} disabled={busy} />
          <span><strong>{item.label}</strong><small>{KIND[item.kind] ?? item.kind}{item.pendingFields.length ? ' · 含换设备后待关联内容' : ''}</small></span></label>)}
        {listReady && !listError && !items.length && <p className={styles.empty}>当前没有可带走的资料。请先在快速开始、工具与连接或资料库中产生配置或资料。</p>}
      </div>
      <div className={styles.action}><label>配置包口令<span className={styles.secret}><input aria-label="配置包口令" type={revealPassword ? 'text' : 'password'} value={exportPassword} autoComplete="new-password" placeholder="至少 12 位" onChange={(event) => setExportPassword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void exportBundle(); } }} />{revealButton}</span></label>
        <button type="button" className="button primary" disabled={!nativeAvailable || busy || exportPassword.length < 12 || !exportSelected.length} onClick={() => void exportBundle()}>导出配置包</button>
        <small className={styles.passwordHint} data-ok={(exportPassword.length >= 12 && exportSelected.length > 0) || undefined}>{!exportSelected.length ? '至少勾选一项资料。' : exportPassword.length >= 12 ? '口令长度符合要求，请另外妥善保存。' : `口令还需 ${12 - exportPassword.length} 位`}</small></div>
    </section>}
    {operation === 'import' && <section className="settings-group">
      {!preview ? <div className={styles.action}><label>配置包口令<span className={styles.secret}><input aria-label="配置包口令" type={revealPassword ? 'text' : 'password'} value={importPassword} autoComplete="current-password" placeholder="输入导出时的口令" onChange={(event) => setImportPassword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void importBundle(); } }} />{revealButton}</span></label>
        <button type="button" className="button primary" disabled={!nativeAvailable || busy || !importPassword} onClick={() => void importBundle()}>选择配置包并预览</button></div> : <>
        <div className={styles.listBar}><span><strong>已选 {importSelected.length} / {preview.items.filter((item) => item.status !== 'same').length} 项</strong>新资料默认选中；与本机不同的资料由你逐项决定是否替换。</span></div>
        <div className={`${styles.list} ${styles.previewList}`} aria-label="导入预览">{preview.items.map((item) => <div className={styles.previewItem} key={item.key}>
          <label className={styles.item}><input type="checkbox" checked={importSelected.includes(item.key)} disabled={busy || item.status === 'same'} onChange={() => toggle(item.key, importSelected, setImportSelected)} />
            <span><strong>{item.label}</strong><small>{KIND[item.kind] ?? item.kind} · {item.status === 'new' ? '新增' : item.status === 'same' ? '已存在且相同' : '与本机不同，勾选后替换'}
              {item.pendingFields.length ? ` · 待关联：${item.pendingFields.join('、')}` : ''}</small></span></label>
          {item.status !== 'same' && <details className={styles.previewDetails}><summary>比较本机与配置包内容</summary><div className={styles.compare}><div><strong>本机</strong><pre>{item.localPreview ?? '无，新增资料'}</pre></div><div><strong>配置包</strong><pre>{item.incomingPreview ?? '预览不可用'}</pre></div></div></details>}
          {item.kind === 'project' && importSelected.includes(item.key) && <div className={styles.targetChoice}><span>本机目录：{projectLinks[item.key.slice('project:'.length)] ?? '恢复后待关联'}</span><button className="button" type="button" disabled={busy} onClick={() => void pickProjectDirectory(item.key.slice('project:'.length))}>选择目录</button></div>}
          {item.kind === 'profile' && importSelected.includes(item.key) && <label className={styles.targetChoice}>恢复后应用到本机（{item.toolId ?? 'CLI'}）<select value={applyTargets[item.key] ?? ''} disabled={busy} onChange={(event) => setApplyTargets((old) => ({ ...old, [item.key]: event.target.value }))}>
            <option value="">只保存资料，稍后应用</option><option value="global">全局配置</option>{projectChoices.map((project) => <option key={project.id} value={project.id}>项目 · {project.name}{project.path ? '' : '（请先选择本机目录）'}</option>)}
          </select></label>}
        </div>)}</div>
        <div className={styles.action}><span className={styles.hint}>{preview.pendingProjects ? `${preview.pendingProjects} 个项目目录需在新设备重新关联` : '恢复后不会自动切换活动配置'}</span>
          <button type="button" className="button" disabled={busy} onClick={() => void cancelPreview()}>取消</button>
          <button type="button" className="button primary" disabled={busy || !importSelected.length} onClick={() => void applyPreview()}>确认恢复 {importSelected.length} 项</button></div>
      </>}
    </section>}
    </GuideDialog>
    <WebdavSettings active={active} editing={operation === 'webdav'} onEdit={setWebdavEditing} />
  </div>;
}
