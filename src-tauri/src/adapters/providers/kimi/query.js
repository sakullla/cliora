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
  // Absolute count windows are authoritative. Moonshot's ratio pools can lag or
  // stay zero while the same window is already exhausted (#3908), and
  // usages.limit_5h merely repeats limits[]. Only fill a window that no count
  // covered.
  function takeCount(duration) {
    const i = counts.findIndex(c => c.window.durationSeconds === duration);
    return i < 0 ? null : counts.splice(i, 1)[0];
  }
  function ratio(key, duration, id, label) {
    const raw = pools && pools[key];
    if (raw == null) return false;
    const used = nonnegative(raw.used_ratio);
    if (used === null) { errors.push(failure('parse', 'Kimi 比例额度字段不可用', id)); return true; }
    const m = metric(id, label, { kind: 'custom', label: '套餐比例' }, duration, instant(raw.reset_time));
    m.sourcePercent = used * 100;
    metrics.push(m);
    return true;
  }
  for (const [duration, key, id, label] of [
    [18000, 'limit_5h', 'kimi-session', 'Kimi Code · 5 小时'],
    [604800, 'limit_7d', 'kimi-weekly-ratio', 'Kimi Code · 周额度'],
  ]) {
    const counted = takeCount(duration);
    if (counted) metrics.push(counted);
    else ratio(key, duration, id, label);
  }
  // Keep any other bounded count windows after the known 5h/weekly periods.
  metrics.push(...counts);
  // limit_month_code repeats the shared total on some accounts; only use it
  // when the shared pool is absent.
  if (!ratio('limit_month_total', null, 'kimi-monthly', 'Kimi · 月总额度（共享）'))
    ratio('limit_month_code', null, 'kimi-month-code', 'Kimi Code · 月额度');
  if (pools && Object.keys(pools).some(k => !['limit_5h', 'limit_7d', 'limit_month_total', 'limit_month_code'].includes(k)))
    errors.push(failure('parse', 'Kimi 返回了尚未支持的额外额度池'));
  return finish(metrics, errors);
}
