import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { native, nativeAvailable } from '../../lib/native';
import type { AdapterDescriptor } from '../../types/native';
import type { Project } from '../../types/launch';
import type { HistoryFilter, HistoryPrice, UsageBucket, UsageGroup, UsageReport, UsageTotals } from '../../types/history';
import { FilterSelect } from '../../components/FilterSelect';
import { GuideDialog } from '../../components/GuideDialog';
import { ToolIcon, toolOptions } from '../../components/ToolIcon';
import { Icon } from '../../components/Icon';
import { DAY_MS, bucketLabel, cacheHitRate, clockTime, exactMoney, formatMoney, formatPercent, formatTokens, niceScale, ratio, shortDate, tokenParts } from './usageFormat';
import styles from './UsageDashboard.module.css';

type UsageRange = 'today' | 'yesterday' | '7' | '30' | 'month' | 'all' | 'custom';
const ranges: Array<{ id: UsageRange; label: string }> = [
  { id: 'today', label: '今天' },
  { id: 'yesterday', label: '昨天' },
  { id: '7', label: '近 7 天' },
  { id: '30', label: '近 30 天' },
  { id: 'month', label: '本月' },
  { id: 'all', label: '全部' },
  { id: 'custom', label: '自定义' },
];
const rangeStorageKey = 'cliora.usage.range';
const storedRange = (): UsageRange => {
  try {
    const value = localStorage.getItem(rangeStorageKey);
    return ranges.some((item) => item.id === value) && value !== 'custom' ? value as UsageRange : 'today';
  } catch { return 'today'; }
};

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
  if (range === 'today') return '较昨日同时段';
  const days = Math.max(1, Math.round((previous.to - previous.from) / DAY_MS));
  return days === 1 ? '较前一天' : `较前 ${days} 天`;
}

function rangeCaption(report: UsageReport | null, range: UsageRange, now: number) {
  if (!report?.from || !report.to) return range === 'all' ? '全部已索引记录' : '';
  const day = (ms: number) => new Date(ms).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
  const end = Math.min(report.to, now);
  if (report.to > now && report.from <= now) {
    return new Date(report.from).toDateString() === new Date(now).toDateString()
      ? `今天 00:00 至 ${clockTime(now)}`
      : `${day(report.from)} 至今天 ${clockTime(now)}`;
  }
  const last = end - 1;
  return new Date(report.from).toDateString() === new Date(last).toDateString() ? `${day(report.from)}全天` : `${day(report.from)} 至 ${day(last)}`;
}

function Delta({ current, previous, label, title }: { current: number | null; previous: number | null | undefined; label: string; title: string }) {
  if (current === null || previous === null || previous === undefined) return null;
  if (previous === 0) {
    return <span className={styles.delta} data-direction={current > 0 ? 'up' : 'flat'} title={title}>{current > 0 ? '新增' : '持平'}<small>{label}</small></span>;
  }
  const change = (current - previous) / previous;
  const direction = Math.abs(change) < 0.005 ? 'flat' : change > 0 ? 'up' : 'down';
  const arrow = direction === 'up' ? '↑' : direction === 'down' ? '↓' : '→';
  return <span className={styles.delta} data-direction={direction} title={title}>{arrow} {formatPercent(Math.abs(change))}<small>{label}</small></span>;
}

