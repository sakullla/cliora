import { expect, test, type Locator, type Page } from '@playwright/test';

// R3: when a capability read fails, the error and its recovery control stay on the page instead of
// being folded into a row menu (02 ADR-2/ADR-7).

async function install(page: Page) {
  await page.addInitScript(() => {
    const state = { fail: true, calls: 0 };
    const workspace = (toolId: string) => ({
      probe: { tool: toolId, selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '1.0.0', status: 'available', source: 'native' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [] },
      profiles: [{ id: 'daily', tool: toolId, name: '日常', version: 1, inheritCommon: false, files: {}, suppressed: {}, nativeCredentials: {}, connection: null }],
      binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null,
    });
    Object.assign(window, { isTauri: true, __probe: state, __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex' }] };
      if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], management: { accounts: false, mcp: false, skills: false, agents: false, plugins: false, projectPlugins: false } }], managedIds: ['codex'], preservedUnknown: [] };
      if (command === 'get_registered_tool_workspace') {
        state.calls += 1;
        if (state.fail) throw { message: '找不到 Codex 可执行文件' };
        return workspace(args.toolId);
      }
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command.startsWith('plugin:event|')) return 1;
      if (command.startsWith('list_') || command === 'usage_presets') return [];
      return null;
    } } });
  });
}

const heal = (page: Page) => page.evaluate(() => { (window as unknown as { __probe: { fail: boolean } }).__probe.fail = false; });

/** Visible, enabled, and not inside any menu. */
async function expectDirect(control: Locator) {
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled();
  expect(await control.evaluate((el) => !!el.closest('[role="menu"]'))).toBe(false);
}

test('a failed home probe keeps the error, 重新检测 and 编辑配置 on the row', async ({ page }) => {
  await install(page);
  await page.goto('/');
  const tools = page.getByLabel('管理中的工具');
  const row = tools.locator('[data-tool-row]').filter({ hasText: 'Codex' });
  const alert = tools.getByRole('alert');
  await expect(alert).toContainText('Codex 检测失败');
  await expect(alert).toContainText('找不到 Codex 可执行文件');
  await expectDirect(row.getByRole('button', { name: '重新检测', exact: true }));
  await expectDirect(row.getByRole('button', { name: '编辑配置 →', exact: true }));

  await heal(page);
  await row.getByRole('button', { name: '重新检测', exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect(row.getByRole('button', { name: '启动', exact: true })).toBeEnabled();
  // Once healthy, the edit entry moves back into the row menu.
  await expect(row.getByRole('button', { name: '编辑配置 →', exact: true })).toHaveCount(0);
});

test('a failed tool workspace read shows the error and a direct retry on the tools page', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('group', { name: '受管 CLI' }).getByRole('button', { name: 'Codex', exact: true }).click();
  const region = page.getByRole('region', { name: '工具与连接' });
  await expect(region.getByText('配置读取失败', { exact: true })).toBeVisible();
  await expect(page.getByText('找不到 Codex 可执行文件').first()).toBeVisible();
  const retry = region.getByRole('button', { name: '重试读取配置', exact: true });
  await expectDirect(retry);
  await expect(page.getByRole('menu')).toHaveCount(0);

  await heal(page);
  await retry.click();
  await expect(region.getByLabel('配置列表')).toBeVisible();
  await expect(region.getByRole('button', { name: '日常', exact: true })).toBeVisible();
  await expect(region.getByText('配置读取失败', { exact: true })).toHaveCount(0);
});
