import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { native, nativeAvailable } from '../../lib/native';
import type { AdapterDescriptor } from '../../types/native';
import type { Project } from '../../types/launch';
import type { HistoryFilter, HistoryPrice, UsageBucket, UsageGroup, UsageReport, UsageTotals } from '../../types/history';
import { FilterSelect } from '../../components/FilterSelect';
import { GuideDialog } from '../../components/GuideDialog';
import { ToolIcon, toolOptions } from '../../components/ToolIcon';
import { Icon } from '../../components/Icon';
import { DAY_MS, bucketLabel, cacheHitRate, clockTime, exactMoney, formatMoney, formatPercent, formatTokens, niceScale, ratio, shortDate, tokenParts } from './usageFormat';
import { navigateChoices } from '../../lib/choiceNavigation';
import { saveShortcutHint } from '../../lib/shortcut';
import { DateRangeFilter, type RangeKey } from './DateRangeFilter';
import i18n from '../../i18n';
import styles from './UsageDashboard.module.css';

type UsageRange = RangeKey;
const rangeIds: UsageRange[] = ['today', 'yesterday', '7', '30', 'month', 'all', 'custom'];
const rangePresetKey = (id: UsageRange) => id === '7' ? 'week' : id === '30' ? 'month30' : id;
const ranges = (): Array<{ id: UsageRange; label: string }> => rangeIds.map((id) => ({ id, label: i18n.t(`records.page.preset.${rangePresetKey(id)}`) }));
const rangeStorageKey = 'cliora.usage.range';
const storedRange = (): UsageRange => {
  try {
    const value = localStorage.getItem(rangeStorageKey);
    return rangeIds.some((id) => id === value) && value !== 'custom' ? value as UsageRange : 'today';
  } catch { return 'today'; }
};
const dateLocale = () => i18n.language === 'en' ? 'en-US' : 'zh-CN';

const isoDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const parseDay = (iso: string) => { const [year, month, day] = iso.split('-').map(Number); return new Date(year, (month || 1) - 1, day || 1); };
const shiftDay = (iso: string, days: number) => { const date = parseDay(iso); return isoDay(new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)); };
const startOf = (iso: string) => parseDay(iso).getTime();
const endOf = (iso: string) => startOf(shiftDay(iso, 1));

function bounds(range: UsageRange, today: string, customFrom: string, customTo: string): { fromMs: number | null; toMs: number | null } {
  switch (range) {
    case 'today': return { fromMs: startOf(today), toMs: endOf(today) };
    case 'yesterday': return { fromMs: startOf(shiftDay(today, -1)), toMs: startOf(today) };
    case '7': return { fromMs: startOf(shiftDay(today, -6)), toMs: endOf(today) };
    case '30': return { fromMs: startOf(shiftDay(today, -29)), toMs: endOf(today) };
    case 'month': return { fromMs: startOf(`${today.slice(0, 8)}01`), toMs: endOf(today) };
    case 'custom': {
      const [from, to] = customFrom && customTo && customFrom > customTo ? [customTo, customFrom] : [customFrom, customTo];
      return { fromMs: from ? startOf(from) : null, toMs: to ? endOf(to) : null };
    }
    default: return { fromMs: null, toMs: null };
  }
}

function comparisonLabel(range: UsageRange, previous: { from: number; to: number }) {
  if (range === 'today') return i18n.t('records.usage.compareYesterday');
  const days = Math.max(1, Math.round((previous.to - previous.from) / DAY_MS));
  return days === 1 ? i18n.t('records.usage.comparePrevDay') : i18n.t('records.usage.comparePrevDays', { days });
}

function rangeCaption(report: UsageReport | null, range: UsageRange, now: number) {
  if (!report?.from || !report.to) return range === 'all' ? i18n.t('records.usage.allIndexed') : '';
  const day = (ms: number) => new Date(ms).toLocaleDateString(dateLocale(), { month: 'long', day: 'numeric' });
  const end = Math.min(report.to, now);
  if (report.to > now && report.from <= now) {
    return new Date(report.from).toDateString() === new Date(now).toDateString()
      ? i18n.t('records.usage.todayRange', { time: clockTime(now) })
      : i18n.t('records.usage.rangeToToday', { from: day(report.from), time: clockTime(now) });
  }
  const last = end - 1;
  return new Date(report.from).toDateString() === new Date(last).toDateString() ? i18n.t('records.usage.fullDay', { date: day(report.from) }) : i18n.t('records.usage.rangeSpan', { from: day(report.from), to: day(last) });
}