function Composition({ totals }: { totals: UsageTotals }) {
  const shown = tokenParts.filter((part) => totals[part.key] > 0);
  return <div className={styles.composition} role="group" aria-label="token 构成">
    <div className={styles.compositionBar} aria-hidden="true">
      {shown.map((part) => <span key={part.key} data-key={part.key} style={{ flexGrow: totals[part.key] }} />)}
    </div>
    <ul>
      {tokenParts.map((part) => <li key={part.key} title={`${part.hint}：${totals[part.key].toLocaleString()} token`}>
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
    aria-label={`用量趋势，${buckets.length} 个时段${peak !== null ? `，峰值 ${bucketLabel(buckets[peak], report.bucket, true, multiYear)} ${format(value(buckets[peak].totals))}` : ''}。左右方向键查看各时段。`}>
    <div className={styles.yAxis} aria-hidden="true">{ticks.map((tick) => <span key={tick} style={{ bottom: `${(tick / top) * 100}%` }}>{format(tick)}</span>)}</div>
    <div className={styles.plot}>
      <div className={styles.grid} aria-hidden="true">{ticks.map((tick) => <i key={tick} style={{ bottom: `${(tick / top) * 100}%` }} />)}</div>
      <div className={styles.bars} style={{ gridTemplateColumns: `repeat(${buckets.length}, minmax(0, 1fr))`, gap: buckets.length > 40 ? 1 : buckets.length > 16 ? 3 : 6 }}>
        {buckets.map((bucket, index) => {
          const amount = value(bucket.totals);
          const height = amount > 0 ? Math.max(1.5, (amount / top) * 100) : 0;
          return <div key={bucket.start} className={styles.column} data-active={active === index || undefined} data-future={bucket.start > now || undefined} data-current={bucket.start <= now && now < bucket.end || undefined} onMouseEnter={() => setActive(index)}>
            <div className={styles.stack} style={{ height: `${height}%` }} data-metric={metric}>
              {metric === 'tokens' ? tokenParts.map((part) => bucket.totals[part.key] > 0 && <span key={part.key} data-key={part.key} style={{ flexGrow: bucket.totals[part.key] }} />) : <span data-key="cost" style={{ flexGrow: 1 }} />}
            </div>
          </div>;
        })}
      </div>
      {shown && active !== null && <div className={styles.tooltip} data-align={align} style={{ left: `${((active + 0.5) / buckets.length) * 100}%` }} role="status">
        <strong>{bucketLabel(shown, report.bucket, true, multiYear)}</strong>
        {shown.totals.requests ? <>
          <p><span>总 Token</span><b>{shown.totals.total.toLocaleString()}</b></p>
          {tokenParts.map((part) => shown.totals[part.key] > 0 && <p key={part.key}><span><i data-key={part.key} />{part.label}</span><b>{formatTokens(shown.totals[part.key])}</b></p>)}
          <p><span>估算费用</span><b>{formatMoney(shown.totals.cost, report.currency)}</b></p>
          <p><span>请求</span><b>{shown.totals.requests.toLocaleString()} 次 · {shown.totals.sessions} 个会话</b></p>
        </> : <p><span>{shown.start > now ? '尚未到达' : '没有调用'}</span></p>}
      </div>}
    </div>
    <div className={styles.xAxis} aria-hidden="true" style={{ gridTemplateColumns: `repeat(${buckets.length}, minmax(0, 1fr))` }}>
      {buckets.map((bucket, index) => <span key={bucket.start}>{index % labelEvery === 0 ? bucketLabel(bucket, report.bucket, false, multiYear) : ''}</span>)}
    </div>
  </div>;
}

type BreakdownView = 'model' | 'tool' | 'project';
function Breakdown({ report, toolName, filter, onFilter, onPrice }: {
  report: UsageReport; toolName: (id: string) => string;
  filter: { toolId: string; model: string; projectId: string };
  onFilter: (next: Partial<{ toolId: string; model: string; projectId: string }>) => void;
  onPrice: (toolId: string, model: string) => void;
}) {
  const [view, setView] = useState<BreakdownView>('model');
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
  const subtitle = (row: UsageGroup) => view === 'model' ? `${toolName(row.toolId ?? '')} · ${row.totals.requests.toLocaleString()} 次` : `${row.totals.sessions} 个会话 · ${row.totals.requests.toLocaleString()} 次`;
  return <section className={styles.card} aria-labelledby="usage-breakdown-title">
    <header className={styles.cardHead}>
      <h3 id="usage-breakdown-title">用量分布</h3>
      <div className={styles.miniTabs} role="tablist" aria-label="分布维度">
        {(['model', 'tool', 'project'] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={view === item} onClick={() => { setView(item); setExpanded(false); }}>{{ model: '模型', tool: '工具', project: '项目' }[item]}</button>)}
      </div>
    </header>
    <ol className={styles.rank} aria-label={view === 'model' ? '按模型用量明细' : view === 'tool' ? '按工具用量明细' : '按项目用量明细'}>
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
          {clickable ? <button type="button" className={styles.rankMain} aria-pressed={isActive(row)} title={isActive(row) ? '再次点击取消筛选' : '点击只看这一项'} onClick={() => toggle(row)}>{content}</button> : <div className={styles.rankMain}>{content}</div>}
          {view === 'model' && row.toolId && <button type="button" className={styles.priceButton} data-unpriced={!row.priced || undefined} onClick={() => onPrice(row.toolId ?? '', row.model ?? '')} title={`${row.priced ? '调整' : '填写'} ${row.label} 的估算价格`}>{row.priced ? '改价' : '定价'}</button>}
        </li>;
      })}
    </ol>
    {rows.length > 8 && <button type="button" className={styles.more} onClick={() => setExpanded((value) => !value)}>{expanded ? '收起' : `显示全部 ${rows.length} 项`}</button>}
  </section>;
}

