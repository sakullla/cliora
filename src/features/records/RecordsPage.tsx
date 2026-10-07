import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { save } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import type { AdapterDescriptor } from '../../types/native';
import type { Project } from '../../types/launch';
import type { HistoryDetail, HistoryFilter, HistoryPrice, HistorySession, ScanStatus } from '../../types/history';
import { displayPath } from '../../lib/paths';
import { FilterSelect } from '../../components/FilterSelect';
import { SearchField } from '../../components/SearchField';
import { ToastStack, type Toast } from '../../components/Toast';
import { ToolIcon, toolOptions } from '../../components/ToolIcon';
import { Icon } from '../../components/Icon';
import { searchShortcutHint } from '../../lib/shortcut';
import { formatFailure } from '../../lib/feedback';
import { UsageDashboard, type UsageNotify } from './UsageDashboard';
import { SessionReader } from './SessionReader';
import { DateRangeFilter, type RangeKey } from './DateRangeFilter';
import { useDisclosure } from './useDisclosure';
import { navigateChoices } from '../../lib/choiceNavigation';
import i18n from '../../i18n';
import styles from './RecordsPage.module.css';

const copiedCommandText = () => i18n.t('records.page.copiedCommand');

const dateLocale = () => i18n.language === 'en' ? 'en-US' : 'zh-CN';
const day = (ms: number | null) => ms === null ? i18n.t('records.format.timeUnknown') : new Date(ms).toLocaleString(dateLocale());
const timeOfDay = (date: Date) => date.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' });
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
function compactDay(ms: number | null) {
  if (ms === null) return i18n.t('records.format.timeUnknown');
  const date = new Date(ms);
  const now = new Date();
  const daysAgo = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (daysAgo <= 0) return timeOfDay(date);
  if (daysAgo === 1) return i18n.t('records.format.yesterday', { time: timeOfDay(date) });
  if (date.getFullYear() === now.getFullYear()) return i18n.t('records.format.dayOfYear', { month: date.getMonth() + 1, day: date.getDate() });
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
type SessionGroup = 'favorite' | 'today' | 'yesterday' | 'week' | 'earlier' | 'unknown';
const groupLabel = (group: SessionGroup) => i18n.t(`records.page.group.${group}`);
function groupOf(ms: number | null): SessionGroup {
  if (ms === null) return 'unknown';
  const daysAgo = Math.round((startOfDay(new Date()) - startOfDay(new Date(ms))) / 86400000);
  if (daysAgo <= 0) return 'today';
  if (daysAgo === 1) return 'yesterday';
  if (daysAgo < 7) return 'week';
  return 'earlier';
}
function rowTime(ms: number | null) {
  if (ms === null) return i18n.t('records.format.timeUnknown');
  const group = groupOf(ms);
  if (group === 'today') return timeOfDay(new Date(ms));
  if (group === 'yesterday') return i18n.t('records.format.yesterday', { time: timeOfDay(new Date(ms)) });
  return compactDay(ms);
}
const recordNext = () => i18n.t('records.page.next');
const errorText = (error: unknown) => formatFailure(error, i18n.t('records.page.operationFailed'), recordNext());

function rangePresets(): Array<{ id: RangeKey; label: string }> {
  return [
    { id: 'all', label: i18n.t('records.page.preset.all') },
    { id: 'today', label: i18n.t('records.page.preset.today') },
    { id: 'yesterday', label: i18n.t('records.page.preset.yesterday') },
    { id: '7', label: i18n.t('records.page.preset.week') },
    { id: '30', label: i18n.t('records.page.preset.month30') },
    { id: 'month', label: i18n.t('records.page.preset.month') },
    { id: 'custom', label: i18n.t('records.page.preset.custom') },
  ];
}
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
const dayLabel = (iso: string) => { const [year, month, day] = iso.split('-').map(Number); return new Date(year, (month || 1) - 1, day || 1).toLocaleDateString(dateLocale(), { year: 'numeric', month: 'long', day: 'numeric' }); };
function rangeCaption(from: string, to: string) {
  if (!from && !to) return '';
  if (from && to && from === to) return dayLabel(from);
  if (from && to) return `${dayLabel(from)} – ${dayLabel(to)}`;
  if (from) return i18n.t('records.page.captionFrom', { date: dayLabel(from) });
  return i18n.t('records.page.captionTo', { date: dayLabel(to) });
}
export function RecordsPage({ active, tools, onOpenProjects }: { active: boolean; tools: AdapterDescriptor[]; onOpenProjects: () => void }) {
  const { t } = useTranslation();
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
  const sessionTotal = useRef(0); sessionTotal.current = sessions.length;
  const sentinelObserver = useRef<IntersectionObserver | null>(null);
  const observeSentinel = useCallback((node: HTMLDivElement | null) => {
    sentinelObserver.current?.disconnect();
    sentinelObserver.current = null;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisibleSessionCount((count) => Math.min(sessionTotal.current, count + 80));
    }, { rootMargin: '400px' });
    observer.observe(node);
    sentinelObserver.current = observer;
  }, []);
  useEffect(() => () => sentinelObserver.current?.disconnect(), []);
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
    setError({ id: ++toastSequence.current, tone: 'alert', text: typeof value === 'string' ? value : formatFailure(value, t('records.page.readFailed'), recordNext()) });
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
      .catch((value) => { if (sequence === detailRequest.current) setDetailError(formatFailure(value, t('records.page.detailFailed'), t('records.page.detailFailedNext'))); });
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
      showNotice(t('records.page.refreshed'));
    } catch (value) { if (sequence === scanRequest.current && !auto) showError(value); }
    finally { if (sequence === scanRequest.current) { scanningRef.current = false; setScanning(false); setScanProgress(null); } }
  }
  async function cancelScan() {
    scanRequest.current++; scanningRef.current = false; setScanning(false); setScanProgress(null); protectSave.current = false; setNotice(null); setError(null);
    try { await native.cancelHistoryRefresh(); showNotice(t('records.page.scanStopped')); }
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
    try { await navigator.clipboard.writeText(readyCommand); showNotice(copiedCommandText()); setCopyFlash((value) => value + 1); }
    catch { setCopyFlash(0); if (commandRef.current) commandRef.current.open = true; showError(t('records.page.copyFailed')); }
  }

  async function resume() {
    if (!selected || !readyCommand) return;
    setBusy(true); protectSave.current = false; setNotice(null); setError(null);
    try { await native.resumeHistorySession(selected.session.id, mode); showNotice(t('records.page.resumeRequested')); }
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
      const destination = await save({ title: t('records.page.exportTitle'), defaultPath: `cliora-session-${selected.session.nativeId ?? selected.session.id.slice(0, 8)}.${format === 'json' ? 'json' : 'md'}`,
        filters: [{ name: format === 'json' ? 'JSON' : 'Markdown', extensions: [format === 'json' ? 'json' : 'md'] }] });
      if (!destination) return;
      protectSave.current = false; setNotice(null); setError(null);
      const path = await native.exportHistorySession(selected.session.id, format, destination);
      showNotice(t('records.page.exported', { path }));
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
    if (toolId) items.push({ key: 'tool', label: t('records.page.chipTool', { name: toolName(toolId) }), clear: () => setToolId('') });
    if (tab === 'sessions' && search.trim()) items.push({ key: 'search', label: t('records.page.chipSearch', { query: search.trim() }), clear: () => setSearch('') });
    if (tab === 'sessions' && favoriteOnly) items.push({ key: 'favorite', label: t('records.page.favoriteOnly'), clear: () => setFavoriteOnly(false) });
    if (projectId) items.push({ key: 'project', label: t('records.page.chipProject', { name: projectId === '__unknown__' ? t('records.page.unclassified') : projects.find((item) => item.id === projectId)?.name ?? projectId }), clear: () => setProjectId('') });
    if (model) items.push({ key: 'model', label: t('records.page.chipModel', { name: model === '__unknown__' ? t('records.page.modelUnknown') : model }), clear: () => setModel('') });
    if (rangeKey !== 'all') items.push({ key: 'range', label: t('records.page.chipTime', { name: rangeKey === 'custom' ? rangeCaption(dates.from, dates.to) || t('records.page.preset.custom') : rangePresets().find((item) => item.id === rangeKey)?.label ?? rangeKey }), clear: () => setRangeKey('all') });
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

  if (!nativeAvailable) return <div className={styles.empty}><h2>{t('records.page.nativeTitle')}</h2><p>{t('records.page.nativeDetail')}</p></div>;
  return <section className={styles.page} aria-label={t('records.page.label')} data-mobile-detail={mobileDetail || undefined}>
    <div className={styles.toolbar}><div className={styles.tabs} role="tablist" aria-label={t('records.page.typesAria')} onKeyDown={navigateChoices}>
      <button type="button" role="tab" id="records-sessions-tab" aria-controls="records-sessions-panel" tabIndex={tab === 'sessions' ? 0 : -1} aria-selected={tab === 'sessions'} onClick={() => setTab('sessions')}><Icon name="records" size={15} />{t('records.page.sessions')}{initialized.current ? <span className="count-chip">{sessions.length}</span> : null}</button>
      <button type="button" role="tab" id="records-usage-tab" aria-controls="records-usage-panel" tabIndex={tab === 'usage' ? 0 : -1} aria-selected={tab === 'usage'} onClick={() => setTab('usage')}><Icon name="connections" size={15} />{t('records.page.usage')}</button>
    </div><button type="button" className={styles.refresh} disabled={scanning} aria-label={t('records.page.refreshAria')} aria-busy={scanning || undefined} onClick={() => void refresh()}>{scanning ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" size={15} />}<span>{scanning ? t('records.page.refreshing') : t('records.page.refresh')}</span></button></div>
    {scanning && scanMode === 'manual' && <p className={styles.caveat} role="status">{t('records.page.scanning', { tool: tools.find(item => item.id === scanProgress?.toolId)?.name ?? scanProgress?.toolId ?? '', progress: scanProgress?.totalSources ? `${scanProgress.completedSources} / ${scanProgress.totalSources}` : t('records.page.discovering') })}<span className={styles.progress} aria-hidden="true"><span style={scanProgress?.totalSources ? { width: `${Math.min(100, (scanProgress.completedSources / scanProgress.totalSources) * 100)}%` } : undefined} data-indeterminate={!scanProgress?.totalSources || undefined} /></span><button type="button" onClick={() => void cancelScan()}>{t('records.page.stopScan')}</button></p>}
    <ToastStack status={notice} alert={error} onDismiss={(tone) => { if (tone === 'alert') setError(null); else setNotice(null); }} />
    <div className={styles.columns} id="records-sessions-panel" role="tabpanel" aria-labelledby="records-sessions-tab" hidden={tab !== 'sessions'}>
      <aside className={styles.sessionLibrary} aria-label={t('records.page.libraryAria')}>
        <div className={styles.filters}>
      <label className={styles.search}><span className="sr-only">{t('records.page.searchSr')}</span><SearchField className={styles.searchBox} label={t('records.page.searchLabel')} pageSearch title={searchShortcutHint()} value={search} onChange={setSearch} placeholder={t('records.page.searchPlaceholder')} /></label>
      <label className={styles.filterSelect}><span className="sr-only">{t('records.page.toolSr')}</span><FilterSelect label={t('records.page.toolFilter')} value={toolId} options={[{ value: '', label: t('records.page.allTools') }, ...toolOptions(tools)]} onChange={setToolId} /></label>
      <details className={styles.moreFilters}><summary>{t('records.page.filters')}{[projectId, model, favoriteOnly, rangeKey !== 'all'].filter(Boolean).length ? t('records.page.filtersCount', { count: [projectId, model, favoriteOnly, rangeKey !== 'all'].filter(Boolean).length }) : ''}</summary><div className={styles.filters}>
      <label className={styles.favorite}><input type="checkbox" checked={favoriteOnly} onChange={(event) => setFavoriteOnly(event.target.checked)} />{t('records.page.favoriteOnly')}</label>
      <DateRangeFilter value={rangeKey} customFrom={customFrom} customTo={customTo} presets={rangePresets()} onChange={setRangeKey}
        onCustomRange={(from, to) => { setCustomFrom(from); setCustomTo(to); setRangeKey('custom'); }} />
          <label className={styles.filterSelect}><span>{t('records.page.project')}</span><FilterSelect label={t('records.page.projectFilter')} value={projectId} options={[{ value: '', label: t('records.page.allProjects') }, { value: '__unknown__', label: t('records.page.unclassified') }, ...projects.map((item) => ({ value: item.id, label: item.name }))]} onChange={setProjectId} /></label>
          <label className={styles.filterSelect}><span>{t('records.page.model')}</span><FilterSelect label={t('records.page.modelFilter')} value={model} options={[{ value: '', label: t('records.page.allModels') }, { value: '__unknown__', label: t('records.page.modelUnknown') }, ...modelCatalog.map((item) => ({ value: item, label: item }))]} onChange={setModel} /></label>
          <button type="button" onClick={() => { setProjectId(''); setModel(''); setFavoriteOnly(false); setRangeKey('all'); }}>{t('records.page.resetFilters')}</button></div></details>
    </div>
    {activeFilters.length > 0 && <div className={styles.activeFilters} aria-label={t('records.page.activeAria')}>
      {activeFilters.map((item) => <button type="button" key={item.key} className={styles.filterChip} title={t('records.page.chipTitle')} onClick={item.clear}><span>{item.label}</span><Icon name="close" size={11} strokeWidth={2.4} /></button>)}
      {activeFilters.length > 1 && <button type="button" className="text-button" onClick={clearAllFilters}>{t('records.page.clearAll')}</button>}
    </div>}
        <div className={styles.listToolbar}><span>{filterLoading ? t('records.page.updating') : activeFilters.length ? t('records.page.filtered') : t('records.page.allSessions')}</span><select aria-label={t('records.page.sortAria')} value={sort} onChange={(event) => setSort(event.target.value)}><option value="recent">{t('records.page.sortRecent')}</option><option value="oldest">{t('records.page.sortOldest')}</option><option value="messages">{t('records.page.sortMessages')}</option></select></div>
      <div className={styles.list} aria-label={t('records.page.listAria')} aria-busy={filterLoading || undefined}>{sessions.length ? <>{visibleGroups.flatMap(({ group, items, total }, groupIndex) => [
        <div key={`group-${groupIndex}-${group}`} className={styles.group} role="presentation" aria-hidden="true">{sort === 'recent' ? groupLabel(group) : sort === 'messages' ? t('records.page.groupByMessages') : t('records.page.groupByTime')}<span>{total}</span></div>,
        ...items.map((item) => <button type="button" key={item.id} data-session-id={item.id} aria-current={selectedId === item.id ? 'true' : undefined} className={selectedId === item.id ? styles.selected : ''} onClick={() => selectSession(item.id)} onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); moveSession(item, 1); } else if (event.key === 'ArrowUp') { event.preventDefault(); moveSession(item, -1); } else if (event.key === 'Home') { event.preventDefault(); focusSession(orderedSessions[0]); } else if (event.key === 'End') { event.preventDefault(); focusSession(orderedSessions[orderedSessions.length - 1]); } }}>
          <span className={styles.rowTop}><ToolIcon toolId={item.toolId} size={16} /><span>{toolName(item.toolId)}</span>{item.favorite && <span className={styles.favoriteMark} aria-label={t('records.page.favorited')}>★</span>}<time title={day(item.updatedAt)}>{rowTime(item.updatedAt)}</time></span>
          <strong className={styles.rowTitle} title={item.title}>{item.title || t('records.page.untitled')}</strong>
          <span className={styles.rowContext}><Icon name="folder" size={12} /><span title={item.cwd ?? undefined}>{projects.find((project) => project.id === item.projectId)?.name ?? item.cwd?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? t('records.page.noProject')}</span><span>{t('records.reader.messageCount', { count: item.messageCount.toLocaleString() })}</span></span>
          {(item.partial || item.stale) && <small className={styles.sessionMeta}>{item.partial && <em className={styles.flag}>{t('records.page.partial')}</em>}{item.stale && <em className={styles.flag} data-tone="muted">{t('records.page.stale')}</em>}</small>}
        </button>),
      ])}{visibleSessionCount < sessions.length && <div ref={observeSentinel} className={styles.listSentinel} role="status">{t('records.page.loadingMore')}</div>}</> : <div className={styles.empty} role={listError ? 'alert' : 'status'}><span className="empty-symbol"><Icon name={listError ? 'alert' : 'search'} size={20} /></span><h3>{listError ? t('records.page.listFailed') : filterLoading ? t('records.page.loading') : activeFilters.length ? t('records.page.noMatch') : t('records.page.emptyTitle')}</h3><p>{listError ? t('records.page.listFailedHint') : filterLoading ? t('records.page.loadingHint') : activeFilters.length ? t('records.page.noMatchHint') : t('records.page.emptyHint')}</p>{listError ? <button type="button" onClick={() => void load(filter)}>{t('records.page.retryList')}</button> : activeFilters.length > 0 && <button type="button" className="text-button" onClick={clearAllFilters}>{t('records.page.clearAll')}</button>}</div>}</div>
        <details className={styles.coverage}><summary>{scanning ? t('records.page.syncing') : lastScanAt ? t('records.page.syncedAt', { time: timeOfDay(new Date(lastScanAt)) }) : t('records.page.localOnly')}{scans.some((item) => item.failedCount || item.incomplete) ? t('records.page.partialSuffix') : ''}</summary>{scans.length ? scans.map((item) => <span key={item.toolId}>{t('records.page.scanEntry', { tool: toolName(item.toolId), count: item.sourceCount })}{item.failedCount ? t('records.page.scanFailed', { count: item.failedCount }) : ''}{item.incomplete ? t('records.page.scanIncomplete') : ''}</span>) : <span>{t('records.page.scanEmpty')}</span>}</details>
      </aside>
      <div className={styles.detail} ref={detailRef}>
        <button type="button" className={styles.backToList} onClick={() => { setMobileDetail(false); if (selectedId) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-session-id="${CSS.escape(selectedId)}"]`)?.focus()); }}>{t('records.page.backToList')}</button>
        {selected ? <>
        <div className={styles.detailBar}>
        <div className={styles.detailEyebrow}><ToolIcon toolId={selected.session.toolId} size={18} /><span>{toolName(selected.session.toolId)}</span><span className={styles.modelBadge}>{selected.session.model ?? t('records.page.modelUnknown')}</span><button type="button" disabled={favoriteBusy} data-active={selected.session.favorite || undefined} aria-pressed={selected.session.favorite} onClick={() => void favorite()} aria-label={selected.session.favorite ? t('records.page.unfavoriteAria') : t('records.page.favoriteAria')}>{selected.session.favorite ? t('records.page.favoritedStar') : t('records.page.favoriteStar')}</button></div>
        <div className={styles.detailHead}><h2 title={selected.session.title}>{selected.session.title || t('records.page.untitled')}</h2></div>
        <div className={styles.detailMeta}><span title={selected.session.cwd ? displayPath(selected.session.cwd) : undefined}><Icon name="folder" size={13} />{projects.find((item) => item.id === selected.session.projectId)?.name ?? selected.session.cwd?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? t('records.page.cwdUnknown')}</span><time title={day(selected.session.updatedAt)}>{t('records.page.updated', { time: compactDay(selected.session.updatedAt) })}</time></div>
        {(selected.session.partial || selected.session.stale) && <p className={styles.caveat}>{t('records.page.partialCaveat')}</p>}
        <div className={styles.resume}>
          {readyCommand && <button type="button" className={styles.primary} disabled={busy} onClick={() => void resume()}><Icon name="tool" size={14} />{busy ? t('records.page.resuming') : t('records.page.resume')}{mode === 'yolo' && ' · YOLO'}</button>}
          <details className={styles.moreActions} ref={actionsRef} key={selected.session.id}><summary>{t('records.page.options')}</summary><div className={styles.actionPanel}>
            <div className={styles.resumeBar}><label>{t('records.page.resumeMode')} <select aria-label={t('records.page.resumeMode')} value={mode} onChange={(event) => setMode(event.target.value as 'normal' | 'yolo')}><option value="normal">{t('settings.terminal.modeNormal')}</option>{yolo && <option value="yolo">{t('settings.terminal.modeYolo')}</option>}</select></label>{readyCommand && <button type="button" aria-label={t('records.page.copyCommand')} data-copied={copied || undefined} onClick={() => void copy()}><Icon name={copied ? 'check' : 'copy'} size={13} />{copied ? t('home.launcher.copied') : t('records.page.copyCommand')}</button>}</div>
            {readyCommand && <details className={styles.commandDetails} ref={commandRef}><summary>{t('records.page.viewCommand')}</summary><pre aria-label={t('records.page.commandAria')} title={readyCommand}>{readyCommand}</pre></details>}
            <div className={styles.actions}><button type="button" onClick={() => void exportSession('markdown')}>{t('records.page.exportMarkdown')}</button><button type="button" onClick={() => void exportSession('json')}>{t('records.page.exportJson')}</button></div><label className={styles.projectLink}>{t('records.page.linkProject')}<select aria-label={t('records.page.linkProjectAria')} value={selected.session.projectId ?? ''} onChange={(event) => void assignProject(event.target.value)}><option value="">{t('records.page.useOriginalDir')}</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}{item.available ? '' : t('records.page.staleDirSuffix')}</option>)}</select></label>
            {selected.session.cwd && <p className={styles.fullPath}>{displayPath(selected.session.cwd)}</p>}
          </div></details>
          {!readyCommand && <p className={styles.resumeStatus}>{shownResumeError || t('records.page.checkingResume')}</p>}
          {selected.resumeReason && <button type="button" onClick={onOpenProjects}>{t('records.page.relinkProject')}</button>}
        </div>
        </div>
        <SessionReader key={selected.session.id} detail={selected} toolName={toolName(selected.session.toolId)} />
      </> : detailError ? <div className={styles.empty} role="alert"><Icon name="alert" size={26} /><h3>{t('records.page.openFailed')}</h3><p>{detailError}</p><button type="button" onClick={() => setDetailRetry((value) => value + 1)}>{t('records.page.reloadSession')}</button></div> : selectedId && sessions.some((item) => item.id === selectedId) ? <div className={styles.detailLoading} role="status" aria-label={t('records.page.loadingSession')}><span className={styles.detailSkeleton} /><span className={styles.detailSkeleton} data-size="short" /><span className={styles.detailSkeleton} data-size="block" /></div>
      : <div className={styles.empty}><span className="empty-symbol"><Icon name="records" size={20} /></span><p>{t('records.page.pickSession')}</p></div>}</div>
    </div>
    <div className={styles.usagePane} id="records-usage-panel" role="tabpanel" aria-labelledby="records-usage-tab" hidden={tab !== 'usage'}><UsageDashboard search={search} favoriteOnly={favoriteOnly} active={active && tab === 'usage'} tools={tools} projects={projects} prices={prices} onPricesChange={setPrices}
      scanVersion={scanVersion} scanning={scanning} lastScanAt={lastScanAt} onOpenSession={openSession} notify={notify} /></div>
  </section>;
}
