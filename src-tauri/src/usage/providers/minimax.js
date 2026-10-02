// Known MiniMax responses use 10-digit Unix seconds or 13-digit milliseconds.
// Reject other magnitudes instead of guessing a date in 1970 or a distant future.
function minimaxEpoch(value) {
  const n = number(value);
  if (!Number.isInteger(n)) return null;
  if (n >= 1000000000 && n < 10000000000) return epochMillis(n * 1000);
  if (n >= 1000000000000 && n < 10000000000000) return epochMillis(n);
  return null;
}

async function query(ctx) {
  const root = await read(ctx, { 'MM-API-Source': 'Cliora', 'content-type': 'application/json' });
  const data = root.data && typeof root.data === 'object' ? root.data : root;
  // Check both envelopes before considering any successful metrics.
  for (const base of [root.base_resp, data.base_resp]) {
    if (!base) continue;
    const status = number(base.status_code);
    if (status === null) throw failure('parse', 'MiniMax 业务状态字段不可用');
    if (status !== 0) throw failure(status === 1004 ? 'authentication' : 'business', 'MiniMax 套餐接口拒绝查询，请核对订阅 Key 与接口版本');
  }
  const metrics = [], errors = [];
  if (!root.base_resp && !data.base_resp) throw failure('parse', 'MiniMax 响应缺少业务状态');
  if (!Array.isArray(data.model_remains)) throw failure('parse', 'MiniMax 响应缺少套餐额度列表');
  data.model_remains.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') { errors.push(failure('parse', 'MiniMax 额度项格式不可用')); return; }
    const name = typeof raw.model_name === 'string' && raw.model_name.trim() ? raw.model_name.slice(0, 100) : '订阅套餐';
    const textService = name === 'general' || /minimax-m|^m2\./i.test(name);
    for (const weekly of [false, true]) {
      const prefix = weekly ? 'current_weekly_' : 'current_interval_';
      if (weekly && !Object.keys(raw).some(k => k.startsWith(prefix))) continue;
      const total = nonnegative(raw[prefix + 'total_count']);
      const remaining = number(raw[prefix + 'usage_count']); // Upstream name means REMAINING, not used.
      const remainingPercent = number(raw[prefix + 'remaining_percent']);
      const status = number(raw[prefix + 'status']);
      const unlimited = weekly && textService && status === 3 && remainingPercent >= 100;
      // Status 3 + empty video lane is not an entitlement and must not look like a full quota.
      if (!unlimited && status === 3 && (total === null || total === 0) && (remaining === null || remaining === 0) && remainingPercent >= 100) continue;
      const rawStart = raw[weekly ? 'weekly_start_time' : 'start_time'];
      const rawEnd = raw[weekly ? 'weekly_end_time' : 'end_time'];
      const start = minimaxEpoch(rawStart);
      let end = minimaxEpoch(rawEnd);
      const duration = start && end ? seconds((Date.parse(end) - Date.parse(start)) / 1000) : null;
      const invalidRange = start !== null && end !== null && duration === null;
      const invalidTime = (rawStart != null && start === null) || (rawEnd != null && end === null) || invalidRange;
      if (invalidRange) end = null;
      const boost = nonnegative(raw[weekly ? 'weekly_boost_permille' : 'interval_boost_permille'] ?? raw[weekly ? 'weekly_boost_permill' : 'interval_boost_permill']);
      const boostLabel = boost && boost !== 1000 ? ' · 配额倍率 ' + (boost / 1000) : '';
      const m = metric('minimax-' + index + (weekly ? '-weekly' : '-interval'), name + (weekly ? ' · 周额度' : ' · 周期额度') + boostLabel,
        { kind: 'custom', label: remainingPercent !== null ? '套餐比例' : '套餐配额' }, duration, unlimited ? null : end);
      if (unlimited) m.unlimited = true;
      else if (remainingPercent !== null && remainingPercent <= 100) m.sourcePercent = 100 - remainingPercent;
      else if (total !== null && total > 0 && remaining !== null && remaining <= total) {
        m.total = total; m.remaining = remaining; m.used = total - remaining;
      } else missing(m, errors, 'MiniMax 此窗口缺少可用额度，未假定为零');
      if (!unlimited && invalidTime) missing(m, errors, 'MiniMax 周期时间无法可靠识别，已保留可用额度并省略无效时间');
      metrics.push(m);
    }
  });
  // Points are an extra balance, never added to subscription windows or labelled as currency.
  const points = data.points_balance ?? data.point_balance ?? data.credits_balance ?? data.credit_balance;
  if (points !== undefined && points !== null) {
    const m = metric('minimax-points', 'MiniMax · 额外积分', { kind: 'credits' });
    m.subject = 'extra'; m.window = null; m.remaining = number(points);
    if (m.remaining === null) missing(m, errors, 'MiniMax 积分余额格式不可用');
    metrics.push(m);
  }
  return finish(metrics, errors);
}