export type UsageNotify = { status: (text: string, protect?: boolean) => void; alert: (value: unknown) => void; readAlert: (value: unknown) => void; clear: () => void };

export function UsageDashboard({ active, tools, projects, prices, onPricesChange, scanVersion, scanning, lastScanAt, onOpenSession, notify }: {
  active: boolean; tools: AdapterDescriptor[]; projects: Project[]; prices: HistoryPrice[]; onPricesChange: (prices: HistoryPrice[]) => void;
  scanVersion: number; scanning: boolean; lastScanAt: number | null; onOpenSession: (id: string) => void; notify: UsageNotify;
}) {
  const [range, setRange] = useState<UsageRange>(storedRange);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [toolId, setToolId] = useState('');
  const [model, setModel] = useState('');
  const [projectId, setProjectId] = useState('');
  const [metric, setMetric] = useState<'tokens' | 'cost'>('tokens');
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [priceOpen, setPriceOpen] = useState(false);
  const [priceError, setPriceError] = useState('');
  const [priceTool, setPriceTool] = useState('');
  const [priceModel, setPriceModel] = useState('');
  const [priceDraft, setPriceDraft] = useState({ currency: 'USD', input: '', output: '', read: '', write: '', source: '' });
  const request = useRef(0);
  const loaded = useRef(false);

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
    toolId: toolId || null, model: model || null, projectId: projectId || null, search: null,
    fromMs, toMs, favoriteOnly: false, tools: toolKey ? toolKey.split('|') : null,
  }), [toolId, model, projectId, fromMs, toMs, toolKey]);

  useEffect(() => {
    if (!active || !nativeAvailable) return;
    const sequence = ++request.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      native.getUsageReport(filter)
        .then((value) => { if (sequence === request.current) { setReport(value); loaded.current = true; } })
        .catch((value) => { if (sequence === request.current) notify.readAlert(value); })
        .finally(() => { if (sequence === request.current) setLoading(false); });
    }, loaded.current ? 120 : 0);
    return () => window.clearTimeout(timer);
  }, [filter, active, scanVersion]);

  const toolName = (id: string) => tools.find((item) => item.id === id)?.name ?? id;
  const totals = report?.totals ?? null;
  const previous = report?.previous ?? null;
  const compare = previous ? comparisonLabel(range, previous) : '';
  const compareTitle = previous ? `对比 ${new Date(previous.from).toLocaleString()} – ${new Date(previous.to).toLocaleString()}` : '';
  const empty = !!report && report.totals.requests === 0;
  const pricedShare = totals ? ratio(totals.total - totals.unpricedTokens, totals.total) : 0;
  const multiDay = report?.bucket !== 'hour';
  const shownMetric = totals?.cost === null ? 'tokens' : metric;
  const timedBuckets = report?.timeline.filter((bucket) => bucket.start <= now) ?? [];
  const average = timedBuckets.length ? (totals?.total ?? 0) / timedBuckets.length : 0;
  const peak = report?.timeline.reduce<UsageBucket | null>((best, bucket) => bucket.totals.total > (best?.totals.total ?? 0) ? bucket : best, null) ?? null;

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
    if (!chosenTool || !chosenModel) { setPriceError('先选择工具和模型，再填写价格。'); return; }
    if (![priceDraft.input, priceDraft.output, priceDraft.read, priceDraft.write].every((value) => value.trim() !== '')) {
      setPriceError('请填写四项单价；确认为免费的项目可填 0。'); return;
    }
    notify.clear(); setPriceError('');
    try {
      const price = await native.saveHistoryPrice({ toolId: chosenTool, model: chosenModel, currency: priceDraft.currency.trim().toUpperCase(),
        inputPerMillion: Number(priceDraft.input), outputPerMillion: Number(priceDraft.output),
        cacheReadPerMillion: Number(priceDraft.read), cacheWritePerMillion: Number(priceDraft.write),
        source: priceDraft.source.trim() || '手动设置', updatedAt: 0 });
      onPricesChange([...prices.filter((item) => item.toolId !== price.toolId || item.model !== price.model), price]);
      setPriceOpen(false); notify.status('估算价格已保存；只影响本机统计。', true);
      const sequence = ++request.current;
      try { const value = await native.getUsageReport(filter); if (sequence === request.current) setReport(value); }
      catch (value) { notify.readAlert(value); }
    } catch (value) { setPriceError(typeof value === 'string' ? value : (value as { message?: string })?.message ?? '价格没有保存，请检查后重试。'); }
  }

  const scanned = lastScanAt ?? (report?.scans.length ? Math.max(...report.scans.map((item) => item.scannedAt)) : null);
  const modelOptions = [{ value: '', label: '全部模型' }, ...(report?.models ?? []).map((item) => ({ value: item, label: item })), ...(model && !(report?.models ?? []).includes(model) ? [{ value: model, label: model }] : [])];

  return <div className={styles.dashboard} data-loading={loading || undefined} aria-busy={loading || undefined}>
    <div className={styles.header}>
      <div className={styles.segmented} role="radiogroup" aria-label="统计时间">
        {ranges.map((item) => <button key={item.id} type="button" role="radio" aria-checked={range === item.id} onClick={() => {
          setRange(item.id);
          if (item.id === 'custom' && !customFrom && !customTo) { setCustomFrom(shiftDay(today, -6)); setCustomTo(today); }
        }}>{item.label}</button>)}
      </div>
      {range === 'custom' && <div className={styles.dates}>
        <label><span className="sr-only">开始日期</span><input aria-label="开始日期" type="date" value={customFrom} max={customTo || undefined} onChange={(event) => setCustomFrom(event.target.value)} /></label>
        <span aria-hidden="true">–</span>
        <label><span className="sr-only">结束日期</span><input aria-label="结束日期" type="date" value={customTo} min={customFrom || undefined} onChange={(event) => setCustomTo(event.target.value)} /></label>
      </div>}
      <div className={styles.headerFilters}>
        <FilterSelect label="用量工具" value={toolId} options={[{ value: '', label: '全部工具' }, ...toolOptions(tools)]} onChange={setToolId} />
        <FilterSelect label="用量模型" value={model} options={modelOptions} onChange={setModel} />
        <FilterSelect label="用量项目" value={projectId} options={[{ value: '', label: '全部项目' }, { value: '__unknown__', label: '未关联项目' }, ...projects.map((item) => ({ value: item.id, label: item.name }))]} onChange={setProjectId} />
      </div>
    </div>
    <div className={styles.subhead}>
      <p>{rangeCaption(report, range, now)}{(toolId || model || projectId) && <button type="button" className="text-button" onClick={() => { setToolId(''); setModel(''); setProjectId(''); }}>清除筛选</button>}</p>
      <p className={styles.freshness}>
        {scanning ? <><span className="spinner" aria-hidden="true" />正在同步本机记录…</> : scanned ? `数据更新于 ${clockTime(scanned)}` : '尚未扫描本机记录'}
        <button type="button" className="text-button" onClick={() => openPrice()}><Icon name="sparkle" size={13} />设置估算价格</button>
      </p>
    </div>

    {!report ? <div className={styles.skeleton} aria-hidden="true"><span /><span /><span /></div> : empty ? <div className={styles.empty}>
      <span className="empty-symbol"><Icon name="clock" size={20} /></span>
      <h3>{range === 'all' ? '还没有可统计的模型调用' : '这段时间没有模型调用'}</h3>
      <p>{range === 'all' ? '使用受管理的 CLI 后，本机记录会自动出现在这里。' : '换个时间范围看看，或者确认相关 CLI 已在“设置”里被管理。'}</p>
      <div>{range !== '7' && <button type="button" onClick={() => setRange('7')}>查看近 7 天</button>}{range !== 'all' && <button type="button" onClick={() => setRange('all')}>查看全部</button>}</div>
    </div> : totals && <>
      <section className={styles.summary} aria-label="用量概览">
        <div className={styles.primary}>
          <small>总 Token</small>
          <strong title={`${totals.total.toLocaleString()} token`}>{formatTokens(totals.total)}</strong>
          <Delta current={totals.total} previous={previous?.totals.total} label={compare} title={compareTitle} />
        </div>
        <div className={styles.metric}>
          <small>估算费用</small>
          <strong title={exactMoney(totals.cost, report.currency)} data-unpriced={totals.cost === null || undefined}>{formatMoney(totals.cost, report.currency)}</strong>
          {totals.unpricedTokens > 0
            ? <button type="button" className={styles.metricNote} onClick={() => openPrice()}>{formatPercent(1 - pricedShare)} token 未定价</button>
            : <Delta current={totals.cost} previous={previous?.totals.cost ?? (previous ? 0 : undefined)} label={compare} title={compareTitle} />}
        </div>
        <div className={styles.metric}>
          <small>模型调用</small>
          <strong>{totals.requests.toLocaleString()}</strong>
          <span className={styles.metricNote}>{totals.sessions} 个会话 · 每次约 {formatTokens(totals.total / Math.max(1, totals.requests))}</span>
        </div>
        <div className={styles.metric}>
          <small>缓存命中</small>
          <strong title="提示词 token 中从缓存读取的比例">{formatPercent(cacheHitRate(totals))}</strong>
          <span className={styles.metricNote}>新输入 {formatTokens(totals.input)} · 输出 {formatTokens(totals.output)}</span>
        </div>
        <Composition totals={totals} />
      </section>

      <section className={styles.card} aria-labelledby="usage-trend-title">
        <header className={styles.cardHead}>
          <h3 id="usage-trend-title">用量趋势<small>{{ hour: '按小时', day: '按天', month: '按月' }[report.bucket]}</small></h3>
          <p className={styles.trendStats}>
            {peak && <span>峰值 <b>{bucketLabel(peak, report.bucket, true)}</b> {formatTokens(peak.totals.total)}</span>}
            {timedBuckets.length > 1 && <span>平均每{multiDay ? (report.bucket === 'month' ? '月' : '天') : '小时'} <b>{formatTokens(average)}</b></span>}
          </p>
          {totals.cost !== null && <div className={styles.miniTabs} role="tablist" aria-label="趋势指标">
            <button type="button" role="tab" aria-selected={metric === 'tokens'} onClick={() => setMetric('tokens')}>Token</button>
            <button type="button" role="tab" aria-selected={metric === 'cost'} onClick={() => setMetric('cost')}>费用</button>
          </div>}
        </header>
        <TrendChart report={report} metric={shownMetric} now={now} />
        {shownMetric === 'tokens' && <ul className={styles.legend} aria-hidden="true">{tokenParts.map((part) => <li key={part.key}><i data-key={part.key} />{part.label}</li>)}</ul>}
      </section>

      <div className={styles.split}>
        <Breakdown report={report} toolName={toolName} filter={{ toolId, model, projectId }}
          onFilter={(next) => { if (next.toolId !== undefined) setToolId(next.toolId); if (next.model !== undefined) setModel(next.model); if (next.projectId !== undefined) setProjectId(next.projectId); }}
          onPrice={openPrice} />
        <section className={styles.card} aria-labelledby="usage-sessions-title">
          <header className={styles.cardHead}><h3 id="usage-sessions-title">消耗最多的会话</h3></header>
          <ol className={styles.sessions} aria-label="消耗最多的会话">
            {report.topSessions.map((item) => <li key={item.id}><button type="button" onClick={() => onOpenSession(item.id)} title="在会话中查看">
              <ToolIcon toolId={item.toolId} size={20} />
              <span className={styles.rankName}><strong title={item.title}>{item.title}</strong><small>{toolName(item.toolId)}{item.model ? ` · ${item.model}` : ''} · {shortDate(item.updatedAt)}</small></span>
              <span className={styles.rankValue} title={`${item.totals.total.toLocaleString()} token`}><strong>{formatTokens(item.totals.total)}</strong><small>{formatMoney(item.totals.cost, report.currency)}</small></span>
            </button></li>)}
          </ol>
        </section>
      </div>
    </>}

    {report && <details className={styles.notes}>
      <summary>统计口径与数据来源</summary>
      <ul>
        <li><b>总 Token</b> = 新输入 + 缓存读取 + 缓存写入 + 输出。各 CLI 日志口径不同（有的把缓存算进输入），这里已统一拆开，不会重复计算。</li>
        <li><b>时间</b>按每次模型调用实际发生的时刻归入时段；跨天的长会话会分摊到各自的日期，而不是全部算到最后活跃的那天。</li>
        {report.duplicateRequests > 0 && <li>已合并 {report.duplicateRequests.toLocaleString()} 次在恢复或分叉会话里重复出现的同一调用。</li>}
        {report.untimedRequests > 0 && <li>{report.untimedRequests.toLocaleString()} 次调用的原始记录缺少时间，未计入所选时间范围。</li>}
        {(report.partialSessions > 0 || report.staleSessions > 0) && <li>{report.partialSessions ? `${report.partialSessions} 个会话的原始记录不完整` : ''}{report.partialSessions && report.staleSessions ? '，' : ''}{report.staleSessions ? `${report.staleSessions} 个会话的源文件最近读取失败` : ''}；它们只计入已读取到的部分。</li>}
        <li><b>费用</b>为估算，不等于账单：优先使用你设置的价格，其次使用内置公开价；未定价模型的 token 不计入费用。{report.mixedCurrency ? `部分价格不是 ${report.currency}，未合并计入。` : ''}</li>
        {report.latestEventAt && <li>本机记录里最近一次调用：{new Date(report.latestEventAt).toLocaleString()}。</li>}
        {!!report.scans.length && <li>已索引 {report.scans.reduce((sum, item) => sum + item.sourceCount, 0).toLocaleString()} 个会话源{report.scans.some((item) => item.failedCount) ? `，其中 ${report.scans.reduce((sum, item) => sum + item.failedCount, 0)} 个读取失败` : ''}。</li>}
      </ul>
      {!!report.priceSources.length && <div className={styles.chips}><b>本次使用的价格</b>{report.priceSources.map((source) => <span className="quiet-chip" key={source}>{source}</span>)}</div>}
      {!!prices.length && <div className={styles.chips}><b>已保存的价格</b>{prices.map((price) => <button type="button" className="quiet-chip" key={`${price.toolId}:${price.model}`} onClick={() => openPrice(price.toolId, price.model)} title={`输入 ${price.inputPerMillion} · 输出 ${price.outputPerMillion} · 缓存读 ${price.cacheReadPerMillion} · 缓存写 ${price.cacheWritePerMillion}（${price.currency} / 每 100 万 token）`}>{toolName(price.toolId)} / {price.model}</button>)}</div>}
    </details>}

    <GuideDialog open={priceOpen} title="设置估算价格" hint="价格按每 100 万 token 填写，仅用于本机估算。" onClose={() => { setPriceOpen(false); setPriceError(''); }}>
      <div className={styles.priceForm}>
        <label>工具<FilterSelect label="价格工具" value={priceTool} options={[{ value: '', label: '选择工具' }, ...toolOptions(tools)]} searchLabel="搜索工具" onChange={setPriceTool} /></label>
        <label>模型<input aria-label="价格模型" list="priced-models" value={priceModel} onChange={(event) => setPriceModel(event.target.value)} /><datalist id="priced-models">{[...new Set([...(report?.models ?? []), ...prices.filter((item) => item.toolId === priceTool).map((item) => item.model)])].map((value) => <option key={value} value={value} />)}</datalist></label>
        <label>币种<input aria-label="价格币种" value={priceDraft.currency} onChange={(event) => setPriceDraft({ ...priceDraft, currency: event.target.value })} /></label>
        <label>输入<input aria-label="输入单价" type="number" min="0" value={priceDraft.input} onChange={(event) => setPriceDraft({ ...priceDraft, input: event.target.value })} /></label>
        <label>输出<input aria-label="输出单价" type="number" min="0" value={priceDraft.output} onChange={(event) => setPriceDraft({ ...priceDraft, output: event.target.value })} /></label>
        <label>缓存读取<input aria-label="缓存读取单价" type="number" min="0" value={priceDraft.read} onChange={(event) => setPriceDraft({ ...priceDraft, read: event.target.value })} /></label>
        <label>缓存写入<input aria-label="缓存写入单价" type="number" min="0" value={priceDraft.write} onChange={(event) => setPriceDraft({ ...priceDraft, write: event.target.value })} /></label>
        <label>来源<input aria-label="价格来源" value={priceDraft.source} onChange={(event) => setPriceDraft({ ...priceDraft, source: event.target.value })} placeholder="官方价格页或手动设置" /></label>
        {priceError && <p className={styles.error} role="alert">{priceError}</p>}
        <div className="dialog-footer"><button type="button" className={styles.primaryButton} data-dialog-save onClick={() => void savePrice()}>保存价格</button></div>
      </div>
    </GuideDialog>
  </div>;
}
