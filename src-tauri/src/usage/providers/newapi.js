// QuantumNous/new-api 1a4166d8e8ba9802d2ca56fe8ecf0ed5404e80d5.
// Subscription purchase currency is not a quota conversion rate.
async function query(ctx) {
  const metrics = [], errors = [];
  const divisor = ctx.parameters.unitsPerCurrency;
  const currency = ctx.parameters.currency;
  const converted = typeof divisor === 'number' && Number.isFinite(divisor) && divisor > 0 && typeof currency === 'string' && /^[A-Z]{3}$/.test(currency);
  if ((divisor !== undefined || currency !== undefined) && !converted) throw failure('invalid_configuration', '货币换算需明确的正数单位除数及币种');
  const unit = converted ? { kind: 'currency', code: currency } : { kind: 'custom', label: 'quota（站点原始单位）' };
  const value = v => { const n = number(v); return n === null ? null : converted ? n / divisor : n; };
  const headers = ctx.parameters.userId ? { 'New-Api-User': String(ctx.parameters.userId) } : {};
  if (mode === 'key') {
    const root = await siteRead(ctx, '/api/usage/token/', 'api_key', 'token');
    if (root.code !== true) throw failure('business', 'Key 额度查询失败，请核对站点接口版本');
    const data = root.data;
    if (!data || data.object !== 'token_usage' || typeof data.unlimited_quota !== 'boolean') throw failure('parse', 'Key 查询响应结构不兼容');
    const m = siteMetric('newapi-key', 'Key 额度', 'key', unit);
    if (data.unlimited_quota) { m.unlimited = true; m.used = nonnegative(value(data.total_used)); }
    else quota(m, value(data.total_used), value(data.total_available), value(data.total_granted), errors);
    expiry(m, data.expires_at, errors, true, true); metrics.push(m);
    return finish(metrics, errors);
  }
  if (mode === 'account' || mode === 'account-plans') {
    try {
      const user = await siteRead(ctx, '/api/user/self', 'user_token', 'new', headers);
      const m = siteMetric('newapi-wallet', '账户余额', 'account', unit, validId(user && user.id));
      // used_quota is lifetime account usage, not the purchased total of the current wallet.
      quota(m, null, value(user && user.quota), null, errors); metrics.push(m);
    } catch (error) { siteError(error, errors, 'newapi-wallet'); }
  }
  if (mode === 'plans' || mode === 'account-plans') {
    let plans = null;
    try {
      plans = await siteRead(ctx, '/api/subscription/plans', 'user_token', 'new', headers);
      if (!Array.isArray(plans)) { plans = null; throw failure('parse', '套餐定义结构不兼容'); }
    } catch (error) { siteError(error, errors); }
    try {
      const data = await siteRead(ctx, '/api/subscription/self', 'user_token', 'new', headers);
      if (!data || !Array.isArray(data.subscriptions)) throw failure('parse', '用户套餐结构不兼容');
      const seen = new Set();
      for (const entry of data.subscriptions) {
        const s = entry && entry.subscription, id = validId(s && s.id);
        if (!id || seen.has(id)) { errors.push(failure('parse', '用户套餐身份缺失或重复')); continue; }
        seen.add(id);
        const m = siteMetric('newapi-plan-' + id, '订阅 ' + id + (s.status === 'expired' ? '（已过期）' : s.status === 'cancelled' ? '（已取消）' : ''), 'plan', unit, id);
        if (number(s.amount_total) === 0) { m.unlimited = true; m.used = nonnegative(value(s.amount_used)); }
        else quota(m, value(s.amount_used), null, value(s.amount_total), errors);
        expiry(m, s.end_time, errors, true);
        const definition = plans && plans.find(entry => entry && entry.plan && validId(entry.plan.id) === validId(s.plan_id));
        const p = definition && definition.plan;
        const reset = unixInstant(s.next_reset_time);
        if (s.next_reset_time != null && number(s.next_reset_time) !== 0 && !reset) missing(m, errors, '来源重置时间格式不可识别');
        const period = p && p.quota_reset_period;
        if (period && period !== 'never' || reset) m.window = {
          durationSeconds: period === 'daily' ? 86400 : period === 'weekly' ? 604800 : period === 'custom' ? seconds(p.quota_reset_custom_seconds) : null,
          resetsAt: reset, recovery: 'fixed'
        };
        if (!p) missing(m, errors, '套餐定义不可用，周期信息可能不完整；到期时间仍独立显示');
        metrics.push(m);
      }
      if (data.subscriptions.length === 0) errors.push(failure('parse', '站点未返回活跃订阅；空列表可能是无订阅或服务端查询失败'));
    } catch (error) { siteError(error, errors); }
  }
  return finish(metrics, errors);
}
