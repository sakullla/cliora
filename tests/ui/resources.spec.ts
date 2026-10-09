import { expect, test, type Page } from '@playwright/test';

async function mockResources(page: Page) {
  await page.addInitScript(() => {
    const library: Array<Record<string, unknown>> = [];
    const definitions: Array<Record<string, unknown>> = [];
    const placements: Array<Record<string, unknown>> = [];
    const skillPackages: Array<Record<string, unknown>> = [];
    const nativeSkills: Array<Record<string, unknown>> = [];
    const skillIssues: Array<Record<string, unknown>> = [];
    const writes: unknown[] = [];
    const managed:Record<string,boolean>={};
    const pendingPreviews: Array<() => void> = [];
    Object.assign(window, {
      isTauri: true,
      __resourceWrites: writes,
      __resourceSkillPackages: skillPackages,
      __resourceNativeSkills: nativeSkills,
      __resourceSkillIssues: skillIssues,
      __resourceMcpDefinitions: definitions,
      __resourceMcpPlacements: placements,
      __resourceMcpConflict: false,
      __resourceDeferMcpPreview: false,
      __resourcePendingPreviews: pendingPreviews,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], nativeConfig: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects') return [{ id: 'second-project', name: 'Second project', path: '/tmp/second-project', available: true, preferredTool: 'codex', modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} }];
        if (command === 'list_library_items') return library.filter((item) => item.kind === args.kind && (!args.search || `${item.title} ${item.body} ${item.category}`.toLowerCase().includes(String(args.search).toLowerCase())));
        if (command === 'save_library_item') {
          const draft = args.draft;
          const item = { ...draft, id: draft.id ?? `item-${library.length + 1}`, version: (draft.expectedVersion ?? 0) + 1, updatedAt: 1 };
          const index = library.findIndex((old) => old.id === item.id);
          if (index < 0) library.push(item); else library[index] = item;
          return item;
        }
        if (command === 'delete_library_item') {
          const index = library.findIndex((item) => item.id === args.id);
          if (index >= 0) library.splice(index, 1);
          return null;
        }
        if (command === 'get_registered_tool_workspace') return {
          probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '尚未安装' },
            interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null },
          profiles: [], common: null, binding: null, effectiveContextId: null, snapshots: [], recoveryNeeded: [], customPath: null,
        };
        if (command === 'list_mcp_definitions') return definitions;
        if (command === 'list_mcp_placements') return placements;
        if (command === 'get_managed_mcp_enabled') return managed[`${args.definitionId}:${args.target.toolId}:${args.target.scope}:${args.target.projectPath}`] ?? null;
        if (command === 'save_mcp_definition') {
          const item = { ...args.draft, id: args.draft.id ?? 'mcp-1', version: (args.draft.expectedVersion ?? 0) + 1 };
          const index = definitions.findIndex((old) => old.id === item.id);
          if (index < 0) definitions.push(item); else definitions[index] = item;
          return item;
        }
        if (command === 'delete_mcp_definition') {
          const index = definitions.findIndex((item) => item.id === args.id && item.version === args.expectedVersion);
          if (index < 0) throw new Error('MCP 定义已被修改或不存在，请重新读取');
          definitions.splice(index, 1);
          return null;
        }
        if (command === 'remove_native_mcp') {
          const index = placements.findIndex((item) => item.toolId === args.target.toolId && item.scope === args.target.scope && item.projectPath === (args.target.projectPath ?? null));
          if (index >= 0) placements.splice(index, 1);
          writes.push({ command, args });
          return null;
        }
        if (command === 'delete_skill_package') {
          const index = skillPackages.findIndex((item) => item.id === args.packageId);
          if (index >= 0) skillPackages.splice(index, 1);
          return null;
        }
        if (command === 'list_native_mcp') return [];
        if (command === 'preview_mcp_targets') {
          const response = args.targets.map((target: Record<string, unknown>) =>
            ({ ...target, status: (window as typeof window & { __resourceMcpConflict: boolean }).__resourceMcpConflict ? 'conflict' : 'ready', detail: '将创建 CLI 原生条目', path: '/tmp/config.toml', baselineHash: 'hash-empty', previewToken: 'bound-token', existing: (window as typeof window & { __resourceMcpConflict: boolean }).__resourceMcpConflict ? { command: 'old-command' } : null, proposed: { command: 'npx' } }));
          if ((window as typeof window & { __resourceDeferMcpPreview: boolean }).__resourceDeferMcpPreview) {
            return new Promise((resolve) => { pendingPreviews.push(() => resolve(response)); });
          }
          return response;
        }
        if (command === 'distribute_mcp') {
          for (const target of args.targets) {
            managed[`${args.definitionId}:${target.toolId}:${target.scope}:${target.projectPath}`] = target.enabled;
            const row = { definitionId: args.definitionId, toolId: target.toolId, scope: target.scope, projectPath: target.projectPath ?? null, enabled: target.enabled };
            const index = placements.findIndex((item) => item.definitionId === row.definitionId && item.toolId === row.toolId && item.scope === row.scope && item.projectPath === row.projectPath);
            if (index < 0) placements.push(row); else placements[index] = row;
          }
          writes.push(args);
          return args.targets.map((target: Record<string, unknown>) => ({ ...target, status: 'written', detail: 'committed', path: '/tmp/config.toml', baselineHash: 'hash-empty' }));
        }
        if (command === 'set_skill_in_library') {
          const found = skillPackages.find((item) => item.id === args.id);
          if (found) found.inLibrary = args.inLibrary;
          return null;
        }
        if (command === 'list_skill_packages') return skillPackages;
        if (command === 'list_skill_installations') return [];
        if (command === 'get_skill_enabled') return false;
        if (command === 'list_skill_recovery_issues') return [...skillIssues];
        if (command === 'scan_native_skills') return nativeSkills;
        if (command === 'preview_skill_target') return { path: '/tmp/.codex/skills/sample', status: 'conflict', detail: '同名原生 Skills 未受当前包管理', previewToken: 'skill-token', existingDigest: 'old', packageDigest: 'new', changes: [{ path: 'SKILL.md', before: 'old text', after: 'new text', beforeSize: 8, afterSize: 8, beforeDigest: 'old', afterDigest: 'new' }] };
        if (command === 'install_skill') { writes.push(args); return { toolId: args.toolId, scope: args.scope, projectPath: args.projectPath, path: '/tmp/.codex/skills/sample', status: 'installed', detail: '完成' }; }
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        throw new Error(`Unexpected IPC: ${command}`);
      } },
    });
  });
}

