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

async function installRemoteLibrary(page: Page, largeSkills = false, skillMode: 'builtin' | 'read-only' | 'unsupported' | 'mixed' = 'builtin', initialSkillFailure = 'none') {
  await page.addInitScript(({ host, names, largeSkills, skillMode, initialSkillFailure }) => {
    localStorage.setItem('cliora:remote-target', host.id);
    const tools = Object.entries(names).map(([id, name]) => ({ id, name, installation: 'not_checked', configuration: 'not_checked' }));
    const roots: Record<string, string> = { codex: '.codex/skills', claude_code: '.claude/skills', grok: '.grok/skills', cursor: '.cursor/skills' };
    const registered = Object.entries(names).map(([id, name]) => ({
      remoteResources: { mcp: { relative: '.fixture/config.json', format: 'json', table: 'servers', nested: false }, skillRoot: skillMode === 'builtin' || (skillMode === 'mixed' && ['codex', 'cursor'].includes(id)) ? roots[id] : null, agentRoot: null, agentExtension: null },
      remoteSkillDirectories: skillMode === 'unsupported' || (skillMode === 'mixed' && id === 'grok') ? [] : [{ relative: roots[id], readOnly: skillMode === 'read-only' || (skillMode === 'mixed' && id === 'claude_code'), detail: 'fixture' }],
      id, name, interfaceFormats: [], yoloAvailable: true, resumeLatestAvailable: false, projectModelOverride: false, launchForm: 'terminal',
      nativeConfig: { state: 'available', reason: '' }, launch: { state: 'available', reason: '' }, resume: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' }, history: { state: 'available', reason: '' },
    }));
    const calls: Array<Record<string, unknown>> = [];
    const state = { fail: false, delay: false, name: 'node_repl', skillFailure: initialSkillFailure };
    const versions: Record<string, string> = {};
    const snapshots = new Map<string, Record<string, string>>();
    const skillStores: Record<string, any> = {};
    if (largeSkills) for (const cli of ['codex', 'grok']) {
      versions[`$HOME/.cliora/resources/${cli}/skills.json`] = 'a'.repeat(64);
      const entries = Array.from({ length: 128 }, (_, n) => ({ name: `${cli}-${n}`, path: `/home/fixture/.${cli}/skills/${cli}-${n}/SKILL.md`, state: 'external', source: 'writable', detail: 'fixture' }));
      const documents = Object.fromEntries(entries.map(entry => {
        versions[entry.path.replace('/home/fixture/', '$HOME/')] = 'b'.repeat(64);
        return [entry.path, `---\nname: ${entry.name}\ndescription: fixture\n---\nbody`];
      }));
      skillStores[cli] = { entries, documents };
    }
    if (!largeSkills) {
      const entries = Array.from({ length: 40 }, (_, n) => ({ name: `perf-skill-${n}`, path: `/home/fixture/.claude/skills/perf-skill-${n}/SKILL.md`, state: skillMode === 'read-only' || skillMode === 'mixed' ? 'read_only' : 'external', source: skillMode === 'read-only' || skillMode === 'mixed' ? 'read_only' : 'writable', detail: 'fixture' }));
      skillStores.claude_code = { entries, documents: Object.fromEntries(entries.map(entry => [entry.path, '# fixture'])) };
    }
    if (skillMode === 'mixed') {
      skillStores.codex = { entries: [{ name: 'writable-fixture', path: '/home/fixture/.codex/skills/writable-fixture/SKILL.md', source: 'writable', state: 'external', detail: 'fixture' }], documents: { '/home/fixture/.codex/skills/writable-fixture/SKILL.md': '---\nname: writable-fixture\n---\nFull source body, including unmanaged content.\n' } };
      skillStores.cursor = { entries: [{ name: 'cursor-managed', packageId: 'managed-package-id', path: '/home/fixture/.cursor/skills/cursor-managed/SKILL.md', source: 'writable', state: 'managed', detail: 'fixture' }], documents: { '/home/fixture/.cursor/skills/cursor-managed/SKILL.md': '# Full Cursor body\n', '/home/fixture/.cursor/skills/other/SKILL.md': '# Preserve adjacent document\n' } };
    }
    let release = () => {};
    Object.assign(window, {
      isTauri: true,
      __resourceCalls: calls,
      __resourceState: state,
      __skillStores: skillStores,
      __releaseResources: () => release(),
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: Object.keys(names), theme: 'light', remote_ssh_enabled: true }, tools };
          if (command === 'list_cli_adapters') return { registered, managedIds: Object.keys(names), preservedUnknown: [] };
          if (command === 'list_remote_targets') return [host, { ...host, id: 'host-2', name: '另一台主机', host: '203.0.113.22' }];
          if (command === 'get_remote_write_snapshot') return snapshots.get(args.requestId) ?? {};
          if (['list_remote_resource_stores', 'get_remote_resource_store'].includes(command) && args.kind === 'skills') {
            calls.push({ command, kind: args.kind, toolIds: args.toolIds, toolId: args.toolId });
            if (state.fail || state.skillFailure !== 'none') {
              const detail = state.skillFailure === 'blank' ? '' : 'fixture Skill parent is not a directory';
              // Native exit46 failures originally have blank messages at both levels.
              throw { code: 'remote_error', message: state.skillFailure === 'nested' ? ' \n ' : detail, action: '请按远程操作建议处理。', remote: {
                code: 'remote_remote_command', stage: 'remote_command', reason: 'remote_command', message: detail,
                action: '检查网络与远端状态后重试。', requestId: args.operation.requestId, targetId: host.id,
                targetRevision: null, outcome: 'failed', retryable: false, exitCode: 46,
              } };
            }
            snapshots.set(args.operation.requestId, { ...versions });
            return command === 'list_remote_resource_stores' ? { stores: skillStores } : skillStores[args.toolId];
          }
          if (command === 'save_remote_resource_store') {
            const expected = args.operation.expectedFiles;
            if (largeSkills && (Object.keys(expected).length > 16384 || Object.entries(versions).some(([path, hash]) => expected[path] !== hash))) throw { message: 'inventory baseline rejected' };
            calls.push({ command, expected, value: args.value, toolId: args.toolId });
            skillStores[args.toolId] = structuredClone(args.value);
            snapshots.set(args.operation.requestId, { ...versions });
            return null;
          }
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
  }, { host, names, largeSkills, skillMode, initialSkillFailure });
}

