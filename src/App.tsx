import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Icon } from './components/Icon';
import type { IconName } from './components/Icon';
import { ConfirmationHost } from './components/ConfirmationHost';
import { ToolIcon, ToolIconsContext } from './components/ToolIcon';
import { ToolIconSettings } from './features/settings/ToolIconSettings';
import { ManagedTools } from './features/home/ManagedTools';
import { ProjectLauncher } from './features/home/ProjectLauncher';
import { LibraryPage } from './features/library/LibraryPage';
import { RecordsPage } from './features/records/RecordsPage';
import { TerminalSettings } from './features/settings/TerminalSettings';
import { MigrationSettings } from './features/settings/MigrationSettings';
import { ToolWorkspacePage } from './features/tools/ToolWorkspace';
import { native, nativeAvailable } from './lib/native';
import { browserBootstrap } from './types/domain';
import type { ApiError, Bootstrap, Theme } from './types/domain';
import type { TrayRepairTarget } from './types/launch';
import type { AdapterCatalog } from './types/native';

type Page = 'home' | 'connections' | 'library' | 'records' | 'settings';
type SettingsTab = 'general' | 'migration';

const pages: { id: Page; label: string; glyph: IconName }[] = [
  { id: 'home', label: '快速开始', glyph: 'home' },
  { id: 'connections', label: '工具与连接', glyph: 'connections' },
  { id: 'library', label: '资料库', glyph: 'library' },
  { id: 'records', label: '使用记录', glyph: 'records' },
  { id: 'settings', label: '设置', glyph: 'settings' },
];

const themes: { id: Theme; label: string; glyph: IconName }[] = [
  { id: 'system', label: '跟随系统主题', glyph: 'monitor' },
  { id: 'light', label: '浅色主题', glyph: 'sun' },
  { id: 'dark', label: '深色主题', glyph: 'moon' },
];

const shortcutKey = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

function titleFor(page: Page): [string, string] {
  switch (page) {
    case 'home': return ['快速开始', '选择工具与项目，一键在外部终端启动。'];
    case 'connections': return ['工具与连接', '管理每个 CLI 的配置、MCP 与 Skill。'];
    case 'library': return ['资料库', '统一保存常用提示词与规则。'];
    case 'records': return ['使用记录', '查看本机会话与用量。'];
    case 'settings': return ['设置', '只保留日常需要的选项。'];
  }
}

function Empty({ title, detail, action, icon = 'leaf' }: { title: string; detail: string; action?: ReactNode; icon?: IconName }) {
  return <div className="empty-state"><div className="empty-symbol" aria-hidden="true"><Icon name={icon} size={22} /></div><h2>{title}</h2><p>{detail}</p>{action}</div>;
}

function LoadingSkeleton() {
  return <div className="skeleton-page" aria-busy="true">
    <p className="muted-copy">正在读取本机设置</p>
    <div className="skeleton-row"><div className="skeleton-page"><div className="skeleton-block" /><div className="skeleton-block" /><div className="skeleton-block" /></div><div className="skeleton-block tall" /></div>
  </div>;
}

