import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import type { AdapterDescriptor } from '../../types/native';
import type { Project } from '../../types/launch';
import type { HistoryDetail, HistoryFilter, HistoryPrice, HistorySession, ScanStatus } from '../../types/history';
import { displayPath } from '../../lib/paths';
import { FilterSelect } from '../../components/FilterSelect';
import { ToastStack, type Toast } from '../../components/Toast';
import { ToolIcon, toolOptions } from '../../components/ToolIcon';
import { Icon } from '../../components/Icon';
import { searchShortcutHint } from '../../lib/shortcut';
import { UsageDashboard, type UsageNotify } from './UsageDashboard';
import { SessionReader } from './SessionReader';
import { DateRangeFilter, type RangeKey } from './DateRangeFilter';
import { useDisclosure } from './useDisclosure';
import { navigateChoices } from '../../lib/choiceNavigation';
import styles from './RecordsPage.module.css';

const copiedCommandText = '已复制原生恢复命令，粘贴后由终端执行。';

const day = (ms: number | null) => ms === null ? '时间未知' : new Date(ms).toLocaleString();
const timeOfDay = (date: Date) => date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
function compactDay(ms: number | null) {
  if (ms === null) return '时间未知';
  const date = new Date(ms);
  const now = new Date();
  const daysAgo = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (daysAgo <= 0) return timeOfDay(date);
  if (daysAgo === 1) return `昨天 ${timeOfDay(date)}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
type SessionGroup = 'favorite' | 'today' | 'yesterday' | 'week' | 'earlier' | 'unknown';
const groupLabels: Record<SessionGroup, string> = { favorite: '收藏', today: '今天', yesterday: '昨天', week: '近 7 天', earlier: '更早', unknown: '时间未知' };
function groupOf(ms: number | null): SessionGroup {
  if (ms === null) return 'unknown';
  const daysAgo = Math.round((startOfDay(new Date()) - startOfDay(new Date(ms))) / 86400000);
  if (daysAgo <= 0) return 'today';
  if (daysAgo === 1) return 'yesterday';
  if (daysAgo < 7) return 'week';
  return 'earlier';
}
function rowTime(ms: number | null) {
  if (ms === null) return '时间未知';
  const group = groupOf(ms);
  if (group === 'today') return timeOfDay(new Date(ms));
  if (group === 'yesterday') return `昨天 ${timeOfDay(new Date(ms))}`;
  return compactDay(ms);
}
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
const recordNext = '可点击刷新本机记录或调整筛选。';
const errorText = (error: unknown) => formatFailure(error, '使用记录操作失败', recordNext);

const rangePresets: Array<{ id: RangeKey; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'today', label: '今天' },
  { id: 'yesterday', label: '昨天' },
  { id: '7', label: '近 7 天' },
  { id: '30', label: '近 30 天' },
  { id: 'month', label: '本月' },
  { id: 'custom', label: '自定义' },
];
const isoDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const shiftDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
function rangeDates(key: RangeKey, customFrom: string, customTo: string, today = new Date()) {
  const current = isoDay(today);
  if (key === 'today') return { from: current, to: current };
  if (key === 'yesterday') { const day = isoDay(shiftDays(today, -1)); return { from: day, to: day }; }
  if (key === '7') return { from: isoDay(shiftDays(today, -6)), to: current };
  if (key === '30') return { from: isoDay(shiftDays(today, -29)), to: current };
  if (key === 'month') return { from: isoDay(new Date(today.getFullYear(), today.getMonth(), 1)), to: current };
  if (key === 'custom') return customFrom && customTo && customFrom > customTo ? { from: customTo, to: customFrom } : { from: customFrom, to: customTo };
  return { from: '', to: '' };
}
const dayLabel = (iso: string) => { const [year, month, day] = iso.split('-').map(Number); return new Date(year, (month || 1) - 1, day || 1).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }); };
function rangeCaption(from: string, to: string) {
  if (!from && !to) return '';
  if (from && to && from === to) return dayLabel(from);
  if (from && to) return `${dayLabel(from)} – ${dayLabel(to)}`;
  if (from) return `${dayLabel(from)} 起`;
  return `${dayLabel(to)} 止`;
}
export function RecordsPage({ active, tools, onOpenProjects }: { active: boolean; tools: AdapterDescriptor[]; onOpenProjects: () => void }) {
  const [tab, setTab] = useState<'sessions' | 'usage'>('sessions');
  const [search, setSearch] = useState('');
  const [toolId, setToolId] = useState('');
  const [model, setModel] = useState('');
  const [projectId, setProjectId] = useState('');
  const [rangeKey, setRangeKey] = useState<RangeKey>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [sort, setSort] = useState('recent');
  const [visibleSessionCount, setVisibleSessionCount] = useState(80);
  const [detailError, setDetailError] = useState('');
  const [detailRetry, setDetailRetry] = useState(0);
  const [listError, setListError] = useState(false);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [scans, setScans] = useState<ScanStatus[]>([]);
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const pendingSession = useRef<string | null>(null);
  const [prices, setPrices] = useState<HistoryPrice[]>([]);
  const [modelCatalog, setModelCatalog] = useState<string[]>([]);
  const [scanVersion, setScanVersion] = useState(0);
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);
  const [scanMode, setScanMode] = useState<'manual' | 'auto'>('manual');
  const [mode, setMode] = useState<'normal' | 'yolo'>('normal');
  const [resumeCommand, setResumeCommand] = useState<{ key: string; text: string } | null>(null);
  const [resumeError, setResumeError] = useState<{ key: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [filterLoading, setFilterLoading] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ running: boolean; toolId: string; completedSources: number; totalSources: number } | null>(null);
  const scanRequest = useRef(0);
  const scanningRef = useRef(false);
  const lastScan = useRef(0);
  const [error, setError] = useState<Toast | null>(null);
  const [notice, setNotice] = useState<Toast | null>(null);
  const toastSequence = useRef(0);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const [copyFlash, setCopyFlash] = useState(0);
  useEffect(() => {
    if (!copyFlash) return;
    const timer = window.setTimeout(() => setCopyFlash(0), 1800);
    return () => window.clearTimeout(timer);
  }, [copyFlash]);
  const copied = !!copyFlash;
  const protectSave = useRef(false);
  function showError(value: unknown) {
    protectSave.current = false;
    setNotice(null);
    setError({ id: ++toastSequence.current, tone: 'alert', text: typeof value === 'string' ? value : errorText(value) });
  }
  function showReadError(value: unknown) {
    if (!protectSave.current) setNotice(null);
    setError({ id: ++toastSequence.current, tone: 'alert', text: typeof value === 'string' ? value : formatFailure(value, '使用记录读取失败', recordNext) });
  }
  function showNotice(text: string, protect = false) {
    setError(null);
    setNotice({ id: ++toastSequence.current, tone: 'status', text });
    protectSave.current = protect;
  }
  const initialized = useRef(false);
  const request = useRef(0);
  const detailRequest = useRef(0);
  const dates = useMemo(() => rangeDates(rangeKey, customFrom, customTo), [rangeKey, customFrom, customTo]);
  const toolKey = tools.map((item) => item.id).join('|');
  const filter = useMemo<HistoryFilter>(() => ({
    toolId: toolId || null, model: model.trim() || null, projectId: projectId || null,
    search: search.trim() || null, fromMs: dates.from ? new Date(`${dates.from}T00:00:00`).getTime() : null,
    toMs: dates.to ? (() => { const next = new Date(`${dates.to}T00:00:00`); next.setDate(next.getDate() + 1); return next.getTime(); })() : null,
    favoriteOnly, tools: toolKey ? toolKey.split('|') : null,
  }), [toolId, model, projectId, search, dates, favoriteOnly, toolKey]);

  const filterRef = useRef(filter); filterRef.current = filter;
  const loadedFilter = useRef('');
  const load = useCallback(async (current: HistoryFilter) => {
    if (!nativeAvailable) return false;
    const sequence = ++request.current;
    const key = JSON.stringify(current); setFilterLoading(true); setListError(false);
    try {
      const items = await native.listHistorySessions(current);
      if (sequence !== request.current || key !== JSON.stringify(filterRef.current)) return false;
      loadedFilter.current = key;
      setSessions(items); setError(null);
      setModelCatalog((old) => { const next = [...new Set([...old, ...items.flatMap((item) => item.model ? [item.model] : [])])].sort(); return next.length === old.length ? old : next; });
      const pending = pendingSession.current;
      pendingSession.current = null;
      setSelectedId((old) => pending && items.some((item) => item.id === pending) ? pending : old && items.some((item) => item.id === old) ? old : items[0]?.id ?? null);
      return true;
    } catch (value) {
      if (sequence === request.current && key === JSON.stringify(filterRef.current)) { setListError(true); showReadError(value); }
      return false;
    }
    finally { if (sequence === request.current) setFilterLoading(false); }
  }, []);

  useEffect(() => {
    if (!active || !nativeAvailable || initialized.current) return;
    initialized.current = true;
    void Promise.all([native.listProjects(), native.listHistoryPrices()])
      .then(([knownProjects, knownPrices]) => { setProjects(knownProjects); setPrices(knownPrices); })
      .catch(value => showReadError(value));
  }, [active]);

  // Scans are incremental, so the index is refreshed whenever the page is shown and
  // periodically while it stays open; today's numbers then track running sessions.
  useEffect(() => {
    if (!active || !nativeAvailable) return;
    const run = () => { if (Date.now() - lastScan.current > 45_000) void refresh(false, true); };
    run();
    const timer = window.setInterval(run, 120_000);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (!initialized.current || !active) return;
    if (loadedFilter.current === JSON.stringify(filter)) return;
    const timer = window.setTimeout(() => { void load(filter); }, loadedFilter.current ? 180 : 0);
    return () => window.clearTimeout(timer);
  }, [filter, active, load]);

  useEffect(() => {
    const sequence = ++detailRequest.current;
    setDetailError('');
    if (!selectedId || !nativeAvailable) { setDetail(null); return; }
    void native.getHistorySession(selectedId).then((value) => {
      if (sequence !== detailRequest.current) return;
      setDetail(value);
    })
      .catch((value) => { if (sequence === detailRequest.current) setDetailError(formatFailure(value, '这段会话暂时无法读取', '请重新加载会话。')); });
    return () => { detailRequest.current++; };
  }, [selectedId, detailRetry, scanVersion]);

  const selected = detail?.session.id === selectedId ? detail : null;
  const yolo = tools.find((item) => item.id === selected?.session.toolId)?.yoloAvailable ?? false;
  const resumeKey = selected ? JSON.stringify([selected.session.id, selected.session.updatedAt, selected.session.projectId,
    selected.session.cwd, selected.resumeReason, mode, yolo]) : '';
  const readyCommand = resumeCommand?.key === resumeKey ? resumeCommand.text : '';
  const shownResumeError = resumeError?.key === resumeKey ? resumeError.text : selected?.resumeReason ?? '';
  useEffect(() => { if (!yolo && mode === 'yolo') setMode('normal'); }, [yolo, mode]);
  useEffect(() => {
    setResumeCommand(null);
    setResumeError(null);
    if (!selected || selected.resumeReason || !nativeAvailable || (mode === 'yolo' && !yolo)) {
      return;
    }
    let live = true;
    void native.copyHistoryResumeCommand(selected.session.id, mode).then((text) => { if (live) { setResumeCommand({ key: resumeKey, text }); setResumeError(null); } })
      .catch((value) => { if (live) { setResumeCommand(null); setResumeError({ key: resumeKey, text: errorText(value) }); } });
    return () => { live = false; };
  }, [resumeKey]);

  useEffect(() => {
    if (!scanning || !active) return;
    const poll = () => { void native.getHistoryScanProgress().then(setScanProgress).catch(() => {}); };
    poll(); const timer = window.setInterval(poll, 700);
    return () => window.clearInterval(timer);
  }, [scanning, active]);
  async function refresh(announce = true, auto = false) {
    if (!nativeAvailable || scanningRef.current) return;
    const sequence = ++scanRequest.current; scanningRef.current = true; lastScan.current = Date.now();
    setScanning(true); setScanMode(auto ? 'auto' : 'manual');
    if (!auto) { protectSave.current = false; setNotice(null); setError(null); }
    try {
      const reports = await native.refreshHistory();
      if (sequence !== scanRequest.current) return;
      setScans(reports); setLastScanAt(Date.now()); setScanVersion((value) => value + 1);
      const loaded = await load(filterRef.current);
      if (sequence !== scanRequest.current || !loaded || !announce) return;
      showNotice('已刷新本机记录。');
    } catch (value) { if (sequence === scanRequest.current && !auto) showError(value); }
    finally { if (sequence === scanRequest.current) { scanningRef.current = false; setScanning(false); setScanProgress(null); } }
  }
  async function cancelScan() {
    scanRequest.current++; scanningRef.current = false; setScanning(false); setScanProgress(null); protectSave.current = false; setNotice(null); setError(null);
    try { await native.cancelHistoryRefresh(); showNotice('已请求停止扫描，现有记录保留。'); }
    catch (value) { showError(value); }
  }

  async function favorite() {
    if (!selected || favoriteBusy) return;
    setFavoriteBusy(true);
    try {
      await native.setHistoryFavorite(selected.session.id, !selected.session.favorite);
      setDetail((current) => current?.session.id === selected.session.id ? { ...current, session: { ...current.session, favorite: !selected.session.favorite } } : current);
      await load(filter);
    } catch (value) { showError(value); }
    finally { setFavoriteBusy(false); }
  }

  async function assignProject(next: string) {
    if (!selected) return;
    try {
      await native.setHistoryProject(selected.session.id, next || null);
      const updated = await native.getHistorySession(selected.session.id);
      setDetail((current) => current?.session.id === updated.session.id ? updated : current);
      await load(filter);
    } catch (value) { showError(value); }
  }

  async function copy() {
    if (!readyCommand) return;
    protectSave.current = false; setNotice(null); setError(null);
    try { await navigator.clipboard.writeText(readyCommand); showNotice(copiedCommandText); setCopyFlash((value) => value + 1); }
    catch { setCopyFlash(0); if (commandRef.current) commandRef.current.open = true; showError('复制失败，恢复命令仍在页面上，可以手动选择。'); }
  }

  async function resume() {
    if (!selected || !readyCommand) return;
    setBusy(true); protectSave.current = false; setNotice(null); setError(null);
    try { await native.resumeHistorySession(selected.session.id, mode); showNotice('已请求外部终端恢复会话。'); }
    catch (value) { showError(value); }
    finally { setBusy(false); }
  }

  function focusSession(next: HistorySession | undefined) {
    if (!next) return;
    const index = orderedSessions.findIndex((item) => item.id === next.id);
    setVisibleSessionCount((count) => Math.max(count, index + 1));
    setSelectedId(next.id);
    requestAnimationFrame(() => {
      const target = document.querySelector<HTMLButtonElement>(`[data-session-id="${CSS.escape(next.id)}"]`);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'nearest' });
    });
  }
  function moveSession(current: HistorySession, step: 1 | -1) {
    const index = orderedSessions.findIndex((item) => item.id === current.id);
    if (index < 0 || orderedSessions.length < 2) return;
    focusSession(orderedSessions[(index + step + orderedSessions.length) % orderedSessions.length]);
  }

  async function exportSession(format: 'markdown' | 'json') {
    if (!selected) return;
    try {
      const destination = await save({ title: '导出会话资料', defaultPath: `cliora-session-${selected.session.nativeId ?? selected.session.id.slice(0, 8)}.${format === 'json' ? 'json' : 'md'}`,
        filters: [{ name: format === 'json' ? 'JSON' : 'Markdown', extensions: [format === 'json' ? 'json' : 'md'] }] });
      if (!destination) return;
      protectSave.current = false; setNotice(null); setError(null);
      const path = await native.exportHistorySession(selected.session.id, format, destination);
      showNotice(`已导出到 ${path}`);
    } catch (value) { showError(value); }
  }

  const toolName = (id: string) => tools.find((item) => item.id === id)?.name ?? id;
  const detailRef = useRef<HTMLDivElement>(null);
  const commandRef = useRef<HTMLDetailsElement>(null);
  const actionsRef = useDisclosure();
  function selectSession(id: string) {
    setSelectedId(id); setMobileDetail(true);
    requestAnimationFrame(() => {
      if (window.matchMedia('(max-width: 760px)').matches) detailRef.current?.querySelector('button')?.focus({ preventScroll: true });
    });
  }
  useEffect(() => { detailRef.current?.scrollTo({ top: 0 }); }, [selectedId]);
  const groupedSessions = useMemo(() => {
    const groups = new Map<SessionGroup, HistorySession[]>();
    const sorted = [...sessions].sort((a, b) => sort === 'messages' ? b.messageCount - a.messageCount : sort === 'oldest' ? (a.updatedAt ?? Infinity) - (b.updatedAt ?? Infinity) : (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    if (sort !== 'recent') return [{ group: 'earlier' as SessionGroup, items: sorted }];
    for (const item of sorted) {
      const group: SessionGroup = item.favorite ? 'favorite' : groupOf(item.updatedAt);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(item);
    }
    return (['favorite', 'today', 'yesterday', 'week', 'earlier', 'unknown'] as const)
      .flatMap((group) => groups.has(group) ? [{ group, items: groups.get(group)! }] : []);
  }, [sessions, sort]);
  const orderedSessions = useMemo(() => groupedSessions.flatMap((group) => group.items), [groupedSessions]);
  useEffect(() => { setVisibleSessionCount(80); }, [filter, sort]);
  useEffect(() => {
    const index = orderedSessions.findIndex((item) => item.id === selectedId);
    if (index >= 0) setVisibleSessionCount((count) => Math.max(count, Math.ceil((index + 1) / 80) * 80));
  }, [orderedSessions, selectedId, filter, sort]);
  let remainingSessions = visibleSessionCount;
  const visibleGroups = groupedSessions.flatMap(({ group, items }) => {
    const visible = items.slice(0, Math.max(0, remainingSessions));
    remainingSessions -= items.length;
    return visible.length ? [{ group, items: visible, total: items.length }] : [];
  });
  const activeFilters = useMemo(() => {
    const items: Array<{ key: string; label: string; clear: () => void }> = [];
    if (toolId) items.push({ key: 'tool', label: `工具：${toolName(toolId)}`, clear: () => setToolId('') });
    if (tab === 'sessions' && search.trim()) items.push({ key: 'search', label: `搜索：${search.trim()}`, clear: () => setSearch('') });
    if (tab === 'sessions' && favoriteOnly) items.push({ key: 'favorite', label: '只看收藏', clear: () => setFavoriteOnly(false) });
    if (projectId) items.push({ key: 'project', label: `项目：${projectId === '__unknown__' ? '未归类' : projects.find((item) => item.id === projectId)?.name ?? projectId}`, clear: () => setProjectId('') });
    if (model) items.push({ key: 'model', label: `模型：${model === '__unknown__' ? '模型未知' : model}`, clear: () => setModel('') });
    if (rangeKey !== 'all') items.push({ key: 'range', label: `时间：${rangeKey === 'custom' ? rangeCaption(dates.from, dates.to) || '自定义' : rangePresets.find((item) => item.id === rangeKey)?.label ?? rangeKey}`, clear: () => setRangeKey('all') });
    return items;
  }, [toolId, tab, search, favoriteOnly, projectId, model, rangeKey, projects, dates, tools]);
  function clearAllFilters() {
    setToolId(''); setSearch(''); setFavoriteOnly(false); setProjectId(''); setModel(''); setRangeKey('all');
  }

  const notify: UsageNotify = { status: (text, protect) => showNotice(text, protect), alert: showError, readAlert: showReadError, clear: () => { protectSave.current = false; setNotice(null); setError(null); } };
  function openSession(id: string) {
    pendingSession.current = search.trim() || favoriteOnly || toolId || model || projectId || rangeKey !== 'all' ? id : null;
    clearAllFilters();
    setTab('sessions');
    selectSession(id);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-session-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' }));
  }

  if (!nativeAvailable) return <div className={styles.empty}><h2>本机使用记录</h2><p>在桌面应用中读取原生 CLI 会话。浏览器预览不展示本机历史。</p></div>;
  return <section className={styles.page} aria-label="使用记录内容" data-mobile-detail={mobileDetail || undefined}>
    <div className={styles.toolbar}><div className={styles.tabs} role="tablist" aria-label="使用记录类型" onKeyDown={navigateChoices}>
      <button type="button" role="tab" id="records-sessions-tab" aria-controls="records-sessions-panel" tabIndex={tab === 'sessions' ? 0 : -1} aria-selected={tab === 'sessions'} onClick={() => setTab('sessions')}><Icon name="records" size={15} />会话{initialized.current ? <span className="count-chip">{sessions.length}</span> : null}</button>
      <button type="button" role="tab" id="records-usage-tab" aria-controls="records-usage-panel" tabIndex={tab === 'usage' ? 0 : -1} aria-selected={tab === 'usage'} onClick={() => setTab('usage')}><Icon name="connections" size={15} />用量</button>
    </div><button type="button" className={styles.refresh} disabled={scanning} aria-busy={scanning || undefined} onClick={() => void refresh()}>{scanning && <span className="spinner" aria-hidden="true" />}刷新本机记录</button></div>
    {scanning && scanMode === 'manual' && <p className={styles.caveat} role="status">{`后台扫描 ${tools.find(item => item.id === scanProgress?.toolId)?.name ?? scanProgress?.toolId ?? ''} ${scanProgress?.totalSources ? `${scanProgress.completedSources} / ${scanProgress.totalSources}` : '正在发现文件'}`}<span className={styles.progress} aria-hidden="true"><span style={scanProgress?.totalSources ? { width: `${Math.min(100, (scanProgress.completedSources / scanProgress.totalSources) * 100)}%` } : undefined} data-indeterminate={!scanProgress?.totalSources || undefined} /></span><button type="button" onClick={() => void cancelScan()}>停止扫描</button></p>}
    <ToastStack status={notice} alert={error} onDismiss={(tone) => { if (tone === 'alert') setError(null); else setNotice(null); }} />
    <div className={styles.columns} id="records-sessions-panel" role="tabpanel" aria-labelledby="records-sessions-tab" hidden={tab !== 'sessions'}>
      <aside className={styles.sessionLibrary} aria-label="会话库">
        <div className={styles.filters}>
      <label className={styles.search}><span className="sr-only">搜索</span><span className={styles.searchBox}><input aria-label="搜索会话" data-page-search title={searchShortcutHint} value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && search) { event.preventDefault(); setSearch(''); } }} placeholder="搜索标题或正文" />{search && <button type="button" className={styles.clearSearch} aria-label="清空搜索" onClick={() => setSearch('')}><Icon name="close" size={12} strokeWidth={2.2} /></button>}</span></label>
      <label className={styles.filterSelect}><span className="sr-only">工具</span><FilterSelect label="筛选工具" value={toolId} options={[{ value: '', label: '全部工具' }, ...toolOptions(tools)]} onChange={setToolId} /></label>
      <details className={styles.moreFilters}><summary>筛选{[projectId, model, favoriteOnly, rangeKey !== 'all'].filter(Boolean).length ? ` · ${[projectId, model, favoriteOnly, rangeKey !== 'all'].filter(Boolean).length}` : ''}</summary><div className={styles.filters}>
      <label className={styles.favorite}><input type="checkbox" checked={favoriteOnly} onChange={(event) => setFavoriteOnly(event.target.checked)} />只看收藏</label>
      <DateRangeFilter value={rangeKey} customFrom={customFrom} customTo={customTo} presets={rangePresets} onChange={setRangeKey}
        onCustomRange={(from, to) => { setCustomFrom(from); setCustomTo(to); setRangeKey('custom'); }} />
          <label className={styles.filterSelect}><span>项目</span><FilterSelect label="筛选项目" value={projectId} options={[{ value: '', label: '全部项目' }, { value: '__unknown__', label: '未归类' }, ...projects.map((item) => ({ value: item.id, label: item.name }))]} onChange={setProjectId} /></label>
          <label className={styles.filterSelect}><span>模型</span><FilterSelect label="筛选模型" value={model} options={[{ value: '', label: '全部模型' }, { value: '__unknown__', label: '模型未知' }, ...modelCatalog.map((item) => ({ value: item, label: item }))]} onChange={setModel} /></label>
          <button type="button" onClick={() => { setProjectId(''); setModel(''); setFavoriteOnly(false); setRangeKey('all'); }}>重置筛选</button></div></details>
    </div>
    {activeFilters.length > 0 && <div className={styles.activeFilters} aria-label="已启用的筛选">
      {activeFilters.map((item) => <button type="button" key={item.key} className={styles.filterChip} title="点击移除该筛选" onClick={item.clear}><span>{item.label}</span><Icon name="close" size={11} strokeWidth={2.4} /></button>)}
      {activeFilters.length > 1 && <button type="button" className="text-button" onClick={clearAllFilters}>清除全部筛选</button>}
    </div>}
        <div className={styles.listToolbar}><span>{filterLoading ? '正在更新…' : activeFilters.length ? '筛选结果' : '全部会话'}</span><select aria-label="会话排序" value={sort} onChange={(event) => setSort(event.target.value)}><option value="recent">最近活跃</option><option value="oldest">最早活跃</option><option value="messages">消息最多</option></select></div>
      <div className={styles.list} aria-label="会话列表" aria-busy={filterLoading || undefined} onScroll={(event) => {
        const list = event.currentTarget;
        if (list.scrollHeight - list.scrollTop - list.clientHeight < 400) setVisibleSessionCount((count) => Math.min(sessions.length, count + 80));
      }}>{sessions.length ? visibleGroups.flatMap(({ group, items, total }, groupIndex) => [
        <div key={`group-${groupIndex}-${group}`} className={styles.group} role="presentation" aria-hidden="true">{sort === 'recent' ? groupLabels[group] : sort === 'messages' ? '按消息数量' : '从早到晚'}<span>{total}</span></div>,
        ...items.map((item) => <button type="button" key={item.id} data-session-id={item.id} aria-current={selectedId === item.id ? 'true' : undefined} className={selectedId === item.id ? styles.selected : ''} onClick={() => selectSession(item.id)} onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); moveSession(item, 1); } else if (event.key === 'ArrowUp') { event.preventDefault(); moveSession(item, -1); } else if (event.key === 'Home') { event.preventDefault(); focusSession(orderedSessions[0]); } else if (event.key === 'End') { event.preventDefault(); focusSession(orderedSessions[orderedSessions.length - 1]); } }}>
          <span className={styles.rowTop}><ToolIcon toolId={item.toolId} size={16} /><span>{toolName(item.toolId)}</span>{item.favorite && <span className={styles.favoriteMark} aria-label="已收藏">★</span>}<time title={day(item.updatedAt)}>{rowTime(item.updatedAt)}</time></span>
          <strong className={styles.rowTitle} title={item.title}>{item.title || '未命名会话'}</strong>
          <span className={styles.rowContext}><Icon name="folder" size={12} /><span title={item.cwd ?? undefined}>{projects.find((project) => project.id === item.projectId)?.name ?? item.cwd?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '未关联项目'}</span><span>{item.messageCount.toLocaleString()} 条消息</span></span>
          {(item.partial || item.stale) && <small className={styles.sessionMeta}>{item.partial && <em className={styles.flag}>部分记录</em>}{item.stale && <em className={styles.flag} data-tone="muted">源暂不可读</em>}</small>}
        </button>),
      ]) : <div className={styles.empty} role={listError ? 'alert' : 'status'}><span className="empty-symbol"><Icon name={listError ? 'alert' : 'search'} size={20} /></span><h3>{listError ? '会话列表读取失败' : filterLoading ? '正在加载会话…' : activeFilters.length ? '没有匹配的会话' : '从第一段会话开始'}</h3><p>{listError ? '本机记录仍然保留，可以重新读取。' : filterLoading ? '正在读取本机记录。' : activeFilters.length ? '试试其他关键词，或清除筛选。' : '使用受管理的 CLI 后，回到这里查找与继续对话。'}</p>{listError ? <button type="button" onClick={() => void load(filter)}>重新读取列表</button> : activeFilters.length > 0 && <button type="button" className="text-button" onClick={clearAllFilters}>清除全部筛选</button>}</div>}</div>
        <details className={styles.coverage}><summary>{scanning ? '正在同步本机记录…' : lastScanAt ? `${timeOfDay(new Date(lastScanAt))} 已同步` : '仅存于本机'}{scans.some((item) => item.failedCount || item.incomplete) ? ' · 部分未读取' : ''}</summary>{scans.length ? scans.map((item) => <span key={item.toolId}>{toolName(item.toolId)} · {item.sourceCount} 个来源{item.failedCount ? ` · ${item.failedCount} 个失败` : ''}{item.incomplete ? ' · 扫描不完整' : ''}</span>) : <span>刷新后查看本机记录来源。</span>}</details>
      </aside>
      <div className={styles.detail} ref={detailRef}>
        <button type="button" className={styles.backToList} onClick={() => { setMobileDetail(false); if (selectedId) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-session-id="${CSS.escape(selectedId)}"]`)?.focus()); }}>← 返回会话列表</button>
        {selected ? <>
        <div className={styles.detailBar}>
        <div className={styles.detailEyebrow}><ToolIcon toolId={selected.session.toolId} size={18} /><span>{toolName(selected.session.toolId)}</span><span className={styles.modelBadge}>{selected.session.model ?? '模型未知'}</span><button type="button" disabled={favoriteBusy} data-active={selected.session.favorite || undefined} aria-pressed={selected.session.favorite} onClick={() => void favorite()} aria-label={selected.session.favorite ? '取消收藏' : '收藏会话'}>{selected.session.favorite ? '★ 已收藏' : '☆ 收藏'}</button></div>
        <div className={styles.detailHead}><h2 title={selected.session.title}>{selected.session.title || '未命名会话'}</h2></div>
        <div className={styles.detailMeta}><span title={selected.session.cwd ? displayPath(selected.session.cwd) : undefined}><Icon name="folder" size={13} />{projects.find((item) => item.id === selected.session.projectId)?.name ?? selected.session.cwd?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '项目目录未知'}</span><time title={day(selected.session.updatedAt)}>{compactDay(selected.session.updatedAt)} 更新</time></div>
        {(selected.session.partial || selected.session.stale) && <p className={styles.caveat}>原始记录不完整或最近读取失败；仅展示已索引的内容。</p>}
        <div className={styles.resume}>
          {readyCommand && <button type="button" className={styles.primary} disabled={busy} onClick={() => void resume()}><Icon name="tool" size={14} />{busy ? '正在打开终端…' : '在外部终端继续'}{mode === 'yolo' && ' · YOLO'}</button>}
          <details className={styles.moreActions} ref={actionsRef} key={selected.session.id}><summary>会话选项</summary><div className={styles.actionPanel}>
            <div className={styles.resumeBar}><label>恢复模式 <select aria-label="恢复模式" value={mode} onChange={(event) => setMode(event.target.value as 'normal' | 'yolo')}><option value="normal">普通模式</option>{yolo && <option value="yolo">YOLO 模式</option>}</select></label>{readyCommand && <button type="button" aria-label="复制命令" data-copied={copied || undefined} onClick={() => void copy()}><Icon name={copied ? 'check' : 'copy'} size={13} />{copied ? '已复制' : '复制命令'}</button>}</div>
            {readyCommand && <details className={styles.commandDetails} ref={commandRef}><summary>查看恢复命令</summary><pre aria-label="原生恢复命令" title={readyCommand}>{readyCommand}</pre></details>}
            <div className={styles.actions}><button type="button" onClick={() => void exportSession('markdown')}>导出 Markdown</button><button type="button" onClick={() => void exportSession('json')}>导出 JSON</button></div><label className={styles.projectLink}>关联项目<select aria-label="关联会话项目" value={selected.session.projectId ?? ''} onChange={(event) => void assignProject(event.target.value)}><option value="">使用原会话目录</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}{item.available ? '' : ' · 目录失效'}</option>)}</select></label>
            {selected.session.cwd && <p className={styles.fullPath}>{displayPath(selected.session.cwd)}</p>}
          </div></details>
          {!readyCommand && <p className={styles.resumeStatus}>{shownResumeError || '正在确认原生恢复命令…'}</p>}
          {selected.resumeReason && <button type="button" onClick={onOpenProjects}>前往最近项目重新关联目录</button>}
        </div>
        </div>
        <SessionReader key={selected.session.id} detail={selected} toolName={toolName(selected.session.toolId)} />
      </> : detailError ? <div className={styles.empty} role="alert"><Icon name="alert" size={26} /><h3>暂时无法打开会话</h3><p>{detailError}</p><button type="button" onClick={() => setDetailRetry((value) => value + 1)}>重新加载会话</button></div> : selectedId && sessions.some((item) => item.id === selectedId) ? <div className={styles.detailLoading} role="status" aria-label="正在读取会话"><span className={styles.detailSkeleton} /><span className={styles.detailSkeleton} data-size="short" /><span className={styles.detailSkeleton} data-size="block" /></div>
      : <div className={styles.empty}><span className="empty-symbol"><Icon name="records" size={20} /></span><p>选择左侧会话查看详情。</p></div>}</div>
    </div>
    <div className={styles.usagePane} id="records-usage-panel" role="tabpanel" aria-labelledby="records-usage-tab" hidden={tab !== 'usage'}><UsageDashboard active={active && tab === 'usage'} tools={tools} projects={projects} prices={prices} onPricesChange={setPrices}
      scanVersion={scanVersion} scanning={scanning} lastScanAt={lastScanAt} onOpenSession={openSession} notify={notify} /></div>
  </section>;
}
