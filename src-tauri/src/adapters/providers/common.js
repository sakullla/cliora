// Provider error messages contain no server text, account identifiers, or credentials.
function failure(code, message, metricId = null) {
  return { code, stage: 'validation', message, retryAfterSeconds: null, metricId };
}
function number(value) {
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null;
}
function nonnegative(value) { const n = number(value); return n !== null && n >= 0 ? n : null; }
function seconds(value) { return Number.isInteger(value) && value > 0 && value <= 4294967295 ? value : null; }
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function epochMillis(value) {
  const n = nonnegative(value);
  if (n === null || !Number.isInteger(n)) return null;
  const date = new Date(n); return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function metric(id, label, unit, duration = null, reset = null, recovery = 'unknown') {
  return { id, label, subject: 'plan', subjectId: null, unit, used: null, remaining: null,
    total: null, sourcePercent: null, unlimited: false, expiresAt: null, neverExpires: false,
    window: { durationSeconds: duration, resetsAt: reset, recovery }, missingReason: null };
}
function finish(metrics, errors) {
  const available = metrics.some(m => m.unlimited || [m.used, m.remaining, m.total, m.sourcePercent].some(v => v !== null));
  if (!available) return { schemaVersion: 1, status: 'failed', metrics: [],
    errors: errors.length ? errors : [failure('parse', '来源未返回可识别的套餐额度，请核对套餐、凭据和接口版本')] };
  return { schemaVersion: 1, status: errors.length || metrics.some(m => m.missingReason) ? 'partial' : 'success', metrics, errors };
}
function missing(m, errors, message) {
  m.missingReason = message; errors.push(failure('parse', message, m.id)); return m;
}
async function read(ctx, headers = {}) {
  const response = await ctx.http({ url: endpoint, method: 'GET', headers: { accept: 'application/json', ...headers },
    auth: { credential: ctx.credentials.api_key, header: 'Authorization', prefix: 'Bearer ' } });
  let root;
  try { root = response.json(); } catch (_) { throw failure('parse', '套餐接口未返回有效 JSON'); }
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw failure('parse', '套餐接口响应结构不兼容');
  return root;
}
