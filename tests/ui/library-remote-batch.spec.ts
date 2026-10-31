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
      remoteResources: { mcp: { relative: '.fixture/config.json', format: 'json', table: 'servers', nested: false }, skillRoot: ['codex', 'grok'].includes(id) ? '.fixture/skills' : null, agentRoot: null, agentExtension: null },
      id, name, interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal',
      nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' },
    }));
    const calls: Array<Record<string, unknown>> = [];
    const state = { fail: false, delay: false, name: 'node_repl' };
    let release = () => {};
    Object.assign(window, {
      isTauri: true,
      __resourceCalls: calls,
      __resourceState: state,
      __releaseResources: () => release(),
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: 'light', remote_ssh_enabled: true }, tools };
          if (command === 'list_cli_adapters') return { registered, managedIds: Object.keys(names), preservedUnknown: [] };
          if (command === 'list_remote_targets') return [host, { ...host, id: 'host-2', name: '另一台主机', host: '203.0.113.22' }];
          if (command === 'list_remote_resource_stores') {
            calls.push({ command, kind: args.kind, toolIds: args.toolIds, targetId: args.targetId, refresh: args.operation?.refresh });
            if (state.fail) throw { message: 'fixture refresh permission failure' };
            const result = { stores: { codex: { entries: [{ name: args.targetId === 'host-2' ? 'other_host_row' : state.name, transport: 'stdio', command: 'node', args: ['repl.js'], url: '', env: {}, headers: {}, inLibrary: true, enabled: true }], definitions: [] } } };
            if (state.delay) { state.delay = false; return new Promise(resolve => { release = () => resolve(result); }); }
            return result;
          }
          if (command === 'cancel_remote_operation') { calls.push({ command }); return true; }
          if (command === 'get_remote_resource_store') {
            calls.push({ command, kind: args.kind, toolId: args.toolId });
            return { entries: [] };
          }
          if (command === 'list_remote_library_items' && args.search === 'bad') throw { message: 'bad query denied' };
          if (command === 'list_remote_library_items' && args.search === 'good') return [{ id: 'good', kind: args.kind, title: 'fresh-good-row', body: 'good-body', category: '', projectId: null, version: 1, updatedAt: 1 }];
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


async function openMcp(page: Page) {
  await installRemoteLibrary(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await expect(page.getByRole('region', { name: '资料库 MCP' }).getByText('node_repl')).toBeVisible();
}

const mcpCalls = (page: Page) => page.evaluate(() => (window as any).__resourceCalls.filter((call: any) => call.command === 'list_remote_resource_stores' && call.kind === 'mcp'));

test('nonempty MCP remount is warm, explicit refresh revalidates, and failure retains stale success', async ({ page }) => {
  await openMcp(page);
  const before = (await mcpCalls(page)).length;
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  const workspace = page.getByRole('region', { name: '资料库 MCP' });
  await expect(workspace.getByText('node_repl')).toBeVisible();
  expect((await mcpCalls(page)).length).toBe(before);
  await workspace.getByRole('button', { name: '刷新', exact: true }).click();
  await expect.poll(async () => (await mcpCalls(page)).length).toBe(before + 1);
  expect((await mcpCalls(page)).at(-1).refresh).toBe(true);
  await page.evaluate(() => { (window as any).__resourceState.fail = true; });
  await workspace.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(workspace.getByText('node_repl')).toBeVisible();
  await expect(page.getByText(/刷新失败，当前显示的是上次成功读取的内容/)).toBeVisible();
  const failedCalls = (await mcpCalls(page)).length;
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await expect(workspace.getByText('node_repl')).toBeVisible();
  await expect(page.getByText(/刷新失败，当前显示的是上次成功读取的内容/)).toBeVisible();
  expect((await mcpCalls(page)).length).toBe(failedCalls);
  await page.evaluate(() => { (window as any).__resourceState.fail = false; });
  await workspace.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByText(/刷新失败，当前显示的是上次成功读取的内容/)).toHaveCount(0);
});

test('a delayed old host refresh is cancelled and cannot overwrite the selected host', async ({ page }) => {
  await openMcp(page);
  await page.evaluate(() => { (window as any).__resourceState.delay = true; });
  await page.getByRole('region', { name: '资料库 MCP' }).getByRole('button', { name: '刷新', exact: true }).click();
  await page.locator('.sidebar-host').getByRole('button', { name: '运行位置：测试远程主机' }).click();
  await page.getByRole('menuitemradio', { name: /另一台主机/ }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  const workspace = page.getByRole('region', { name: '资料库 MCP' });
  await expect(workspace.getByText('other_host_row')).toBeVisible();
  await page.evaluate(() => (window as any).__releaseResources());
  await expect(workspace.getByText('node_repl')).toHaveCount(0);
  await expect(workspace.getByText('other_host_row')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__resourceCalls.filter((call: any) => call.command === 'cancel_remote_operation').length)).toBeGreaterThan(0);
});

test('refresh completion preserves an MCP draft edited while the list was loading', async ({ page }) => {
  await openMcp(page);
  await page.evaluate(() => { (window as any).__resourceState.delay = true; });
  const workspace = page.getByRole('region', { name: '资料库 MCP' });
  await workspace.getByRole('button', { name: '刷新', exact: true }).click();
  await workspace.getByRole('button', { name: '修改', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const name = dialog.getByRole('textbox', { name: /名称/ }).first();
  await name.fill('unsaved-draft');
  await page.evaluate(() => (window as any).__releaseResources());
  await expect(name).toHaveValue('unsaved-draft');
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
});

test('a successful library query does not inherit another query freshness failure', async ({ page }) => {
  await installRemoteLibrary(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  const search = page.getByRole('textbox', { name: '搜索资料' });
  await search.fill('bad');
  await expect(page.getByText(/bad query denied/)).toBeVisible();
  await search.fill('good');
  await expect(page.getByRole('button', { name: 'fresh-good-row', exact: true })).toBeVisible();
  await expect(page.getByText(/刷新失败，当前显示的是上次成功读取的内容/)).toHaveCount(0);
});