async function startLibraryMcp(page: Page) {
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '新建 MCP', exact: true }).click();
  await page.getByRole('textbox', { name: '名称' }).fill('filesystem');
  await page.getByRole('textbox', { name: '命令' }).fill('npx');
}

test('MCP argument and environment fields keep new lines and literal values', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await startLibraryMcp(page);
  const dialog = page.getByRole('dialog');
  const args = dialog.getByRole('textbox', { name: '参数，每行一项' });
  await args.fill('chrome-devtools-mcp@latest');
  await args.press('Enter');
  await args.pressSequentially('--stdio');
  await expect(args).toHaveValue('chrome-devtools-mcp@latest\n--stdio');
  const env = dialog.getByRole('textbox', { name: '环境变量' });
  await env.fill('MYSQL_PORT=3216');
  await env.press('Enter');
  await env.pressSequentially('MYSQL_PASSWORD=local-secret');
  await expect(env).toHaveValue('MYSQL_PORT=3216\nMYSQL_PASSWORD=local-secret');
  await dialog.getByRole('button', { name: 'HTTP', exact: true }).click();
  const headers = dialog.getByRole('textbox', { name: '请求头' });
  await headers.fill('Authorization=Bearer local-secret');
  await headers.press('Enter');
  await headers.pressSequentially('X-Team=desk');
  await expect(headers).toHaveValue('Authorization=Bearer local-secret\nX-Team=desk');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('请使用环境变量引用')).toHaveCount(0);
});

