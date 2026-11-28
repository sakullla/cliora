import { type Locator, type Page } from '@playwright/test';
import { expect, test } from './sharedPage';
import { openCli } from './cli-switcher';

// R2: the capability tabs come from each CLI's registry descriptor (`management`), so two CLIs with
// different descriptors show different tab sets. That shared UI has no CLI-ID branches is covered by
// tests/native/adapter-architecture.test.mjs (02 ADR-7).

const catalog = [
  { id: 'alpha', name: 'Alpha CLI', management: { accounts: true, mcp: true, skills: true, agents: true, plugins: true, projectPlugins: true, memoryReason: '记忆目录尚未扫描' } },
  { id: 'beta', name: 'Beta CLI', management: { accounts: true, mcp: true, skills: false, agents: false, plugins: false, projectPlugins: false } },
];

const tabsFor = (management: Record<string, unknown>) => [
  '配置',
  ...(management.accounts ? ['账号'] : []),
  ...(management.mcp ? ['MCP'] : []),
  ...(management.skills ? ['Skill'] : []),
  ...(management.agents ? ['Agents'] : []),
  ...(management.plugins ? ['插件'] : []),
  ...(management.memory || management.memoryReason ? ['记忆'] : []),
];

async function install(page: Page) {
  await page.addInitScript((tools) => {
    const calls: Array<{ command: string; args: any }> = [];
    Object.assign(window, { isTauri: true, __calls: calls, __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
      calls.push({ command, args });
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: tools.map((tool) => tool.id), theme: 'light' }, tools: tools.map(({ id, name }) => ({ id, name })) };
      if (command === 'list_cli_adapters') return { registered: tools.map((tool) => ({ ...tool, interfaceFormats: ['openai_responses'] })), managedIds: tools.map((tool) => tool.id), preservedUnknown: [] };
      if (command === 'get_registered_tool_workspace') return { probe: { tool: args.toolId, selectedPath: '/fixture/cli', installations: [{ path: '/fixture/cli', version: '1.0.0', status: 'available', source: 'native' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [], dependencies: [] }, profiles: [], binding: null, common: null, snapshots: [], recoveryNeeded: [], customPath: null, effectiveContextId: 'ctx' };
      if (command === 'get_registered_tool_context') return { effectiveContextId: 'ctx', nativeContextError: null };
      if (command === 'account_capabilities') return tools.map((tool) => ({ toolId: tool.id, managedLogin: false, methods: [], reason: 'fixture' }));
      if (command === 'discover_native_logins') return { toolId: args.toolId, checkedAt: 1, logins: [] };
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command.startsWith('plugin:event|')) return 1;
      if (command.startsWith('list_') || command === 'usage_presets' || command === 'scan_native_skills') return [];
      return null;
    } } });
  }, catalog);
}

test('two CLIs with different management descriptors show different capability tabs', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await install(page);
  await page.goto('/');
  const tabs = page.getByRole('tablist', { name: '当前任务' }).getByRole('tab');
  const seen: string[][] = [];
  for (const tool of catalog) {
    await openCli(page, tool.name);
    await expect(page.getByRole('heading', { name: tool.name, level: 2 })).toBeVisible();
    await expect(tabs).toHaveText(tabsFor(tool.management));
    seen.push(await tabs.allTextContents());
  }
  expect(seen[0]).not.toEqual(seen[1]);

  // An entry the descriptor does not declare is absent, not merely disabled; switching back restores it.
  for (const name of ['Skill', 'Agents', '插件', '记忆']) await expect(page.getByRole('tab', { name, exact: true })).toHaveCount(0);
  await openCli(page, 'Alpha CLI');
  await page.getByRole('tab', { name: '记忆', exact: true }).click();
  await expect(page.getByText('记忆目录尚未扫描')).toBeVisible();

  // Beta never declared skills, agents or plugins, so no scan for them was issued.
  const betaScans = await page.evaluate(() => (window as unknown as { __calls: Array<{ command: string; args: any }> }).__calls
    .filter((call) => /^scan_native_(skills|agents|plugins)$|^preview_native_plugins$/.test(call.command) && (call.args?.target?.toolId === 'beta' || call.args?.toolId === 'beta'))
    .map((call) => call.command));
  expect(betaScans).toEqual([]);
});

// Tab semantics follow RecordsPage's records-*-tab/-panel pattern: the tab names its panel via
// aria-controls and the panel labels itself back via aria-labelledby. Panels render lazily per
// tab, so each tab is activated in turn before its link is checked; while a tab is active its
// panel is the only tabpanel the accessibility tree exposes.
async function expectLinkedPanel(page: Page, tab: Locator) {
  const tabId = await tab.getAttribute('id');
  const panelId = await tab.getAttribute('aria-controls');
  expect(tabId, 'tab carries an id for the panel to point back at').toBeTruthy();
  expect(panelId, 'tab names its panel via aria-controls').toBeTruthy();
  const panel = page.locator(`#${panelId}`);
  await expect(panel).toHaveCount(1);
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('role', 'tabpanel');
  await expect(panel).toHaveAttribute('aria-labelledby', tabId as string);
  await expect(page.getByRole('tabpanel')).toHaveCount(1);
}

test('every capability tab points at its own panel, which labels the tab back', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await install(page);
  await page.goto('/');
  for (const tool of catalog) {
    await openCli(page, tool.name);
    await expect(page.getByRole('heading', { name: tool.name, level: 2 })).toBeVisible();
    const tabs = page.getByRole('tablist', { name: '当前任务' }).getByRole('tab');
    const total = await tabs.count();
    expect(total).toBe(tabsFor(tool.management).length);
    for (let index = 0; index < total; index++) {
      const tab = tabs.nth(index);
      await tab.click();
      await expectLinkedPanel(page, tab);
    }
  }
});

test('every library section tab points at its own panel, which labels the tab back', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await install(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  const tabs = page.getByRole('tablist', { name: '资料类型' }).getByRole('tab');
  await expect(tabs).toHaveCount(4);
  for (let index = 0; index < 4; index++) {
    const tab = tabs.nth(index);
    await tab.click();
    await expectLinkedPanel(page, tab);
  }
});
