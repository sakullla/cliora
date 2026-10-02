import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { save } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import type { AdapterDescriptor } from '../../types/native';
import type { Project } from '../../types/launch';
import type { HistoryDetail, HistoryFilter, HistoryMessage, HistoryPrice, HistorySession, ScanStatus } from '../../types/history';
import { displayPath } from '../../lib/paths';
import { writeClipboard } from '../../lib/clipboard';
import { FilterSelect } from '../../components/FilterSelect';
import { ToastStack, type Toast } from '../../components/Toast';
import { ToolIcon, toolOptions } from '../../components/ToolIcon';
import { Icon } from '../../components/Icon';
import { searchShortcutHint } from '../../lib/shortcut';
import { UsageDashboard, type UsageNotify } from './UsageDashboard';
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
const MESSAGE_CLAMP = 1000;
const sameDay = (a: number | null, b: number | null) => a !== null && b !== null && startOfDay(new Date(a)) === startOfDay(new Date(b));
/** Within one transcript the date is only repeated when it changes between messages. */
function messageTime(ms: number | null, previous: number | null | undefined) {
  if (ms === null) return '时间未知';
  const date = new Date(ms);
  if (previous !== undefined && sameDay(ms, previous)) return timeOfDay(date);
  return `${date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })} ${timeOfDay(date)}`;
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
function MessageItem({ item, previous }: { item: HistoryMessage; previous: number | null | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const clampable = item.text.length > MESSAGE_CLAMP;
  const clamped = clampable && !expanded;
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <article data-role={item.role}>
    <div className={styles.messageHead}>
      <small>{item.role === 'user' ? '你' : '助手'} · <time title={day(item.timestamp)}>{messageTime(item.timestamp, previous)}</time></small>
      <button type="button" className={styles.messageCopy} aria-label={copied ? '已复制这条消息' : '复制这条消息'} title="复制这条消息" data-copied={copied || undefined} onClick={() => { void writeClipboard(item.text).then((ok) => { if (ok) setCopied(true); }); }}><Icon name={copied ? 'check' : 'copy'} size={13} strokeWidth={2} /></button>
    </div>
    <p className={clamped ? styles.clamped : undefined}>{item.text}</p>
    {clampable && <button type="button" className={styles.expandMessage} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? '收起' : `展开全文（${item.text.length.toLocaleString()} 字）`}</button>}
  </article>;
}
function RangePicker({ value, customFrom, customTo, onChange, onCustomFrom, onCustomTo }: {
  value: RangeKey; customFrom: string; customTo: string;
  onChange: (key: RangeKey) => void; onCustomFrom: (value: string) => void; onCustomTo: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 244;
      setBox({ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchor.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); anchor.current?.querySelector('button')?.focus(); } };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [open]);
  const label = value === 'custom'
    ? (rangeCaption(customFrom, customTo) || '自定义')
    : rangePresets.find((item) => item.id === value)?.label ?? '全部';
  const choose = (key: RangeKey) => {
    onChange(key);
    if (key !== 'custom') setOpen(false);
  };
  return <div ref={anchor} className={styles.rangePicker}>
    <button type="button" className={styles.rangeTrigger} aria-label="时间范围" aria-haspopup="dialog" aria-expanded={open} data-open={open || undefined} onClick={() => setOpen((current) => !current)}>
      <Icon name="clock" size={13} /><span>{label}</span>
    </button>
    {open && box && createPortal(<div ref={panel} className={styles.rangePanel} style={{ top: box.top, left: box.left }} role="dialog" aria-label="时间范围">
      <div className={styles.rangeOptions} role="listbox" aria-label="预设范围">
        {rangePresets.map((item) => <button type="button" key={item.id} role="option" aria-selected={value === item.id} onClick={() => choose(item.id)}>
          <span>{item.label}</span>{value === item.id && <Icon name="check" size={13} />}
        </button>)}
      </div>
      {value === 'custom' && <div className={styles.rangeDates}>
        <label>开始<input aria-label="开始日期" type="date" value={customFrom} max={customTo || undefined} onChange={(event) => onCustomFrom(event.target.value)} /></label>
        <label>结束<input aria-label="结束日期" type="date" value={customTo} min={customFrom || undefined} onChange={(event) => onCustomTo(event.target.value)} /></label>
      </div>}
    </div>, document.body)}
  </div>;
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

type RangeKey = 'all' | 'today' | 'yesterday' | '7' | '30' | 'month' | 'custom';
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
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [scans, setScans] = useState<ScanStatus[]>([]);
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  const load = useCallback(async (current: HistoryFilter) => {
    if (!nativeAvailable) return false;
    const sequence = ++request.current;
    const key = JSON.stringify(current); setFilterLoading(true);
    try {
      const items = await native.listHistorySessions(current);
      if (sequence !== request.current || key !== JSON.stringify(filterRef.current)) return false;
      setSessions(items); setError(null);
      setModelCatalog((old) => { const next = [...new Set([...old, ...items.flatMap((item) => item.model ? [item.model] : [])])].sort(); return next.length === old.length ? old : next; });
      setSelectedId((old) => old && items.some((item) => item.id === old) ? old : items[0]?.id ?? null);
      return true;
    } catch (value) {
      if (sequence === request.current && key === JSON.stringify(filterRef.current)) showReadError(value);
      return false;
    }
    finally { if (sequence === request.current) setFilterLoading(false); }
  }, []);

  useEffect(() => {
    if (!active || !nativeAvailable || initialized.current) return;
    initialized.current = true;
    void load(filter);
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
    const timer = window.setTimeout(() => { void load(filter); }, 180);
    return () => window.clearTimeout(timer);
  }, [filter, active, load]);

  useEffect(() => {
    if (!selectedId || !nativeAvailable) { setDetail(null); return; }
    const sequence = ++detailRequest.current;
    void native.getHistorySession(selectedId).then((value) => { if (sequence === detailRequest.current) setDetail(value); })
      .catch((value) => { if (sequence === detailRequest.current) showReadError(value); });
  }, [selectedId]);

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
    if (!selected) return;
    try {
      await native.setHistoryFavorite(selected.session.id, !selected.session.favorite);
      setDetail({ ...selected, session: { ...selected.session, favorite: !selected.session.favorite } });
      await load(filter);
    } catch (value) { showError(value); }
  }

  async function assignProject(next: string) {
    if (!selected) return;
    try {
      await native.setHistoryProject(selected.session.id, next || null);
      setDetail(await native.getHistorySession(selected.session.id));
      await load(filter);
    } catch (value) { showError(value); }
  }

  async function copy() {
    if (!readyCommand) return;
    protectSave.current = false; setNotice(null); setError(null);
    try { await navigator.clipboard.writeText(readyCommand); showNotice(copiedCommandText); setCopyFlash((value) => value + 1); }
    catch { showError('复制失败，恢复命令仍在页面上，可以手动选择。'); }
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
    setSelectedId(next.id);
    requestAnimationFrame(() => {
      const target = document.querySelector<HTMLButtonElement>(`[data-session-id="${CSS.escape(next.id)}"]`);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'nearest' });
    });
  }
  function moveSession(current: HistorySession, step: 1 | -1) {
    const index = sessions.findIndex((item) => item.id === current.id);
    if (index < 0 || sessions.length < 2) return;
    focusSession(sessions[(index + step + sessions.length) % sessions.length]);
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
  const groupedSessions = useMemo(() => {
    const groups: Array<{ group: SessionGroup; items: HistorySession[] }> = [];
    for (const item of sessions) {
      const group: SessionGroup = item.favorite ? 'favorite' : groupOf(item.updatedAt);
      const last = groups[groups.length - 1];
      if (last && last.group === group) last.items.push(item); else groups.push({ group, items: [item] });
    }
    return groups;
  }, [sessions]);
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
    setTab('sessions');
    setSelectedId(id);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-session-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' }));
  }

  if (!nativeAvailable) return <div className={styles.empty}><h2>本机使用记录</h2><p>在桌面应用中读取原生 CLI 会话。浏览器预览不展示本机历史。</p></div>;
  return <section className={styles.page} aria-label="使用记录内容">
    <div className={styles.toolbar}><div className={styles.tabs} role="tablist" aria-label="使用记录类型">
      <button type="button" role="tab" aria-selected={tab === 'sessions'} onClick={() => setTab('sessions')}>会话{initialized.current ? <span className="count-chip">{sessions.length}</span> : null}</button>
      <button type="button" role="tab" aria-selected={tab === 'usage'} onClick={() => setTab('usage')}>用量</button>
    </div><button type="button" className={styles.refresh} disabled={scanning} aria-busy={scanning || undefined} onClick={() => void refresh()}>{scanning && <span className="spinner" aria-hidden="true" />}刷新本机记录</button></div>
    {((scanning && scanMode === 'manual') || (filterLoading && tab === 'sessions')) && <p className={styles.caveat} role="status">{scanning ? `后台扫描 ${tools.find(item => item.id === scanProgress?.toolId)?.name ?? scanProgress?.toolId ?? ''} ${scanProgress?.totalSources ? `${scanProgress.completedSources} / ${scanProgress.totalSources}` : '正在发现文件'}` : '正在筛选已缓存记录…'}{scanning && <span className={styles.progress} aria-hidden="true"><span style={scanProgress?.totalSources ? { width: `${Math.min(100, (scanProgress.completedSources / scanProgress.totalSources) * 100)}%` } : undefined} data-indeterminate={!scanProgress?.totalSources || undefined} /></span>}{scanning && <button type="button" onClick={() => void cancelScan()}>停止扫描</button>}</p>}
    {tab === 'sessions' && <><div className={styles.filters}>
      <label className={styles.search}><span className="sr-only">搜索</span><span className={styles.searchBox}><input aria-label="搜索会话" data-page-search title={searchShortcutHint} value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && search) { event.preventDefault(); setSearch(''); } }} placeholder="搜索标题或正文" />{search && <button type="button" className={styles.clearSearch} aria-label="清空搜索" onClick={() => setSearch('')}><Icon name="close" size={12} strokeWidth={2.2} /></button>}</span></label>
      <label className={styles.filterSelect}><span className="sr-only">工具</span><FilterSelect label="筛选工具" value={toolId} options={[{ value: '', label: '全部工具' }, ...toolOptions(tools)]} onChange={setToolId} /></label>
      <label className={styles.favorite}><input type="checkbox" checked={favoriteOnly} onChange={(event) => setFavoriteOnly(event.target.checked)} />只看收藏</label>
      <RangePicker value={rangeKey} customFrom={customFrom} customTo={customTo}
        onChange={(key) => { setRangeKey(key); if (key === 'custom' && !customFrom && !customTo) { const today = isoDay(new Date()); setCustomFrom(today); setCustomTo(today); } }}
        onCustomFrom={(value) => { if (customTo && value && value > customTo) { setCustomFrom(customTo); setCustomTo(value); } else setCustomFrom(value); }}
        onCustomTo={(value) => { if (customFrom && value && value < customFrom) { setCustomTo(customFrom); setCustomFrom(value); } else setCustomTo(value); }} />
      <div className={styles.filterMeta}>
        <details className={styles.moreFilters}><summary>更多筛选{[projectId, model].filter(Boolean).length ? ` · ${[projectId, model].filter(Boolean).length} 项已启用` : ''}</summary><div className={styles.filters}>
          <label className={styles.filterSelect}><span>项目</span><FilterSelect label="筛选项目" value={projectId} options={[{ value: '', label: '全部项目' }, { value: '__unknown__', label: '未归类' }, ...projects.map((item) => ({ value: item.id, label: item.name }))]} onChange={setProjectId} /></label>
          <label className={styles.filterSelect}><span>模型</span><FilterSelect label="筛选模型" value={model} options={[{ value: '', label: '全部模型' }, { value: '__unknown__', label: '模型未知' }, ...modelCatalog.map((item) => ({ value: item, label: item }))]} onChange={setModel} /></label>
          <button type="button" onClick={() => { setProjectId(''); setModel(''); }}>清除更多筛选</button></div></details>
        {!!scans.length && <details className={styles.coverage}><summary>本机覆盖 · {scans.reduce((total, item) => total + item.sourceCount, 0)} 个来源{scans.some((item) => item.failedCount || item.incomplete) ? ' · 有失败或扫描不完整' : ''}{lastScanAt ? ` · ${timeOfDay(new Date(lastScanAt))} 更新` : ''}</summary>{scans.map((item) => <span key={item.toolId}>{toolName(item.toolId)} {item.sourceCount} 个来源{item.failedCount ? ` · ${item.failedCount} 个失败` : ''}{item.incomplete ? ' · 扫描不完整' : ''}</span>)}</details>}
      </div>
    </div>
    {activeFilters.length > 0 && <div className={styles.activeFilters} aria-label="已启用的筛选">
      {activeFilters.map((item) => <button type="button" key={item.key} className={styles.filterChip} title="点击移除该筛选" onClick={item.clear}><span>{item.label}</span><Icon name="close" size={11} strokeWidth={2.4} /></button>)}
      {activeFilters.length > 1 && <button type="button" className="text-button" onClick={clearAllFilters}>清除全部筛选</button>}
    </div>}</>}
    <ToastStack status={notice} alert={error} onDismiss={(tone) => { if (tone === 'alert') setError(null); else setNotice(null); }} />
    {tab === 'sessions' ? <div className={styles.columns}>
      <div className={styles.list} aria-label="会话列表">{sessions.length ? groupedSessions.flatMap(({ group, items }, groupIndex) => [
        <div key={`group-${groupIndex}-${group}`} className={styles.group} role="presentation" aria-hidden="true">{groupLabels[group]}<span>{items.length}</span></div>,
        ...items.map((item) => <button type="button" key={item.id} data-session-id={item.id} aria-current={selectedId === item.id ? 'true' : undefined} className={selectedId === item.id ? styles.selected : ''} onClick={() => setSelectedId(item.id)} onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); moveSession(item, 1); } else if (event.key === 'ArrowUp') { event.preventDefault(); moveSession(item, -1); } else if (event.key === 'Home') { event.preventDefault(); focusSession(sessions[0]); } else if (event.key === 'End') { event.preventDefault(); focusSession(sessions[sessions.length - 1]); } }}>
          <span className={styles.sessionTitle}><ToolIcon toolId={item.toolId} size={22} /><strong title={item.title}>{item.favorite && <span className={styles.favoriteMark} aria-hidden="true">★</span>}{item.title}</strong></span><small>{toolName(item.toolId)} · <time title={day(item.updatedAt)}>{rowTime(item.updatedAt)}</time></small>
          <small className={styles.sessionMeta}>{item.model ?? '模型未知'} · {item.messageCount.toLocaleString()} 条消息{item.partial && <em className={styles.flag}>部分记录</em>}{item.stale && <em className={styles.flag} data-tone="muted">源暂不可读</em>}</small>
        </button>),
      ]) : <div className={styles.empty}><span className="empty-symbol"><Icon name="search" size={20} /></span><p>没有符合条件的会话。可刷新记录或调整筛选。</p>{activeFilters.length > 0 && <button type="button" className="text-button" onClick={clearAllFilters}>清除全部筛选</button>}</div>}</div>
      <div className={styles.detail} ref={detailRef}>{selected ? <>
        <div className={styles.detailBar}>
        <div className={styles.detailHead}><div className={styles.detailIdentity}><ToolIcon toolId={selected.session.toolId} size={30} /><div><h2 title={selected.session.title}>{selected.session.title}</h2><p><span>{toolName(selected.session.toolId)}</span><span><time title={day(selected.session.updatedAt)}>{compactDay(selected.session.updatedAt)}</time></span><span className={styles.detailModel}>{selected.session.model ?? '模型未知'}</span><span className={styles.detailPath} title={selected.session.cwd ? displayPath(selected.session.cwd) : undefined}>{selected.session.cwd ? displayPath(selected.session.cwd) : '项目目录未知'}</span></p></div></div><button type="button" data-active={selected.session.favorite || undefined} aria-pressed={selected.session.favorite} onClick={() => void favorite()} aria-label={selected.session.favorite ? '取消收藏' : '收藏会话'}>{selected.session.favorite ? '★ 已收藏' : '☆ 收藏'}</button></div>
        {(selected.session.partial || selected.session.stale) && <p className={styles.caveat}>原始记录不完整或最近读取失败；仅展示已索引的内容。</p>}
        <div className={styles.resume}>
          <div className={styles.resumeBar}><select aria-label="恢复模式" value={mode} onChange={(event) => setMode(event.target.value as 'normal' | 'yolo')}><option value="normal">普通模式</option>{yolo && <option value="yolo">YOLO 模式</option>}</select>{readyCommand && <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy} onClick={() => void resume()}>在外部终端继续</button><button type="button" aria-label="复制命令" data-copied={copied || undefined} onClick={() => void copy()}>{copied ? <><Icon name="check" size={13} strokeWidth={2.2} />已复制</> : '复制命令'}</button></div>}{readyCommand ? <pre aria-label="原生恢复命令" title={readyCommand}>{readyCommand}</pre> : <p>{shownResumeError || '正在确认原生恢复命令…'}</p>}</div>
          <details className={styles.moreActions}><summary>导出与项目关联</summary><div className={styles.actions}><button type="button" onClick={() => void exportSession('markdown')}>导出 Markdown</button><button type="button" onClick={() => void exportSession('json')}>导出 JSON</button></div><label className={styles.projectLink}>关联项目<select aria-label="关联会话项目" value={selected.session.projectId ?? ''} onChange={(event) => void assignProject(event.target.value)}><option value="">使用原会话目录</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}{item.available ? '' : ' · 目录失效'}</option>)}</select></label></details>
          {selected.resumeReason && <button type="button" onClick={onOpenProjects}>前往最近项目重新关联目录</button>}
        </div>
        </div>
        <div className={styles.transcript} aria-label="会话正文">
          {selected.messages.length > 0 && <div className={styles.transcriptHead}><span>{selected.messages.length.toLocaleString()} 条消息{selected.session.messageCount > selected.messages.length ? ` · 已索引 ${selected.session.messageCount.toLocaleString()} 条` : ''}</span>{selected.messages.length > 4 && <button type="button" className="text-button" onClick={() => detailRef.current?.scrollTo({ top: detailRef.current.scrollHeight, behavior: 'smooth' })}><Icon name="arrowDown" size={13} strokeWidth={2} />跳到最新</button>}</div>}
          <div className={styles.messages}>{selected.messages.length ? selected.messages.map((item, index) => <MessageItem key={item.id} item={item} previous={index ? selected.messages[index - 1].timestamp : undefined} />) : <p>此记录没有可读取的对话正文。</p>}</div>
        </div>
      </> : selectedId && sessions.some((item) => item.id === selectedId) ? <div className={styles.detailLoading} role="status" aria-label="正在读取会话"><span className={styles.detailSkeleton} /><span className={styles.detailSkeleton} data-size="short" /><span className={styles.detailSkeleton} data-size="block" /></div>
      : <div className={styles.empty}><span className="empty-symbol"><Icon name="records" size={20} /></span><p>选择左侧会话查看详情。</p></div>}</div>
    </div> : <UsageDashboard active={active && tab === 'usage'} tools={tools} projects={projects} prices={prices} onPricesChange={setPrices}
      scanVersion={scanVersion} scanning={scanning} lastScanAt={lastScanAt} onOpenSession={openSession} notify={notify} />}
  </section>;
}
