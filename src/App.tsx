import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ManagedTools } from './features/home/ManagedTools';
import { ProjectLauncher } from './features/home/ProjectLauncher';
import { TerminalSettings } from './features/settings/TerminalSettings';
import { ToolWorkspacePage } from './features/tools/ToolWorkspace';
import { native, nativeAvailable } from './lib/native';
import { browserBootstrap } from './types/domain';
import type { ApiError, Bootstrap, Theme } from './types/domain';
import type { AdapterCatalog } from './types/native';

type Page = 'home' | 'connections' | 'library' | 'records' | 'settings';
type SettingsTab = 'general' | 'migration';
type RecordsTab = 'sessions' | 'usage';
type LibraryTab = 'prompts' | 'rules';

const pages: { id: Page; label: string; glyph: string }[] = [
  { id: 'home', label: '快速开始', glyph: '⌂' },
  { id: 'connections', label: '工具与连接', glyph: '◫' },
  { id: 'library', label: '资料库', glyph: '▤' },
  { id: 'records', label: '使用记录', glyph: '◷' },
  { id: 'settings', label: '设置', glyph: '⚙' },
];

function titleFor(page: Page): [string, string] {
  switch (page) {
    case 'home': return ['快速开始', '选择工具与项目，开始使用。'];
    case 'connections': return ['工具与连接', '按工具查看原生配置与连接。'];
    case 'library': return ['资料库', '统一保存常用提示词与规则。'];
    case 'records': return ['使用记录', '查看本机会话与用量。'];
    case 'settings': return ['设置', '只保留日常需要的选项。'];
  }
}

