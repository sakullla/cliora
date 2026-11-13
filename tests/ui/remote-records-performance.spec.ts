import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const host = { id: 'history-host', name: '远程开发机', host: '203.0.113.24', port: 22, user: 'fixture', authMethod: 'key', enabled: true, createdAt: 1, updatedAt: 1 };
    localStorage.setItem('cliora:remote-target', host.id);
    const tools = [{ id: 'codex', name: 'Codex' }];
    const facets = { state: 'available', reason: '' };
    const session = { id: 'remote-native:history-host:codex:fixture', toolId: 'codex', nativeId: 'fixture', title: '远程会话示例', cwd: '/fixture', model: null, projectId: null, startedAt: 1, updatedAt: 2, favorite: false, partial: false, stale: false, messageCount: 1, usageCount: 0 };
    const state = { hold: true, fail: false, version: 1, offset: 0, calls: [] as { name: string; refresh?: boolean }[], releases: [] as (() => void)[] };
    const now = Date.now;
    Date.now = () => now() + state.offset;
    Object.assign(window, {
      __remoteRecords: state,
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (command: string, args: { operation?: { refresh?: boolean } } = {}) => {
          state.calls.push({ name: command, refresh: args.operation?.refresh });
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'dark', remote_ssh_enabled: true }, tools };
          if (command === 'list_cli_adapters') return { registered: tools.map(tool => ({ ...tool, interfaceFormats: [], launchForm: 'terminal', nativeConfig: facets, launch: facets, resume: facets, resources: facets, history: facets })), managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'list_remote_targets') return [host];
          if (command === 'list_remote_native_history_snapshot') {
            if (state.hold) await new Promise<void>(resolve => state.releases.push(resolve));
            if (state.fail) throw { message: 'fixture connection failed' };
            return { sessions: [session], sourceFailures: [] };
          }
          if (command === 'get_remote_native_history') return { session, messages: [{ id: 'message', role: 'user', text: `远程正文版本 ${state.version}`, timestamp: 2 }], usage: [], children: [], resumeReason: null };
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          return [];
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '记录', exact: true }).click();
});

type Probe = { hold: boolean; fail: boolean; version: number; offset: number; calls: { name: string; refresh?: boolean }[]; releases: (() => void)[] };
declare global { interface Window { __remoteRecords: Probe } }

test('remote loading can be cancelled and retried without showing zero sessions or local usage', async ({ page }, testInfo) => {
  await expect(page.getByRole('heading', { name: '正在加载会话…' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /^会话/ })).toHaveText('会话');
  await expect(page.getByRole('tab', { name: '用量', exact: true })).toHaveCount(0);
  await expect(page.getByText('正在读取本机记录。', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '只看收藏' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('remote-loading.png') });
  await page.getByRole('button', { name: '取消读取', exact: true }).click();
  await expect(page.getByRole('heading', { name: '已取消读取' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('remote-cancelled.png') });
  await expect.poll(() => page.evaluate(() => window.__remoteRecords.calls.filter(call => call.name === 'cancel_remote_operation').length)).toBeGreaterThan(0);
  await page.evaluate(() => { window.__remoteRecords.hold = false; window.__remoteRecords.releases.splice(0).forEach(release => release()); });
  await expect(page.getByText('远程正文版本 1')).toHaveCount(0);
  await page.getByRole('button', { name: '重新读取列表', exact: true }).click();
  await expect(page.getByText('远程正文版本 1')).toBeVisible();
  await expect(page.getByRole('button', { name: '收藏会话', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('remote-ready.png') });
  expect(await page.evaluate(() => window.__remoteRecords.calls.filter(call => call.name === 'get_usage_report' || call.name === 'refresh_history'))).toEqual([]);
});

test('remote filters reuse the snapshot and refreshing preserves reading without a second forced fetch', async ({ page }, testInfo) => {
  await page.evaluate(() => { window.__remoteRecords.hold = false; window.__remoteRecords.releases.splice(0).forEach(release => release()); });
  await expect(page.getByText('远程正文版本 1')).toBeVisible();
  const initial = await page.evaluate(() => window.__remoteRecords.calls.filter(call => call.name === 'list_remote_native_history_snapshot').length);
  await page.evaluate(() => { window.__remoteRecords.offset = 31_000; });
  await page.getByPlaceholder('搜索标题、路径或模型').fill('fixture');
  await expect(page.getByPlaceholder('搜索标题、路径或模型')).toHaveValue('fixture');
  await expect(page.getByText('远程正文版本 1')).toBeVisible();
  await page.getByPlaceholder('搜索标题、路径或模型').fill('没有这条会话');
  await expect(page.getByRole('heading', { name: '没有匹配的会话' })).toBeVisible();
  expect(await page.evaluate(() => window.__remoteRecords.calls.filter(call => call.name === 'list_remote_native_history_snapshot').length)).toBe(initial);
  await page.getByPlaceholder('搜索标题、路径或模型').fill('');
  await expect(page.getByText('远程正文版本 1')).toBeVisible();
  await page.evaluate(() => { window.__remoteRecords.hold = true; window.__remoteRecords.version = 2; });
  await page.getByRole('button', { name: '刷新远程记录', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消读取', exact: true })).toBeVisible();
  await expect(page.getByText('远程正文版本 1')).toBeVisible();
  const cancelled = await page.evaluate(() => window.__remoteRecords.calls.filter(call => call.name === 'cancel_remote_operation').length);
  await page.getByPlaceholder('搜索标题、路径或模型').fill('刷新期间没有匹配');
  await expect(page.getByRole('heading', { name: '没有匹配的会话' })).toBeVisible();
  await page.getByPlaceholder('搜索标题、路径或模型').fill('fixture');
  await expect(page.getByText('远程正文版本 1')).toBeVisible();
  await expect(page.getByRole('button', { name: '取消读取', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('remote-refresh.png') });
  await page.evaluate(() => { window.__remoteRecords.hold = false; window.__remoteRecords.releases.splice(0).forEach(release => release()); });
  await expect(page.getByText('远程正文版本 2')).toBeVisible();
  expect(await page.evaluate(() => window.__remoteRecords.calls.filter(call => call.name === 'cancel_remote_operation').length)).toBe(cancelled);
  expect(await page.evaluate(() => window.__remoteRecords.calls.filter(call => call.name === 'get_remote_native_history').every(call => !call.refresh))).toBe(true);
});

test('a failed remote refresh retains its warning through filtering and can recover', async ({ page }) => {
  await page.evaluate(() => { window.__remoteRecords.hold = false; window.__remoteRecords.releases.splice(0).forEach(release => release()); });
  await expect(page.getByText('远程正文版本 1')).toBeVisible();
  await page.evaluate(() => { window.__remoteRecords.fail = true; });
  await page.getByRole('button', { name: '刷新远程记录', exact: true }).click();
  await expect(page.getByText('远程正文版本 1')).toBeVisible();
  await expect(page.getByText('fixture connection failed', { exact: false })).toBeVisible();
  await page.getByPlaceholder('搜索标题、路径或模型').fill('fixture');
  await expect(page.getByText('fixture connection failed', { exact: false })).toBeVisible();
  await page.evaluate(() => { window.__remoteRecords.fail = false; window.__remoteRecords.version = 2; });
  await page.getByRole('button', { name: '重新读取列表', exact: true }).click();
  await expect(page.getByText('远程正文版本 2')).toBeVisible();
  await expect(page.getByText('fixture connection failed', { exact: false })).toHaveCount(0);
});
