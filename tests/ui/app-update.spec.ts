import { loadApp } from './loadApp';
import { expect, test, type Page } from '@playwright/test';


async function setup(page: Page, theme = 'light') {
  await page.addInitScript((theme) => {
    const callbacks = new Map<number, (event: unknown) => void>();
    const handlers = new Map<string, number[]>();
    let callbackId = 0;
    const control = { checkResult: null as null | Record<string, unknown>, checks: 0, calls: [] as string[], checkpointFails: false };
    Object.assign(window, {
      isTauri: true,
      __updateTest: {
        control,
        emit: (event: string, payload: unknown) => (handlers.get(event) ?? []).forEach((id) => callbacks.get(id)?.({ event, id: 1, payload })),
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++callbackId, callback); return callbackId; },
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (['plugin:updater|download', 'checkpoint_workbench_sessions', 'plugin:updater|install', 'plugin:process|restart'].includes(command)) {
            control.calls.push(command);
            if (command === 'checkpoint_workbench_sessions' && control.checkpointFails) throw new Error('checkpoint failed');
            return command === 'plugin:updater|download' ? 2 : null;
          }
          if (command === 'plugin:event|listen') { handlers.set(args.event, [...(handlers.get(args.event) ?? []), args.handler]); return args.handler; }
          if (command === 'plugin:event|unlisten') return null;
          if (command === 'plugin:app|version') return '0.4.29';
          if (command === 'plugin:updater|check') { control.checks++; return control.checkResult; }
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: [], theme }, tools: [] };
          if (command === 'list_cli_adapters') return { registered: [], managedIds: [], preservedUnknown: [] };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [], presets: [], cliMode: 'normal', projectMode: 'normal' };
          return [];
        },
      },
    });
  }, theme);
  await loadApp(page);
}

test('an automatic update offer surfaces in the sidebar and opens the settings card', async ({ page }, testInfo) => {
  await setup(page);
  const nav = page.getByRole('complementary');
  await expect(nav.getByRole('button', { name: /已发布/ })).toHaveCount(0);
  await page.evaluate(() => (window as any).__updateTest.emit('cliora:update-available', { version: '0.5.0', notes: '## 新功能\n- 全新安装进度窗口\n- MCP 编辑器重做' }));
  const chip = nav.getByRole('button', { name: '栖点 0.5.0 已发布，点击查看更新内容' });
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('新版本 0.5.0');
  await chip.click();
  const card = page.locator('#app-update');
  await expect(card.getByRole('status')).toHaveText('发现新版本 0.5.0');
  await expect(card.getByText('0.5.0 更新内容')).toBeVisible();
  await expect(card.getByRole('heading', { name: '新功能' })).toBeVisible();
  await expect(card.getByRole('listitem').filter({ hasText: '全新安装进度窗口' })).toBeVisible();
  await expect(card.getByRole('button', { name: '下载并安装' })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('app-update.png') });
});

test('a manual check without a release reports the current version is latest', async ({ page }) => {
  await setup(page);
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  const card = page.locator('#app-update');
  await expect(card.getByText('v0.4.29')).toBeVisible();
  await card.getByRole('button', { name: '检查更新' }).click();
  await expect(card.getByRole('status')).toHaveText('已是最新版本。');
  await expect(page.getByRole('complementary').getByRole('button', { name: /已发布/ })).toHaveCount(0);
});

for (const fails of [false, true]) test(`updater checkpoints sessions before Windows installer exits (checkpoint fails: ${fails})`, async ({ page }) => {
  await setup(page);
  await page.evaluate(fails => {
    const control = (window as any).__updateTest.control;
    control.checkResult = { rid: 1, version: '0.5.0', currentVersion: '0.4.29', body: 'test update' };
    control.checkpointFails = fails;
  }, fails);
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  const card = page.locator('#app-update');
  await card.getByRole('button', { name: '检查更新' }).click();
  await card.getByRole('button', { name: '下载并安装' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__updateTest.control.calls)).toEqual(fails
    ? ['plugin:updater|download', 'checkpoint_workbench_sessions']
    : ['plugin:updater|download', 'checkpoint_workbench_sessions', 'plugin:updater|install', 'plugin:process|restart']);
  if (fails) await expect(card.getByText(/checkpoint failed/)).toBeVisible();
});

test('settings open on General with the update card in view, and keep the chosen category', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 760 });
  await setup(page);
  const nav = page.getByRole('navigation', { name: '页面' });
  await nav.getByRole('button', { name: '设置', exact: true }).click();
  const categories = page.getByRole('tablist', { name: '设置分类' });
  await expect(categories.getByRole('tab', { name: '通用', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#app-update')).toBeInViewport();
  await expect(page.locator('#app-update').getByRole('button', { name: '检查更新' })).toBeVisible();
  // A category stays chosen while the page is left and revisited.
  await categories.getByRole('tab', { name: '迁移与同步', exact: true }).click();
  await nav.getByRole('button', { name: '首页', exact: true }).click();
  await nav.getByRole('button', { name: '设置', exact: true }).click();
  await expect(categories.getByRole('tab', { name: '迁移与同步', exact: true })).toHaveAttribute('aria-selected', 'true');

  // Below 900px the categories become one row above the settings, without a sideways page scroll.
  await page.setViewportSize({ width: 899, height: 760 });
  await categories.getByRole('tab', { name: 'CLI 工具', exact: true }).click();
  await expect(page.locator('#settings-managed')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

