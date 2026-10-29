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
      if (command === 'inspect_native_plugin') return { pluginId: args.pluginId, root, manifest: { description: null, author: null, homepage: null, license: null, keywords: [], path: null }, items: [
        { kind: 'rules', name: 'rules', description: null, path: `${root}/rules/style.md`, location: `${root}/rules`, format: 'markdown' },
        { kind: 'rules', name: 'AGENTS.md', description: null, path: `${root}/AGENTS.md`, location: `${root}/AGENTS.md`, format: 'markdown' },
        { kind: 'hooks', name: 'PreToolUse', description: '1', path: `${root}/hooks.json`, location: `${root}/hooks.json`, format: 'json' },
        { kind: 'mcp', name: 'docs', description: null, path: `${root}/.mcp.json`, location: `${root}/.mcp.json`, format: 'json' },
        { kind: 'mcp', name: 'search', description: null, path: `${root}/mcp.json`, location: `${root}/mcp.json`, format: 'json' },
      ], truncated: false };
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
  await expect(page.getByRole('button', { name: '安装新插件', exact: true })).toBeEnabled();
});

test('plugin resources render rules, hooks, and both mcp layout entries', async ({ page }) => {
  await setup(page);
  await page.getByRole('tab', { name: '插件', exact: true }).click();
  const card = page.getByRole('listitem').filter({ has: page.getByText('Fixture plugin', { exact: true }) });
  await card.getByRole('button').click();
  const details = page.getByLabel('插件详情', { exact: true });
  const items = details.getByRole('list', { name: '插件内容' }).getByRole('listitem');
  await expect(items).toHaveCount(5);
  const expected = [['规则', 'rules'], ['规则', 'AGENTS.md'], ['Hook', '1 个处理器'], ['MCP 服务', 'docs'], ['MCP 服务', 'search']] as const;
  for (const [index, [kind, text]] of expected.entries()) {
    await expect(items.nth(index)).toContainText(text);
    await expect(details.getByRole('group', { name: '按类型筛选' }).getByRole('button', { name: new RegExp(`^${kind}`) })).toBeVisible();
  }
});
