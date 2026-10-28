import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page, theme = 'light') {
  await page.addInitScript((theme) => {
    const callbacks = new Map<number, (event: unknown) => void>();
    const handlers = new Map<string, number[]>();
    let callbackId = 0;
    const control = { checkResult: null as null | Record<string, unknown>, checks: 0 };
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
  await page.goto('/');
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

test('the General tab lists its sections beside them from 900px and scrolls to the one chosen', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 760 });
  await setup(page);
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  const anchors = page.getByRole('navigation', { name: '本页目录' });
  await expect(anchors).toBeVisible();
  await expect(anchors.getByRole('link')).toHaveText(['管理的 CLI', '界面', '更新', '外部终端', '远程 SSH', '其它']);
  await anchors.getByRole('link', { name: '其它' }).click();
  await expect(page.locator('#settings-other')).toBeInViewport();
  await expect(anchors.getByRole('link', { name: '其它' })).toHaveAttribute('aria-current', 'true');
  await anchors.getByRole('link', { name: '更新' }).click();
  await expect(page.locator('#app-update')).toBeInViewport();
  await expect(page.locator('#app-update').getByRole('button', { name: '检查更新' })).toBeVisible();

  await page.setViewportSize({ width: 899, height: 760 });
  await expect(anchors).toBeHidden();
  await expect(page.locator('#settings-managed')).toBeVisible();
});
