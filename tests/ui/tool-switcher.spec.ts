import { expect, test, type Page } from '@playwright/test';
import { cliSwitcher, openCli } from './cli-switcher';

// The CLI is picked from the 工具与连接 header: the h2 is a searchable switcher, and the sidebar\n// keeps only the six pages so it never grows with the managed list.
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

const options = (page: Page) => page.getByRole('listbox', { name: /，切换 CLI$/ }).getByRole('option');

async function expectSidebarFits(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const aside = document.querySelector<HTMLElement>('aside.sidebar');
    if (!aside) return 'missing sidebar';
    const sideways = aside.scrollWidth - aside.clientWidth;
    const tall = aside.getBoundingClientRect().bottom - window.innerHeight;
    const doc = document.documentElement.scrollWidth - window.innerWidth;
    return sideways <= 0 && tall <= 0 && doc <= 0 ? '' : `sidebar ${sideways} tall ${tall} doc ${doc}`;
  })).toBe('');
}

test('the header switcher lists every managed CLI and the sidebar keeps only the pages', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await setup(page);
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '页面' });
  await expect(nav.getByRole('button')).toHaveCount(6);
  await expect(nav.getByRole('button', { name: 'Codex', exact: true })).toHaveCount(0);

  await nav.getByRole('button', { name: '工具与连接', exact: true }).click();
  const heading = page.getByRole('heading', { name: 'Codex', level: 2 });
  await expect(heading).toBeVisible();
  const picker = cliSwitcher(page);
  await expect(picker).toHaveAccessibleName('Codex，切换 CLI');
  await picker.click();
  await expect(options(page)).toHaveCount(tools.length);
  await expect(options(page).filter({ has: page.getByText('Codex', { exact: true }) })).toHaveAttribute('aria-selected', 'true');
  // Sixteen CLIs open with a search box; typing narrows the list.
  await page.getByRole('textbox', { name: '搜索 CLI' }).fill('kir');
  await expect(options(page)).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Kiro', level: 2 })).toBeVisible();
  await expect(picker).toHaveAccessibleName('Kiro，切换 CLI');

  // Picking the CLI already shown keeps the page as it is.
  await openCli(page, 'Kiro');
  await picker.click();
  await options(page).filter({ has: page.getByText('Kiro', { exact: true }) }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Kiro', level: 2 })).toBeVisible();

  for (const width of [1360, 900, 640]) {
    await page.setViewportSize({ width, height: 600 });
    await expect(picker).toBeVisible();
    await expectSidebarFits(page);
  }
});

test('the header switcher is reached by keyboard and opens with arrows', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await setup(page);
  await page.goto('/');
  await openCli(page, 'Codex');
  const picker = cliSwitcher(page);
  await picker.focus();
  await page.keyboard.press('ArrowDown');
  const search = page.getByRole('textbox', { name: '搜索 CLI' });
  await expect(search).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Claude Code', level: 2 })).toBeVisible();
  await picker.focus();
  await page.keyboard.press('Enter');
  await expect(search).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(search).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Claude Code', level: 2 })).toBeVisible();
});

test('switching CLI with an unsaved draft asks once, and cancel keeps the CLI and draft', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await setupDirty(page);
  await page.goto('/');
  await openCli(page, 'Claude Code');
  await expect(page.getByRole('heading', { name: 'Claude Code', level: 2 })).toBeVisible();
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  await page.getByRole('listitem').filter({ has: page.getByText('reviewer', { exact: true }) }).getByRole('button').click();
  await page.getByRole('article', { name: 'reviewer' }).getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '原生 Agent 定义', exact: true });
  await editor.fill('unsaved draft');

  await openCli(page, 'Codex');
  const confirm = page.getByRole('dialog').filter({ hasText: '尚未保存' });
  await expect(confirm).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(editor).toContainText('unsaved draft');
  await expect(page.getByRole('heading', { name: 'Claude Code', level: 2 })).toBeVisible();
  await expect(cliSwitcher(page)).toHaveAccessibleName('Claude Code，切换 CLI');

  // The command palette tool item uses the same channel: one prompt, then the CLI changes.
  await page.keyboard.press('Control+K');
  const palette = page.getByRole('dialog', { name: '快速前往' });
  await palette.getByRole('combobox', { name: '搜索页面、工具或项目' }).fill('Codex');
  await palette.getByRole('option', { name: /Codex/ }).first().click();
  await expect(confirm).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await confirm.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Codex', level: 2 })).toBeVisible();
  await expect(cliSwitcher(page)).toHaveAccessibleName('Codex，切换 CLI');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
});