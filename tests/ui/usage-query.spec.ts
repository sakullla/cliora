import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page) {
  await page.addInitScript(() => {
    const config = { schemaVersion: 1, label: '测试套餐', site: 'https://quota.example', identity: { profileId: 'p1', accountId: null, contextId: null, subject: 'plan', subjectId: null }, program: { kind: 'builtin', provider: 'glm', templateVersion: 1 }, parameters: { region: 'cn' }, targets: [{ origin: 'https://quota.example', allowPrivateNetwork: false }], enabled: true, refreshIntervalSeconds: 0 };
    const metric = { id: 'hour', label: '五小时套餐', subject: 'plan', subjectId: null, unit: { kind: 'requests' }, used: 125, remaining: -25, total: 100, sourcePercent: null, unlimited: false, expiresAt: '2028-01-01T00:00:00Z', neverExpires: false, window: { durationSeconds: 18000, resetsAt: '2020-01-01T00:00:00Z', recovery: 'rolling' }, missingReason: null };
    const result = { schemaVersion: 1, status: 'success', metrics: [metric, { ...metric, id: 'missing', label: '未知余额', unit: { kind: 'credits' }, used: null, remaining: null, total: null, window: null, expiresAt: null, missingReason: '无账户权限' }, { ...metric, id: 'unlimited', label: '无限 Key', used: 0, remaining: null, total: null, unlimited: true, window: null, expiresAt: null, neverExpires: true }], errors: [] };
    const harness = {
      calls: [] as Array<{ command: string; args: any }>,
      queries: [{ id: 'q1', version: 1, generation: 1, config, credentials: [{ name: 'api_key', secretRef: 'hidden', revision: 1, allowedOrigins: ['https://quota.example'] }] }],
      cache: [{ queryId: 'q1', generation: 1, success: { execution: { kind: 'saved', queryId: 'q1', generation: 1, identity: config.identity }, source: 'builtin:glm:1', attemptedAt: '2026-01-01T00:00:00Z', measuredAt: '2026-01-01T00:00:00Z', result }, attemptedAt: '2026-01-01T00:00:00Z', errors: [] as any[], nextAllowedAt: 0, nextAutoAt: 0, failures: 0, authPaused: false, refreshing: false }],
      holdReserve: false, holdTest: false, releaseReserve: null as null | (() => void), releaseTest: null as null | (() => void), testCount: 0,
    };
    Object.assign(window, { quotaHarness: harness, isTauri: true, __TAURI_INTERNALS__: { invoke: async (command: string, args: any) => {
      harness.calls.push({ command, args });
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
      if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: ['openai_responses'] }], managedIds: ['codex'], preservedUnknown: [] };
      if (['list_projects', 'list_mcp_definitions', 'list_skill_packages', 'list_skill_recovery_issues', 'scan_native_skills', 'list_native_mcp'].includes(command)) return [];
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
      if (command === 'get_registered_tool_workspace') return {
        probe: { selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '1.0.0', status: 'available', source: 'npm_shim', detail: null }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null, nativeInstallCommand: null },
        profiles: [{ id: 'p1', tool: 'codex', name: '主配置', version: 1, inheritCommon: true, files: {}, connection: { providerId: 'fixture', baseUrl: 'https://quota.example', interfaceFormat: 'openai_responses', model: 'gpt-test' } }], common: null, binding: null, snapshots: [], recoveryNeeded: [], customPath: null,
      };
      if (command === 'list_usage_queries') return structuredClone(harness.queries);
      if (command === 'list_usage_cache') return structuredClone(harness.cache);
      if (command === 'usage_presets') return [{ id: 'glm-cn', label: 'GLM 中国大陆', description: '查询 Coding Plan', config, credentials: [{ name: 'api_key', label: '套餐 Key', instructions: '填写套餐查询凭据', allowedOrigins: ['https://quota.example'] }] }, { id: 'custom-example', label: 'JavaScript 示例', description: '复制为自己的脚本', config: { ...config, program: { kind: 'javascript', source: 'async function query(ctx) {\n  throw new Error("测试错误");\n}' } }, credentials: [] }];
      if (command === 'usage_builtin_script') return 'async function query(ctx) {\n  throw new Error("测试错误");\n}';
      if (command === 'refresh_usage_query') { harness.cache[0].errors = [{ code: 'rate_limit', message: '请求受限，请稍后刷新', stage: 'http', retryAfterSeconds: 600, metricId: null }]; harness.cache[0].nextAllowedAt = Math.floor(Date.now() / 1000) + 600; return; }
      if (command === 'cancel_usage_refresh') { harness.cache[0].refreshing = false; harness.cache[0].errors = [{ code: 'cancelled', message: '额度刷新已取消' }]; return; }
      if (command === 'create_usage_test') { if (harness.holdReserve) await new Promise<void>(resolve => { harness.releaseReserve = resolve; }); return `test-${++harness.testCount}`; }
      if (command === 'cancel_usage_test') return;
      if (command === 'test_usage_query') { if (harness.holdTest) await new Promise<void>(resolve => { harness.releaseTest = resolve; }); return { execution: { kind: 'draft', executionId: args.executionId, draftRevision: args.draftRevision }, result: null, error: { code: 'script', stage: 'script', message: '测试错误', scriptLine: 2 }, elapsedMs: 12, stage: 'script', preview: '', requestOrigins: ['https://quota.example'] }; }
      if (command === 'save_usage_query') { const query = { id: args.draft.id ?? 'q2', version: 2, generation: 2, config: args.draft.config, credentials: [] }; harness.queries = [...harness.queries.filter(q => q.id !== query.id), query]; return { query, credentialCleanupPending: false }; }
      if (command === 'delete_usage_query') { harness.queries = harness.queries.filter(q => q.id !== args.id); return { credentialCleanupPending: false }; }
      return null;
    } } });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await expect(page.getByText('测试套餐', { exact: true })).toBeVisible();
}
const harness = (page: Page, action: string) => page.evaluate(action);

