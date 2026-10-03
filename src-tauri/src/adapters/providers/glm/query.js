async function query(ctx) {
  const root = await read(ctx);
  if (root.success !== true || root.code !== 200) {
    if (root.code === 401 || root.code === 1000 || root.code === 1001 || root.code === 1002 || root.code === 1003)
      throw failure('authentication', 'GLM 套餐凭据被拒绝，请核对所选区域的 API Key');
    throw failure('business', 'GLM 套餐接口拒绝查询，请核对套餐状态');
  }
  if (!root.data || !Array.isArray(root.data.limits)) throw failure('parse', 'GLM 响应缺少 limits');
  const metrics = [], errors = [];
  root.data.limits.forEach((raw, index) => {
    if (!raw || !['TOKENS_LIMIT', 'CREDIT_LIMIT', 'TIME_LIMIT'].includes(raw.type)) {
      errors.push(failure('parse', 'GLM 返回了尚未支持的额度类型')); return;
    }
    const duration = seconds(number(raw.number) * ({ 1: 86400, 3: 3600, 5: 60, 6: 604800 }[raw.unit] || NaN));
    // TIME_LIMIT unit=5/number=1 is a legacy monthly MCP marker, not a one-minute quota.
    const monthlyMcp = raw.type === 'TIME_LIMIT' && raw.unit === 5 && raw.number === 1;
    const rolling = raw.type !== 'TIME_LIMIT' && duration === 18000;
    let reset = epochMillis(raw.nextResetTime);
    if (rolling && reset && Date.parse(reset) > Date.now() + 18060000) reset = null;
    const m = metric('glm-' + index, raw.type === 'TIME_LIMIT' ? 'MCP 调用额度' : rolling ? 'Coding Plan · 5 小时动态恢复' : 'Coding Plan 额度',
      raw.type === 'CREDIT_LIMIT' ? { kind: 'credits' } : raw.type === 'TIME_LIMIT' ? { kind: 'requests' } : { kind: 'custom', label: '套餐配额' },
      monthlyMcp ? null : duration, reset, rolling ? 'rolling' : 'unknown');
    m.total = nonnegative(raw.usage); m.used = nonnegative(raw.currentValue); m.remaining = number(raw.remaining);
    // Counts are authoritative when the denominator is known. Never clamp overage to 100%.
    if (!(m.total > 0 && (m.used !== null || m.remaining !== null))) m.sourcePercent = nonnegative(raw.percentage);
    if (m.used === null && m.remaining === null && m.sourcePercent === null) {
      m.total = null; missing(m, errors, 'GLM 额度项缺少有效用量');
    }
    if (!monthlyMcp && duration === null) missing(m, errors, 'GLM 周期单位或长度不可用');
    metrics.push(m);
  });
  return finish(metrics, errors);
}