test('MCP replacement shows both native entries and can be canceled', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => { (window as typeof window & { __resourceMcpConflict: boolean }).__resourceMcpConflict = true; });
  await startLibraryMcp(page);
  await page.getByRole('checkbox', { name: 'Codex' }).check();
  await page.getByRole('button', { name: '保存并分发' }).click();
  await expect(page.getByText('old-command')).toBeVisible();
  await expect(page.getByText('"npx"')).toBeVisible();
  await page.getByRole('button', { name: '保留当前文件' }).click();
  let writes = await page.evaluate(() => (window as typeof window & { __resourceWrites: unknown[] }).__resourceWrites);
  expect(writes).toHaveLength(0);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('old-command')).toHaveCount(0);
  await page.getByRole('button', { name: '保存并分发' }).click();
  await page.getByRole('button', { name: '替换并分发', exact: true }).click();
  writes = await page.evaluate(() => (window as typeof window & { __resourceWrites: unknown[] }).__resourceWrites);
  expect(writes).toEqual([expect.objectContaining({ targets: [expect.objectContaining({ allowReplace: true, previewToken: 'bound-token' })] })]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '已写入 Codex。' })).toBeVisible();
  await page.getByRole('button', { name: '修改' }).click();
  await expect(page.getByRole('checkbox', { name: 'Codex' })).toBeChecked();
});

test('editing an MCP starts from the CLIs already written and unchecking removes one', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => {
    const state = window as typeof window & { __resourceMcpDefinitions: Array<Record<string, unknown>>; __resourceMcpPlacements: Array<Record<string, unknown>> };
    state.__resourceMcpDefinitions.push({ id: 'mcp-1', name: 'filesystem', transport: 'stdio', command: 'npx', args: [], url: '', env: {}, headers: {}, inLibrary: true, version: 1 });
    state.__resourceMcpPlacements.push({ definitionId: 'mcp-1', toolId: 'codex', scope: 'global', projectPath: null, enabled: true });
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '修改' }).click();
  await expect(page.getByRole('checkbox', { name: 'Codex' })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Codex' }).uncheck();
  await page.getByRole('button', { name: '保存并分发' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '已从 Codex 移除。' })).toBeVisible();
  const writes = await page.evaluate(() => (window as typeof window & { __resourceWrites: Array<Record<string, unknown>> }).__resourceWrites);
  expect(writes).toEqual([expect.objectContaining({ command: 'remove_native_mcp' })]);
});

test('MCP removal notice expires after four seconds', async ({ page }) => {
  await mockResources(page);
  await page.clock.install();
  await page.goto('/');
  await page.evaluate(() => {
    const state = window as typeof window & { __resourceMcpDefinitions: Array<Record<string, unknown>>; __resourceMcpPlacements: Array<Record<string, unknown>> };
    state.__resourceMcpDefinitions.push({ id: 'mcp-1', name: 'filesystem', transport: 'stdio', command: 'npx', args: [], url: '', env: {}, headers: {}, inLibrary: true, version: 1 });
    state.__resourceMcpPlacements.push({ definitionId: 'mcp-1', toolId: 'codex', scope: 'global', projectPath: null, enabled: true });
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '修改' }).click();
  const codex = page.getByRole('checkbox', { name: 'Codex' });
  await expect(codex).toBeEnabled();
  await expect(codex).toBeChecked();
  await codex.uncheck();
  await expect(codex).not.toBeChecked();
  await page.getByRole('button', { name: '保存并分发' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { __resourceWrites: Array<Record<string, unknown>> }).__resourceWrites)).toEqual([expect.objectContaining({ command: 'remove_native_mcp' })]);
  const status = page.getByRole('status').filter({ hasText: '已从 Codex 移除。' });
  await expect(status).toBeVisible();
  await page.clock.fastForward(4100);
  await expect(status).toHaveCount(0);
});

