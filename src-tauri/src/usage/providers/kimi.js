async function query(ctx) {
  const root = await read(ctx);
  if (root.error || root.code) {
    const code = root.error && root.error.code || root.code;
    throw failure([401, 'UNAUTHENTICATED', 'invalid_api_key'].includes(code) ? 'authentication' : 'business', 'Kimi Code 套餐查询被拒绝，请核对 Code API Key 与区域');
  }
  const metrics = [], errors = [], counts = [];
  function count(detail, duration, id, label) {
    const m = metric(id, label, { kind: 'requests' }, duration,
      instant(detail && (detail.resetTime ?? detail.resetAt ?? detail.reset_time ?? detail.reset_at)));
    m.total = nonnegative(detail && detail.limit); m.used = nonnegative(detail && detail.used); m.remaining = number(detail && detail.remaining);
    if (m.used === null && m.remaining === null) { m.total = null; missing(m, errors, 'Kimi 旧版额度缺少有效计数'); }
    counts.push(m);
  }
  if (root.usage != null) count(root.usage, 604800, 'kimi-weekly', 'Kimi Code · 周额度');
  if (root.limits != null && !Array.isArray(root.limits)) errors.push(failure('parse', 'Kimi limits 格式不可用'));
  if (Array.isArray(root.limits)) root.limits.forEach((raw, i) => {
    const w = raw && raw.window;
    const duration = seconds(w && number(w.duration) * ({ TIME_UNIT_MINUTE: 60, TIME_UNIT_HOUR: 3600, TIME_UNIT_DAY: 86400 }[w.timeUnit] || NaN));
    count(raw && raw.detail, duration, 'kimi-count-' + i, 'Kimi Code · 周期额度');
    if (duration === null) missing(counts[counts.length - 1], errors, 'Kimi 周期长度不可用');
  });
  const pools = root.usages;
  if (pools != null && (typeof pools !== 'object' || Array.isArray(pools))) errors.push(failure('parse', 'Kimi usages 格式不可用'));
  const monthly = pools && nonnegative(pools.limit_month_total && pools.limit_month_total.used_ratio) !== null;
  for (const [key, duration, id, label] of [
    ['limit_5h', 18000, 'kimi-session', 'Kimi Code · 5 小时'],
    ['limit_7d', 604800, 'kimi-weekly-ratio', 'Kimi Code · 周额度'],
    ['limit_month_total', null, 'kimi-monthly', 'Kimi · 月总额度（共享）'],
  ]) {
    if (!pools || pools[key] == null) continue;
    const raw = pools[key], ratio = nonnegative(raw.used_ratio);
    if (ratio === null) { errors.push(failure('parse', 'Kimi 比例额度字段不可用', id)); continue; }
    const m = metric(id, label, { kind: 'custom', label: '套餐比例' }, duration, instant(raw.reset_time));
    m.sourcePercent = ratio * 100;
    const same = counts.filter(c => c.window.durationSeconds === duration);
    const fallback = same.find(c => c.used > 0 && c.total > 0 && c.window.resetsAt && m.window.resetsAt
      && Math.abs(Date.parse(c.window.resetsAt) - Date.parse(m.window.resetsAt)) <= 2000);
    // Known mixed legacy response sends placeholder zero ratios. Only borrow matching periods.
    if (ratio === 0 && !monthly && fallback) metrics.push(fallback);
    else metrics.push(m);
    for (const c of same) counts.splice(counts.indexOf(c), 1);
  }
  metrics.push(...counts);
  // limit_month_code is a subset of the shared monthly pool, not an additive balance.
  if (pools && Object.keys(pools).some(k => !['limit_5h', 'limit_7d', 'limit_month_total', 'limit_month_code'].includes(k)))
    errors.push(failure('parse', 'Kimi 返回了尚未支持的额外额度池'));
  return finish(metrics, errors);
}
