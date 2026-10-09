import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page, supported = true, currentVersion = '3000.11.2', latestVersion = '3000.11.3') {
  await page.addInitScript(({ supported, currentVersion, latestVersion }) => {
    let attempts = 0;
    let versionChecks = 0;
    let rejectInstall: ((error: unknown) => void) | undefined;
    const callbacks = new Map<number, (event: unknown) => void>();
    let callbackId = 0;
    let progressCallback: number | undefined;
    Object.assign(window, {
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: { transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++callbackId, callback); return callbackId; }, invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'plugin:event|listen') { if (args.event === 'cliora:maintenance-progress') progressCallback = args.handler; return 1; }
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['devin'], theme: 'light' }, tools: [{ id: 'devin', name: 'Devin' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'devin', name: 'Devin', management: { accounts: false, mcp: false, skills: false, agents: false, plugins: false } }], managedIds: ['devin'], preservedUnknown: [] };
        if (command === 'get_registered_tool_workspace') return {
          probe: { tool: 'devin', latestVersionSupported: supported, selectedPath: '/fixture/devin', installations: [{ path: '/fixture/devin', version: currentVersion, status: 'available', source: 'native' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: 'https://devin.ai', upgradeHint: '', installCommand: null, upgradeCommand: 'fixture-update' }, profiles: [], binding: null, common: null, snapshots: [], recoveryNeeded: [], customPath: null,
        };
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'cli_latest_version') {
          versionChecks++;
          if (!supported) throw new Error('Unsupported clients must not query');
          if (versionChecks === 1) throw { message: 'temporary network error' };
          return latestVersion;
        }
        if (command === 'maintain_registered_cli') {
          attempts++;
          if (progressCallback) callbacks.get(progressCallback)?.({ payload: { toolId: 'devin', output: 'Downloading package…\nRunning postinstall…' } });
          if (attempts === 1) return new Promise((_resolve, reject) => { rejectInstall = reject; });
          return { output: `completed ${args.action}`, version: '3000.11.3' };
        }
        if (command === 'cancel_cli_maintenance') { rejectInstall?.({ message: '安装已取消' }); return null; }
        if (command.startsWith('plugin:event|')) return 1;
        if (command.startsWith('list_') || command === 'usage_presets') return [];
        return null;
      } },
    });
  }, { supported, currentVersion, latestVersion });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByText('安装与更新', { exact: true }).click();
}

test('version lookup retries and background installation can cancel then retry', async ({ page }, testInfo) => {
  await setup(page);
  // A failed release lookup must not block the adapter's supported update action.
  await expect(page.getByRole('button', { name: '更新', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重试查询' }).click();
  await expect(page.getByText('最新 3000.11.3')).toBeVisible();
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '更新', exact: true }).click();
  const progress = page.getByRole('dialog', { name: 'Devin 安装与更新' });
  await expect(progress.getByText('正在后台安装，请稍候…')).toBeVisible();
  await expect(progress.getByLabel('安装日志')).toContainText('Running postinstall');
  for (const width of [1360, 640]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: testInfo.outputPath(`maintenance-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  }
  await progress.getByRole('button', { name: '取消安装' }).click();
  await expect(progress.getByText('安装已取消')).toBeVisible();
  await progress.getByRole('button', { name: '重试', exact: true }).click();
  await expect(progress.getByText('操作完成 3000.11.3')).toBeVisible();
  await expect(progress.getByLabel('安装日志')).toContainText('completed upgrade');
  expect(page.context().pages()).toHaveLength(1);
});

test('unsupported public version lookup is explicit and avoids a failing request', async ({ page }) => {
  await setup(page, false);
  await expect(page.getByText('暂无公开的自动版本查询接口')).toBeVisible();
  await expect(page.getByRole('button', { name: '重试查询' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '官方安装说明 ↗' })).toBeVisible();
});

for (const latest of ['1.0.0-rc.10', '1.0.0']) {
  test(`prerelease 1.0.0-rc.2 can update to ${latest}`, async ({ page }) => {
    await setup(page, true, '1.0.0-rc.2', latest);
    await page.getByRole('button', { name: '重试查询' }).click();
    await expect(page.getByRole('button', { name: '更新', exact: true })).toBeVisible();
  });
}