function Empty({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-symbol" aria-hidden="true">✧</div><h2>{title}</h2><p>{detail}</p>{action}</div>;
}

function PageTabs<T extends string>({ items, value, onChange }: { items: [T, string][]; value: T; onChange: (value: T) => void }) {
  return <div className="tabs" role="tablist">{items.map(([id, text]) => <button key={id} type="button" role="tab" aria-selected={value === id} className={value === id ? 'active' : ''} onClick={() => onChange(id)}>{text}</button>)}</div>;
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap>(() => browserBootstrap());
  const [catalog, setCatalog] = useState<AdapterCatalog | null>(null);
  const [loading, setLoading] = useState(nativeAvailable);
  const [loaded, setLoaded] = useState(!nativeAvailable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [page, setPage] = useState<Page>('home');
  const [tool, setTool] = useState<string>('');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [recordsTab, setRecordsTab] = useState<RecordsTab>('sessions');
  const [libraryTab, setLibraryTab] = useState<LibraryTab>('prompts');

  useEffect(() => {
    if (!nativeAvailable) return;
    void loadBootstrap();
  }, []);

  useEffect(() => {
    if (!nativeAvailable) return;
    let active = true;
    let stop: (() => void) | undefined;
    void listen<string>('cliora:tray-error', (event) => {
      if (active) setError({ code: 'tray_error', message: event.payload, action: '请检查项目目录、工具配置或外部终端后重试。' });
    }).then((unlisten) => {
      if (active) stop = unlisten; else unlisten();
    }).catch(() => {});
    return () => { active = false; stop?.(); };
  }, []);

  async function loadBootstrap() {
    if (!nativeAvailable) return;
    setLoading(true);
    setError(null);
    try {
      const [loadedBootstrap, loadedCatalog] = await Promise.all([native.getBootstrap(), native.listCliAdapters()]);
      setBootstrap(loadedBootstrap);
      setCatalog(loadedCatalog);
      setLoaded(true);
    } catch (value) {
      setLoaded(false);
      setError(value as ApiError);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const mode = bootstrap.preferences.theme;
    const apply = () => { document.documentElement.dataset.theme = mode === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode; };
    apply();
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [bootstrap.preferences.theme]);

  const managed: string[] = nativeAvailable ? catalog?.managedIds ?? [] : bootstrap.preferences.managed_tools;
  const visible = (nativeAvailable ? catalog?.registered ?? [] : bootstrap.tools).filter((item) => managed.includes(item.id));
  const visibleDescriptors = (catalog?.registered ?? []).filter((item) => managed.includes(item.id));
  const selectedTool = visible.some((item) => item.id === tool) ? tool : visible[0]?.id;
  const selectedToolName = visible.find((item) => item.id === selectedTool)?.name ?? selectedTool;
  const title = titleFor(page);

  function go(next: Page) {
    setPage(next);
    if (loaded) setError(null);
    document.querySelector('main')?.scrollTo({ top: 0 });
    requestAnimationFrame(() => document.querySelector<HTMLElement>('h1')?.focus());
  }

  async function updateManaged(id: string, checked: boolean) {
    if (!nativeAvailable || busy) return;
    const next = checked ? [...managed, id] : managed.filter((item) => item !== id);
    setBusy(true); setError(null);
    try { setCatalog(await native.setRegisteredManagedTools(next)); }
    catch (value) { setError(value as ApiError); }
    finally { setBusy(false); }
  }

  async function updateTheme(theme: Theme) {
    if (!nativeAvailable) { setBootstrap({ ...bootstrap, preferences: { ...bootstrap.preferences, theme } }); return; }
    if (busy) return;
    setBusy(true); setError(null);
    try { setBootstrap(await native.setTheme(theme)); }
    catch (value) { setError(value as ApiError); }
    finally { setBusy(false); }
  }

  return <div className="shell">
    <aside className="sidebar" aria-label="主导航">
      <div className="brand"><span className="brandmark" aria-hidden="true">栖</span><span><strong>栖点</strong><small>CLIORA</small></span></div>
      <nav className="nav" aria-label="页面">
        {pages.map((item, index) => <button key={item.id} type="button" className={page === item.id ? 'active' : ''} aria-current={page === item.id ? 'page' : undefined} onClick={() => go(item.id)}>
          <span className="nav-glyph" aria-hidden="true">{item.glyph}</span>{item.label}
          {index === 3 && <span className="nav-divider" />}
        </button>)}
      </nav>
      <div className="sidebar-foot"><span className="status-dot" /> 本机资料</div>
    </aside>
    <main className="content" id="main">
      {!nativeAvailable && <div className="environment-banner" role="status">浏览器预览：原生配置、持久保存和系统凭据仅在桌面应用中可用。</div>}
      {error && <div className="error-banner" role="alert"><div className="error-copy"><strong>{error.message}</strong><span>{error.action}</span>{error.data_directory && <code>{error.data_directory}</code>}</div>{loaded && <button type="button" onClick={() => setError(null)} aria-label="关闭错误提示">×</button>}</div>}
      <header className="page-head"><div><div className="eyebrow">CLIORA · LOCAL WORKSPACE</div><h1 tabIndex={-1}>{title[0]}</h1><p>{title[1]}</p></div>{page === 'home' && <span className="quiet-chip">仅在本机</span>}</header>
      {loading ? <Empty title="正在读取本机设置" detail="请稍候。" /> : !loaded ? <Empty title="暂时无法读取本机资料" detail="原数据仍保留。请按上方提示处理后重试。" action={<button className="button primary" type="button" onClick={loadBootstrap}>重试读取</button>} /> : <>
        {page === 'home' && <>
          <div className="section-heading"><h2>管理中的工具</h2><button className="text-button" type="button" onClick={() => go('settings')}>调整工具 <span aria-hidden="true">→</span></button></div>
          {visible.length ? nativeAvailable ? <ManagedTools tools={visibleDescriptors} onOpenTool={(id) => { setTool(id); go('connections'); }} /> : <div className="tool-table"><div className="table-head"><span>工具</span><span>当前状态</span><span>操作</span></div>{visible.map((item) => <div className="tool-row" key={item.id}><div className="tool-identity"><span className="tool-icon" aria-hidden="true">{item.name.slice(0, 1)}</span><span><strong>{item.name}</strong><small>浏览器预览</small></span></div><div className="tool-state"><strong>尚未检测</strong><small>请在桌面应用中读取本机配置</small></div><button className="button" type="button" onClick={() => { setTool(item.id); go('connections'); }}>查看工具 <span aria-hidden="true">→</span></button></div>)}</div> : <Empty title="尚未管理工具" detail="可在设置中开启需要管理的 CLI。" action={<button className="button primary" type="button" onClick={() => go('settings')}>前往设置</button>} />}
          {nativeAvailable ? <ProjectLauncher tools={visibleDescriptors} /> : <section className="home-secondary"><div className="section-heading"><h2>最近项目</h2></div><div className="subtle-panel"><strong>桌面应用中管理项目</strong><p>可以关联本机目录，并用选定的 CLI 在外部终端启动。</p></div></section>}
        </>}
        {page === 'connections' && <>
          {selectedTool ? nativeAvailable ? <ToolWorkspacePage managedTools={visibleDescriptors} initialTool={selectedTool} /> : <><div className="tool-tabs" role="tablist" aria-label="工具">{visible.map((item) => <button key={item.id} type="button" role="tab" aria-selected={selectedTool === item.id} className={selectedTool === item.id ? 'active' : ''} onClick={() => setTool(item.id)}>{item.name}</button>)}</div><div className="connection-layout"><div className="profile-column"><div className="column-title">{selectedToolName} 配置</div><div className="muted-copy">浏览器预览不读取本机配置</div></div><div className="detail-panel"><div className="detail-header"><div><div className="eyebrow">原生配置</div><h2>{selectedToolName}</h2></div><span className="status-pill">预览</span></div><Empty title="请在桌面应用中编辑原生配置" detail="桌面应用可读取和保存 CLI 的 TOML / JSON 原文。" /></div></div></> : <Empty title="没有管理中的工具" detail="先在设置中勾选需要管理的 CLI。" action={<button className="button primary" type="button" onClick={() => go('settings')}>前往设置</button>} />}
        </>}
        {page === 'library' && <><PageTabs items={[["prompts", "提示词"], ["rules", "长期规则"]]} value={libraryTab} onChange={setLibraryTab} /><Empty title={libraryTab === 'prompts' ? '还没有提示词' : '还没有长期规则'} detail="资料库功能接入后，内容会保存在本机并支持换设备恢复。" /></>}
        {page === 'records' && <><PageTabs items={[["sessions", "会话"], ["usage", "用量"]]} value={recordsTab} onChange={setRecordsTab} /><Empty title={recordsTab === 'sessions' ? '还没有可查看的会话' : '还没有可统计的用量'} detail={recordsTab === 'sessions' ? '本机 CLI 会话索引接入后，可从这里复制原生恢复命令。' : '仅在读取到真实记录后显示 token 与费用估算。'} /></>}
        {page === 'settings' && <><PageTabs items={[["general", "常规"], ["migration", "迁移与同步"]]} value={settingsTab} onChange={setSettingsTab} />{settingsTab === 'general' ? <>
          <section className="settings-group"><div className="setting-intro"><h2>管理的 CLI</h2><p>只在首页和工具页显示勾选的工具。关闭管理不会删除已有配置。</p></div>{(nativeAvailable ? catalog?.registered ?? [] : bootstrap.tools).map((item) => <label className="setting-row" key={item.id}><span><strong>{item.name}</strong><small>安装与配置状态在工具页查看</small></span><input type="checkbox" checked={managed.includes(item.id)} disabled={!nativeAvailable || busy} onChange={(event) => updateManaged(item.id, event.target.checked)} /></label>)}{catalog?.preservedUnknown.map((item) => <div className="setting-row" key={item.id}><span><strong>{item.id}</strong><small>未安装适配器，保留 {item.profileCount} 份配置，只读</small></span></div>)}</section>
          <section className="settings-group"><div className="setting-intro"><h2>外观</h2><p>跟随系统，或固定浅色、深色。</p></div><label className="setting-row"><span><strong>主题</strong></span><select aria-label="主题" value={bootstrap.preferences.theme} disabled={busy} onChange={(event) => updateTheme(event.target.value as Theme)}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label></section>
          {nativeAvailable && <TerminalSettings />}
        </> : <div className="migration-card"><span className="migration-mark" aria-hidden="true">↗</span><h2>换设备，恢复熟悉的配置</h2><p>加密配置包与 WebDAV 将集中在这里。导入前会预览差异，并重新关联本机目录。</p><div className="migration-actions"><button type="button" className="button" disabled>导出配置包</button><button type="button" className="button" disabled>导入配置包</button><button type="button" className="button" disabled>配置 WebDAV</button></div><small>迁移服务尚未接入；目前不会生成配置包。</small></div>}</>}
      </>}
    </main>
  </div>;
}
