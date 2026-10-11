import { expect, test } from '@playwright/test';

const tools = [['codex', 'Codex', true], ['kimi_code', 'Kimi Code', true], ['mimo_code', 'MiMo Code', false], ['cline', 'Cline', false], ['devin', 'Devin', true]] as const;

test('launch buttons stay in one column whether or not a CLI is installed', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.addInitScript((catalog) => {
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: catalog.map((item) => item[0]), theme: 'light' }, tools: catalog.map(([id, name]) => ({ id, name })) };
      if (command === 'list_cli_adapters') return { registered: catalog.map(([id, name]) => ({ id, name, interfaceFormats: ['openai_responses'] })), managedIds: catalog.map((item) => item[0]), preservedUnknown: [] };
      if (command === 'get_registered_tool_workspace') {
        const installed = catalog.find((item) => item[0] === args.toolId)?.[2];
        return { probe: { tool: args.toolId, selectedPath: installed ? '/fixture/cli' : null, installations: installed ? [{ path: '/fixture/cli', version: '1.0.0', status: 'available', source: 'native' }] : [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['openai_responses'], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null }, profiles: [], binding: null, common: null, snapshots: [], recoveryNeeded: [], customPath: null };
      }
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command === 'list_projects') return [];
      if (command.startsWith('plugin:event|')) return 1;
      return null;
    } } });
  }, tools);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '去安装 →' })).toHaveCount(2);
  const rows = page.locator('[data-tool-row]');
  await expect(rows.getByRole('button', { name: '启动', exact: true })).toHaveCount(3);
  await expect(rows.getByRole('button', { name: '重新检测', exact: true })).toHaveCount(2);
  const primary = rows.getByRole('button', { name: /^(启动|重新检测)$/ });
  const edges = await primary.evaluateAll((nodes) => nodes.map((node) => { const box = node.getBoundingClientRect(); return `${Math.round(box.left)}-${Math.round(box.right)}`; }));
  expect(new Set(edges).size).toBe(1);
  const menus = await rows.getByRole('button', { name: '启动目录' }).evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().left)));
  expect(new Set(menus).size).toBe(1);
});
