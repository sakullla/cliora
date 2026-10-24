import { expect, test, type Page } from '@playwright/test';

// Regression proof for the devin capability flip, expressed with a synthetic
// descriptor and fixture ids only (never a real CLI name): agents/plugins tabs
// driven by the management bits, a plugin capability without enable/disable
// actions, and resource entries for both MCP layouts. Synthetic IPC does not
// establish native platform acceptance; see docs/verification/devin-agents-plugins.md.
async function setup(page: Page) {
  await page.addInitScript(() => {
    const management = { accounts: false, mcp: true, skills: true, agents: true, plugins: true, projectPlugins: false, rules: { global: true, project: true } };
    const root = '/fixture/plugins/fixture';
    const entry = {
      id: 'fixture', name: 'Fixture plugin', source: 'fixture', version: '1.0.0', scope: 'user', enabled: null, state: 'installed_load_unknown', policy: 'AVAILABLE · NONE', readOnly: false, root,
      resources: [
        { kind: 'rules', path: `${root}/rules`, ownerId: 'fixture' },
        { kind: 'rules', path: `${root}/AGENTS.md`, ownerId: 'fixture' },
        { kind: 'hooks', path: `${root}/hooks.json`, ownerId: 'fixture' },
        { kind: 'mcp', path: `${root}/.mcp.json`, ownerId: 'fixture' },
        { kind: 'mcp', path: `${root}/mcp.json`, ownerId: 'fixture' },
      ],
    };
    const state = { calls: [] as Array<{ command: string; args: any }> };
    Object.assign(window, { isTauri: true, capabilitiesHarness: state, __TAURI_INTERNALS__: { invoke: async (command: string, args: any) => {
      state.calls.push({ command, args });
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['capable'], theme: 'system' }, tools: [{ id: 'capable', name: 'Capable CLI' }] };
      if (command === 'list_cli_adapters') return { registered: [{ id: 'capable', name: 'Capable CLI', interfaceFormats: ['openai_responses'], management }], managedIds: ['capable'], preservedUnknown: [] };
      if (command === 'list_projects') return [{ id: 'project', name: '测试项目', path: '/fixture/project', available: true, selectedProfiles: {}, appliedProfiles: {} }];
      if (command === 'get_registered_tool_workspace') return { probe: { tool: args.toolId, selectedPath: '/fixture/cli', installations: [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [], dependencies: [] }, profiles: [], binding: null, common: null, snapshots: [], recoveryNeeded: [], customPath: null };
      if (command === 'scan_native_plugins') return { target: args.target, capability: { version: '3000.11.205', sources: 'GitHub owner/repo 或本地路径', actions: ['install', 'update', 'uninstall'], project: false, detail: '' }, entries: [entry], baseline: 'fixture-baseline', detail: '' };
      if (command === 'account_capabilities') return [];
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

test('global scope shows agents and plugins tabs while the memory entry stays hidden without scans', async ({ page }) => {
  await setup(page);
  for (const name of ['MCP', 'Skill', 'Agents', '插件']) await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '记忆', exact: true })).toHaveCount(0);
  const memoryCalls = () => page.evaluate(() => (window as any).capabilitiesHarness.calls.filter((call: any) => call.command.toLowerCase().includes('memor')));
  await page.getByRole('tab', { name: '插件', exact: true }).click();
  await expect(page.getByText('Fixture plugin', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  expect(await memoryCalls()).toEqual([]);
});

test('a projectPlugins=false capability hides the plugins tab in project scope but keeps agents', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '配置范围' }).click();
  await page.getByRole('option', { name: '测试项目' }).click();
  await expect(page.getByRole('tab', { name: '插件', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Agents', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '配置范围' }).click();
  await page.getByRole('option', { name: '全局配置' }).click();
  await expect(page.getByRole('tab', { name: '插件', exact: true })).toBeVisible();
});

test('a capability without enable or disable only offers update and uninstall per row', async ({ page }) => {
  await setup(page);
  await page.getByRole('tab', { name: '插件', exact: true }).click();
  const card = page.getByRole('listitem').filter({ has: page.getByText('Fixture plugin', { exact: true }) });
  await card.getByRole('button').click();
  const details = page.getByLabel('插件详情', { exact: true });
  await expect(details.getByRole('button', { name: '更新', exact: true })).toBeVisible();
  await expect(details.getByRole('button', { name: '卸载', exact: true })).toBeVisible();
  await expect(details.getByRole('button', { name: '启用', exact: true })).toHaveCount(0);
  await expect(details.getByRole('button', { name: '禁用', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '安装插件' })).toBeVisible();
});

test('plugin resources render rules, hooks, and both mcp layout entries', async ({ page }) => {
  await setup(page);
  await page.getByRole('tab', { name: '插件', exact: true }).click();
  const card = page.getByRole('listitem').filter({ has: page.getByText('Fixture plugin', { exact: true }) });
  await card.getByRole('button').click();
  const details = page.getByLabel('插件详情', { exact: true });
  const root = '/fixture/plugins/fixture';
  await expect(details.locator('li')).toHaveCount(5);
  const resources = details.locator('li');
  const expected = [['rules', 'rules'], ['rules', 'AGENTS.md'], ['hooks', 'hooks.json'], ['mcp', '.mcp.json'], ['mcp', 'mcp.json']] as const;
  for (const [index, [kind, suffix]] of expected.entries()) {
    await expect(resources.nth(index).getByText(kind, { exact: true })).toBeVisible();
    await expect(resources.nth(index).getByText(`${root}/${suffix}`, { exact: true })).toBeVisible();
  }
});
