import { expect, test, type Page } from '@playwright/test';

const host = {
  id: 'host-1',
  name: '测试远程主机',
  host: '212.60.153.19',
  port: 22,
  user: 'root',
  authMethod: 'key',
  identityFile: '',
  sshConfig: null,
  defaultPath: '/srv/project',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};

const names: Record<string, string> = { codex: 'Codex', claude_code: 'Claude Code', grok: 'Grok', cursor: 'Cursor' };

async function installRemoteLibrary(page: Page) {
  await page.addInitScript(({ host, names }) => {
    localStorage.setItem('cliora:remote-target', host.id);
    const tools = Object.entries(names).map(([id, name]) => ({ id, name, installation: 'not_checked', configuration: 'not_checked' }));
    const registered = Object.entries(names).map(([id, name]) => ({
      id, name, interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal',
      nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' },
    }));
    const calls: Array<Record<string, unknown>> = [];
    Object.assign(window, {
      isTauri: true,
      __resourceCalls: calls,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: 'light', remote_ssh_enabled: true }, tools };
          if (command === 'list_cli_adapters') return { registered, managedIds: Object.keys(names), preservedUnknown: [] };
          if (command === 'list_remote_targets') return [host];
          if (command === 'list_remote_resource_stores') {
            calls.push({ command, kind: args.kind, toolIds: args.toolIds });
            return { stores: { codex: { entries: [{ name: 'node_repl', transport: 'stdio', command: 'node', args: ['repl.js'], url: '', env: {}, headers: {}, inLibrary: true, enabled: true }], definitions: [] } } };
          }
          if (command === 'get_remote_resource_store') {
            calls.push({ command, kind: args.kind, toolId: args.toolId });
            return { entries: [] };
          }
          if (command === 'list_remote_library_items' || command === 'list_library_items' || command === 'list_projects' || command === 'list_accounts' || command === 'list_mcp_definitions' || command === 'list_mcp_placements' || command === 'list_skill_packages') return [];
          if (command === 'get_launch_settings') return { selected: 'workbench', terminals: [], cliMode: 'normal', projectMode: 'normal' };
          if (command === 'get_tray_status') return { available: false, error: null };
          return [];
        },
      },
    });
  }, { host, names });
}

test('remote library MCP reads every CLI in one batch', async ({ page }) => {
  await installRemoteLibrary(page);
  await page.goto('/');
  await expect(page.locator('.sidebar-host').getByRole('button', { name: '运行位置：测试远程主机' })).toBeVisible();
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  const workspace = page.getByRole('region', { name: '资料库 MCP' });
  await expect(workspace.getByText('node_repl')).toBeVisible();
  await expect(workspace.getByText('暂时无法读取 MCP')).toHaveCount(0);
  const calls = await page.evaluate(() => (window as unknown as { __resourceCalls: Array<{ command: string; kind?: string; toolIds?: string[]; toolId?: string }> }).__resourceCalls);
  const batches = calls.filter((call) => call.command === 'list_remote_resource_stores' && call.kind === 'mcp');
  const singles = calls.filter((call) => call.command === 'get_remote_resource_store');
  expect(singles).toEqual([]);
  expect(batches.length).toBeGreaterThan(0);
  expect(batches.length).toBeLessThanOrEqual(2);
  expect(batches[0].toolIds).toEqual(['codex', 'claude_code', 'grok', 'cursor']);
});