function PageTabs<T extends string>({ items, value, onChange }: { items: [T, string][]; value: T; onChange: (value: T) => void }) {
  return <div className="tabs" role="tablist" aria-label="设置分类">{items.map(([id, text]) => <button key={id} type="button" role="tab" aria-selected={value === id} className={value === id ? 'active' : ''} onClick={() => onChange(id)}>{text}</button>)}</div>;
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap>(() => browserBootstrap());
  const [catalog, setCatalog] = useState<AdapterCatalog | null>(null);
  const [loading, setLoading] = useState(nativeAvailable);
  const [loaded, setLoaded] = useState(!nativeAvailable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [page, setPage] = useState<Page>('home');
  const [connectionsVisited, setConnectionsVisited] = useState(false);
  const [tool, setTool] = useState<string>('');
  const [toolOpenSequence, setToolOpenSequence] = useState(0);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [trayRepair, setTrayRepair] = useState<TrayRepairTarget | null>(null);
  const activePage = useRef<Page>(page);
  activePage.current = page;
  const workspaceDirty = useRef(false);
  const pendingCatalog = useRef<AdapterCatalog | null>(null);
  const refreshSequence = useRef(0);
  const onWorkspaceDirtyChange = useCallback((dirty: boolean) => {
    workspaceDirty.current = dirty;
    if (!dirty && pendingCatalog.current) { setCatalog(pendingCatalog.current); pendingCatalog.current = null; }
  }, []);
  const canLeave = useCallback((_next: Page) => true, []);
  useEffect(() => { if (page === 'connections') setConnectionsVisited(true); }, [page]);

  useEffect(() => {
    if (!nativeAvailable) return;
    void loadBootstrap();
  }, []);

  useEffect(() => {
    if (!nativeAvailable) return;
    let active = true;
    const stops: Array<() => void> = [];
    void listen<string>('cliora:tray-error', (event) => {
      if (active) setError({ code: 'tray_error', message: event.payload, action: '请检查项目目录、工具配置或外部终端后重试。' });
    }).then((unlisten) => {
      if (active) stops.push(unlisten); else unlisten();
    }).catch(() => {});
    void listen('cliora:portable-changed', () => { if (active) void refreshAfterImport(); }).then((unlisten) => {
      if (active) stops.push(unlisten); else unlisten();
    }).catch(() => {});
    void listen<Omit<TrayRepairTarget, 'sequence'>>('cliora:tray-repair', (event) => {
      if (!active || !['home', 'connections', 'settings'].includes(event.payload.page) || !canLeave(event.payload.page)) return;
      setTrayRepair((old) => ({ ...event.payload, sequence: (old?.sequence ?? 0) + 1 }));
      if (event.payload.page === 'settings') setSettingsTab('general');
      setPage(event.payload.page);
    }).then((unlisten) => {
      if (active) stops.push(unlisten); else unlisten();
    }).catch(() => {});
    return () => { active = false; stops.forEach((stop) => stop()); };
  }, [canLeave]);

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

  async function refreshAfterImport() {
    if (!nativeAvailable) return;
    const sequence = ++refreshSequence.current;
    try {
      const [nextBootstrap, nextCatalog] = await Promise.all([native.getBootstrap(), native.listCliAdapters()]);
      if (sequence !== refreshSequence.current) return;
      setBootstrap(nextBootstrap);
      if (workspaceDirty.current) {
        pendingCatalog.current = nextCatalog;
        setCatalog((current) => current ? { ...nextCatalog, managedIds: current.managedIds } : nextCatalog);
      } else { pendingCatalog.current = null; setCatalog(nextCatalog); }
    } catch (value) { setError(value as ApiError); }
  }

  useEffect(() => {
    const mode = bootstrap.preferences.theme;
    if (nativeAvailable) { try { void getCurrentWindow().setTheme(mode === 'system' ? null : mode).catch(() => {}); } catch { void 0; } }
    const apply = () => { document.documentElement.dataset.theme = mode === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode; };
    apply();
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [bootstrap.preferences.theme]);

  const goRef = useRef<(next: Page) => void>(() => {});
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const index = Number(event.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= pages.length || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      goRef.current(pages[index].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const managed: string[] = nativeAvailable ? catalog?.managedIds ?? [] : bootstrap.preferences.managed_tools;
  const visible = (nativeAvailable ? catalog?.registered ?? [] : bootstrap.tools).filter((item) => managed.includes(item.id));
  const visibleDescriptors = (catalog?.registered ?? []).filter((item) => managed.includes(item.id));
  const selectedTool = visible.some((item) => item.id === tool) ? tool : visible[0]?.id;
  const selectedToolName = visible.find((item) => item.id === selectedTool)?.name ?? selectedTool;
  const title = titleFor(page);

  function go(next: Page) {
    if (!canLeave(next)) return;
    setPage(next);
    if (loaded) setError(null);
    document.querySelector('main')?.scrollTo({ top: 0 });
    requestAnimationFrame(() => document.querySelector<HTMLElement>('h1')?.focus());
  }
  goRef.current = go;

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

  async function updateIcon(toolId: string, dataUrl: string | null) {
    if (!nativeAvailable || busy) return;
    setBusy(true); setError(null);
    try { setBootstrap(await native.setToolIcon(toolId, dataUrl)); }
    catch (value) { setError(value as ApiError); }
    finally { setBusy(false); }
  }

  return <ToolIconsContext value={bootstrap.preferences.tool_icons ?? {}}><div className="shell">
    <aside className="sidebar" aria-label="主导航">
      <div className="brand"><span className="brandmark" aria-hidden="true"><Icon name="leaf" size={20} strokeWidth={1.9} /></span><span><strong>栖点</strong><small>CLIORA</small></span></div>
      <nav className="nav" aria-label="页面">
        {pages.map((item, index) => <button key={item.id} type="button" className={page === item.id ? 'active' : ''} aria-current={page === item.id ? 'page' : undefined} aria-keyshortcuts={`${shortcutKey === '⌘' ? 'Meta' : 'Control'}+${index + 1}`} title={`${item.label}（${shortcutKey}+${index + 1}）`} onClick={() => go(item.id)}>
          <span className="nav-glyph" aria-hidden="true"><Icon name={item.glyph} /></span>{item.label}<kbd className="nav-kbd" aria-hidden="true">{shortcutKey === '⌘' ? '⌘' : '^'}{index + 1}</kbd>
        </button>)}
      </nav>
      <div className="sidebar-foot">
        <div className="theme-switch" role="group" aria-label="切换主题">{themes.map((item) => <button key={item.id} type="button" aria-label={item.label} title={item.label} aria-pressed={bootstrap.preferences.theme === item.id} disabled={busy} onClick={() => { if (bootstrap.preferences.theme !== item.id) void updateTheme(item.id); }}><Icon name={item.glyph} size={14} /></button>)}</div>
        <div className="sidebar-status"><span className="status-dot" data-tone={nativeAvailable ? undefined : 'preview'} />{nativeAvailable ? '本机资料 · 仅存于此设备' : '浏览器预览'}</div>
      </div>
    </aside>
    <main className="content" id="main"><div className="content-inner">
      {!nativeAvailable && <div className="environment-banner" role="status"><span className="banner-icon"><Icon name="info" size={16} /></span><span>浏览器预览：原生配置、持久保存和系统凭据仅在桌面应用中可用。</span></div>}
      {error && <div className="error-banner" role="alert"><span className="banner-icon"><Icon name="alert" size={16} /></span><div className="error-copy"><strong>{error.message}</strong><span>{error.action}</span>{error.data_directory && <code>{error.data_directory}</code>}</div>{loaded && <button type="button" onClick={() => setError(null)} aria-label="关闭错误提示"><Icon name="close" size={14} /></button>}</div>}
      <header className="page-head"><div><h1 tabIndex={-1}>{title[0]}</h1>{title[1] && <p>{title[1]}</p>}</div></header>
      {loading ? <LoadingSkeleton /> : !loaded ? <Empty icon="alert" title="暂时无法读取本机资料" detail="原数据仍保留。请按上方提示处理后重试。" action={<button className="button primary" type="button" onClick={loadBootstrap}>重试读取</button>} /> : <>
        {page === 'home' && <div className="home-band">
          <section className="home-tools">
            <div className="section-heading"><h2>管理中的工具</h2><button className="text-button" type="button" onClick={() => go('settings')}>调整工具 <span aria-hidden="true">→</span></button></div>
            {visible.length ? nativeAvailable ? <ManagedTools tools={visibleDescriptors} onOpenTool={(id) => { setTool(id); setToolOpenSequence((value) => value + 1); go('connections'); }} /> : <div className="tool-table"><div className="table-head"><span>工具</span><span>当前状态</span><span>操作</span></div>{visible.map((item) => <div className="tool-row" key={item.id}><div className="tool-identity"><span className="tool-icon" aria-hidden="true"><ToolIcon toolId={item.id} /></span><span><strong>{item.name}</strong><small>浏览器预览</small></span></div><div className="tool-state"><strong>尚未检测</strong><small>请在桌面应用中读取本机配置</small></div><button className="button" type="button" onClick={() => { setTool(item.id); go('connections'); }}>查看工具 <span aria-hidden="true">→</span></button></div>)}</div> : <Empty title="尚未管理工具" detail="可在设置中开启需要管理的 CLI。" action={<button className="button primary" type="button" onClick={() => go('settings')}>前往设置</button>} />}
          </section>
          {nativeAvailable ? <ProjectLauncher tools={visibleDescriptors} repair={trayRepair?.page === 'home' ? trayRepair : null} /> : <section className="home-secondary"><div className="section-heading"><h2>最近项目</h2></div><div className="subtle-panel"><strong>桌面应用中管理项目</strong><p>可以关联本机目录，并用选定的 CLI 在外部终端启动。</p></div></section>}
        </div>}
        {(page === 'connections' || connectionsVisited) && <div hidden={page !== 'connections'}>
          {selectedTool ? nativeAvailable ? <ToolWorkspacePage managedTools={visibleDescriptors} initialTool={selectedTool} openSequence={toolOpenSequence} active={page === 'connections'} repair={trayRepair?.page === 'connections' ? trayRepair : null} onDirtyChange={onWorkspaceDirtyChange} /> : <><div className="tool-tabs" role="tablist" aria-label="工具">{visible.map((item) => <button key={item.id} type="button" role="tab" aria-selected={selectedTool === item.id} className={selectedTool === item.id ? 'active' : ''} onClick={() => setTool(item.id)}>{item.name}</button>)}</div><div className="connection-layout"><div className="profile-column"><div className="column-title">{selectedToolName} 配置</div><div className="muted-copy">浏览器预览不读取本机配置</div></div><div className="detail-panel"><div className="detail-header"><div><div className="eyebrow">配置</div><h2>{selectedToolName}</h2></div><span className="status-pill">预览</span></div><Empty title="请在桌面应用中编辑原生配置" detail="桌面应用可读取和保存 CLI 的 TOML / JSON 原文。" /></div></div></> : <Empty title="没有管理中的工具" detail="先在设置中勾选需要管理的 CLI。" action={<button className="button primary" type="button" onClick={() => go('settings')}>前往设置</button>} />}
        </div>}
        <div hidden={page !== 'library'}><LibraryPage managedTools={visibleDescriptors} active={page === 'library'} /></div>
        <div hidden={page !== 'records'}><RecordsPage active={page === 'records'} tools={catalog?.registered ?? []} onOpenProjects={() => go('home')} /></div>
        {page === 'settings' && <PageTabs items={[["general", "常规"], ["migration", "迁移与同步"]]} value={settingsTab} onChange={setSettingsTab} />}
        {page === 'settings' && settingsTab === 'general' && <>
          <section className="settings-group"><div className="setting-intro"><h2>管理的 CLI</h2><p>只在首页和工具页显示勾选的工具。关闭管理不会删除已有配置。</p></div><div className="managed-checks">{(nativeAvailable ? catalog?.registered ?? [] : bootstrap.tools).map((item) => <label key={item.id}><input type="checkbox" checked={managed.includes(item.id)} disabled={!nativeAvailable || busy} onChange={(event) => updateManaged(item.id, event.target.checked)} /><ToolIcon toolId={item.id} size={24} /><span>{item.name}</span></label>)}</div><ToolIconSettings tools={nativeAvailable ? catalog?.registered ?? [] : bootstrap.tools} icons={bootstrap.preferences.tool_icons ?? {}} busy={busy} onChange={updateIcon} onError={(message) => setError({ code: 'icon_error', message, action: '请重新选择图片。' })} />{catalog?.preservedUnknown.map((item) => <div className="setting-row" key={item.id}><span><strong>{item.id}</strong><small>未安装适配器，保留 {item.profileCount} 份配置，只读</small></span></div>)}</section>
          <section className="settings-group"><div className="setting-intro"><h2>外观</h2><p>跟随系统，或固定浅色、深色。</p></div><label className="setting-row"><span><strong>主题</strong></span><select aria-label="主题" value={bootstrap.preferences.theme} disabled={busy} onChange={(event) => updateTheme(event.target.value as Theme)}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label></section>
          {nativeAvailable && <TerminalSettings />}
          <div className="setting-row migration-entry"><span><strong>换设备与备份</strong><small>导出加密配置包，或通过 WebDAV 同步</small></span><button className="button" type="button" onClick={() => setSettingsTab('migration')}>迁移与同步 →</button></div>
        </>}
        <div hidden={page !== 'settings' || settingsTab !== 'migration'}><MigrationSettings active={page === 'settings' && settingsTab === 'migration'} onImported={() => void refreshAfterImport()} /></div>
      </>}
    </div></main>
  </div><ConfirmationHost /></ToolIconsContext>;
}