test('profile quota preserves overage, missing values, expiry and last success after rate limit', async ({ page }) => {
  await setup(page);
  await expect(page.getByText('125% 已用')).toBeVisible();
  await expect(page.getByText('剩余 -25 次')).toBeVisible();
  await expect(page.getByText('比例未知')).toBeVisible();
  await expect(page.getByText('无限额', { exact: true })).toBeVisible();
  await expect(page.getByText('永不过期')).toBeVisible();
  await expect(page.getByText(/滚动恢复时间已到，待刷新/)).toBeVisible();
  await expect(page.getByText(/有效期至/)).toBeVisible();
  await page.getByRole('button', { name: '刷新额度' }).click();
  await expect(page.getByText('请求受限，请稍后刷新')).toBeVisible();
  await expect(page.getByText('125% 已用')).toBeVisible();
  await expect(page.getByText(/最近成功：.*数据已过期/)).toBeVisible();
  await expect(page.getByRole('button', { name: /秒后可刷新/ })).toBeDisabled();
  await page.screenshot({ path: 'test-results/quota-card.png', fullPage: true });
});

test('preset and script editor test current draft without saving or refreshing, then save only', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '额度设置' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('自动刷新')).toHaveValue('0');
  await expect(dialog.getByLabel('凭据值 1')).toHaveValue('');
  await dialog.getByRole('button', { name: '复制为自定义脚本' }).click();
  await expect(dialog.getByRole('textbox', { name: '额度查询脚本' })).toContainText('async function query');
  await dialog.getByRole('button', { name: '测试当前草稿' }).click();
  await expect(dialog.getByText('测试错误（第 2 行）')).toBeVisible();
  await expect(dialog.getByText(/耗时 12 ms/)).toBeVisible();
  await expect(dialog.getByText(/请求目标（不含路径及参数）：https:\/\/quota.example/)).toBeVisible();
  expect(await harness(page, `window.quotaHarness.calls.filter(c => ['save_usage_query', 'refresh_usage_query'].includes(c.command)).length`)).toBe(0);
  await page.screenshot({ path: 'test-results/quota-editor.png', fullPage: true });
  await dialog.getByLabel('查询名称').fill('保存的新名称');
  await expect(dialog.getByLabel('草稿测试结果')).toHaveCount(0);
  await dialog.getByRole('button', { name: '保存查询' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await harness(page, `window.quotaHarness.calls.filter(c => c.command === 'refresh_usage_query').length`)).toBe(0);
  const saved = await harness(page, `window.quotaHarness.calls.find(c => c.command === 'save_usage_query').args.draft`);
  expect(saved.config.label).toBe('保存的新名称');
  expect(saved.config.program.kind).toBe('javascript');
  expect(saved.credentials[0].value.kind).toBe('keep');
});

