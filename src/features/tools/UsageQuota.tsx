import { useCallback, useEffect, useRef, useState } from 'react';
import { native, nativeAvailable } from '../../lib/native';
import type { CredentialDraft, DraftTestReport, QueryConfig, UsageCache, UsagePreset, UsageQuery, UsageQueryDraft, UsageResult } from '../../types/usage';
import { GuideDialog } from '../../components/GuideDialog';
import { CodeEditor } from '../../components/CodeEditor';
import { usageAmount, usagePercent, usageReset, usageUnit } from './usageDisplay';
import styles from './UsageQuota.module.css';

function message(e: unknown): string { return e && typeof e === 'object' && 'message' in e ? String(e.message) : '额度服务暂不可用'; }
const date = (value: string) => new Date(value).toLocaleString('zh-CN');
export function useUsageQuota(active: boolean) {
  const [queries, setQueries] = useState<UsageQuery[]>([]);
  const [cache, setCache] = useState<UsageCache[]>([]);
  const [presets, setPresets] = useState<UsagePreset[]>([]);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    if (!nativeAvailable || !active) return;
    const current = ++sequence.current;
    try {
      const [q, c, p] = await Promise.all([native.listUsageQueries(), native.listUsageCache(), native.usagePresets()]);
      if (current !== sequence.current) return;
      setQueries(q ?? []); setCache(c ?? []); setPresets(p ?? []); setError('');
    } catch (e) { if (current === sequence.current) setError(message(e)); }
  }, [active]);
  useEffect(() => { void reload(); const timer = setInterval(() => void reload(), 3000); return () => { clearInterval(timer); sequence.current++; }; }, [reload]);
  return { queries, cache, presets, error, reload };
}
type QuotaState = ReturnType<typeof useUsageQuota>;
export function UsageMetrics({ result, now = Date.now() }: { result: UsageResult; now?: number }) {
  return <div className={styles.metrics}>{result.metrics.map(metric => {
    const percent = usagePercent(metric);
    return <div className={styles.metric} key={metric.id}>
      <div className={styles.heading}><strong>{metric.label}</strong><span>{metric.unlimited ? '无限额' : percent === null ? '比例未知' : `${usageAmount(percent)}% 已用`}</span></div>
      {percent !== null && <progress aria-label={`${metric.label}已用比例`} max={100} value={Math.min(100, Math.max(0, percent))} />}
      <small>{({ account: '账户', plan: '套餐', key: 'Key', extra: '额外资源' })[metric.subject]} · 单位：{usageUnit(metric)}</small>
      <div className={styles.values}>{metric.used !== null && <span>已用 {usageAmount(metric.used)} {usageUnit(metric)}</span>}{metric.remaining !== null && <span>剩余 {usageAmount(metric.remaining)} {usageUnit(metric)}</span>}{metric.total !== null && <span>总量 {usageAmount(metric.total)} {usageUnit(metric)}</span>}</div>
      {metric.missingReason && <small>{metric.missingReason}</small>}
      {metric.window && <small>{metric.window.durationSeconds ? `${usageAmount(metric.window.durationSeconds / 3600)} 小时窗口 · ` : ''}{usageReset(metric, now)}</small>}
      {metric.expiresAt && <small>有效期至 {date(metric.expiresAt)}</small>}{metric.neverExpires && <small>永不过期</small>}
    </div>;
  })}{result.errors.map((e, i) => <p className={styles.error} key={i}>{e.message}</p>)}</div>;
}
export function ProfileQuota({ profileId, state }: { profileId: string; state: QuotaState }) {
  const [editing, setEditing] = useState<UsageQuery | 'new' | null>(null);
  const [error, setError] = useState('');
  const queries = state.queries.filter(q => q.config.identity.profileId === profileId);
  async function refresh(q: UsageQuery, cancel = false) {
    try { setError(''); await (cancel ? native.cancelUsageRefresh(q.id) : native.refreshUsageQuery(q.id)); await state.reload(); } catch (e) { setError(message(e)); }
  }
  return <section className={styles.quota} aria-label="套餐额度">
    <div className={styles.heading}><span>套餐额度</span><button type="button" disabled={!nativeAvailable} onClick={() => setEditing('new')}>添加额度查询</button></div>
    {!nativeAvailable && <small>桌面服务不可用，无法保存或查询额度。</small>}
    {(error || state.error) && <p role="alert" className={styles.error}>{error || state.error}</p>}
    {queries.map(q => {
      const cache = state.cache.find(c => c.queryId === q.id && c.generation === q.generation);
      const now = Date.now();
      const snapshot = cache?.success;
      const stale = snapshot && (!!cache?.errors.length || now - Date.parse(snapshot.measuredAt!) > Math.max(300, q.config.refreshIntervalSeconds * 2) * 1000);
      const cooldown = Math.max(0, (cache?.nextAllowedAt ?? 0) - Math.floor(now / 1000));
      return <div className={styles.query} key={q.id}>
        <div className={styles.heading}><strong>{q.config.label}</strong><div className={styles.actions}><button type="button" onClick={() => void refresh(q)} disabled={!q.config.enabled || cache?.refreshing || cooldown > 0}>{cache?.refreshing ? '刷新中' : cooldown > 0 ? `${cooldown} 秒后可刷新` : '刷新额度'}</button>{cache?.refreshing && <button type="button" onClick={() => void refresh(q, true)}>停止刷新</button>}<button type="button" onClick={() => setEditing(q)}>额度设置</button></div></div>
        <small>{!q.config.enabled ? '已停用' : q.config.refreshIntervalSeconds ? `每 ${q.config.refreshIntervalSeconds / 60} 分钟自动刷新` : '手动刷新'}{cache?.authPaused && ' · 认证失效，自动刷新已暂停'}</small>
        {snapshot ? <><UsageMetrics result={snapshot.result} now={now} /><details><summary>数据来源</summary><p>{q.config.site} · {snapshot.source}</p></details><small>最近成功：{date(snapshot.measuredAt!)}{stale && ' · 数据已过期'}</small></> : <small>尚无成功查询数据</small>}
        {!!cache?.errors.length && <p className={styles.error}>{cache.errors.map(e => e.message).join('；')}</p>}
        {cache?.attemptedAt && <small>最近尝试：{date(cache.attemptedAt)}</small>}
      </div>;
    })}
    {editing && <QuotaEditor key={typeof editing === 'string' ? 'new' : editing.id} profileId={profileId} query={editing === 'new' ? null : editing} presets={state.presets} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void state.reload(); }} />}
  </section>;
}
function fromQuery(query: UsageQuery): UsageQueryDraft {
  return { id: query.id, expectedVersion: query.version, config: structuredClone(query.config), credentials: query.credentials.map(c => ({ name: c.name, allowedOrigins: [...c.allowedOrigins], value: { kind: 'keep' } })) };
}
function fromPreset(p: UsagePreset, profileId: string): UsageQueryDraft {
  return { id: null, expectedVersion: null, config: { ...structuredClone(p.config), identity: { ...p.config.identity, profileId } }, credentials: p.credentials.map(c => ({ name: c.name, allowedOrigins: [...c.allowedOrigins], value: { kind: 'replace', secret: '' } })) };
}
function empty(profileId: string): UsageQueryDraft {
  return { id: null, expectedVersion: null, config: { schemaVersion: 1, label: '自定义查询', site: 'https://your-site.example', identity: { accountId: null, contextId: null, profileId, subject: 'account', subjectId: null }, program: { kind: 'javascript', source: 'async function query(ctx) {\n  // 使用 ctx.http 查询已声明的目标，返回 schemaVersion/status/metrics/errors。\n  throw new Error("请填写额度查询脚本");\n}' }, parameters: {}, targets: [{ origin: 'https://your-site.example', allowPrivateNetwork: false }], enabled: true, refreshIntervalSeconds: 0 }, credentials: [] };
}
export function QuotaEditor({ profileId, query, presets, onClose, onSaved }: { profileId: string; query: UsageQuery | null; presets: UsagePreset[]; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<UsageQueryDraft>(() => query ? fromQuery(query) : presets[0] ? fromPreset(presets[0], profileId) : empty(profileId));
  const [presetId, setPresetId] = useState(query ? '' : presets[0]?.id ?? 'custom');
  const [parameters, setParameters] = useState(() => JSON.stringify(draft.config.parameters, null, 2));
  const [error, setError] = useState('');
  const [report, setReport] = useState<DraftTestReport | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const revision = useRef(0);
  const mounted = useRef(true);
  const execution = useRef<string | null>(null);
  const preset = presets.find(p => p.id === presetId);
  const invalidate = () => {
    revision.current++; setReport(null); setTesting(false);
    if (execution.current) void native.cancelUsageTest(execution.current).catch(() => {});
    execution.current = null;
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++; if (execution.current) void native.cancelUsageTest(execution.current).catch(() => {}); }; }, []);
  function edit(next: UsageQueryDraft) { invalidate(); setError(''); setDraft(next); }
  function config(next: Partial<QueryConfig>) { edit({ ...draft, config: { ...draft.config, ...next } }); }
  function credential(index: number, next: Partial<CredentialDraft>) { edit({ ...draft, credentials: draft.credentials.map((c, i) => i === index ? { ...c, ...next } : c) }); }
  function materialize(): UsageQueryDraft {
    const parsed: unknown = JSON.parse(parameters);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('普通参数必须是 JSON 对象');
    return { ...draft, config: { ...draft.config, parameters: parsed as QueryConfig['parameters'] } };
  }
  async function test() {
    invalidate(); setError('');
    const rev = revision.current;
    let id: string | null = null;
    try {
      const current = materialize();
      setTesting(true);
      id = await native.createUsageTest();
      if (!mounted.current || rev !== revision.current) { await native.cancelUsageTest(id); return; }
      execution.current = id;
      const result = await native.testUsageQuery(id, rev, current);
      if (mounted.current && rev === revision.current && result.execution.executionId === id && result.execution.draftRevision === rev) setReport(result);
    } catch (e) { if (mounted.current && rev === revision.current) setError(message(e)); }
    finally { if (mounted.current && rev === revision.current) { setTesting(false); execution.current = null; } }
  }
  async function save() {
    invalidate(); setError('');
    try { const current = materialize(); setSaving(true); await native.saveUsageQuery(current); if (mounted.current) onSaved(); }
    catch (e) { if (mounted.current) setError(message(e)); }
    finally { if (mounted.current) setSaving(false); }
  }
  async function remove() {
    if (!query) return;
    invalidate(); setSaving(true); setError('');
    try { await native.deleteUsageQuery(query.id, query.version); if (mounted.current) onSaved(); }
    catch (e) { if (mounted.current) setError(message(e)); }
    finally { if (mounted.current) setSaving(false); }
  }
  async function copyScript() {
    const rev = revision.current;
    try { const source = await native.usageBuiltinScript(materialize().config); if (mounted.current && rev === revision.current) config({ program: { kind: 'javascript', source } }); }
    catch (e) { if (mounted.current && rev === revision.current) setError(message(e)); }
  }
  const line = report?.error?.scriptLine;
  return <GuideDialog open title="额度查询设置" hint="保存不会执行查询。测试当前草稿不会更新配置卡数据。" onClose={() => { if (!saving) { invalidate(); onClose(); } }}>
    <fieldset className={styles.editor} disabled={saving || !nativeAvailable}>
      <label>查询预设<select aria-label="查询预设" value={presetId} onChange={e => {
        const id = e.target.value; const p = presets.find(p => p.id === id); const next = p ? fromPreset(p, profileId) : empty(profileId);
        edit({ ...next, id: draft.id, expectedVersion: draft.expectedVersion }); setParameters(JSON.stringify(next.config.parameters, null, 2)); setPresetId(id);
      }}><option value="">已保存的查询</option>{presets.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}<option value="custom">自定义 JavaScript</option></select></label>
      {preset && <p>{preset.description}</p>}
      <label>查询名称<input aria-label="查询名称" value={draft.config.label} onChange={e => config({ label: e.target.value })} /></label>
      <label>站点地址<input aria-label="额度站点地址" value={draft.config.site} onChange={e => {
        const previous = draft.config.site, site = e.target.value;
        const next = { ...draft, config: { ...draft.config, site, targets: draft.config.targets.map(t => t.origin === previous ? { ...t, origin: site } : t) }, credentials: draft.credentials.map(c => ({ ...c, allowedOrigins: c.allowedOrigins.map(o => o === previous ? site : o) })) };
        try { const p = JSON.parse(parameters); if (p.site === previous) setParameters(JSON.stringify({ ...p, site }, null, 2)); } catch { /* Preserve invalid draft text. */ }
        edit(next);
      }} /></label>
      <label className={styles.check}><input type="checkbox" checked={draft.config.enabled} onChange={e => config({ enabled: e.target.checked })} />启用查询</label>
      <label>自动刷新<select aria-label="自动刷新" value={draft.config.refreshIntervalSeconds} onChange={e => config({ refreshIntervalSeconds: Number(e.target.value) })}><option value={0}>关闭，仅手动</option>{[60, 300, 900, 1800, 3600, ...(draft.config.refreshIntervalSeconds && ![60, 300, 900, 1800, 3600].includes(draft.config.refreshIntervalSeconds) ? [draft.config.refreshIntervalSeconds] : [])].map(n => <option key={n} value={n}>每 {n / 60} 分钟</option>)}</select></label>
      <details><summary>网络目标与统计对象</summary>
        {draft.config.targets.map((target, i) => <div className={styles.target} key={i}><label>允许的 origin<input aria-label={`允许目标 ${i + 1}`} value={target.origin} onChange={e => config({ targets: draft.config.targets.map((t, j) => i === j ? { ...t, origin: e.target.value } : t) })} /></label><label className={styles.check}><input type="checkbox" checked={target.allowPrivateNetwork} onChange={e => config({ targets: draft.config.targets.map((t, j) => i === j ? { ...t, allowPrivateNetwork: e.target.checked } : t) })} />允许此目标访问私网</label><button type="button" onClick={() => config({ targets: draft.config.targets.filter((_, j) => j !== i) })}>移除目标</button></div>)}
        <button type="button" onClick={() => config({ targets: [...draft.config.targets, { origin: '', allowPrivateNetwork: false }] })}>添加目标</button>
        <label>统计对象<select value={draft.config.identity.subject} onChange={e => config({ identity: { ...draft.config.identity, subject: e.target.value as QueryConfig['identity']['subject'] } })}><option value="account">账户</option><option value="plan">套餐</option><option value="key">Key</option><option value="extra">额外资源</option></select></label>
        <label>对象标识（可选）<input value={draft.config.identity.subjectId ?? ''} onChange={e => config({ identity: { ...draft.config.identity, subjectId: e.target.value || null } })} /></label>
      </details>
      <section aria-label="查询凭据"><h3>查询凭据</h3>{draft.credentials.map((c, i) => <div className={styles.credential} key={i}>
        <label>凭据名称<input aria-label={`凭据名称 ${i + 1}`} value={c.name} onChange={e => credential(i, { name: e.target.value })} /></label>
        <small>{preset?.credentials.find(p => p.name === c.name)?.instructions}</small>
        <label>{c.value.kind === 'keep' ? '已保存，留空保留；更改认证目标需重新填写' : '凭据值'}<input type="password" autoComplete="new-password" aria-label={`凭据值 ${i + 1}`} value={c.value.kind === 'replace' ? c.value.secret : ''} onChange={e => credential(i, { value: e.target.value === '' && query?.credentials.some(saved => saved.name === c.name) ? { kind: 'keep' } : { kind: 'replace', secret: e.target.value } })} /></label>
        <label>此凭据允许发送到（每行一个 origin）<textarea aria-label={`凭据目标 ${i + 1}`} value={c.allowedOrigins.join('\n')} onChange={e => credential(i, { allowedOrigins: e.target.value.split('\n') })} /></label>
        <button type="button" onClick={() => edit({ ...draft, credentials: draft.credentials.filter((_, j) => j !== i) })}>移除凭据</button>
      </div>)}<button type="button" onClick={() => edit({ ...draft, credentials: [...draft.credentials, { name: `token_${draft.credentials.length + 1}`, allowedOrigins: [], value: { kind: 'replace', secret: '' } }] })}>添加凭据</button></section>
      <label>普通参数（JSON，不含秘密）</label><CodeEditor format="json" label="额度查询普通参数" value={parameters} onChange={v => { invalidate(); setParameters(v); }} readOnly={saving} compact />
      {draft.config.program.kind === 'builtin' ? <button type="button" onClick={() => void copyScript()}>复制为自定义脚本</button> : <><label>JavaScript · async query(ctx)</label><CodeEditor format="javascript" label="额度查询脚本" value={draft.config.program.source} onChange={source => config({ program: { kind: 'javascript', source } })} readOnly={saving} errorLine={line} /><small>ctx.parameters 为普通参数；ctx.credentials 为命名引用。使用 ctx.http 的 auth 绑定凭据，结果包含 schemaVersion、status、metrics、errors。</small></>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {report && <section aria-label="草稿测试结果"><p>阶段：{report.stage} · 耗时 {report.elapsedMs} ms · 仅草稿测试</p>{!!report.requestOrigins?.length && <p>请求目标（不含路径及参数）：{report.requestOrigins.join('、')}</p>}{report.error && <p role="alert" className={styles.error}>{report.error.message}{line && `（第 ${line} 行）`}</p>}{report.result && <UsageMetrics result={report.result} />}<details><summary>脱敏预览</summary><pre>{report.preview || '无返回数据'}</pre></details></section>}
      <div className={styles.actions}><button type="button" disabled={testing} onClick={() => void test()}>{testing ? '测试中' : '测试当前草稿'}</button>{testing && <button type="button" onClick={invalidate}>取消测试</button>}<button type="button" data-dialog-save onClick={() => void save()}>保存查询</button>{query && <button type="button" onClick={() => void remove()}>删除查询</button>}</div>
    </fieldset>
  </GuideDialog>;
}
