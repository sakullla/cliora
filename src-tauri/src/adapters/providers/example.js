// Copy this independent script and adapt endpoints/fields to your service's documentation.
// Example response contracts: /balance {remaining: 12.5, currency: "USD"};
// /plans {plans: [{id: "plan-a", used: 10, total: 100, resetsAt: "2026-11-01T00:00:00Z"}]}.
// Configure parameters.site AND allowed targets/credential origins. Never paste a secret here.
async function query(ctx) {
  const metrics = [], errors = [];
  const err = (code, message) => ({code, stage: 'validation', message, retryAfterSeconds: null, metricId: null});
  const make = (id, label, subject, unit) => ({id, label, subject, subjectId: null, unit, used: null,
    remaining: null, total: null, sourcePercent: null, unlimited: false, expiresAt: null, neverExpires: false,
    window: null, missingReason: null});
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  async function get(path) {
    const response = await ctx.http({url: ctx.parameters.site + path, method: 'GET',
      auth: {credential: ctx.credentials.user_token, header: 'Authorization', prefix: 'Bearer '}});
    try { return response.json(); } catch (_) { throw err('parse', '示例接口未返回 JSON'); }
  }
  // Failure of either optional request must not hide valid data from the other.
  try {
    const wallet = await get('/balance');
    if (!wallet || !finite(wallet.remaining) || !/^[A-Z]{3}$/.test(wallet.currency)) throw err('parse', '请按服务文档修改余额字段');
    const m = make('wallet', '账户余额', 'account', {kind: 'currency', code: wallet.currency});
    m.remaining = wallet.remaining; metrics.push(m);
  } catch (e) { errors.push(err(e && e.code || 'parse', '余额请求不可用，请检查脚本映射和权限')); }
  try {
    const data = await get('/plans');
    if (!data || !Array.isArray(data.plans) || !data.plans.length) throw err('parse', '未返回套餐');
    for (let i = 0; i < data.plans.length; i++) {
      const plan = data.plans[i];
      if (!plan || !finite(plan.used) || plan.used < 0 || !finite(plan.total) || plan.total < 0) {
        errors.push(err('parse', '某个套餐字段不可用')); continue;
      }
      const m = make('plan-' + i, '套餐 ' + (i + 1), 'plan', {kind: 'requests'});
      m.subjectId = typeof plan.id === 'string' && plan.id.trim() ? plan.id : null;
      m.used = plan.used; m.total = plan.total; m.remaining = plan.total - plan.used;
      // The standard contract validates timestamps; use RFC3339 including timezone.
      m.window = {durationSeconds: null, resetsAt: plan.resetsAt || null, recovery: 'unknown'};
      metrics.push(m);
    }
  } catch (e) { errors.push(err(e && e.code || 'parse', '套餐请求不可用，请检查脚本映射和权限')); }
  return {schemaVersion: 1, status: metrics.length ? errors.length ? 'partial' : 'success' : 'failed', metrics, errors};
}