test('editing or closing during reservation cancels late id before draft starts', async ({ page }) => {
  await setup(page);
  await harness(page, 'window.quotaHarness.holdReserve = true');
  await page.getByRole('button', { name: '额度设置' }).click();
  await page.getByRole('button', { name: '测试当前草稿' }).click();
  await expect.poll(() => harness(page, '!!window.quotaHarness.releaseReserve')).toBe(true);
  await page.getByLabel('查询名称').fill('新草稿');
  await harness(page, 'window.quotaHarness.releaseReserve()');
  await expect.poll(() => harness(page, `window.quotaHarness.calls.filter(c => c.command === 'cancel_usage_test').length`)).toBe(1);
  expect(await harness(page, `window.quotaHarness.calls.filter(c => c.command === 'test_usage_query').length`)).toBe(0);
  await harness(page, 'window.quotaHarness.releaseReserve = null');
  await page.getByRole('button', { name: '测试当前草稿' }).click();
  await expect.poll(() => harness(page, '!!window.quotaHarness.releaseReserve')).toBe(true);
  await page.getByRole('dialog').getByRole('button', { name: '关闭' }).click();
  await harness(page, 'window.quotaHarness.releaseReserve()');
  await expect.poll(() => harness(page, `window.quotaHarness.calls.filter(c => c.command === 'cancel_usage_test').length`)).toBe(2);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('editing cancels in-flight draft and rejects late result; multiple query presets remain independent', async ({ page }) => {
  await setup(page);
  await harness(page, 'window.quotaHarness.holdTest = true');
  await page.getByRole('button', { name: '额度设置' }).click();
  await page.getByRole('button', { name: '测试当前草稿' }).click();
  await expect.poll(() => harness(page, '!!window.quotaHarness.releaseTest')).toBe(true);
  await page.getByLabel('查询名称').fill('不要覆盖');
  await harness(page, 'window.quotaHarness.releaseTest()');
  await expect(page.getByLabel('草稿测试结果')).toHaveCount(0);
  await expect.poll(() => harness(page, `window.quotaHarness.calls.filter(c => c.command === 'cancel_usage_test').length`)).toBe(1);
  await page.getByRole('dialog').getByRole('button', { name: '关闭' }).click();
  await page.getByRole('button', { name: '添加额度查询' }).click();
  await page.getByLabel('查询预设').selectOption('custom-example');
  await page.getByLabel('查询名称').fill('独立脚本副本');
  await page.getByRole('button', { name: '保存查询' }).click();
  await expect(page.getByText('测试套餐', { exact: true })).toBeVisible();
  await expect(page.getByText('独立脚本副本', { exact: true })).toBeVisible();
});

test('active saved refresh can be stopped while preserving the previous metrics', async ({ page }) => {
  await setup(page);
  await harness(page, 'window.quotaHarness.cache[0].refreshing = true');
  await expect(page.getByRole('button', { name: '停止刷新' })).toBeVisible();
  await page.getByRole('button', { name: '停止刷新' }).click();
  await expect(page.getByText('额度刷新已取消')).toBeVisible();
  await expect(page.getByText('125% 已用')).toBeVisible();
  await expect(page.getByRole('button', { name: '停止刷新' })).toHaveCount(0);
});
