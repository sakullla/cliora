import { expect, test } from '@playwright/test';

test('a delayed sync refresh cannot undo a newer theme choice', async ({ page }) => {
  await page.addInitScript(() => {
    let theme = 'light';
    let hold = false;
    let release: (() => void) | undefined;
    const callbacks: Array<(event: { payload: unknown }) => void> = [];
    const listeners: Record<string, number> = {};
    const bootstrap = () => ({ preferences: { schema_version: 1, managed_tools: ['codex'], theme, language: 'zh', remote_ssh_enabled: false }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] });
    Object.assign(window, {
      isTauri: true,
      __holdRefresh: () => { hold = true; callbacks[listeners['cliora:portable-changed']]({ payload: null }); },
      __refreshWaiting: () => !!release,
      __releaseRefresh: () => release?.(),
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (event: { payload: unknown }) => void) => { callbacks.push(callback); return callbacks.length - 1; },
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === 'get_bootstrap') {
            const snapshot = bootstrap();
            if (hold) { hold = false; await new Promise<void>(resolve => { release = resolve; }); }
            return snapshot;
          }
          if (command === 'set_theme') { theme = String(args.theme); return bootstrap(); }
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], launchForm: 'terminal' }], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [] };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'plugin:event|listen') { listeners[String(args.event)] = Number(args.handler); return args.handler; }
          return [];
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  await page.evaluate(() => (window as unknown as { __holdRefresh: () => void }).__holdRefresh());
  await expect.poll(() => page.evaluate(() => (window as unknown as { __refreshWaiting: () => boolean }).__refreshWaiting())).toBe(true);
  await page.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => (window as unknown as { __releaseRefresh: () => void }).__releaseRefresh());
  // Allow the released IPC and React render to settle before checking the choice.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

// R7: browser preview can switch the view but cannot claim a persisted setting.
test('browser preview changes the theme without claiming it was saved', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByText('主题已保存。')).toHaveCount(0);
});

// R7: the General tab groups everyday choices by task, each ordinary write says whether it
// landed, and the dangerous quit action asks first. Anything unconfirmed stays silent.
test('settings group preferences by task, confirm each save, and confirm the quit action', async ({ page }) => {
  await page.addInitScript(() => {
    let theme = 'light';
    let managed = ['codex'];
    const state = { quit: 0 };
    const descriptor = { id: 'codex', name: 'Codex', interfaceFormats: [], launchForm: 'terminal' };
    const bootstrap = () => ({ preferences: { schema_version: 1, managed_tools: managed, theme, language: 'zh', remote_ssh_enabled: true, tool_icons: {} }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] });
    Object.assign(window, {
      isTauri: true,
      __preferenceSettings: state,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: () => 0,
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap' || command === 'set_language') return bootstrap();
          if (command === 'set_theme') { theme = String(args.theme); return bootstrap(); }
          if (command === 'list_cli_adapters' || command === 'set_registered_managed_tools') {
            if (command === 'set_registered_managed_tools') managed = args.managedIds;
            return { registered: [descriptor], managedIds: managed, preservedUnknown: [] };
          }
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }], cliMode: 'normal', projectMode: 'normal', presets: [] };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'quit_app') { state.quit += 1; return null; }
          if (command === 'plugin:app|version') return '0.4.92';
          if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
          return [];
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();

  // Settings are one category at a time, chosen from a list of six; General opens first.
  const categories = page.getByRole('tablist', { name: '设置分类' });
  expect(await categories.getByRole('tab').evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('aria-label')))).toEqual(['通用', 'CLI 工具', '启动', '工作树', '远程主机', '迁移与同步']);
  await expect(categories.getByRole('tab', { name: '通用', exact: true })).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByRole('tabpanel', { name: '通用' });
  await expect(panel.getByRole('radiogroup', { name: '主题' })).toBeVisible();
  await expect(panel.locator('#settings-other')).toBeVisible();
  await expect(page.getByText('回看首页的首次使用三步清单', { exact: true })).toBeVisible();
  const surface = await page.locator('#settings-interface').evaluate((element) => {
    const style = getComputedStyle(element);
    return { shadow: style.boxShadow, background: style.backgroundImage };
  });
  expect(surface).toEqual({ shadow: 'none', background: 'none' });

  // A theme write is announced only once the stored preference comes back.
  await panel.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('#settings-interface').getByRole('status')).toHaveText('主题已保存。');

  // Quitting is destructive and irreversible in this window, so it asks and names the effect.
  const tray = page.getByRole('region', { name: '关闭与托盘', exact: true });
  await tray.getByRole('button', { name: '完全退出' }).click();
  const confirm = page.getByRole('dialog', { name: '完全退出栖点？' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__preferenceSettings.quit)).toBe(0);
  await tray.getByRole('button', { name: '完全退出' }).click();
  await page.getByRole('dialog', { name: '完全退出栖点？' }).getByRole('button', { name: '完全退出', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__preferenceSettings.quit)).toBe(1);

  // Arrow keys move between categories; the managed CLIs live under CLI tools.
  await categories.getByRole('tab', { name: '通用', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(categories.getByRole('tab', { name: 'CLI 工具', exact: true })).toBeFocused();
  await expect(categories.getByRole('tab', { name: 'CLI 工具', exact: true })).toHaveAttribute('aria-selected', 'true');
  // The same for a managed CLI: the confirmation names the tool it changed.
  await page.locator('#settings-managed').getByRole('checkbox', { name: 'Codex', exact: true }).uncheck();
  await expect(page.locator('#settings-managed').getByRole('status')).toHaveText('已保存「Codex」的显示设置。');
  await categories.getByRole('tab', { name: '启动', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: '启动' }).getByRole('combobox', { name: '启动终端', exact: true })).toBeVisible();

  // 640 keeps the categories in one scrolling row without a sideways page scroll.
  await page.setViewportSize({ width: 640, height: 800 });
  await categories.getByRole('tab', { name: 'CLI 工具', exact: true }).click();
  await expect(page.locator('#settings-managed')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