function Delta({ current, previous, label, title }: { current: number | null; previous: number | null | undefined; label: string; title: string }) {
  if (current === null || previous === null || previous === undefined) return null;
  if (previous === 0) {
    return <span className={styles.delta} data-direction={current > 0 ? 'up' : 'flat'} title={title}>{current > 0 ? i18n.t('records.usage.deltaNew') : i18n.t('records.usage.deltaFlat')}<small>{label}</small></span>;
  }
  const change = (current - previous) / previous;
  const direction = Math.abs(change) < 0.005 ? 'flat' : change > 0 ? 'up' : 'down';
  const arrow = direction === 'up' ? '↑' : direction === 'down' ? '↓' : '→';
  return <span className={styles.delta} data-direction={direction} title={title}>{arrow} {formatPercent(Math.abs(change))}<small>{label}</small></span>;
}

function Composition({ totals }: { totals: UsageTotals }) {
  let offset = 0;
  return <div className={styles.composition} role="group" aria-label={i18n.t('records.usage.compositionAria')}>
    <div className={styles.donut} aria-hidden="true">
      <svg viewBox="0 0 160 160">
        <circle cx="80" cy="80" r="62" className={styles.donutTrack} />
        {tokenParts().map((part) => {
          const share = ratio(totals[part.key], totals.total) * 100;
          const start = offset; offset += share;
          return share > 0 && <circle key={part.key} cx="80" cy="80" r="62" pathLength="100" data-part={part.key}
            strokeDasharray={`${Math.max(share - 0.7, 0.1)} ${100 - Math.max(share - 0.7, 0.1)}`} strokeDashoffset={-start} />;
        })}
      </svg>
      <div><strong>{formatTokens(totals.total)}</strong><small>{i18n.t('records.usage.totalTokens')}</small></div>
    </div>
    <ul>
      {tokenParts().map((part) => <li key={part.key} title={`${part.hint}：${totals[part.key].toLocaleString()} token`}>
        <i data-key={part.key} aria-hidden="true" /><span>{part.label}</span><strong>{formatTokens(totals[part.key])}</strong><small>{formatPercent(ratio(totals[part.key], totals.total))}</small>
      </li>)}
    </ul>
  </div>;
}

function TrendChart({ report, metric, now }: { report: UsageReport; metric: 'tokens' | 'cost'; now: number }) {
  const [active, setActive] = useState<number | null>(null);
  const buckets = report.timeline;
  const value = (totals: UsageTotals) => metric === 'cost' ? totals.cost ?? 0 : totals.total;
  const { top, ticks } = niceScale(Math.max(0, ...buckets.map((bucket) => value(bucket.totals))));
  const format = (amount: number) => metric === 'cost' ? formatMoney(amount, report.currency) : formatTokens(amount);
  const multiYear = buckets.length > 0 && new Date(buckets[0].start).getFullYear() !== new Date(buckets[buckets.length - 1].start).getFullYear();
  const labelEvery = Math.max(1, Math.ceil(buckets.length / (report.bucket === 'hour' ? 8 : 10)));
  const shown = active === null ? null : buckets[active];
  const peak = buckets.reduce<number | null>((best, bucket, index) => value(bucket.totals) > 0 && (best === null || value(bucket.totals) > value(buckets[best].totals)) ? index : best, null);
  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!buckets.length) return;
    const last = buckets.length - 1;
    const moves: Record<string, number> = { ArrowLeft: (active ?? last + 1) - 1, ArrowRight: (active ?? -1) + 1, Home: 0, End: last };
    if (!(event.key in moves)) return;
    event.preventDefault();
    setActive(Math.max(0, Math.min(last, moves[event.key])));
  }
  const align = active === null ? 'center' : active < buckets.length * 0.2 ? 'start' : active > buckets.length * 0.8 ? 'end' : 'center';
  return <div className={styles.chart} tabIndex={0} role="group" onKeyDown={onKey} onBlur={() => setActive(null)} onMouseLeave={() => setActive(null)}
    aria-label={i18n.t('records.usage.chartAria', { count: buckets.length, peak: peak !== null ? i18n.t('records.usage.chartPeak', { label: bucketLabel(buckets[peak], report.bucket, true, multiYear), value: format(value(buckets[peak].totals)) }) : '' })}>
    <div className={styles.yAxis} aria-hidden="true">{ticks.map((tick) => <span key={tick} style={{ bottom: `${(tick / top) * 100}%` }}>{format(tick)}</span>)}</div>
    <div className={styles.plot}>
      <div className={styles.grid} aria-hidden="true">{ticks.map((tick) => <i key={tick} style={{ bottom: `${(tick / top) * 100}%` }} />)}</div>
      <div className={styles.bars} style={{ gridTemplateColumns: `repeat(${buckets.length}, minmax(0, 1fr))`, gap: buckets.length > 40 ? 1 : buckets.length > 16 ? 3 : 6 }}>
        {buckets.map((bucket, index) => {
          const amount = value(bucket.totals);
          const height = amount > 0 ? Math.max(1.5, (amount / top) * 100) : 0;
          return <div key={bucket.start} className={styles.column} data-active={active === index || undefined} data-future={bucket.start > now || undefined} data-current={bucket.start <= now && now < bucket.end || undefined} onMouseEnter={() => setActive(index)} onClick={() => setActive(index)}>
            <div className={styles.stack} style={{ height: `${height}%` }} data-metric={metric}>
              {metric === 'tokens' ? tokenParts().map((part) => bucket.totals[part.key] > 0 && <span key={part.key} data-key={part.key} style={{ flexGrow: bucket.totals[part.key] }} />) : <span data-key="cost" style={{ flexGrow: 1 }} />}
            </div>
          </div>;
        })}
      </div>
      {shown && active !== null && <div className={styles.tooltip} data-align={align} style={{ left: `${((active + 0.5) / buckets.length) * 100}%` }} role="status">
        <strong>{bucketLabel(shown, report.bucket, true, multiYear)}</strong>
        {shown.totals.usageRecords ? <>
          <p><span>{i18n.t('records.usage.totalTokens')}</span><b>{formatTokens(shown.totals.total)}</b></p>
          {tokenParts().map((part) => shown.totals[part.key] > 0 && <p key={part.key}><span><i data-key={part.key} />{part.label}</span><b>{formatTokens(shown.totals[part.key])}</b></p>)}
          <p><span>{i18n.t('records.usage.estCost')}</span><b>{formatMoney(shown.totals.cost, report.currency)}</b></p>
          <p><span>{i18n.t('records.usage.requests')}</span><b>{i18n.t('records.usage.requestCount', { count: shown.totals.requests.toLocaleString() })}{shown.totals.unknownRequestRecords > 0 ? i18n.t('records.usage.partialUnknown') : ''}{i18n.t('records.usage.sessionCount', { count: shown.totals.sessions })}</b></p>
        </> : <p><span>{shown.start > now ? i18n.t('records.usage.future') : i18n.t('records.usage.noCalls')}</span></p>}
      </div>}
    </div>
    <div className={styles.xAxis} aria-hidden="true" style={{ gridTemplateColumns: `repeat(${buckets.length}, minmax(0, 1fr))` }}>
      {buckets.map((bucket, index) => <span key={bucket.start}>{index % labelEvery === 0 ? bucketLabel(bucket, report.bucket, false, multiYear) : ''}</span>)}
    </div>
  </div>;
}