test('editing an MCP rewrites every CLI that already has it, including another scope', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => {
    const state = window as typeof window & { __resourceMcpDefinitions: Array<Record<string, unknown>>; __resourceMcpPlacements: Array<Record<string, unknown>> };
    state.__resourceMcpDefinitions.push({ id: 'mcp-1', name: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', 'old'], url: '', env: {}, headers: {}, inLibrary: true, version: 1 });
    state.__resourceMcpPlacements.push(
      { definitionId: 'mcp-1', toolId: 'codex', scope: 'global', projectPath: null, enabled: true },
      { definitionId: 'mcp-1', toolId: 'codex', scope: 'project', projectPath: '/tmp/second-project', enabled: true },
    );
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '修改' }).click();
  await expect(page.getByRole('checkbox', { name: 'Codex' })).toBeChecked();
  await page.getByRole('textbox', { name: '命令' }).fill('node');
  await page.getByRole('button', { name: '保存并分发' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const writes = await page.evaluate(() => (window as typeof window & { __resourceWrites: Array<{ targets: Array<Record<string, unknown>> }> }).__resourceWrites);
  expect(writes).toHaveLength(1);
  expect(writes[0].targets).toEqual(expect.arrayContaining([
    expect.objectContaining({ toolId: 'codex', scope: 'global', projectPath: null }),
    expect.objectContaining({ toolId: 'codex', scope: 'project', projectPath: '/tmp/second-project' }),
  ]));
  await expect(page.getByRole('status').filter({ hasText: '已写入' })).toBeVisible();
});

test('an unfinished MCP preview cannot return after switching scope or distribute to the old scope', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await startLibraryMcp(page);
  await page.getByRole('checkbox', { name: 'Codex' }).check();
  await page.evaluate(() => { (window as typeof window & { __resourceDeferMcpPreview: boolean }).__resourceDeferMcpPreview = true; });
  await page.getByRole('button', { name: '保存并分发' }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __resourcePendingPreviews: unknown[] }).__resourcePendingPreviews.length)).toBe(1);
  await page.getByRole('button', { name: '分发范围' }).click();
  await page.getByRole('option', { name: 'Second project' }).click();
  await page.evaluate(() => {
    const state = window as typeof window & { __resourceDeferMcpPreview: boolean; __resourcePendingPreviews: Array<() => void> };
    state.__resourceDeferMcpPreview = false;
    state.__resourcePendingPreviews.shift()?.();
  });
  await expect(page.getByRole('button', { name: '替换并分发', exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Codex' }).check();
  await page.getByRole('button', { name: '保存并分发' }).click();
  const writes = await page.evaluate(() => (window as typeof window & { __resourceWrites: Array<{ targets: Array<Record<string, unknown>> }> }).__resourceWrites);
  expect(writes).toHaveLength(1);
  expect(writes[0].targets[0]).toEqual(expect.objectContaining({ scope: 'project', projectPath: '/tmp/second-project' }));
});

test('local ZIP import is available without a URL, selects a complete Skill, and binds update confirmation to its preview', async ({ page }) => {
  await mockResources(page);
  await page.addInitScript(() => {
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'plugin:dialog|open') return 'C:/fixtures/skills.zip';
      if (command === 'list_skill_zip_entries') return ['bundle/alpha', 'bundle/beta'];
      if (command === 'preview_skill_local_zip') return { name: 'alpha', source: args.source, digest: 'new-bundle', existingDigest: 'old-bundle', fileCount: 3, changes: [], compatibility: null };
      if (command === 'import_skill_local_zip') {
        (window as any).__resourceWrites.push({ command, args });
        const item = { id: 'alpha-id', name: 'alpha', description: 'Complete package', fileCount: 3, digest: 'new-bundle', source: args.source, compatibility: null };
        (window as any).__resourceSkillPackages.push(item); return item;
      }
      return original(command, args);
    };
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  await page.getByRole('button', { name: '添加 Skill', exact: true }).click();
  const sync = page.getByRole('checkbox', { name: '快速同步' });
  await expect(sync).toBeVisible();
  const box = await sync.boundingBox();
  expect(box && box.width < box.height * 4).toBe(true);
  await expect(page.getByRole('button', { name: '导入 ZIP 文件', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '导入 ZIP 文件', exact: true }).click();
  await page.getByRole('combobox', { name: '归档中的 Skill' }).selectOption('bundle/alpha');
  await page.getByRole('button', { name: '导入所选 Skill' }).click();
  expect(await page.evaluate(() => (window as any).__resourceWrites)).toHaveLength(0);
  await page.getByRole('button', { name: '确认并安装到当前工具' }).click();
  await expect(page.getByRole('heading', { name: 'alpha', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__resourceWrites)).toEqual([{ command: 'import_skill_local_zip', args: { source: 'C:/fixtures/skills.zip', subdirectory: 'bundle/alpha', expectedNew: 'new-bundle', expectedExisting: 'old-bundle' } }]);
});

test('MCP and Skill libraries are managed from the library page', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => {
    (window as unknown as { __resourceSkillPackages: Array<Record<string, unknown>> }).__resourceSkillPackages.push({ id: 'alpha-id', name: 'alpha', description: 'Complete package', fileCount: 3, digest: 'new-bundle', source: 'local', compatibility: null });
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '新建 MCP', exact: true }).click();
  await page.getByRole('textbox', { name: '名称' }).fill('filesystem');
  await page.getByRole('textbox', { name: '命令' }).fill('npx');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await expect(page.getByRole('button', { name: 'filesystem' })).toBeVisible();
  await page.getByRole('button', { name: '修改' }).click();
  await expect(page.getByRole('dialog').getByRole('textbox', { name: '命令' })).toHaveValue('npx');
  await page.getByRole('dialog').getByRole('button', { name: '关闭' }).click();
  const library = page.getByRole('region', { name: '资料库内容' });
  await library.getByRole('tab', { name: 'Skill', exact: true }).click();
  await expect(library.getByText('alpha')).toBeVisible();
  await expect(library.getByRole('button', { name: 'Codex · 未安装' })).toBeVisible();
  await library.getByRole('button', { name: '删除' }).click();
  await page.getByRole('button', { name: '删除', exact: true }).last().click();
  await expect(library.getByText('还没有 Skill')).toBeVisible();
  await library.getByRole('tab', { name: 'MCP', exact: true }).click();
  await library.getByRole('button', { name: '删除' }).click();
  await page.getByRole('button', { name: '删除', exact: true }).last().click();
  await expect(library.getByText('还没有 MCP')).toBeVisible();
});

test('saving an MCP closes the dialog and leaves the success on the page', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '添加 MCP', exact: true }).click();
  await page.getByRole('textbox', { name: '名称' }).fill('filesystem');
  await page.getByRole('textbox', { name: '命令' }).fill('npx');
  await page.getByRole('dialog').getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '已写入当前工具。' })).toBeVisible();
});

