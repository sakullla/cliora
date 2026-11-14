import { expect, test } from '@playwright/test';
import { installConfigurationWorkspace } from './configuration-workspace-fixture';

test('settings modal keeps wheel inside the active category, searches across categories, and peels Escape in layers', async ({ page }) => {
  await page.addInitScript(() => {
    let managed = ['codex', 'claude_code'];
    let theme = 'light';
    const icons: Record<string, string> = {};
    const names: Record<string, string> = { codex: 'Codex', claude_code: 'Claude Code', kimi_code: 'Kimi Code' };
    const bootstrap = () => ({
      preferences: { schema_version: 1, managed_tools: managed, theme, remote_ssh_enabled: true, tool_icons: { ...icons } },
      tools: Object.entries(names).map(([id, name]) => ({ id, name, installation: 'not_checked', configuration: 'not_checked' })),
    });
    const catalog = () => ({
      registered: Object.entries(names).map(([id, name]) => ({
        id,
        name,
        interfaceFormats: ['openai_chat'],
        launchForm: 'terminal',
        yoloAvailable: true,
        nativeConfig: { state: 'available', reason: '' },
        launch: { state: 'available', reason: '' },
        resume: { state: 'available', reason: '' },
        resources: { state: 'available', reason: '' },
        history: { state: 'available', reason: '' },
      })),
      managedIds: managed,
      preservedUnknown: [{ id: 'legacy_cli', profileCount: 2 }],
    });
    Object.assign(window, {
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: () => 0,
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap' || command === 'set_language') return bootstrap();
          if (command === 'set_theme') { theme = String(args.theme); return bootstrap(); }
          if (command === 'set_tool_icon') {
            if (args.dataUrl) icons[args.toolId] = String(args.dataUrl);
            else delete icons[args.toolId];
            return bootstrap();
          }
          if (command === 'list_cli_adapters' || command === 'set_registered_managed_tools') {
            if (command === 'set_registered_managed_tools') managed = args.managedIds ?? managed;
            return catalog();
          }
          if (command === 'get_launch_settings') {
            return { selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }], cliMode: 'normal', projectMode: 'normal', presets: [] };
          }
          if (command === 'get_tray_status') return { available: true, error: null };
          if (command === 'plugin:app|version') return '0.4.131';
          if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
          return [];
        },
      },
    });
  });

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '首页', level: 1 })).toBeVisible();

  // Mod+, opens the centered modal without replacing the underlying page or title.
  await page.keyboard.press('ControlOrMeta+Comma');
  const modal = page.getByRole('dialog', { name: '设置' });
  await expect(modal).toBeVisible();
  await expect.poll(() => page.title()).toBe('首页 · Cliora');

  const categories = modal.getByRole('tablist', { name: '设置分类' });
  expect(await categories.getByRole('tab').evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('aria-label')))).toEqual([
    '通用', 'CLI 工具', '终端与启动', '工作树', '远程主机', '同步与备份',
  ]);
  const general = categories.getByRole('tab', { name: '通用', exact: true });
  await expect(general).toHaveAttribute('aria-selected', 'true');

  // Wheel at the top or bottom boundary stays inside the current category instead of jumping tabs.
  await modal.locator('#app-update').hover();
  for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, 240);
  await expect(general).toHaveAttribute('aria-selected', 'true');
  for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, -240);
  await expect(general).toHaveAttribute('aria-selected', 'true');

  // Cross-category instant search finds YOLO under Terminal & launch, and no-match is recoverable.
  const search = modal.getByRole('searchbox', { name: '搜索设置' });
  await search.fill('zzzz-no-match');
  await expect(modal.getByText('没有找到相关设置')).toBeVisible();
  await modal.getByRole('button', { name: '清空搜索' }).last().click();
  await expect(search).toHaveValue('');

  await search.fill('YOLO');
  await expect(modal.getByRole('region', { name: '设置搜索结果' }).getByText('终端与启动', { exact: true })).toBeVisible();
  // First Escape clears the search query while keeping the modal open.
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(modal).toBeVisible();

  // Selecting a search hit jumps straight to its category and clears the query.
  await search.fill('YOLO');
  await search.press('Enter');
  await expect(categories.getByRole('tab', { name: '终端与启动', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(modal.locator('#settings-terminal')).toBeVisible();

  // Unified CLI tools list: enable switch + inline custom icon upload/validation/restore, no second <details>.
  await categories.getByRole('tab', { name: 'CLI 工具', exact: true }).click();
  await expect(modal.locator('details.icon-settings')).toHaveCount(0);
  const codexRow = modal.locator('.managed-tool-row').filter({ hasText: 'Codex' });
  await expect(codexRow.getByRole('switch', { name: 'Codex' })).toBeChecked();
  await expect(codexRow.getByRole('button', { name: '恢复默认' })).toHaveCount(0);
  await expect(modal.getByText('legacy_cli')).toBeVisible();
  await expect(modal.getByText('保留 2 份配置')).toBeVisible();

  // Reject oversized (>128 KB) icon without replacing the default icon.
  await codexRow.getByLabel('Codex 自定义图标').setInputFiles({
    name: 'too-big.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(130 * 1024, 1),
  });
  await expect(modal.locator('#settings-managed').getByRole('alert')).toContainText('128 KB');
  await expect(codexRow.getByRole('button', { name: '恢复默认' })).toHaveCount(0);

  // Valid PNG updates the icon and reveals Restore default; restoring hides it again.
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR2kAAAAASUVORK5CYII=';
  await codexRow.getByLabel('Codex 自定义图标').setInputFiles({
    name: 'ok.png',
    mimeType: 'image/png',
    buffer: Buffer.from(base64, 'base64'),
  });
  await expect(codexRow.locator('img')).toHaveAttribute('src', `data:image/png;base64,${base64}`);
  await expect(codexRow.getByText('自定义图标')).toBeVisible();
  await codexRow.getByRole('button', { name: '恢复默认' }).click();
  await expect(codexRow.getByRole('button', { name: '恢复默认' })).toHaveCount(0);

  // Layered Escape: closing a top confirmation dialog leaves Settings open; next Escape closes Settings.
  await categories.getByRole('tab', { name: '通用', exact: true }).click();
  await modal.getByRole('region', { name: '关闭与托盘', exact: true }).getByRole('button', { name: '完全退出' }).click();
  await expect(page.getByRole('dialog', { name: '完全退出栖点？' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '完全退出栖点？' })).toHaveCount(0);
  await expect(modal).toBeVisible();

  // Narrow desktop minimum (720px): horizontal category bar without sideways overflow.
  await page.setViewportSize({ width: 720, height: 760 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
});

test('opening settings over an unsaved tool configuration draft never prompts to discard changes', async ({ page }) => {
  await installConfigurationWorkspace(page, 'codex');
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具', exact: true }).click();
  await page.getByRole('button', { name: '新建配置', exact: true }).click();
  const nameInput = page.getByRole('dialog').getByLabel('配置名称');
  await nameInput.fill('未保存草稿');

  // The draft dialog owns pointer input, so exercise the shell action directly — the same
  // approach the remote-session tests use. Opening Settings must not run canLeave.
  await page.locator('nav button[aria-label="设置"]').dispatchEvent('click');
  const settings = page.getByRole('dialog', { name: '设置' });
  await expect(settings).toBeVisible();
  await expect(page.getByRole('dialog', { name: '放弃未保存修改？' })).toHaveCount(0);

  // One Escape peels Settings; the draft underneath keeps its unsaved text.
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(page.getByRole('dialog').getByLabel('配置名称')).toHaveValue('未保存草稿');

  // A real page transition still asks once — visiting Settings consumed nothing.
  await page.locator('nav button[aria-label="首页"]').dispatchEvent('click');
  const discard = page.getByRole('dialog', { name: '放弃未保存修改？' });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('配置名称')).toHaveValue('未保存草稿');
});

test('in-panel sub-views hand Escape back to the category and Mod+S saves the active form', async ({ page }) => {
  await page.addInitScript(() => {
    const target = { id: 'h1', name: 'fixture', host: 'key.invalid', port: 22, user: 'fixture', authMethod: 'key', identityFile: null, sshConfig: null, defaultPath: null, enabled: true, createdAt: 0, updatedAt: 0 };
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        transformCallback: () => 0,
        invoke: async (command: string, args: Record<string, unknown> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: [], theme: 'light', remote_ssh_enabled: true }, tools: [] };
          if (command === 'list_cli_adapters') return { registered: [], managedIds: [], preservedUnknown: [] };
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_remote_targets') return [{ ...target }];
          if (command === 'list_remote_saved_passwords') return [];
          if (command === 'save_remote_target') {
            const incoming = args.target as typeof target;
            (window as unknown as { __hostSaved?: unknown }).__hostSaved = incoming;
            return { ...target, ...incoming };
          }
          if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
          return [];
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '远程主机', exact: true }).click();
  await page.getByRole('button', { name: '编辑 fixture', exact: true }).click();
  const editor = page.getByRole('region', { name: '编辑主机', exact: true });
  await expect(editor).toBeVisible();
  await expect(page.getByRole('button', { name: '添加主机', exact: true })).toHaveCount(0);

  // Escape inside the sub-view returns to the host list; Settings stays open.
  await editor.getByLabel(/^主机地址/).press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible();
  await expect(page.getByRole('button', { name: '添加主机', exact: true })).toBeVisible();

  // The back button does the same, and Mod+S submits the form it frames.
  await page.getByRole('button', { name: '编辑 fixture', exact: true }).click();
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: '返回', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page.getByRole('button', { name: '编辑 fixture', exact: true }).click();
  await editor.getByLabel(/^显示名称/).fill('renamed');
  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __hostSaved?: { name?: string } }).__hostSaved?.name)).toBe('renamed');
  await expect(page.getByRole('region', { name: '编辑主机', exact: true })).toHaveCount(0);
});