test('a library single-Skill removal carries both full 128-Skill baselines and reaches the write IPC', async ({ page }) => {
  await installRemoteLibrary(page, true); await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  await expect(page.getByRole('button', { name: 'codex-0', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'grok-127', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'codex-0 的更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByRole('button', { name: 'codex-0', exact: true })).toHaveCount(0);
  const writes = await page.evaluate(() => (window as any).__resourceCalls.filter((call: any) => call.command === 'save_remote_resource_store'));
  expect(writes).toHaveLength(1);
  expect(Object.keys(writes[0].expected)).toHaveLength(258);
  expect(writes[0].expected['$HOME/.grok/skills/grok-127/SKILL.md']).toBe('b'.repeat(64));
  expect(writes[0].value.entries).toHaveLength(127);
  expect(writes[0].toolId).toBe('codex');
});

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


test('remote library reads all forty Claude Skills using the published adapter capability', async ({ page }) => {
  await installRemoteLibrary(page); await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  await expect(page.getByRole('button', { name: 'perf-skill-0', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'perf-skill-39', exact: true })).toBeVisible();
  const calls = await page.evaluate(() => (window as any).__resourceCalls.filter((call: any) => call.kind === 'skills'));
  expect(calls[0].toolIds).toEqual(['codex', 'claude_code', 'grok', 'cursor']);
  await expect(page.getByRole('button', { name: '添加 Skill', exact: true })).toBeVisible();
});

test('read-only remote Skills stay readable without import or delete actions', async ({ page }) => {
  await installRemoteLibrary(page, false, 'read-only'); await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  await expect(page.getByRole('button', { name: 'perf-skill-0', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '添加 Skill', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'perf-skill-0 的更多操作', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '删除', exact: true })).toBeDisabled();
});

test('an explicitly unavailable remote Skills capability neither reads nor offers an import', async ({ page }) => {
  await installRemoteLibrary(page, false, 'unsupported'); await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  await expect(page.getByRole('button', { name: '添加 Skill', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__resourceCalls.filter((call: any) => call.kind === 'skills'))).toEqual([]);
});


test('mixed remote Skills show write controls only for writable CLI targets', async ({ page }) => {
  await installRemoteLibrary(page, false, 'mixed'); await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  const card = page.locator('[data-card]').filter({ has: page.getByRole('button', { name: 'writable-fixture', exact: true }) });
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: /^Codex ·/ })).toBeVisible();
  await expect(card.getByRole('button', { name: /^Cursor ·/ })).toBeVisible();
  await expect(card.getByRole('button', { name: /^(Claude Code|Grok) ·/ })).toHaveCount(0);
  await page.getByRole('button', { name: '添加 Skill', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加 Skill', exact: true });
  await expect(dialog.getByRole('checkbox', { name: 'Codex', exact: true })).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: 'Cursor', exact: true })).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: /Claude Code|Grok/ })).toHaveCount(0);
});

