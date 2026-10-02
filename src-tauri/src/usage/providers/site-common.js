// Shared by versioned self-hosted adapters; never forward server error text.
async function siteRead(ctx, path, credential, flavor, headers = {}) {
  const response = await ctx.http({ url: site + path, method: 'GET', headers: { accept: 'application/json', ...headers },
    auth: { credential: ctx.credentials[credential], header: 'Authorization', prefix: 'Bearer ' } });
  let root;
  try { root = response.json(); } catch (_) { throw failure('parse', '站点响应不是有效 JSON'); }
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw failure('parse', '站点响应结构不兼容');
  if (flavor === 'sub') {
    if (root.code !== 0) throw failure(root.code === 401 ? 'authentication' : root.code === 403 ? 'permission' : 'business', '站点拒绝用户查询，请核对权限和版本');
    return root.data;
  }
  if (flavor === 'new') {
    if (root.success !== true) throw failure(root.code === 'ACCESS_TOKEN_SCOPE_DENIED' ? 'permission' : 'business', '站点拒绝用户查询，请核对权限和版本');
    return root.data;
  }
  return root;
}
function siteMetric(id, label, subject, unit, subjectId = null) {
  const m = metric(id, label, unit); m.subject = subject; m.subjectId = subjectId; m.window = null; return m;
}
function siteError(error, errors, id = null) {
  // The broker supplies safe structured errors. Arbitrary parser exceptions never leave the helper.
  if (error && ['network','timeout','authentication','permission','rate_limit','business','parse','resource_limit'].includes(error.code))
    errors.push({ ...failure(error.code, '站点查询部分不可用，请核对网络、权限和接口版本', id), stage: error.stage || 'validation', retryAfterSeconds: error.retryAfterSeconds || null });
  else errors.push(failure('parse', '站点字段不兼容', id));
}
function validId(value) { return (typeof value === 'string' || typeof value === 'number') && /^[1-9]\d*$/.test(String(value)) ? String(value) : null; }
function expiry(m, value, errors, numeric = false, zeroIsNever = false) {
  if (value === null || value === undefined) return;
  if (numeric && zeroIsNever && number(value) === 0) { m.neverExpires = true; return; }
  m.expiresAt = numeric ? unixInstant(value) : instant(value);
  if (!m.expiresAt) missing(m, errors, '来源有效期格式不可识别');
}
function unixInstant(value) { const n = nonnegative(value); return n > 0 && Number.isInteger(n) ? epochMillis(n * 1000) : null; }
function quota(m, used, remaining, total, errors) {
  m.used = nonnegative(used); m.remaining = number(remaining); m.total = nonnegative(total);
  if ((used != null && m.used === null) || (remaining != null && m.remaining === null) || (total != null && m.total === null))
    missing(m, errors, '来源部分额度数值无效');
  if (m.remaining === null && m.total !== null && m.used !== null) m.remaining = m.total - m.used;
  if ([m.used, m.remaining, m.total].every(v => v === null)) missing(m, errors, '来源未提供可识别的额度数值');
  return m;
}