test('an MCP write conflict stays in the dialog', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => { (window as typeof window & { __resourceMcpConflict: boolean }).__resourceMcpConflict = true; });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '添加 MCP', exact: true }).click();
  await page.getByRole('textbox', { name: '名称' }).fill('filesystem');
  await page.getByRole('textbox', { name: '命令' }).fill('npx');
  await page.getByRole('dialog').getByRole('button', { name: '添加', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('当前同名条目与读取时不同，请比较后选择')).toBeVisible();
  await expect(dialog.getByRole('status').filter({ hasText: '已写入当前工具。' })).toHaveCount(0);
});


async function mockAccountResources(page: Page, contexts = ['ctx-a', 'ctx-b']) {
  await mockResources(page);
  await page.addInitScript(({ contexts }) => {
    const win = window as any;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    win.__activeContext = contexts.at(-1);
    win.__accountInstalls = contexts.map(contextId => ({ packageId: 'skill-1', toolId: 'codex', scope: 'global', projectPath: null, contextId, state: 'current', targetPath: `/accounts/${contextId}/skills/alpha` }));
    win.__resourceSkillPackages.push({ id: 'skill-1', name: 'alpha', description: 'Account skill', fileCount: 1, digest: 'digest', source: 'local', inLibrary: true });
    win.__resourceMcpDefinitions.push({ id: 'mcp-1', name: 'filesystem', transport: 'stdio', command: 'npx', args: [], url: '', env: {}, headers: {}, inLibrary: true, version: 1 });
    win.__resourceMcpPlacements.push(...contexts.map(contextId => ({ definitionId: 'mcp-1', toolId: 'codex', scope: 'global', projectPath: null, contextId, enabled: true })));
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'list_accounts') return contexts.map(id => ({ label: id === 'ctx-a' ? '工作账号' : '个人账号', context: { id }, retiredContexts: [] }));
      if (command === 'get_registered_tool_workspace') return { ...await invoke(command, args), effectiveContextId: win.__activeContext };
      if (command === 'list_skill_installations') return win.__accountInstalls;
      if (command === 'remove_skill' || command === 'remove_native_mcp') {
        const context = command === 'remove_skill' ? args.expectedContextId : args.target.contextId;
        win.__resourceWrites.push({ command, args });
        if (context !== win.__activeContext) throw { message: '请先应用目标账号的配置' };
        const items = command === 'remove_skill' ? win.__accountInstalls : win.__resourceMcpPlacements;
        const index = items.findIndex((item: any) => item.contextId === context);
        if (index >= 0) items.splice(index, 1);
        return null;
      }
      return invoke(command, args);
    };
  }, { contexts });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
}

