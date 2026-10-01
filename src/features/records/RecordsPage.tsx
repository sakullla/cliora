import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { native, nativeAvailable } from '../../lib/native';
import type { AdapterDescriptor } from '../../types/native';
import type { Project } from '../../types/launch';
import type { HistoryDetail, HistoryFilter, HistoryPrice, HistorySession, ScanStatus, UsageSummary } from '../../types/history';
import { displayPath } from '../../lib/paths';
import { ToolIcon } from '../../components/ToolIcon';
import styles from './RecordsPage.module.css';

const day = (ms: number | null) => ms === null ? '时间未知' : new Date(ms).toLocaleString();
const compactFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const compact = (value: number | null) => value === null ? '未知' : value < 1000 ? value.toLocaleString() : compactFormat.format(value);
function Metric({ label, value }: { label: string; value: number | null }) {
  return <div><small>{label}</small><strong title={value === null ? undefined : value.toLocaleString()}>{compact(value)}</strong>{value !== null && value >= 1000 && <span>{value.toLocaleString()}</span>}</div>;
}
function Amount({ value }: { value: number | null }) {
  return <span title={value === null || value < 1000 ? undefined : value.toLocaleString()}>{compact(value)}</span>;
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

export function RecordsPage({ active, tools, onOpenProjects }: { active: boolean; tools: AdapterDescriptor[]; onOpenProjects: () => void }) {
  const [tab, setTab] = useState<'sessions' | 'usage'>('sessions');
  const [search, setSearch] = useState('');
  const [toolId, setToolId] = useState('');
  const [model, setModel] = useState('');
  const [projectId, setProjectId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [scans, setScans] = useState<ScanStatus[]>([]);
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [prices, setPrices] = useState<HistoryPrice[]>([]);
  const [priceOpen, setPriceOpen] = useState(false);
  const [priceTool, setPriceTool] = useState('');
  const [priceModel, setPriceModel] = useState('');
  const [priceDraft, setPriceDraft] = useState({ currency: 'USD', input: '', output: '', read: '', write: '', source: '' });
  const [mode, setMode] = useState<'normal' | 'yolo'>('normal');
  const [resumeCommand, setResumeCommand] = useState<{ key: string; text: string } | null>(null);
  const [resumeError, setResumeError] = useState<{ key: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [filterLoading, setFilterLoading] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ running: boolean; toolId: string; completedSources: number; totalSources: number } | null>(null);
  const scanRequest = useRef(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const protectSave = useRef(false);
  function showError(value: unknown) {
    protectSave.current = false;
    setNotice('');
    setError(typeof value === 'string' ? value : errorText(value));
  }
  function showReadError(value: unknown) {
    if (!protectSave.current) setNotice('');
    setError(typeof value === 'string' ? value : formatFailure(value, '使用记录读取失败', recordNext));
  }
  function showNotice(text: string, protect = false) {
    setError('');
    setNotice(text);
    protectSave.current = protect;
  }
  const initialized = useRef(false);
  const request = useRef(0);
  const detailRequest = useRef(0);
  const filter = useMemo<HistoryFilter>(() => ({
    toolId: toolId || null, model: model.trim() || null, projectId: projectId || null,
    search: search.trim() || null, fromMs: fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : null,
    toMs: toDate ? (() => { const next = new Date(`${toDate}T00:00:00`); next.setDate(next.getDate() + 1); return next.getTime(); })() : null,
    favoriteOnly,
  }), [toolId, model, projectId, search, fromDate, toDate, favoriteOnly]);

  const filterRef = useRef(filter); filterRef.current = filter;
  const load = useCallback(async (current: HistoryFilter) => {
    if (!nativeAvailable) return false;
    const sequence = ++request.current;
    const key = JSON.stringify(current); setFilterLoading(true);
    try {
      const [items, summary] = await Promise.all([native.listHistorySessions(current), native.getHistoryUsage(current)]);
      if (sequence !== request.current || key !== JSON.stringify(filterRef.current)) return false;
      setSessions(items); setUsage(summary); setScans(summary.scans); setError('');
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
    void refresh();
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
  const partialTotals = (usage?.usageSessions ?? 0) > 0 && (usage?.unknownUsageSessions ?? 0) > 0;
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
  async function refresh() {
    if (!nativeAvailable || scanning) return;
    const sequence = ++scanRequest.current; setScanning(true); protectSave.current = false; setNotice(''); setError('');
    try {
      const reports = await native.refreshHistory();
      if (sequence !== scanRequest.current) return;
      setScans(reports);
      const loaded = await load(filterRef.current);
      if (sequence !== scanRequest.current || !loaded) return;
      showNotice('已刷新本机记录。');
    } catch (value) { if (sequence === scanRequest.current) showError(value); }
    finally { if (sequence === scanRequest.current) { setScanning(false); setScanProgress(null); } }
  }
  async function cancelScan() {
    scanRequest.current++; setScanning(false); setScanProgress(null); protectSave.current = false; setNotice(''); setError('');
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
    protectSave.current = false; setNotice(''); setError('');
    try { await navigator.clipboard.writeText(readyCommand); showNotice('已复制原生恢复命令，粘贴后由终端执行。'); }
    catch { showError('复制失败，恢复命令仍在页面上，可以手动选择。'); }
  }

  async function resume() {
    if (!selected || !readyCommand) return;
    setBusy(true); protectSave.current = false; setNotice(''); setError('');
    try { await native.resumeHistorySession(selected.session.id, mode); showNotice('已请求外部终端恢复会话。'); }
    catch (value) { showError(value); }
    finally { setBusy(false); }
  }

  async function exportSession(format: 'markdown' | 'json') {
    if (!selected) return;
    try {
      const destination = await save({ title: '导出会话资料', defaultPath: `cliora-session-${selected.session.nativeId ?? selected.session.id.slice(0, 8)}.${format === 'json' ? 'json' : 'md'}`,
        filters: [{ name: format === 'json' ? 'JSON' : 'Markdown', extensions: [format === 'json' ? 'json' : 'md'] }] });
      if (!destination) return;
      protectSave.current = false; setNotice(''); setError('');
      const path = await native.exportHistorySession(selected.session.id, format, destination);
      showNotice(`已导出到 ${path}`);
    } catch (value) { showError(value); }
  }

  async function savePrice() {
    const chosenTool = priceTool;
    const chosenModel = priceModel.trim();
    if (!chosenTool || !chosenModel) { showError('先选择工具和模型，再填写价格。'); return; }
    if (![priceDraft.input, priceDraft.output, priceDraft.read, priceDraft.write].every((value) => value.trim() !== '')) {
      showError('请填写四项单价；确认为免费的项目可填 0。'); return;
    }
    protectSave.current = false; setNotice(''); setError('');
    try {
      const price = await native.saveHistoryPrice({ toolId: chosenTool, model: chosenModel, currency: priceDraft.currency.trim().toUpperCase(),
        inputPerMillion: Number(priceDraft.input), outputPerMillion: Number(priceDraft.output),
        cacheReadPerMillion: Number(priceDraft.read), cacheWritePerMillion: Number(priceDraft.write),
        source: priceDraft.source.trim(), updatedAt: 0 });
      setPrices((old) => [...old.filter((item) => item.toolId !== price.toolId || item.model !== price.model), price]);
      setPriceOpen(false); showNotice('估算价格已保存；只影响本机统计。', true);
      try { setUsage(await native.getHistoryUsage(filter)); }
      catch (value) { showReadError(value); }
    } catch (value) { showError(value); }
  }

  if (!nativeAvailable) return <div className={styles.empty}><h2>本机使用记录</h2><p>在桌面应用中读取原生 CLI 会话。浏览器预览不展示本机历史。</p></div>;
  return <section className={styles.page} aria-label="使用记录内容">
    <div className={styles.toolbar}><div className={styles.tabs} role="tablist" aria-label="使用记录类型">
      <button type="button" role="tab" aria-selected={tab === 'sessions'} onClick={() => setTab('sessions')}>会话</button>
      <button type="button" role="tab" aria-selected={tab === 'usage'} onClick={() => setTab('usage')}>用量</button>
    </div><button type="button" className={styles.refresh} disabled={scanning} onClick={() => void refresh()}>刷新本机记录</button></div>
    {(scanning || filterLoading) && <p className={styles.caveat} role="status">{scanning ? `后台扫描 ${tools.find(item => item.id === scanProgress?.toolId)?.name ?? scanProgress?.toolId ?? ''} ${scanProgress?.totalSources ? `${scanProgress.completedSources} / ${scanProgress.totalSources}` : '正在发现文件'}` : '正在筛选已缓存记录…'}{scanning && <span className={styles.progress} aria-hidden="true"><span style={scanProgress?.totalSources ? { width: `${Math.min(100, (scanProgress.completedSources / scanProgress.totalSources) * 100)}%` } : undefined} data-indeterminate={!scanProgress?.totalSources || undefined} /></span>}{scanning && <button type="button" onClick={() => void cancelScan()}>停止扫描</button>}</p>}
    <div className={styles.filters}>
      {tab === 'sessions' && <label className={styles.search}>搜索<input aria-label="搜索会话" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="标题或正文" /></label>}
      <label>工具<select aria-label="筛选工具" value={toolId} onChange={(event) => setToolId(event.target.value)}><option value="">全部工具</option>{tools.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      {tab === 'sessions' && <label className={styles.favorite}><input type="checkbox" checked={favoriteOnly} onChange={(event) => setFavoriteOnly(event.target.checked)} />只看收藏</label>}
    </div>
    <details className={styles.moreFilters}><summary>更多筛选{[projectId, model, fromDate, toDate].filter(Boolean).length ? ` · ${[projectId, model, fromDate, toDate].filter(Boolean).length} 项已启用` : ''}</summary><div className={styles.filters}>
      <label>项目<select aria-label="筛选项目" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">全部项目</option><option value="__unknown__">未归类</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>模型<select aria-label="筛选模型" value={model} onChange={(event) => setModel(event.target.value)}><option value="">全部模型</option><option value="__unknown__">模型未知</option>{(usage?.models ?? []).map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>从<input aria-label="开始日期" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>
      <label>到<input aria-label="结束日期" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label>
<button type="button" onClick={() => { setProjectId(''); setModel(''); setFromDate(''); setToDate(''); }}>清除更多筛选</button></div></details>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    {!!scans.length && <details className={styles.coverage}><summary>本机覆盖 · {scans.reduce((total, item) => total + item.sourceCount, 0)} 个来源{scans.some((item) => item.failedCount || item.incomplete) ? ' · 有失败或扫描不完整' : ''}</summary>{scans.map((item) => <span key={item.toolId}>{item.toolId} {item.sourceCount} 个来源{item.failedCount ? ` · ${item.failedCount} 个失败` : ''}{item.incomplete ? ' · 扫描不完整' : ''}</span>)}</details>}
    {tab === 'sessions' ? <div className={styles.columns}>
      <div className={styles.list} aria-label="会话列表">{sessions.length ? sessions.map((item) => <button type="button" key={item.id} className={selectedId === item.id ? styles.selected : ''} onClick={() => setSelectedId(item.id)}>
        <span className={styles.sessionTitle}><ToolIcon toolId={item.toolId} size={22} /><strong title={item.title}>{item.favorite ? '★ ' : ''}{item.title}</strong></span><small>{tools.find((tool) => tool.id === item.toolId)?.name ?? item.toolId} · {day(item.updatedAt)}</small>
        <small>{item.model ?? '模型未知'}{item.partial ? ' · 部分记录' : ''}{item.stale ? ' · 源暂不可读' : ''}</small>
      </button>) : <div className={styles.empty}>没有符合条件的会话。可刷新记录或调整筛选。</div>}</div>
      <div className={styles.detail}>{selected ? <>
        <div className={styles.detailHead}><div><small className={styles.detailIdentity}><ToolIcon toolId={selected.session.toolId} size={22} />{tools.find((tool) => tool.id === selected.session.toolId)?.name ?? selected.session.toolId} · {day(selected.session.updatedAt)}</small><h2 title={selected.session.title}>{selected.session.title}</h2><p>{selected.session.cwd ? displayPath(selected.session.cwd) : '项目目录未知'} · {selected.session.model ?? '模型未知'}</p></div><button type="button" onClick={() => void favorite()} aria-label={selected.session.favorite ? '取消收藏' : '收藏会话'}>{selected.session.favorite ? '★ 已收藏' : '☆ 收藏'}</button></div>
        {(selected.session.partial || selected.session.stale) && <p className={styles.caveat}>原始记录不完整或最近读取失败；仅展示已索引的内容。</p>}
        <div className={styles.resume}><div className={styles.detailHead}><strong>继续会话</strong><select aria-label="恢复模式" value={mode} onChange={(event) => setMode(event.target.value as 'normal' | 'yolo')}><option value="normal">普通模式</option>{yolo && <option value="yolo">YOLO 模式</option>}</select></div>
          {readyCommand ? <><pre aria-label="原生恢复命令">{readyCommand}</pre><div className={styles.actions}><button type="button" onClick={() => void copy()}>复制命令</button><button type="button" className={styles.primary} disabled={busy} onClick={() => void resume()}>在外部终端继续</button></div></> : <p>{shownResumeError || '正在确认原生恢复命令…'}</p>}
          <details className={styles.moreActions}><summary>导出与项目关联</summary><div className={styles.actions}><button type="button" onClick={() => void exportSession('markdown')}>导出 Markdown</button><button type="button" onClick={() => void exportSession('json')}>导出 JSON</button></div><label className={styles.projectLink}>关联项目<select aria-label="关联会话项目" value={selected.session.projectId ?? ''} onChange={(event) => void assignProject(event.target.value)}><option value="">使用原会话目录</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}{item.available ? '' : ' · 目录失效'}</option>)}</select></label></details>
          {selected.resumeReason && <button type="button" onClick={onOpenProjects}>前往最近项目重新关联目录</button>}
        </div>
        <div className={styles.messages}>{selected.messages.length ? selected.messages.map((item) => <article key={item.id} data-role={item.role}><small>{item.role === 'user' ? '你' : '助手'} · {day(item.timestamp)}</small><p>{item.text}</p></article>) : <p>此记录没有可读取的对话正文。</p>}</div>
      </> : <div className={styles.empty}>选择左侧会话查看详情。</div>}</div>
    </div> : <div className={styles.usage}>
      <div className={styles.metrics}><div><small>会话</small><strong>{usage?.sessionCount ?? '—'}</strong></div><Metric label={`输入 token${partialTotals ? ' · 已知小计' : ''}`} value={usage?.input ?? null} /><Metric label={`输出 token${partialTotals ? ' · 已知小计' : ''}`} value={usage?.output ?? null} /><Metric label={`缓存读取${partialTotals ? ' · 已知小计' : ''}`} value={usage?.cacheRead ?? null} /><Metric label={`缓存写入${partialTotals ? ' · 已知小计' : ''}`} value={usage?.cacheWrite ?? null} /><div><small>估算费用</small><strong>{usage?.estimatedCost === null || usage?.estimatedCost === undefined ? '未知' : `${usage.currency ?? ''} ${usage.estimatedCost.toFixed(4)}`}</strong></div></div>
      <p className={styles.caveat}>仅统计本机可读取的记录；{usage?.usageSessions ?? 0} 个会话有用量，{usage?.unknownUsageSessions ?? 0} 个未知，{usage?.partialSessions ?? 0} 个不完整，{usage?.staleSessions ?? 0} 个源暂不可读。{partialTotals ? '显示的是已知小计，实际总量未知。' : ''}费用为估算，不等于账单。</p>
      <p className={styles.caveat}>输入与缓存按原生口径分别展示；{usage?.inputIncludesCache === true ? '当前输入值包含缓存 token，不应再叠加缓存。' : usage?.inputIncludesCache === false ? '当前输入值不包含单列的缓存 token。' : '当前记录口径混合或未知，请勿自行相加。'}</p>
      {!!usage?.priceSources.length && <div className={styles.priceSources}><strong>价格依据</strong>{usage.priceSources.map((source) => <span key={source}>{source}</span>)}</div>}
      {!!usage?.byModel?.length && <div className={styles.modelTable}><table aria-label="按模型用量明细"><thead><tr><th>工具 / 模型</th><th>会话</th><th>输入</th><th>输出</th><th>缓存读 / 写</th><th>估算费用</th></tr></thead><tbody>{usage.byModel.map(row => <tr key={JSON.stringify([row.toolId, row.model])}><td><button type="button" onClick={() => { setPriceTool(row.toolId); setPriceModel(row.model ?? ''); setPriceOpen(true); }}>{tools.find(item => item.id === row.toolId)?.name ?? row.toolId}<br /><strong>{row.model ?? '模型未知'}</strong></button></td><td>{row.sessionCount}{row.unknownUsageSessions ? ` · ${row.unknownUsageSessions} 用量未知` : ''}</td><td><Amount value={row.input} /></td><td><Amount value={row.output} /></td><td><Amount value={row.cacheRead} /> / <Amount value={row.cacheWrite} /></td><td>{row.estimatedCost === null ? '未知' : `${row.currency ?? ''} ${row.estimatedCost.toFixed(4)}`}</td></tr>)}</tbody></table></div>}
      <button type="button" onClick={() => setPriceOpen((old) => !old)}>{priceOpen ? '收起价格设置' : '设置估算价格'}</button>
      {priceOpen && <div className={styles.priceForm}><p>请选择此价格对应的工具与模型。价格按每 100 万 token 填写，仅用于本机估算。</p>
        <label>工具<select aria-label="价格工具" value={priceTool} onChange={event => setPriceTool(event.target.value)}><option value="">选择工具</option>{tools.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>模型<input aria-label="价格模型" list="priced-models" value={priceModel} onChange={event => setPriceModel(event.target.value)} /><datalist id="priced-models">{[...new Set([...(usage?.models ?? []), ...prices.filter(item => item.toolId === priceTool).map(item => item.model)])].map(value => <option key={value} value={value} />)}</datalist></label>
        <label>币种<input aria-label="价格币种" value={priceDraft.currency} onChange={(event) => setPriceDraft({ ...priceDraft, currency: event.target.value })} /></label>
        <label>输入<input aria-label="输入单价" type="number" min="0" value={priceDraft.input} onChange={(event) => setPriceDraft({ ...priceDraft, input: event.target.value })} /></label>
        <label>输出<input aria-label="输出单价" type="number" min="0" value={priceDraft.output} onChange={(event) => setPriceDraft({ ...priceDraft, output: event.target.value })} /></label>
        <label>缓存读取<input aria-label="缓存读取单价" type="number" min="0" value={priceDraft.read} onChange={(event) => setPriceDraft({ ...priceDraft, read: event.target.value })} /></label>
        <label>缓存写入<input aria-label="缓存写入单价" type="number" min="0" value={priceDraft.write} onChange={(event) => setPriceDraft({ ...priceDraft, write: event.target.value })} /></label>
        <label>来源<input aria-label="价格来源" value={priceDraft.source} onChange={(event) => setPriceDraft({ ...priceDraft, source: event.target.value })} placeholder="官方价格页或手动设置" /></label>
        <button type="button" className={styles.primary} onClick={() => void savePrice()}>保存价格</button>
      </div>}
      {!!prices.length && <div className={styles.savedPrices}><strong>已保存的价格</strong>{prices.map((price) => <p key={`${price.toolId}:${price.model}`}>{price.toolId} / {price.model} · {price.currency} · {price.source} · {day(price.updatedAt)}</p>)}</div>}
    </div>}
  </section>;
}
