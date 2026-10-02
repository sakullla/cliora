// Wei-Shaw/sub2api b8dece9000c68815a5b867ca5a1e6f236e173905.
// /v1/sub2api/billing contains multipliers, not quota. Never use it as a balance.
const usd = { kind: 'currency', code: 'USD' };
async function query(ctx) {
  const metrics = [], errors = [];
  if (mode === 'key') {
    const root = await siteRead(ctx, '/v1/usage', 'api_key', 'gateway');
    if (root.isValid === false) throw failure('authentication', 'Key 不可用');
    if (root.mode === 'quota_limited') {
      if (root.quota && root.quota.unit === 'USD') {
        const m = siteMetric('sub2api-key', 'Key 总额度', 'key', usd);
        quota(m, root.quota.used, root.quota.remaining, root.quota.limit, errors);
        expiry(m, root.expires_at, errors); metrics.push(m);
      }
      if (Array.isArray(root.rate_limits)) for (let i = 0; i < root.rate_limits.length; i++) {
        const item = root.rate_limits[i];
        if (!item || typeof item !== 'object') { errors.push(failure('parse', 'Key 的部分周期字段无效')); continue; }
        const m = siteMetric('sub2api-key-window-' + i, 'Key 周期额度 ' + (i + 1), 'key', usd);
        quota(m, item.used, item.remaining, item.limit, errors);
        m.window = { durationSeconds: { '5h': 18000, '1d': 86400, '7d': 604800 }[item.window] || null,
          resetsAt: instant(item.reset_at), recovery: 'fixed' };
        expiry(m, root.expires_at, errors); metrics.push(m);
      }
    } else if (root.mode === 'unrestricted') {
      // This endpoint may expose wallet/subscription data through a Key, but those are not Key limits.
      if (root.subscription && typeof root.subscription === 'object') {
        for (const [period, duration] of [['daily', 86400], ['weekly', 604800], ['monthly', null]]) {
          const sub = root.subscription, limit = nonnegative(sub[period + '_limit_usd']);
          if (limit === null || limit === 0) continue; // absent caps are not fabricated unlimited windows
          const m = siteMetric('sub2api-plan-' + period, 'Key 所属套餐 · ' + period, 'plan', usd);
          quota(m, sub[period + '_usage_usd'], null, limit, errors);
          m.window = { durationSeconds: duration, resetsAt: null, recovery: 'unknown' };
          expiry(m, sub.expires_at, errors); metrics.push(m);
        }
        if (!metrics.length) errors.push(failure('parse', '此 Key 的套餐未返回可识别的周期限额，请使用用户套餐查询'));
      } else if (root.unit === 'USD' && number(root.balance) !== null) {
        const m = siteMetric('sub2api-wallet', 'Key 可见账户钱包余额', 'account', usd);
        m.remaining = number(root.balance); metrics.push(m);
      } else errors.push(failure('permission', 'Key 未返回订阅或钱包详情；unrestricted 不代表账户或套餐无限额，请使用用户查询凭据'));
    } else errors.push(failure('parse', 'Sub2API Key 接口版本或响应模式不兼容'));
    return finish(metrics, errors);
  }
  if (mode === 'account' || mode === 'account-plans') {
    try {
      const user = await siteRead(ctx, '/api/v1/user/profile', 'user_token', 'sub');
      const m = siteMetric('sub2api-wallet', '账户钱包余额', 'account', usd, validId(user && user.id));
      quota(m, null, user && user.balance, null, errors); metrics.push(m);
    } catch (error) { siteError(error, errors, 'sub2api-wallet'); }
  }
  if (mode === 'plans' || mode === 'account-plans') {
    // Both requests are independent: keep valid progress even when enumeration fails.
    let active = null, progress = null;
    try {
      active = await siteRead(ctx, '/api/v1/subscriptions/active', 'user_token', 'sub');
      if (!Array.isArray(active)) { active = null; throw failure('parse', '订阅列表结构不兼容'); }
    } catch (error) { siteError(error, errors); }
    try {
      progress = await siteRead(ctx, '/api/v1/subscriptions/progress', 'user_token', 'sub');
      if (!Array.isArray(progress)) throw failure('parse', '套餐进度结构不兼容');
      const seen = new Set();
      for (const item of progress) {
        const p = item && item.progress, id = validId(item && item.subscription && item.subscription.id);
        if (!p || !id || validId(p.id) !== id || seen.has(id)) { errors.push(failure('parse', '订阅身份缺失、不一致或重复')); continue; }
        seen.add(id);
        let count = 0;
        for (const [period, duration] of [['daily', 86400], ['weekly', 604800], ['monthly', null]]) {
          const window = p[period]; if (!window) continue;
          const m = siteMetric('sub2api-plan-' + id + '-' + period, '套餐 ' + id + ' · ' + period, 'plan', usd, id);
          quota(m, window.used_usd, window.remaining_usd, window.limit_usd, errors);
          m.window = { durationSeconds: duration, resetsAt: instant(window.resets_at), recovery: 'fixed' };
          expiry(m, p.expires_at, errors); metrics.push(m); count++;
        }
        if (!count) errors.push(failure('parse', '套餐 ' + id + ' 未提供日周月周期额度'));
      }
      if (active) for (const item of active) {
        const id = validId(item && item.id);
        if (!id || !seen.has(id)) errors.push(failure('parse', '活跃订阅的部分进度缺失，不能当作零用量'));
      }
      if (progress.length === 0) errors.push(failure('parse', '站点未返回可用订阅进度；空列表不代表无限额'));
    } catch (error) { siteError(error, errors); }
  }
  return finish(metrics, errors);
}