test('a remote Skill target mark preserves the source and reports actual target availability', async ({ page }) => {
  await installRemoteLibrary(page, false, 'mixed'); await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  const card = page.locator('[data-card]').filter({ has: page.getByRole('button', { name: 'writable-fixture', exact: true }) });
  const cursor = card.getByRole('button', { name: /^Cursor ·/ });
  await expect(cursor).toBeVisible();
  const original = await page.evaluate(() => structuredClone((window as any).__skillStores));
  // An actual DOM click exercises the old destructive handler and remains a no-op when unavailable.
  await cursor.evaluate((button: HTMLButtonElement) => button.click());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => (window as any).__resourceCalls.filter((call: any) => call.command === 'save_remote_resource_store'))).toEqual([]);
  expect(await page.evaluate(() => (window as any).__skillStores)).toEqual(original);
  await expect(card.getByRole('button', { name: /^Codex ·/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(cursor).toHaveAttribute('aria-pressed', 'false');
  await expect(cursor).toBeDisabled();
  await expect(card.getByRole('button', { name: /^Codex ·/ })).toBeDisabled();
  await card.getByRole('button', { name: /^Codex ·/ }).evaluate((button: HTMLButtonElement) => button.click());
  expect(await page.evaluate(() => (window as any).__skillStores)).toEqual(original);
});

test('explicit remote Skill deletion confirms and changes only its inventory origin even with a managed package ID', async ({ page }) => {
  await installRemoteLibrary(page, false, 'mixed'); await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  await expect(page.getByRole('button', { name: 'cursor-managed', exact: true })).toBeVisible();
  const original = await page.evaluate(() => structuredClone((window as any).__skillStores));
  await page.getByRole('button', { name: 'cursor-managed 的更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => (window as any).__resourceCalls.filter((call: any) => call.command === 'save_remote_resource_store'))).toEqual([]);
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByRole('button', { name: 'cursor-managed', exact: true })).toHaveCount(0);
  const writes = await page.evaluate(() => (window as any).__resourceCalls.filter((call: any) => call.command === 'save_remote_resource_store'));
  expect(writes).toHaveLength(1);
  expect(writes[0].toolId).toBe('cursor');
  expect(writes[0].value).toEqual({ entries: [], documents: { '/home/fixture/.cursor/skills/other/SKILL.md': '# Preserve adjacent document\n' } });
  const after = await page.evaluate(() => (window as any).__skillStores);
  expect(after.codex).toEqual(original.codex);
  expect(after.claude_code).toEqual(original.claude_code);
});

test('a failed fresh remote Skill scan retains the previous list as stale and recovers on retry', async ({ page }) => {
  await installRemoteLibrary(page); await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  await expect(page.getByRole('button', { name: 'perf-skill-39', exact: true })).toBeVisible();
  const remove = async () => {
    await page.getByRole('button', { name: 'perf-skill-0 的更多操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '删除', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  };
  await page.evaluate(() => { (window as any).__resourceState.skillFailure = 'blank'; });
  await remove();
  await expect(page.getByText(/刷新失败，当前显示的是上次成功读取的内容/)).toBeVisible();
  await expect(page.getByRole('alert').getByText('操作失败', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'perf-skill-39', exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__resourceState.skillFailure = 'none'; });
  await remove();
  await expect(page.getByRole('button', { name: 'perf-skill-0', exact: true })).toHaveCount(0);
  await expect(page.getByText(/刷新失败，当前显示的是上次成功读取的内容/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'perf-skill-39', exact: true })).toBeVisible();
});

for (const [mode, message] of [['blank', '操作失败'], ['nested', 'fixture Skill parent is not a directory'], ['nonblank', 'fixture Skill parent is not a directory']]) {
  test(`an initial remote Skill ${mode} failure shows a visible error`, async ({ page }) => {
    await installRemoteLibrary(page, false, 'builtin', mode); await page.goto('/');
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
    await page.getByRole('tab', { name: 'Skill', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__resourceCalls.filter((call: any) => call.kind === 'skills').length)).toBeGreaterThan(0);
    await expect(page.getByRole('alert').getByText(message, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'perf-skill-0', exact: true })).toHaveCount(0);
  });
}