test('OAuth MCP uncheck passes its exact context with one account', async ({ page }) => {
  await mockAccountResources(page, ['ctx-a']);
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '修改' }).click();
  await expect(page.getByRole('checkbox', { name: 'Codex' })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Codex' }).uncheck();
  await page.getByRole('button', { name: '保存并分发' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__resourceWrites)).toEqual([{ command: 'remove_native_mcp', args: { name: 'filesystem', target: expect.objectContaining({ contextId: 'ctx-a' }) } }]);
});

test('A and B MCP placements stay distinct and unchecking B preserves A', async ({ page }) => {
  await mockAccountResources(page);
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await expect(page.getByRole('group', { name: 'filesystem 的 CLI · 全局 · 工作账号', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'filesystem 的 CLI · 全局 · 个人账号', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '修改' }).click();
  await expect(page.getByText('Codex · 全局 · 工作账号（切换后可修改）')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Codex' })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Codex' }).uncheck();
  await page.getByRole('button', { name: '保存并分发' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const state = await page.evaluate(() => ({ writes: (window as any).__resourceWrites, places: (window as any).__resourceMcpPlacements }));
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].args.target.contextId).toBe('ctx-b');
  expect(state.places.map((item: any) => item.contextId)).toEqual(['ctx-a']);
});

test('Skill card and installed list remove the selected account without collapsing A/B', async ({ page }) => {
  await mockAccountResources(page);
  await page.getByRole('region', { name: '资料库内容' }).getByRole('tab', { name: 'Skill', exact: true }).click();
  const a = page.getByRole('group', { name: 'alpha 的 CLI · 全局 · 工作账号', exact: true });
  const b = page.getByRole('group', { name: 'alpha 的 CLI · 全局 · 个人账号', exact: true });
  await expect(a).toBeVisible(); await expect(b).toBeVisible();
  await a.getByRole('button').click();
  await expect(page.getByRole('alert')).toContainText('请先应用目标账号');
  await b.getByRole('button').click();
  await expect(b).toHaveCount(0); await expect(a).toBeVisible();
  await page.evaluate(() => { (window as any).__activeContext = 'ctx-a'; });
  await page.getByRole('button', { name: '修改' }).click();
  const row = page.getByRole('dialog').getByRole('listitem').filter({ hasText: '工作账号' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '移除', exact: true }).click();
  await page.getByRole('dialog').last().getByRole('button', { name: '移除', exact: true }).click();
  await expect(row).toHaveCount(0);
  const writes = await page.evaluate(() => (window as any).__resourceWrites);
  expect(writes.map((entry: any) => entry.args.expectedContextId)).toEqual(['ctx-a', 'ctx-b', 'ctx-a']);
});


async function mockBrokenResourceTargets(page: Page) {
  await mockResources(page);
  await page.addInitScript(() => {
    const win = window as any;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    win.__deferContext = false;
    win.__pendingContexts = [];
    win.__isolatedInstalls = [
      { packageId: 'skill-broken', toolId: 'codex', scope: 'global', projectPath: null, contextId: null, targetPath: '/tmp/global/alpha', state: 'current' },
      { packageId: 'skill-broken', toolId: 'codex', scope: 'project', projectPath: '/tmp/deleted-project', contextId: null, targetPath: '/tmp/deleted-project/alpha', state: 'current' },
    ];
    win.__resourceSkillPackages.push({ id: 'skill-broken', name: 'alpha', description: 'fixture', source: 'local', digest: 'fixture', fileCount: 1, inLibrary: true });
    win.__resourceMcpDefinitions.push({ id: 'mcp-broken', name: 'filesystem', transport: 'stdio', command: 'node', args: [], url: '', env: {}, headers: {}, inLibrary: true, version: 1 });
    win.__resourceMcpPlacements.push(
      { definitionId: 'mcp-broken', toolId: 'codex', scope: 'global', projectPath: null, contextId: null, enabled: true },
      { definitionId: 'mcp-broken', toolId: 'codex', scope: 'project', projectPath: '/tmp/deleted-project', contextId: null, enabled: true },
    );
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'list_cli_adapters') {
        const catalog = await invoke(command, args);
        return { ...catalog, registered: [...catalog.registered, { ...catalog.registered[0], id: 'claude_code', name: 'Claude Code' }], managedIds: ['codex', 'claude_code'] };
      }
      if (command === 'get_registered_tool_workspace') {
        if (args.scope === 'project') throw { message: '项目目录已删除' };
        if (args.toolId === 'claude_code') throw { message: '账号绑定不可读' };
        const workspace = { ...await invoke(command, args), effectiveContextId: null };
        if (win.__deferContext) return new Promise(resolve => win.__pendingContexts.push(() => resolve(workspace)));
        return workspace;
      }
      if (command === 'list_skill_installations') return win.__isolatedInstalls;
      if (command === 'preview_skill_target') { win.__resourceWrites.push({ command, args }); return { status: 'ready', previewToken: 'isolated-token' }; }
      if (command === 'remove_skill') { win.__resourceWrites.push({ command, args }); return null; }
      return invoke(command, args);
    };
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
}

