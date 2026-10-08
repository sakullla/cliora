import { expect, test, type Page } from '@playwright/test';

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

async function setup(page: Page) {
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
      if (['list_accounts', 'list_usage_queries', 'list_usage_cache', 'usage_presets', 'list_mcp_definitions', 'list_skill_packages'].includes(command)) return [];
      if (command.startsWith('plugin:event|')) return 1;
      return null;
    } } });
  }, tools);
}

async function tabs(page: Page) {
  const list = page.getByRole('tablist', { name: 'CLI' });
  return list.evaluate((root) => {
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    return {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      items: buttons.map((node) => {
        const box = node.getBoundingClientRect();
        return {
          name: node.textContent?.trim() ?? '',
          top: Math.round(box.top),
          height: Math.round(box.height),
          clipped: node.scrollWidth > node.clientWidth + 1,
        };
      }),
    };
  });
}

test('the tool switcher stays one horizontal row', async ({ page }) => {
  await page.setViewportSize({ width: 1160, height: 780 });
  await setup(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  const list = page.getByRole('tablist', { name: 'CLI' });
  await expect(list.getByRole('tab', { name: 'Codex', exact: true })).toBeVisible();
  const fitted = await tabs(page);
  expect(fitted.items.map((item) => item.name)).toEqual(tools.map((item) => item[1]));
  expect(fitted.items.every((item) => !item.clipped)).toBe(true);
  expect(new Set(fitted.items.map((item) => item.top)).size).toBe(1);
  expect(fitted.scrollWidth).toBeGreaterThan(fitted.clientWidth);

  await list.getByRole('tab', { name: 'Kiro', exact: true }).click();
  await expect(list.getByRole('tab', { name: 'Kiro', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(list.getByRole('tab', { name: 'Codex', exact: true })).toHaveAttribute('aria-selected', 'false');
});
