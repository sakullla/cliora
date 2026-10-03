import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page) {
  await page.addInitScript(() => {
    const full = { accounts: true, mcp: true, skills: true, agents: true, plugins: true, projectPlugins: false };
    const none = { accounts: false, mcp: false, skills: false, agents: false, plugins: false, projectPlugins: false };
    const state = { calls: [] as Array<{ command: string; args: any }> };
    Object.assign(window, { isTauri: true, capabilitiesHarness: state, __TAURI_INTERNALS__: { invoke: async (command: string, args: any) => {
      state.calls.push({ command, args });
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['supported', 'unsupported'], theme: 'system' }, tools: [{ id: 'supported', name: 'Supported CLI' }, { id: 'unsupported', name: 'Unsupported CLI' }] };
      if (command === 'list_cli_adapters') return { registered: [{ id: 'supported', name: 'Supported CLI', interfaceFormats: ['openai_responses'], management: full }, { id: 'unsupported', name: 'Unsupported CLI', interfaceFormats: ['openai_responses'], management: none }], managedIds: ['supported', 'unsupported'], preservedUnknown: [] };
      if (command === 'list_projects') return [{ id: 'project', name: '测试项目', path: '/fixture/project', available: true, selectedProfiles: {}, appliedProfiles: {} }];
      if (command === 'get_registered_tool_workspace') return { probe: { tool: args.toolId, selectedPath: '/fixture/cli', installations: [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [], dependencies: [] }, profiles: [], binding: null, common: null, snapshots: [], recoveryNeeded: [], customPath: null };
      if (command === 'account_capabilities') return [{ toolId: 'supported', managedLogin: true, methods: ['browser'], reason: 'fixture' }];
      if (command === 'scan_native_plugins') return { target: args.target, capability: { version: '1.0.0', sources: 'package', actions: ['install'], project: false, detail: '' }, entries: [], baseline: 'fixture', detail: '' };
      if (['list_accounts', 'list_usage_queries', 'list_usage_cache', 'usage_presets'].includes(command)) return [];
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command.startsWith('plugin:event|')) return 1;
      return null;
    } } });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
}

test('unsupported management tabs are hidden and switching tools leaves no unsupported scan', async ({ page }) => {
  await setup(page);
  await page.getByRole('tab', { name: '插件', exact: true }).click();
  await expect(page.getByLabel('原生插件管理')).toBeVisible();
  await page.getByRole('tab', { name: 'Unsupported CLI', exact: true }).click();
  for (const name of ['账号', 'MCP', 'Skill', 'Agents', '插件']) await expect(page.getByRole('tab', { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '配置', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('原生插件管理')).toHaveCount(0);
  const unsupportedCalls = await page.evaluate(() => (window as any).capabilitiesHarness.calls.filter((call: any) => call.args?.target?.toolId === 'unsupported'));
  expect(unsupportedCalls).toEqual([]);
});

test('a global-only plugin capability disappears in project scope and returns in global scope', async ({ page }) => {
  await setup(page);
  await page.getByRole('tab', { name: '插件', exact: true }).click();
  await page.getByRole('button', { name: '配置范围' }).click();
  await page.getByRole('option', { name: '测试项目' }).click();
  await expect(page.getByRole('tab', { name: '插件', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '配置', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '配置范围' }).click();
  await page.getByRole('option', { name: '全局配置' }).click();
  await expect(page.getByRole('tab', { name: '插件', exact: true })).toBeVisible();
});