test('MCP isolates failed historical projects and bindings while default global context resolves independently', async ({ page }) => {
  await mockBrokenResourceTargets(page);
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.evaluate(() => { (window as any).__deferContext = true; });
  await page.getByRole('button', { name: '修改' }).click();
  const codex = page.getByRole('checkbox', { name: 'Codex', exact: true });
  await expect(codex).toBeDisabled();
  await expect(page.getByText(/项目目录已删除/)).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Claude Code' })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__resourceWrites)).toHaveLength(0);
  await page.evaluate(() => { const win = window as any; win.__deferContext = false; win.__pendingContexts.forEach((resolve: () => void) => resolve()); });
  await expect(codex).toBeEnabled(); await expect(codex).toBeChecked();
  await page.getByRole('button', { name: '保存并分发' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const writes = await page.evaluate(() => (window as any).__resourceWrites);
  expect(writes).toHaveLength(1);
  expect(writes[0].targets).toEqual([expect.objectContaining({ toolId: 'codex', scope: 'global', contextId: null })]);
  await page.getByRole('button', { name: '修改' }).click();
  await expect(codex).toBeEnabled(); await expect(codex).toBeChecked();
  await codex.uncheck();
  await page.getByRole('button', { name: '保存并分发' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const state = await page.evaluate(() => ({ writes: (window as any).__resourceWrites, places: (window as any).__resourceMcpPlacements }));
  expect(state.writes[1]).toMatchObject({ command: 'remove_native_mcp', args: { target: { toolId: 'codex', scope: 'global', contextId: null } } });
  expect(state.places).toEqual([expect.objectContaining({ scope: 'project', projectPath: '/tmp/deleted-project' })]);
});

test('Skill failed project stays visible and disabled while healthy global installation proceeds', async ({ page }) => {
  await mockBrokenResourceTargets(page);
  await page.getByRole('region', { name: '资料库内容' }).getByRole('tab', { name: 'Skill', exact: true }).click();
  await page.getByRole('button', { name: '修改' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/项目目录已删除/)).toBeVisible();
  await expect(dialog.getByRole('listitem').filter({ hasText: 'deleted-project' }).getByRole('button', { name: '移除' })).toBeDisabled();
  await expect(dialog.getByRole('checkbox', { name: 'Claude Code' })).toBeDisabled();
  await expect(dialog.getByRole('checkbox', { name: 'Codex', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('checkbox', { name: 'Codex', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: '安装到所选 CLI' }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Codex：已安装' })).toBeVisible();
  const writes = await page.evaluate(() => (window as any).__resourceWrites);
  expect(writes).toHaveLength(2);
  expect(writes[0]).toMatchObject({ command: 'preview_skill_target', args: { toolId: 'codex', scope: 'global', projectPath: null } });
  expect(writes[1]).toMatchObject({ toolId: 'codex', scope: 'global', projectPath: null, previewToken: 'isolated-token' });
  expect(await page.evaluate(() => (window as any).__isolatedInstalls)).toHaveLength(2);
});


test('library success notices expire after four seconds', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('button', { name: '新建提示词', exact: true }).click();
  await page.getByRole('textbox', { name: '标题', exact: true }).fill('Notice fixture');
  await page.getByRole('textbox', { name: '资料正文', exact: true }).fill('Fixture body');
  await page.clock.install();
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  const status = page.getByRole('status').filter({ hasText: '已保存在本机资料库' });
  await expect(status).toBeVisible();
  await page.clock.fastForward(4100);
  await expect(status).toHaveCount(0);
  await expect(page.getByText('Notice fixture', { exact: true })).toBeVisible();
});
