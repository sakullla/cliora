import { expect, test, type Locator, type Page } from '@playwright/test';

// The in-page CLI strip moved into the sidebar under 工具与连接 (02 ADR-3/ADR-7). Its overflow,
// selected-item visibility and keyboard coverage now apply to the sidebar list.
const tools = [
  ['codex', 'Codex'],
  ['claude_code', 'Claude Code'],
  ['grok', 'Grok'],
  ['pi', 'Pi'],
  ['open_code', 'OpenCode'],
  ['zcode', 'ZCode'],
  ['qoder_cn', 'Qoder CN'],
  ['kimi_code', 'Kimi Code'],
  ['deepseek', 'DeepSeek Harness'],
  ['codebuddy', 'CodeBuddy'],
  ['mimo_code', 'MiMo Code'],
  ['cline', 'Cline'],
  ['devin', 'Devin'],
  ['command_code', 'Command Code'],
  ['antigravity', 'Antigravity'],
  ['kiro', 'Kiro'],
] as const;

async function setup(page: Page, catalog: ReadonlyArray<readonly [string, string]> = tools) {
  await page.addInitScript((catalog) => {
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: catalog.map((item) => item[0]), theme: 'system' }, tools: catalog.map(([id, name]) => ({ id, name })) };
      if (command === 'list_cli_adapters') return {
        registered: catalog.map(([id, name]) => ({ id, name, interfaceFormats: ['openai_responses'], management: { accounts: false, mcp: false, skills: false, agents: false, plugins: false, projectPlugins: false } })),
        managedIds: catalog.map((item) => item[0]),
        preservedUnknown: [],
      };
      if (command === 'list_projects') return [];
      if (command === 'get_registered_tool_workspace') return { probe: { tool: args.toolId, selectedPath: '/fixture/cli', installations: [{ path: '/fixture/cli', version: '1.0.0', status: 'available', source: 'native' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null }, profiles: [], binding: null, common: null, snapshots: [], recoveryNeeded: [], customPath: null };
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (['list_accounts', 'list_usage_queries', 'list_usage_cache', 'usage_presets', 'list_mcp_definitions', 'list_skill_packages', 'list_library_items', 'list_history_sessions', 'list_portable_items'].includes(command)) return [];
      if (command.startsWith('plugin:event|')) return 1;
      return null;
    } } });
  }, catalog);
}

/** Two CLIs whose Agents view can hold an unsaved inline draft. */
async function setupDirty(page: Page) {
  await page.addInitScript(() => {
    const entry = { id: 'fixture', name: 'reviewer', description: 'Reviews code', path: '/fixture/agents/reviewer.md', format: 'markdown', content: '---\nname: reviewer\ndescription: Reviews code\n---\nReview code.\n', enabled: true, readOnly: false, owner: '独立定义', detail: '' };
    const snapshot = (target: unknown) => ({ target, capability: { version: '1.0.0', supported: true, format: 'markdown', template: entry.content, detail: '下一次委派加载' }, entries: [entry], baseline: 'fixture-baseline', detail: '原生定义管理' });
    const catalog = [['claude_code', 'Claude Code'], ['codex', 'Codex']];
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: catalog.map((item) => item[0]), theme: 'system' }, tools: catalog.map(([id, name]) => ({ id, name })) };
      if (command === 'list_cli_adapters') return { registered: catalog.map(([id, name]) => ({ id, name, interfaceFormats: ['anthropic_messages'] })), managedIds: catalog.map((item) => item[0]), preservedUnknown: [] };
      if (['list_projects', 'list_usage_queries', 'list_usage_cache', 'list_accounts', 'usage_presets', 'list_mcp_definitions', 'list_skill_packages', 'list_library_items', 'list_history_sessions', 'list_portable_items'].includes(command)) return [];
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command.startsWith('plugin:event|')) return 1;
      if (command === 'get_registered_tool_workspace') return { probe: { tool: args.toolId, selectedPath: '/fixture/cli', installations: [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['anthropic_messages'], providerPresets: [], dependencies: [] }, profiles: [], effectiveContextId: 'ctx-fixture', binding: null, snapshots: [], common: null, customPath: null, recoveryNeeded: [] };
      if (command === 'get_registered_tool_context') return { effectiveContextId: 'ctx-fixture', nativeContextError: null };
      if (command === 'scan_native_agents') return snapshot(args.target);
      return null;
    } } });
  });
}

const sidebarList = (page: Page) => page.getByRole('navigation', { name: '页面' }).getByRole('group', { name: '受管 CLI' });
const item = (list: Locator, name: string) => list.getByRole('button', { name, exact: true });

async function itemNames(list: Locator) {
  return list.evaluate((root) => [...root.querySelectorAll<HTMLButtonElement>('button:not([aria-expanded])')].map((node) => node.getAttribute('aria-label') ?? ''));
}

async function expectSidebarFits(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const aside = document.querySelector<HTMLElement>('aside.sidebar');
    if (!aside) return 'missing sidebar';
    const sideways = aside.scrollWidth - aside.clientWidth;
    const doc = document.documentElement.scrollWidth - window.innerWidth;
    return sideways <= 0 && doc <= 0 ? '' : `sidebar ${sideways} doc ${doc}`;
  })).toBe('');
}