type BreakdownView = 'model' | 'tool' | 'project';
function Breakdown({ report, toolName, filter, onFilter, onPrice, view, onView }: {
  report: UsageReport; toolName: (id: string) => string;
  filter: { toolId: string; model: string; projectId: string };
  onFilter: (next: Partial<{ toolId: string; model: string; projectId: string }>) => void;
  onPrice: (toolId: string, model: string) => void;
  view: BreakdownView; onView: (view: BreakdownView) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const rows = view === 'model' ? report.byModel : view === 'tool' ? report.byTool : report.byProject;
  const visible = expanded ? rows : rows.slice(0, 8);
  const total = report.totals.total;
  const isActive = (row: UsageGroup) => view === 'model' ? !!row.model && filter.model === row.model : view === 'tool' ? filter.toolId === row.toolId : !!row.projectId && filter.projectId === row.projectId;
  const toggle = (row: UsageGroup) => {
    if (view === 'model' && row.model) onFilter({ model: isActive(row) ? '' : row.model });
    else if (view === 'tool' && row.toolId) onFilter({ toolId: isActive(row) ? '' : row.toolId });
    else if (view === 'project' && row.projectId) onFilter({ projectId: isActive(row) ? '' : row.projectId });
  };
  const subtitle = (row: UsageGroup) => view === 'model' ? t('records.usage.subtitleModel', { tool: toolName(row.toolId ?? ''), count: row.totals.requests.toLocaleString(), unknown: row.totals.unknownRequestRecords ? t('records.usage.subtitleUnknown') : '' }) : t('records.usage.subtitle', { sessions: row.totals.sessions, count: row.totals.requests.toLocaleString(), unknown: row.totals.unknownRequestRecords ? t('records.usage.subtitleUnknown') : '' });
  return <section className={styles.card} aria-labelledby="usage-breakdown-title">
    <header className={styles.cardHead}>
      <h3 id="usage-breakdown-title">{t('records.usage.breakdownTitle')}</h3>
      <div className={styles.miniTabs} role="tablist" aria-label={t('records.usage.breakdownAria')} onKeyDown={navigateChoices}>
        {(['model', 'tool', 'project'] as const).map((item) => <button key={item} type="button" role="tab" tabIndex={view === item ? 0 : -1} aria-selected={view === item} onClick={() => { onView(item); setExpanded(false); }}>{t(`records.usage.dim.${item}`)}</button>)}
      </div>
    </header>
    <p className={styles.cardHint}>{t('records.usage.breakdownHint')}</p>
    <ol className={styles.rank} aria-label={view === 'model' ? t('records.usage.byModel') : view === 'tool' ? t('records.usage.byTool') : t('records.usage.byProject')}>
      {visible.map((row) => {
        const share = ratio(row.totals.total, total);
        const clickable = view === 'model' ? !!row.model : view === 'tool' ? !!row.toolId : !!row.projectId;
        const content = <>
          <span className={styles.rankIcon}>{view === 'project' ? <Icon name="folder" size={16} /> : <ToolIcon toolId={row.toolId ?? ''} size={20} />}</span>
          <span className={styles.rankName}><strong title={row.label}>{view === 'tool' ? toolName(row.label) : row.label}</strong><small>{subtitle(row)}</small></span>
          <span className={styles.rankBar} aria-hidden="true"><i style={{ width: `${Math.max(share * 100, row.totals.total > 0 ? 1 : 0)}%` }} /></span>
          <span className={styles.rankValue} title={`${row.totals.total.toLocaleString()} token`}><strong>{formatTokens(row.totals.total)}</strong><small>{formatPercent(share)}</small></span>
          <span className={styles.rankCost} data-unpriced={row.totals.cost === null || undefined} title={exactMoney(row.totals.cost, report.currency)}>{formatMoney(row.totals.cost, report.currency)}</span>
        </>;
        return <li key={row.key} data-active={isActive(row) || undefined}>
          {clickable ? <button type="button" className={styles.rankMain} aria-pressed={isActive(row)} title={isActive(row) ? t('records.usage.untoggleTitle') : t('records.usage.toggleTitle')} onClick={() => toggle(row)}>{content}</button> : <div className={styles.rankMain}>{content}</div>}
          {view === 'model' && row.toolId && <button type="button" className={styles.priceButton} data-unpriced={!row.priced || undefined} onClick={() => onPrice(row.toolId ?? '', row.model ?? '')} title={row.priced ? t('records.usage.priceTitleAdjust', { label: row.label }) : t('records.usage.priceTitleFill', { label: row.label })}>{row.priced ? t('records.usage.priceEdit') : t('records.usage.priceSet')}</button>}
        </li>;
      })}
    </ol>
    {rows.length > 8 && <button type="button" className={styles.more} onClick={() => setExpanded((value) => !value)}>{expanded ? t('records.usage.collapse') : t('records.usage.showAll', { count: rows.length })}</button>}
  </section>;
}

export type UsageNotify = { status: (text: string, protect?: boolean) => void; alert: (value: unknown) => void; readAlert: (value: unknown) => void; clear: () => void };

export function UsageDashboard({ search, favoriteOnly, active, tools, projects, prices, onPricesChange, scanVersion, scanning, lastScanAt, onOpenSession, notify }: {
  search: string; favoriteOnly: boolean; active: boolean; tools: AdapterDescriptor[]; projects: Project[]; prices: HistoryPrice[]; onPricesChange: (prices: HistoryPrice[]) => void;
  scanVersion: number; scanning: boolean; lastScanAt: number | null;   onOpenSession: (id: string) => void; notify: UsageNotify;
}) {
  const { t } = useTranslation();
  const [range, setRange] = useState<UsageRange>(storedRange);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [toolId, setToolId] = useState('');
  const [model, setModel] = useState('');
  const [projectId, setProjectId] = useState('');
  const [metric, setMetric] = useState<'tokens' | 'cost'>('tokens');
  const [breakdownView, setBreakdownView] = useState<BreakdownView>('model');
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [priceOpen, setPriceOpen] = useState(false);
  const [priceError, setPriceError] = useState('');
  const [priceTool, setPriceTool] = useState('');
  const [priceModel, setPriceModel] = useState('');
  const [priceDraft, setPriceDraft] = useState({ currency: 'USD', input: '', output: '', read: '', write: '', source: '' });
  const request = useRef(0);
  const loaded = useRef(false);
  const reportFilter = useRef('');

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [active]);
  useEffect(() => { try { if (range !== 'custom') localStorage.setItem(rangeStorageKey, range); } catch { /* storage is optional */ } }, [range]);

  const today = isoDay(new Date(now));
  const { fromMs, toMs } = useMemo(() => bounds(range, today, customFrom, customTo), [range, today, customFrom, customTo]);
  const toolKey = tools.map((item) => item.id).join('|');
  const filter = useMemo<HistoryFilter>(() => ({
    toolId: toolId || null, model: model || null, projectId: projectId || null, search: search.trim() || null,
    fromMs, toMs, favoriteOnly, tools: toolKey ? toolKey.split('|') : null,
  }), [toolId, model, projectId, fromMs, toMs, toolKey, search, favoriteOnly]);

  useEffect(() => {
    if (!active || !nativeAvailable) return;
    const sequence = ++request.current;
    const filterKey = JSON.stringify(filter);
    setLoading(true); setReadError(false);
    if (filterKey !== reportFilter.current) setReport(null);
    const timer = window.setTimeout(() => {
      native.getUsageReport(filter)
        .then((value) => { if (sequence === request.current) { setReport(value); reportFilter.current = filterKey; loaded.current = true; } })
        .catch(() => { if (sequence === request.current) { setReport(null); setReadError(true); } })
        .finally(() => { if (sequence === request.current) setLoading(false); });
    }, loaded.current ? 120 : 0);
    return () => { window.clearTimeout(timer); request.current++; };
  }, [filter, active, scanVersion, retry]);

  const toolName = (id: string) => tools.find((item) => item.id === id)?.name ?? id;
  const totals = report?.totals ?? null;
  const previous = report?.previous ?? null;
  const compare = previous ? comparisonLabel(range, previous) : '';
  const compareTitle = previous ? t('records.usage.compareTitle', { from: new Date(previous.from).toLocaleString(dateLocale()), to: new Date(previous.to).toLocaleString(dateLocale()) }) : '';
  const empty = !!report && report.totals.usageRecords === 0;
  const pricedShare = totals ? ratio(totals.total - totals.unpricedTokens, totals.total) : 0;
  const multiDay = report?.bucket !== 'hour';
  const shownMetric = totals?.cost === null ? 'tokens' : metric;
  const timedBuckets = report?.timeline.filter((bucket) => bucket.start <= now) ?? [];
  const metricValue = (value: UsageTotals) => shownMetric === 'cost' ? value.cost ?? 0 : value.total;
  const metricFormat = (value: number) => shownMetric === 'cost' ? formatMoney(value, report?.currency ?? 'USD') : formatTokens(value);
  const average = timedBuckets.length ? timedBuckets.reduce((sum, bucket) => sum + metricValue(bucket.totals), 0) / timedBuckets.length : 0;
  const peak = report?.timeline.reduce<UsageBucket | null>((best, bucket) => metricValue(bucket.totals) > (best ? metricValue(best.totals) : 0) ? bucket : best, null) ?? null;

  function openPrice(tool = '', name = '') {
    const existing = prices.find((item) => item.toolId === tool && item.model === name);
    setPriceTool(tool); setPriceModel(name); setPriceError('');
    setPriceDraft(existing
      ? { currency: existing.currency, input: String(existing.inputPerMillion), output: String(existing.outputPerMillion), read: String(existing.cacheReadPerMillion), write: String(existing.cacheWritePerMillion), source: existing.source }
      : { currency: report?.currency ?? 'USD', input: '', output: '', read: '', write: '', source: '' });
    setPriceOpen(true);
  }

  async function savePrice() {
    const chosenTool = priceTool;
    const chosenModel = priceModel.trim();
    if (!chosenTool || !chosenModel) { setPriceError(t('records.usage.pricePickFirst')); return; }
    if (![priceDraft.input, priceDraft.output, priceDraft.read, priceDraft.write].every((value) => value.trim() !== '')) {
      setPriceError(t('records.usage.priceFillAll')); return;
    }
    notify.clear(); setPriceError('');
    try {
      const price = await native.saveHistoryPrice({ toolId: chosenTool, model: chosenModel, currency: priceDraft.currency.trim().toUpperCase(),
        inputPerMillion: Number(priceDraft.input), outputPerMillion: Number(priceDraft.output),
        cacheReadPerMillion: Number(priceDraft.read), cacheWritePerMillion: Number(priceDraft.write),
        source: priceDraft.source.trim() || t('records.usage.sourceManual'), updatedAt: 0 });
      onPricesChange([...prices.filter((item) => item.toolId !== price.toolId || item.model !== price.model), price]);
      setPriceOpen(false); notify.status(t('records.usage.priceSaved'), true);
      const sequence = ++request.current;
      try { const value = await native.getUsageReport(filter); if (sequence === request.current) setReport(value); }
      catch (value) { notify.readAlert(value); }
    } catch (value) { setPriceError(typeof value === 'string' ? value : (value as { message?: string })?.message ?? t('records.usage.priceSaveFailed')); }
  }

  const scanned = lastScanAt ?? (report?.scans.length ? Math.max(...report.scans.map((item) => item.scannedAt)) : null);
  const modelOptions = [{ value: '', label: t('records.page.allModels') }, ...(report?.models ?? []).map((item) => ({ value: item, label: item })), ...(model && !(report?.models ?? []).includes(model) ? [{ value: model, label: model }] : [])];

  return <div className={styles.dashboard} data-loading={loading || undefined} aria-busy={loading || undefined}>
    <div className={styles.overviewHead}><div><h2>{t('records.usage.title')}</h2><p>{search.trim() || favoriteOnly ? t('records.usage.filtered', { parts: [search.trim() ? t('records.usage.filterSearch', { query: search.trim() }) : '', favoriteOnly ? t('records.page.favoriteOnly') : ''].filter(Boolean).join(' · ') }) : t('records.usage.overviewSubtitle')}</p></div>
      <button type="button" onClick={() => openPrice()}><Icon name="settings" size={14} />{t('records.usage.priceSettings')}</button>
    </div>
    <div className={styles.header}>
      <DateRangeFilter variant="toolbar" value={range} customFrom={customFrom} customTo={customTo} presets={ranges()} onChange={setRange}
        onCustomRange={(from, to) => { setCustomFrom(from); setCustomTo(to); setRange('custom'); }} />
      <div className={styles.headerFilters}>
        <FilterSelect label={t('records.usage.toolFilter')} value={toolId} options={[{ value: '', label: t('records.page.allTools') }, ...toolOptions(tools)]} onChange={setToolId} />
        <FilterSelect label={t('records.usage.modelFilter')} value={model} options={modelOptions} onChange={setModel} />
        <FilterSelect label={t('records.usage.projectFilter')} value={projectId} options={[{ value: '', label: t('records.page.allProjects') }, { value: '__unknown__', label: t('records.page.noProject') }, ...projects.map((item) => ({ value: item.id, label: item.name }))]} onChange={setProjectId} />
      </div>
    </div>
    <div className={styles.subhead}>
      <p>{rangeCaption(report, range, now)}{(toolId || model || projectId) && <span className={styles.activeChips} aria-label={t('records.page.activeAria')}>
        {toolId && <button type="button" className={styles.chip} title={t('records.page.chipTitle')} onClick={() => setToolId('')}><span>{t('records.page.chipTool', { name: toolName(toolId) })}</span><Icon name="close" size={10} strokeWidth={2.4} /></button>}
        {model && <button type="button" className={styles.chip} title={t('records.page.chipTitle')} onClick={() => setModel('')}><span>{t('records.page.chipModel', { name: model })}</span><Icon name="close" size={10} strokeWidth={2.4} /></button>}
        {projectId && <button type="button" className={styles.chip} title={t('records.page.chipTitle')} onClick={() => setProjectId('')}><span>{t('records.page.chipProject', { name: projectId === '__unknown__' ? t('records.page.noProject') : projects.find((item) => item.id === projectId)?.name ?? projectId })}</span><Icon name="close" size={10} strokeWidth={2.4} /></button>}
        <button type="button" className="text-button" onClick={() => { setToolId(''); setModel(''); setProjectId(''); }}>{t('tools.plugins.clearFilter')}</button>
      </span>}</p>
      <p className={styles.freshness}>
        {scanning || loading ? <><span className="spinner" aria-hidden="true" />{scanning ? t('records.page.syncing') : t('records.usage.updating')}</> : scanned ? t('records.usage.updatedAt', { time: clockTime(scanned) }) : t('records.usage.notScanned')}
      </p>
    </div>

    {readError ? <div className={styles.empty} role="alert"><span className="empty-symbol"><Icon name="alert" size={20} /></span><h3>{t('records.usage.readFailed')}</h3><p>{t('records.usage.readFailedHint')}</p><button type="button" onClick={() => setRetry((value) => value + 1)}>{t('records.usage.retry')}</button></div>
    : !report ? <div className={styles.skeleton} role="status" aria-label={t('records.usage.loading')}><span /><span /><span /></div> : empty ? <div className={styles.empty}>
      <span className="empty-symbol"><Icon name="clock" size={20} /></span>
      <h3>{range === 'all' ? t('records.usage.emptyAll') : t('records.usage.emptyRange')}</h3>
      <p>{toolId || model || projectId ? t('records.usage.emptyFilteredHint') : range === 'all' ? t('records.usage.emptyAllHint') : t('records.usage.emptyRangeHint')}</p>
      <div>{range !== '7' && <button type="button" onClick={() => setRange('7')}>{t('records.usage.viewWeek')}</button>}{range !== 'all' && <button type="button" onClick={() => setRange('all')}>{t('records.usage.viewAll')}</button>}</div>
    </div> : totals && <>
      <section className={styles.summary} aria-label={t('records.usage.summaryAria')}>
        <div className={styles.primary}>
          <small><Icon name="sparkle" size={15} />{t('records.usage.totalTokens')}</small>
          <strong title={`${totals.total.toLocaleString()} token`}>{formatTokens(totals.total)}</strong>
          <Delta current={totals.total} previous={previous?.totals.total} label={compare} title={compareTitle} />
        </div>
        <div className={styles.metric}>
          <small><Icon name="archive" size={15} />{t('records.usage.estCost')} <span className={styles.currency}>{report.currency}</span></small>
          <strong title={exactMoney(totals.cost, report.currency)} data-unpriced={totals.cost === null || undefined}>{formatMoney(totals.cost, report.currency)}</strong>
          {totals.unpricedTokens > 0
            ? <button type="button" className={styles.metricNote} onClick={() => openPrice()}>{t('records.usage.unpricedNote', { percent: formatPercent(1 - pricedShare) })}</button>
            : <Delta current={totals.cost} previous={previous?.totals.cost ?? (previous ? 0 : undefined)} label={compare} title={compareTitle} />}
        </div>
        <div className={styles.metric}>
          <small><Icon name="connections" size={15} />{totals.unknownRequestRecords ? t('records.usage.knownCalls') : t('records.usage.calls')}</small>
          <strong>{totals.requests.toLocaleString()}</strong>
          <span className={styles.metricNote}>{t('records.usage.sessionsNote', { sessions: totals.sessions, detail: totals.unknownRequestRecords ? t('records.usage.unknownCounts', { count: totals.unknownRequestRecords.toLocaleString() }) : totals.requests ? t('records.usage.perRequest', { amount: formatTokens(totals.total / totals.requests) }) : t('records.usage.noRequests') })}</span>
        </div>
        <div className={styles.metric}>
          <small><Icon name="leaf" size={15} />{t('records.usage.cacheHit')}</small>
          <strong title={t('records.usage.cacheHitTitle')}>{formatPercent(cacheHitRate(totals))}</strong>
          <span className={styles.metricNote}>{t('records.usage.ioNote', { input: formatTokens(totals.input), output: formatTokens(totals.output) })}</span>
        </div>
      </section>

      <div className={styles.analysisGrid}>
      <section className={styles.card} aria-labelledby="usage-trend-title">
        <header className={styles.cardHead}>
          <h3 id="usage-trend-title">{t('records.usage.trendTitle')}<small>{t(`records.usage.bucket.${report.bucket}`)}</small></h3>
          {totals.cost !== null && <div className={styles.miniTabs} role="tablist" aria-label={t('records.usage.metricAria')} onKeyDown={navigateChoices}>
            <button type="button" role="tab" tabIndex={metric === 'tokens' ? 0 : -1} aria-selected={metric === 'tokens'} onClick={() => setMetric('tokens')}>Token</button>
            <button type="button" role="tab" tabIndex={metric === 'cost' ? 0 : -1} aria-selected={metric === 'cost'} onClick={() => setMetric('cost')}>{t('records.usage.cost')}</button>
          </div>}
        </header>
        <p className={styles.trendStats}>
          {peak && <span>{t('records.usage.peak')} <b>{metricFormat(metricValue(peak.totals))}</b> · {bucketLabel(peak, report.bucket, true)}</span>}
          {timedBuckets.length > 1 && <span>{t('records.usage.average', { unit: multiDay ? t(report.bucket === 'month' ? 'records.usage.unitMonth' : 'records.usage.unitDay') : t('records.usage.unitHour') })} <b>{metricFormat(average)}</b></span>}
        </p>
        <TrendChart report={report} metric={shownMetric} now={now} />
        {shownMetric === 'tokens' && <ul className={styles.legend} aria-hidden="true">{tokenParts().map((part) => <li key={part.key}><i data-key={part.key} />{part.label}</li>)}</ul>}
        {shownMetric === 'cost' && <p className={styles.cardHint}>{t('records.usage.costHint')}</p>}
      </section>
      <section className={styles.card} aria-labelledby="usage-composition-title">
        <header className={styles.cardHead}><h3 id="usage-composition-title">{t('records.usage.compositionTitle')}</h3><span className={styles.cardHint}>{t('records.usage.compositionHint')}</span></header>
        <Composition totals={totals} />
      </section>
      </div>

      <div className={styles.split}>
        <Breakdown report={report} toolName={toolName} filter={{ toolId, model, projectId }}
          view={breakdownView} onView={setBreakdownView}
          onFilter={(next) => { if (next.toolId !== undefined) setToolId(next.toolId); if (next.model !== undefined) setModel(next.model); if (next.projectId !== undefined) setProjectId(next.projectId); }}
          onPrice={openPrice} />
        <section className={styles.card} aria-labelledby="usage-sessions-title">
          <header className={styles.cardHead}><h3 id="usage-sessions-title">{t('records.usage.topTitle')}</h3><span className={styles.cardHint}>Top {report.topSessions.length}</span></header>
          <p className={styles.cardHint}>{t('records.usage.topHint')}</p>
          <ol className={styles.sessions} aria-label={t('records.usage.topTitle')}>
            {report.topSessions.map((item) => <li key={item.id}><button type="button" onClick={() => onOpenSession(item.id)} title={t('records.usage.openTitle')}>
              <ToolIcon toolId={item.toolId} size={20} />
              <span className={styles.rankName}><strong title={item.title}>{item.title}</strong><small>{toolName(item.toolId)}{item.model ? ` · ${item.model}` : ''} · {shortDate(item.updatedAt)}</small></span>
              <span className={styles.rankValue} title={`${item.totals.total.toLocaleString()} token`}><strong>{formatTokens(item.totals.total)}</strong><small>{formatMoney(item.totals.cost, report.currency)}</small></span>
            </button></li>)}
          </ol>
        </section>
      </div>
    </>}

    {report && <details className={styles.notes}>
      <summary>{t('records.usage.notesTitle')}</summary>
      <ul>
        <li><b>{t('records.usage.totalTokens')}</b> = {t('records.usage.noteTotal')}</li>
        <li><b>{t('records.usage.timeLabel')}</b>{t('records.usage.noteTime')}</li>
        {report.duplicateRequests > 0 && <li>{t('records.usage.noteMerged', { count: report.duplicateRequests.toLocaleString() })}</li>}
        {report.untimedRequests > 0 && <li>{t('records.usage.noteUntimed', { count: report.untimedRequests.toLocaleString() })}</li>}
        {(report.partialSessions > 0 || report.staleSessions > 0) && <li>{report.partialSessions ? t('records.usage.notePartial', { count: report.partialSessions }) : ''}{report.partialSessions && report.staleSessions ? t('records.usage.noteSep') : ''}{report.staleSessions ? t('records.usage.noteStale', { count: report.staleSessions }) : ''}{t('records.usage.notePartialSuffix')}</li>}
        <li><b>{t('records.usage.costLabel')}</b>{t('records.usage.noteCost')}{report.mixedCurrency ? t('records.usage.noteMixed', { currency: report.currency }) : ''}</li>
        {report.latestEventAt && <li>{t('records.usage.noteLatest', { time: new Date(report.latestEventAt).toLocaleString(dateLocale()) })}</li>}
        {!!report.scans.length && <li>{t('records.usage.noteIndexed', { count: report.scans.reduce((sum, item) => sum + item.sourceCount, 0).toLocaleString(), failed: report.scans.some((item) => item.failedCount) ? t('records.usage.noteIndexedFailed', { count: report.scans.reduce((sum, item) => sum + item.failedCount, 0) }) : '' })}</li>}
      </ul>
      {!!report.priceSources.length && <div className={styles.chips}><b>{t('records.usage.priceSourcesUsed')}</b>{report.priceSources.map((source) => <span className="quiet-chip" key={source}>{source}</span>)}</div>}
      {!!prices.length && <div className={styles.chips}><b>{t('records.usage.priceSourcesSaved')}</b>{prices.map((price) => <button type="button" className="quiet-chip" key={`${price.toolId}:${price.model}`} onClick={() => openPrice(price.toolId, price.model)} title={t('records.usage.priceChipTitle', { input: price.inputPerMillion, output: price.outputPerMillion, read: price.cacheReadPerMillion, write: price.cacheWritePerMillion, currency: price.currency })}>{toolName(price.toolId)} / {price.model}</button>)}</div>}
    </details>}

    <GuideDialog open={priceOpen} title={t('records.usage.priceSettings')} hint={t('records.usage.priceHint')} onClose={() => { setPriceOpen(false); setPriceError(''); }}>
      <div className={styles.priceForm}>
        <label>{t('records.usage.priceTool')}<FilterSelect label={t('records.usage.priceToolFilter')} value={priceTool} options={[{ value: '', label: t('home.launcher.pickTool') }, ...toolOptions(tools)]} searchLabel={t('home.launcher.searchTool')} onChange={setPriceTool} /></label>
        <label>{t('records.usage.priceModel')}<input aria-label={t('records.usage.priceModelAria')} list="priced-models" value={priceModel} onChange={(event) => setPriceModel(event.target.value)} /><datalist id="priced-models">{[...new Set([...(report?.models ?? []), ...prices.filter((item) => item.toolId === priceTool).map((item) => item.model)])].map((value) => <option key={value} value={value} />)}</datalist></label>
        <label>{t('records.usage.currency')}<input aria-label={t('records.usage.currencyAria')} value={priceDraft.currency} onChange={(event) => setPriceDraft({ ...priceDraft, currency: event.target.value })} /></label>
        <label>{t('records.usage.input')}<input aria-label={t('records.usage.inputAria')} type="number" min="0" value={priceDraft.input} onChange={(event) => setPriceDraft({ ...priceDraft, input: event.target.value })} /></label>
        <label>{t('records.usage.output')}<input aria-label={t('records.usage.outputAria')} type="number" min="0" value={priceDraft.output} onChange={(event) => setPriceDraft({ ...priceDraft, output: event.target.value })} /></label>
        <label>{t('records.usage.cacheRead')}<input aria-label={t('records.usage.cacheReadAria')} type="number" min="0" value={priceDraft.read} onChange={(event) => setPriceDraft({ ...priceDraft, read: event.target.value })} /></label>
        <label>{t('records.usage.cacheWrite')}<input aria-label={t('records.usage.cacheWriteAria')} type="number" min="0" value={priceDraft.write} onChange={(event) => setPriceDraft({ ...priceDraft, write: event.target.value })} /></label>
        <label>{t('records.usage.source')}<input aria-label={t('records.usage.sourceAria')} value={priceDraft.source} onChange={(event) => setPriceDraft({ ...priceDraft, source: event.target.value })} placeholder={t('records.usage.sourcePlaceholder')} /></label>
        {priceError && <p className={styles.error} role="alert">{priceError}</p>}
        <div className="dialog-footer"><button type="button" className={styles.primaryButton} data-dialog-save title={saveShortcutHint()} onClick={() => void savePrice()}>{t('records.usage.savePrice')}</button></div>
      </div>
    </GuideDialog>
  </div>;
}
