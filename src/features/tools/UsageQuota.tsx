import { uiAdapterFor } from '../../adapters';
import { usageMetricLabel } from '../../adapters/providers';
import { Icon } from '../../components/Icon';
import { useCallback, useEffect, useRef, useState } from 'react';
import { native, nativeAvailable } from '../../lib/native';
import type { AuthAccount } from '../../types/accounts';
import type { CredentialDraft, DraftTestReport, QueryConfig, UsageCache, UsageMetric, UsagePreset, UsageQuery, UsageQueryDraft, UsageResult, UsageSample } from '../../types/usage';
import { GuideDialog } from '../../components/GuideDialog';
import { CodeEditor } from '../../components/CodeEditor';
import { usageAmount, usagePercent, usageReset, usageUnit } from './usageDisplay';
import { BurnDown } from './UsageBurnDown';
import { saveShortcutHint } from '../../lib/shortcut';
import i18n from '../../i18n';
import { useTranslation } from 'react-i18next';
import styles from './UsageQuota.module.css';

function message(e: unknown): string { return e && typeof e === 'object' && 'message' in e ? String(e.message) : i18n.t('tools.quota.unavailable'); }
const dateLocale = () => i18n.language === 'en' ? 'en-US' : 'zh-CN';
const date = (value: string) => new Date(value).toLocaleString(dateLocale());
export function useUsageQuota(active: boolean) {
  const [queries, setQueries] = useState<UsageQuery[]>([]);
  const [cache, setCache] = useState<UsageCache[]>([]);
  const [presets, setPresets] = useState<UsagePreset[]>([]);
  const [samples, setSamples] = useState<Record<string, UsageSample[]>>({});
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const initialQueries = useRef(new Map<string, Promise<void>>());
  const reload = useCallback(async () => {
    if (!nativeAvailable || !active) return;
    const current = ++sequence.current;
    try {
      const [q, c, p] = await Promise.all([native.listUsageQueries(), native.listUsageCache(), native.usagePresets()]);
      // Sampling failures must not break the quota cards; keep the previous readings.
      const history = await Promise.all((q ?? []).map(async query => {
        try { return { id: query.id, samples: await native.listUsageSamples(query.id) ?? [] }; }
        catch { return { id: query.id, samples: null as UsageSample[] | null }; }
      }));
      if (current !== sequence.current) return;
      setQueries(q ?? []); setCache(c ?? []); setPresets(p ?? []); setError('');
      setSamples(previous => {
        const next: Record<string, UsageSample[]> = {};
        for (const entry of history) next[entry.id] = entry.samples ?? previous[entry.id] ?? [];
        return next;
      });
    } catch (e) { if (current === sequence.current) setError(message(e)); }
  }, [active]);
  useEffect(() => { void reload(); const timer = setInterval(() => void reload(), 3000); return () => { clearInterval(timer); sequence.current++; }; }, [reload]);
  const ensureProfile = useCallback((profileId: string, version: number) => {
    const key = `${profileId}:${version}`;
    const previous = initialQueries.current.get(key);
    if (previous) return previous;
    const task = (async () => {
      const query = await native.ensureProfileUsage(profileId, version);
      if (!query) return;
      await reload();
      const caches = await native.listUsageCache();
      const cached = caches?.find(item => item.queryId === query.id && item.generation === query.generation);
      // One initial lookup; subsequent views use the cache and configured refresh policy.
      if (query.config.enabled && !cached?.attemptedAt && !cached?.refreshing) {
        await native.refreshUsageQuery(query.id);
        await reload();
      }
    })();
    initialQueries.current.set(key, task);
    return task;
  }, [reload]);
  return { queries, cache, presets, samples, error, reload, ensureProfile };
}
type QuotaState = ReturnType<typeof useUsageQuota>;
function MetricSummary({ metric, label, now, samples }: { metric: UsageMetric; label: string; now: number; samples: UsageSample[] }) {
  const { t } = useTranslation();
  const percent = usagePercent(metric);
  const amount = metric.remaining !== null ? t('tools.quota.remaining', { amount: usageAmount(metric.remaining), unit: usageUnit(metric) }) : metric.used !== null ? t('tools.quota.used', { amount: usageAmount(metric.used), unit: usageUnit(metric) }) : metric.missingReason;
  return <div className={styles.summaryMetric} data-warning={percent !== null && percent >= 90 || metric.remaining !== null && metric.remaining < 0}>
    <div><span>{label}</span><strong>{metric.unlimited ? t('tools.quota.unlimited') : percent === null ? t('tools.quota.percentUnknown') : t('tools.quota.percentUsed', { percent: new Intl.NumberFormat(dateLocale(), { maximumFractionDigits: 1 }).format(percent) })}</strong></div>
    {percent !== null && <progress aria-label={t('tools.quota.percentAria', { label })} max={100} value={Math.min(100, Math.max(0, percent))} />}
    <small className={styles.metricMeta}>{(metric.unlimited || amount) && <span>{metric.unlimited ? (metric.neverExpires ? t('tools.quota.neverExpires') : t('tools.quota.noLimit')) : amount}</span>}{!metric.unlimited && metric.window && (metric.window.resetsAt || metric.window.recovery !== 'unknown') && <span>{usageReset(metric, now)}</span>}</small>
    <BurnDown metric={metric} label={label} samples={samples} now={now} />
  </div>;
}
export function UsageMetrics({ result, now = Date.now(), program }: { result: UsageResult; now?: number; program?: QueryConfig['program'] }) {
  const { t } = useTranslation();
  return <div className={styles.metrics}>{result.metrics.map(metric => {
    const percent = usagePercent(metric);
    const label = usageMetricLabel(program, metric);
    return <div className={styles.metric} key={metric.id}>
      <div className={styles.heading}><strong>{label}</strong><span>{metric.unlimited ? t('tools.quota.unlimited') : percent === null ? t('tools.quota.percentUnknown') : `${usageAmount(percent)}%${t('tools.quota.percentUsedSuffix')}`}</span></div>
      {percent !== null && <progress aria-label={t('tools.quota.percentAria', { label })} max={100} value={Math.min(100, Math.max(0, percent))} />}
      <small>{t(`tools.quota.subject.${metric.subject}`)}{t('tools.quota.unitSuffix', { unit: usageUnit(metric) })}</small>
      <div className={styles.values}>{metric.used !== null && <span>{t('tools.quota.used', { amount: usageAmount(metric.used), unit: usageUnit(metric) })}</span>}{metric.remaining !== null && <span>{t('tools.quota.remaining', { amount: usageAmount(metric.remaining), unit: usageUnit(metric) })}</span>}{metric.total !== null && <span>{t('tools.quota.total', { amount: usageAmount(metric.total), unit: usageUnit(metric) })}</span>}</div>
      {metric.missingReason && <small>{metric.missingReason}</small>}
      {metric.window && <small>{metric.window.durationSeconds ? t('tools.quota.windowHours', { hours: usageAmount(metric.window.durationSeconds / 3600) }) : ''}{usageReset(metric, now)}</small>}
      {metric.expiresAt && <small>{t('tools.quota.expiresAt', { time: date(metric.expiresAt) })}</small>}{metric.neverExpires && <small>{t('tools.quota.neverExpires')}</small>}
    </div>;
  })}{result.errors.map((e, i) => <p className={styles.error} key={i}>{e.message}</p>)}</div>;
}
export function ProfileQuota({ profileId, profileVersion, profileAccountId, toolId, state, addRequested = false, onAddHandled }: { profileId: string; profileVersion: number; profileAccountId?: string; toolId?: string; state: QuotaState; addRequested?: boolean; onAddHandled?: () => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<UsageQuery | 'new' | null>(null);
  useEffect(() => {
    if (!addRequested) return;
    if (nativeAvailable) setEditing('new');
    onAddHandled?.();
  }, [addRequested, onAddHandled]);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [error, setError] = useState('');
  const queries = state.queries.filter(q => q.config.identity.profileId === profileId && (q.config.program.kind !== 'profile_builtin' || q.config.program.profileVersion === profileVersion));
  useEffect(() => {
    let live = true;
    if (nativeAvailable) void state.ensureProfile(profileId, profileVersion).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [profileId, profileVersion, state.ensureProfile]);
  async function refresh(q: UsageQuery, cancel = false) {
    try { setError(''); await (cancel ? native.cancelUsageRefresh(q.id) : native.refreshUsageQuery(q.id)); await state.reload(); } catch (e) { setError(message(e)); }
  }
  return <section className={styles.quota} aria-label={t('tools.quota.label')} data-empty={queries.length === 0}>
    {!nativeAvailable && queries.length > 0 && <small>{t('tools.quota.nativeUnavailable')}</small>}
    {(error || state.error) && <p role="alert" className={styles.error}>{error || state.error}</p>}
    {queries.map((q, index) => {
      const cache = state.cache.find(c => c.queryId === q.id && c.generation === q.generation);
      const now = Date.now();
      const snapshot = cache?.success;
      const stale = snapshot && (!!cache?.errors.length || now - Date.parse(snapshot.measuredAt!) > Math.max(300, q.config.refreshIntervalSeconds * 2) * 1000);
      const cooldown = Math.max(0, (cache?.nextAllowedAt ?? 0) - Math.floor(now / 1000));
      const metrics = snapshot?.result.metrics ?? [];
      const primary = [...metrics.filter(metric => metric.subject !== 'extra'), ...metrics.filter(metric => metric.subject === 'extra')].slice(0, 3);
      return <div className={styles.query} key={q.id}>
        <div className={styles.heading}><div className={styles.queryTitle}><span title={q.config.label}>{q.config.program.kind === 'profile_builtin' ? t('tools.quota.official') : q.config.label}</span>{!q.config.enabled ? <small>{t('tools.quota.disabled')}</small> : stale ? <small className={styles.stale}>{t('tools.quota.stale')}</small> : snapshot?.measuredAt && <small title={date(snapshot.measuredAt)}>{t('tools.quota.updatedAt', { time: new Date(snapshot.measuredAt).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' }) })}</small>}</div><div className={styles.actions}><button className={styles.refresh} type="button" onClick={() => void refresh(q)} disabled={!q.config.enabled || cache?.refreshing || cooldown > 0}>{cache?.refreshing ? t('tools.quota.refreshing') : cooldown > 0 ? t('tools.quota.cooldown', { seconds: cooldown }) : t('tools.quota.refresh')}</button>{cache?.refreshing && <button type="button" onClick={() => void refresh(q, true)}>{t('tools.quota.stop')}</button>}<button className={styles.iconButton} type="button" aria-label={t('tools.quota.settings')} title={t('tools.quota.settings')} onClick={() => setEditing(q)}><Icon name="settings" size={16} /></button>{index === 0 && <button className={styles.iconButton} type="button" aria-label={t('tools.quota.add')} title={t('tools.quota.add')} disabled={!nativeAvailable} onClick={() => setEditing('new')}><Icon name="plus" size={16} /></button>}</div></div>
        {snapshot ? <div className={styles.summaryMetrics}>{primary.map(metric => <MetricSummary key={metric.id} metric={metric} label={usageMetricLabel(q.config.program, metric)} now={now} samples={state.samples[q.id] ?? []} />)}</div> : <small>{cache?.refreshing ? t('tools.quota.querying') : !q.config.enabled ? t('tools.quota.enableFirst') : t('tools.quota.noData')}</small>}
        {cache?.authPaused && <p className={styles.error}>{t('tools.quota.authPaused')}</p>}
        {!!cache?.errors.length && <p role="alert" className={styles.error}>{cache.errors.map(e => e.message).join(t('tools.quota.errorSeparator'))}</p>}
        {!!snapshot?.result.errors.length && <p role="alert" className={styles.error}>{snapshot.result.errors.map(e => e.message).join(t('tools.quota.errorSeparator'))}</p>}
        <details className={styles.quotaDetails} onToggle={event => { const open = event.currentTarget.open; setExpanded(previous => { const next = new Set(previous); if (open) next.add(q.id); else next.delete(q.id); return next; }); }}><summary>{t('tools.quota.detail')}{metrics.length > primary.length ? t('tools.quota.detailMore', { count: metrics.length - primary.length }) : ''}</summary>
          {snapshot && expanded.has(q.id) && <UsageMetrics result={snapshot.result} now={now} program={q.config.program} />}
          <div className={styles.metadata}>{q.config.program.kind === 'profile_builtin' && <small className={styles.linked}>{t('tools.quota.linked')}</small>}<small>{!q.config.enabled ? t('tools.quota.disabled') : q.config.refreshIntervalSeconds ? t('tools.quota.autoRefresh', { minutes: q.config.refreshIntervalSeconds / 60 }) : t('tools.quota.manual')}</small>{snapshot?.measuredAt && <small>{t('tools.quota.lastSuccess', { time: date(snapshot.measuredAt) })}</small>}{cache?.attemptedAt && cache.errors.length > 0 && <small>{t('tools.quota.lastAttempt', { time: date(cache.attemptedAt) })}</small>}<small>{t('tools.quota.source', { site: q.config.site })}{snapshot && ` · ${snapshot.source}`}</small></div>
        </details>
      </div>;
    })}
    {editing && <QuotaEditor key={typeof editing === 'string' ? 'new' : editing.id} profileId={profileId} profileAccountId={profileAccountId} toolId={toolId} query={editing === 'new' ? null : editing} presets={state.presets} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void state.reload(); }} />}
  </section>;
}
function fromQuery(query: UsageQuery): UsageQueryDraft {
  return { id: query.id, expectedVersion: query.version, config: structuredClone(query.config), credentials: query.credentials.map(c => ({ name: c.name, allowedOrigins: [...c.allowedOrigins], value: { kind: 'keep' } })) };
}
function fromPreset(p: UsagePreset, profileId: string): UsageQueryDraft {
  return { id: null, expectedVersion: null, config: { ...structuredClone(p.config), identity: { ...p.config.identity, profileId } }, credentials: p.credentials.map(c => ({ name: c.name, allowedOrigins: [...c.allowedOrigins], value: { kind: 'replace', secret: '' } })) };
}
function empty(profileId: string): UsageQueryDraft {
  return { id: null, expectedVersion: null, config: { schemaVersion: 1, label: i18n.t('tools.quota.customLabel'), site: 'https://your-site.example', identity: { accountId: null, contextId: null, profileId, subject: 'account', subjectId: null }, program: { kind: 'javascript', source: i18n.t('tools.quota.customScript') }, parameters: {}, targets: [{ origin: 'https://your-site.example', allowPrivateNetwork: false }], enabled: true, refreshIntervalSeconds: 0 }, credentials: [] };
}
export function QuotaEditor({ profileId, profileAccountId, toolId, query, presets, onClose, onSaved }: { profileId: string; profileAccountId?: string; toolId?: string; query: UsageQuery | null; presets: UsagePreset[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<UsageQueryDraft>(() => query ? fromQuery(query) : presets[0] ? fromPreset(presets[0], profileId) : empty(profileId));
  const [presetId, setPresetId] = useState(query ? '' : presets[0]?.id ?? 'custom');
  const [accounts, setAccounts] = useState<AuthAccount[]>([]);
  const official = draft.config.program.kind === 'official' ? draft.config.program : null;
  const profileLinked = draft.config.program.kind === 'profile_builtin';
  const officialUi = official ? uiAdapterFor(official.tool).officialUsage : null;
  useEffect(() => { let live = true; if (official) void native.listAccounts().then(items => { if (live) setAccounts(items ?? []); }).catch(() => { if (live) setError(t('tools.quota.accountsFailed')); }); return () => { live = false; }; }, [official?.tool]);
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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('tools.quota.parametersInvalid'));
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
  return <GuideDialog open title={t('tools.quota.editorTitle')} hint={t('tools.quota.editorHint')} onClose={() => { if (!saving) { invalidate(); onClose(); } }}>
    <fieldset className={styles.editor} disabled={saving || !nativeAvailable}>
      <label>{t('tools.quota.preset')}<select aria-label={t('tools.quota.preset')} value={presetId} onChange={e => {
        const id = e.target.value; const p = presets.find(p => p.id === id); const next = p ? fromPreset(p, profileId) : empty(profileId);
        edit({ ...next, id: draft.id, expectedVersion: draft.expectedVersion }); setParameters(JSON.stringify(next.config.parameters, null, 2)); setPresetId(id);
      }}><option value="">{t('tools.quota.presetSaved')}</option>{presets.filter(p => p.config.program.kind !== 'official' || !toolId || p.config.program.tool === toolId).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}<option value="custom">{t('tools.quota.presetCustom')}</option></select></label>
      {preset && !official && <p>{preset.description}</p>}
      {profileLinked && <p>{t('tools.quota.linkedNote')}</p>}
      <label>{t('tools.quota.queryName')}<input aria-label={t('tools.quota.queryName')} value={draft.config.label} onChange={e => config({ label: e.target.value })} /></label>
      {official && <><p>{presets.find(p => p.config.program.kind === 'official' && p.config.program.tool === official.tool)?.description}</p>{officialUi?.accountRequired && <label>{t('tools.quota.officialAccount')}<select aria-label={t('tools.quota.officialAccount')} value={draft.config.identity.accountId && draft.config.identity.contextId ? `${draft.config.identity.accountId}:${draft.config.identity.contextId}` : ''} onChange={e => { const account = accounts.find(a => `${a.id}:${a.context?.id}` === e.target.value); config({ identity: { ...draft.config.identity, accountId: account?.id ?? null, contextId: account?.context?.id ?? null } }); }}><option value="">{t('tools.quota.officialAccountPlaceholder')}</option>{draft.config.identity.accountId && !accounts.some(a => a.id === draft.config.identity.accountId && a.context?.id === draft.config.identity.contextId && a.id === profileAccountId && a.state === 'signed_in') && <option value={`${draft.config.identity.accountId}:${draft.config.identity.contextId}`} disabled>{t('tools.quota.bindingLost')}</option>}{accounts.filter(a => a.toolId === official.tool && a.context && a.state === 'signed_in' && !a.pendingLogin && a.id === profileAccountId).map(a => <option key={a.id} value={`${a.id}:${a.context!.id}`}>{a.label}{a.identity?.email ? ` · ${a.identity.email}` : ''}</option>)}</select><small>{t('tools.quota.accountHint')}</small></label>}</>}
      {!official && !profileLinked && <label>{t('tools.quota.site')}<input aria-label={t('tools.quota.siteAria')} value={draft.config.site} onChange={e => {
        const previous = draft.config.site, site = e.target.value;
        const next = { ...draft, config: { ...draft.config, site, targets: draft.config.targets.map(t => t.origin === previous ? { ...t, origin: site } : t) }, credentials: draft.credentials.map(c => ({ ...c, allowedOrigins: c.allowedOrigins.map(o => o === previous ? site : o) })) };
        try { const p = JSON.parse(parameters); if (p.site === previous) setParameters(JSON.stringify({ ...p, site }, null, 2)); } catch { /* Preserve invalid draft text. */ }
        edit(next);
      }} /></label>}
      <label className={styles.check}><input type="checkbox" checked={draft.config.enabled} onChange={e => config({ enabled: e.target.checked })} />{t('tools.quota.enableQuery')}</label>
      <label>{t('tools.quota.autoRefreshLabel')}<select aria-label={t('tools.quota.autoRefreshLabel')} disabled={!!official && !officialUi?.automaticRefresh} value={draft.config.refreshIntervalSeconds} onChange={e => config({ refreshIntervalSeconds: Number(e.target.value) })}><option value={0}>{t('tools.quota.refreshOff')}</option>{[60, 300, 900, 1800, 3600, ...(draft.config.refreshIntervalSeconds && ![60, 300, 900, 1800, 3600].includes(draft.config.refreshIntervalSeconds) ? [draft.config.refreshIntervalSeconds] : [])].map(n => <option key={n} value={n}>{t('tools.quota.refreshEvery', { minutes: n / 60 })}</option>)}</select></label>
      {!official && !profileLinked && <>
      {draft.config.program.kind === 'builtin' ? <button type="button" onClick={() => void copyScript()}>{t('tools.quota.copyScript')}</button> : draft.config.program.kind === 'javascript' ? <><label>JavaScript · async query(ctx)</label><CodeEditor format="javascript" label={t('tools.quota.scriptEditorLabel')} value={draft.config.program.source} onChange={source => config({ program: { kind: 'javascript', source } })} readOnly={saving} errorLine={line} /><small>{t('tools.quota.scriptHint')}</small></> : null}
      <details><summary>{t('tools.quota.targetsSummary')}</summary>
        {draft.config.targets.map((target, i) => <div className={styles.target} key={i}><label>{t('tools.quota.targetOrigin')}<input aria-label={t('tools.quota.targetAria', { index: i + 1 })} value={target.origin} onChange={e => config({ targets: draft.config.targets.map((t, j) => i === j ? { ...t, origin: e.target.value } : t) })} /></label><label className={styles.check}><input type="checkbox" checked={target.allowPrivateNetwork} onChange={e => config({ targets: draft.config.targets.map((t, j) => i === j ? { ...t, allowPrivateNetwork: e.target.checked } : t) })} />{t('tools.quota.targetPrivate')}</label><button type="button" onClick={() => config({ targets: draft.config.targets.filter((_, j) => j !== i) })}>{t('tools.quota.targetRemove')}</button></div>)}
        <button type="button" onClick={() => config({ targets: [...draft.config.targets, { origin: '', allowPrivateNetwork: false }] })}>{t('tools.quota.targetAdd')}</button>
        <label>{t('tools.quota.subjectLabel')}<select value={draft.config.identity.subject} onChange={e => config({ identity: { ...draft.config.identity, subject: e.target.value as QueryConfig['identity']['subject'] } })}><option value="account">{t('tools.quota.subject.account')}</option><option value="plan">{t('tools.quota.subject.plan')}</option><option value="key">{t('tools.quota.subject.key')}</option><option value="extra">{t('tools.quota.subject.extra')}</option></select></label>
        <label>{t('tools.quota.subjectId')}<input value={draft.config.identity.subjectId ?? ''} onChange={e => config({ identity: { ...draft.config.identity, subjectId: e.target.value || null } })} /></label>
      </details>
      <section aria-label={t('tools.quota.credentials')}><h3>{t('tools.quota.credentials')}</h3>{draft.credentials.map((c, i) => <div className={styles.credential} key={i}>
        <label>{t('tools.quota.credentialName')}<input aria-label={t('tools.quota.credentialNameAria', { index: i + 1 })} value={c.name} onChange={e => credential(i, { name: e.target.value })} /></label>
        <small>{preset?.credentials.find(p => p.name === c.name)?.instructions}</small>
        <label>{c.value.kind === 'keep' ? t('tools.quota.credentialKeep') : t('tools.quota.credentialValue')}<input type="password" autoComplete="new-password" aria-label={t('tools.quota.credentialValueAria', { index: i + 1 })} value={c.value.kind === 'replace' ? c.value.secret : ''} onChange={e => credential(i, { value: e.target.value === '' && query?.credentials.some(saved => saved.name === c.name) ? { kind: 'keep' } : { kind: 'replace', secret: e.target.value } })} /></label>
        <label>{t('tools.quota.credentialOrigins')}<textarea aria-label={t('tools.quota.credentialOriginsAria', { index: i + 1 })} value={c.allowedOrigins.join('\n')} onChange={e => credential(i, { allowedOrigins: e.target.value.split('\n') })} /></label>
        <button type="button" onClick={() => edit({ ...draft, credentials: draft.credentials.filter((_, j) => j !== i) })}>{t('tools.quota.credentialRemove')}</button>
      </div>)}<button type="button" onClick={() => edit({ ...draft, credentials: [...draft.credentials, { name: `token_${draft.credentials.length + 1}`, allowedOrigins: [], value: { kind: 'replace', secret: '' } }] })}>{t('tools.quota.credentialAdd')}</button></section>
      <label>{t('tools.quota.parameters')}</label><CodeEditor format="json" label={t('tools.quota.parametersEditorLabel')} value={parameters} onChange={v => { invalidate(); setParameters(v); }} readOnly={saving} compact />

      </>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {report && <section aria-label={t('tools.quota.reportLabel')}><p>{t('tools.quota.reportMeta', { stage: report.stage, ms: report.elapsedMs })}</p>{!!report.requestOrigins?.length && <p>{t('tools.quota.reportOrigins', { origins: report.requestOrigins.join('、') })}</p>}{report.error && <p role="alert" className={styles.error}>{report.error.message}{line ? t('tools.quota.reportLine', { line }) : ''}</p>}{report.result && <UsageMetrics result={report.result} program={draft.config.program} />}<details><summary>{t('tools.quota.reportPreview')}</summary><pre>{report.preview || t('tools.quota.reportEmpty')}</pre></details></section>}
      <div className={`${styles.actions} ${styles.editorActions}`}><button type="button" disabled={testing} onClick={() => void test()}>{testing ? t('tools.quota.testing') : t('tools.quota.test')}</button>{testing && <button type="button" onClick={invalidate}>{t('tools.quota.cancelTest')}</button>}<button type="button" className={styles.primary} data-dialog-save title={saveShortcutHint()} onClick={() => void save()}>{t('tools.quota.save')}</button>{query && <button type="button" onClick={() => void remove()}>{t('tools.quota.delete')}</button>}</div>
    </fieldset>
  </GuideDialog>;
}