test('the sidebar CLI list folds past eight, keeps the selection visible, and never scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await setup(page);
  await page.goto('/');
  const list = sidebarList(page);
  await expect(item(list, 'Codex')).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'CLI' })).toHaveCount(0);
  expect(await itemNames(list)).toEqual(tools.slice(0, 8).map((entry) => entry[1]));
  const more = list.getByRole('button', { name: '更多（8）', exact: true });
  await expect(more).toHaveAttribute('aria-expanded', 'false');

  // Opening a CLI from another page lands on 工具与连接 with that CLI shown and highlighted.
  await item(list, 'Codex').click();
  await expect(page.getByRole('heading', { name: '工具与连接', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Codex', level: 2 })).toBeVisible();
  await expect(item(list, 'Codex')).toHaveAttribute('aria-current', 'true');

  // Expanded, every CLI is reachable; the choice survives a reload.
  await more.click();
  const less = list.getByRole('button', { name: '收起', exact: true });
  await expect(less).toHaveAttribute('aria-expanded', 'true');
  expect(await itemNames(list)).toEqual(tools.map((entry) => entry[1]));
  await item(list, 'Kiro').click();
  await expect(page.getByRole('heading', { name: 'Kiro', level: 2 })).toBeVisible();
  await expect(item(list, 'Kiro')).toHaveAttribute('aria-current', 'true');
  await expect(item(list, 'Codex')).not.toHaveAttribute('aria-current', /.*/);
  await page.reload();
  await expect(less).toBeVisible();

  // Folded again, the selected CLI (past the first eight) takes the last visible slot.
  await item(list, 'Kiro').click();
  await expect(page.getByRole('heading', { name: 'Kiro', level: 2 })).toBeVisible();
  await less.click();
  await expect(more).toBeVisible();
  expect(await itemNames(list)).toEqual([...tools.slice(0, 7).map((entry) => entry[1]), 'Kiro']);
  await expect(item(list, 'Kiro')).toHaveAttribute('aria-current', 'true');
  await expect(item(list, 'Kiro')).toBeInViewport();

  for (const width of [1360, 900, 640]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(item(list, 'Kiro')).toBeVisible();
    await expectSidebarFits(page);
  }

  // Collapsed sidebar: icons only, each with its accessible name.
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.getByRole('button', { name: '折叠侧栏', exact: true }).click();
  await expect.poll(async () => (await page.getByLabel('主导航').boundingBox())?.width ?? 999).toBeLessThan(80);
  const kiro = item(list, 'Kiro');
  await expect(kiro).toBeVisible();
  await expect(kiro.locator('.nav-text')).toBeHidden();
  await expect(kiro.locator('img').first()).toBeVisible();
  await expectSidebarFits(page);
});

test('the sidebar CLI list is one Tab stop walked with arrows, Home and End', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await setup(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接', exact: true }).click();
  const list = sidebarList(page);
  await expect(item(list, 'Codex')).toHaveAttribute('aria-current', 'true');
  expect(await list.evaluate((root) => [...root.querySelectorAll('button')].filter((node) => node.tabIndex === 0).map((node) => node.getAttribute('aria-label')))).toEqual(['Codex']);

  // Tab from the page button reaches the selected CLI, and the next Tab leaves the list.
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(item(list, 'Codex')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(item(list, 'Claude Code')).toBeFocused();
  // Arrows move focus only; nothing opens until Enter.
  await expect(page.getByRole('heading', { name: 'Codex', level: 2 })).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(list.getByRole('button', { name: '更多（8）', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(item(list, 'Codex')).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const less = list.getByRole('button', { name: '收起', exact: true });
  await expect(less).toBeFocused();
  // Every CLI is reachable by arrow keys once the list is expanded.
  for (const [, name] of [...tools].reverse()) {
    await page.keyboard.press('ArrowUp');
    await expect(item(list, name)).toBeFocused();
  }
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowUp');
  await expect(item(list, 'Kiro')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Kiro', level: 2 })).toBeVisible();
  await expect(item(list, 'Kiro')).toHaveAttribute('aria-current', 'true');
  // Already on the page: the open stays in place instead of moving focus to the h1.
  await expect(item(list, 'Kiro')).toBeFocused();
  await item(list, 'Pi').focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('heading', { name: 'Pi', level: 2 })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(list.locator(':focus')).toHaveCount(0);
});

test('switching CLI with an unsaved draft asks once, and cancel keeps the CLI, draft and highlight', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await setupDirty(page);
  await page.goto('/');
  const list = sidebarList(page);
  await item(list, 'Claude Code').click();
  await expect(page.getByRole('heading', { name: 'Claude Code', level: 2 })).toBeVisible();
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  await page.getByRole('listitem').filter({ has: page.getByText('reviewer', { exact: true }) }).getByRole('button').click();
  await page.getByRole('article', { name: 'reviewer' }).getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '原生 Agent 定义', exact: true });
  await editor.fill('unsaved draft');

  await item(list, 'Codex').click();
  const confirm = page.getByRole('dialog').filter({ hasText: '尚未保存' });
  await expect(confirm).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(editor).toContainText('unsaved draft');
  await expect(page.getByRole('heading', { name: 'Claude Code', level: 2 })).toBeVisible();
  await expect(item(list, 'Claude Code')).toHaveAttribute('aria-current', 'true');
  await expect(item(list, 'Codex')).not.toHaveAttribute('aria-current', /.*/);

  // The command palette tool item uses the same channel: one prompt, then the CLI changes.
  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: '快速前往' });
  await palette.getByRole('combobox', { name: '搜索页面、工具或项目' }).fill('Codex');
  await palette.getByRole('option', { name: /Codex/ }).first().click();
  await expect(confirm).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await confirm.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Codex', level: 2 })).toBeVisible();
  await expect(item(list, 'Codex')).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
});
