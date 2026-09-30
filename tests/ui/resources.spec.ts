import { expect, test } from '@playwright/test';

async function mockResources(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const library: Array<Record<string, unknown>> = [];
    const definitions: Array<Record<string, unknown>> = [];
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
          profiles: [], common: null, binding: null, snapshots: [], recoveryNeeded: [], customPath: null,
        };
        if (command === 'list_mcp_definitions') return definitions;
        if (command === 'get_managed_mcp_enabled') return managed[`${args.definitionId}:${args.target.toolId}:${args.target.scope}:${args.target.projectPath}`] ?? null;
        if (command === 'save_mcp_definition') {
          const item = { ...args.draft, id: args.draft.id ?? 'mcp-1', version: (args.draft.expectedVersion ?? 0) + 1 };
          const index = definitions.findIndex((old) => old.id === item.id);
          if (index < 0) definitions.push(item); else definitions[index] = item;
          return item;
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
          for(const target of args.targets) managed[`${args.definitionId}:${target.toolId}:${target.scope}:${target.projectPath}`]=target.enabled;
          writes.push(args);
          return args.targets.map((target: Record<string, unknown>) => ({ ...target, status: 'written', detail: 'committed', path: '/tmp/config.toml', baselineHash: 'hash-empty' }));
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

test('library keeps search and unsaved body across page navigation', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: '页面' });
  await navigation.getByRole('button', { name: '资料库' }).click();
  await page.getByRole('button', { name: '＋ 新建提示词' }).click();
  await page.getByRole('textbox', { name: '标题' }).fill('部署检查');
  await page.getByRole('textbox', { name: '资料正文' }).fill('检查服务健康状态');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('heading', { name: '部署检查', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '搜索资料' }).fill('部署');
  await page.getByRole('textbox', { name: '资料正文' }).fill('尚未保存的修改');
  await navigation.getByRole('button', { name: '快速开始' }).click();
  await navigation.getByRole('button', { name: '资料库' }).click();
  await expect(page.getByRole('textbox', { name: '搜索资料' })).toHaveValue('部署');
  await expect(page.getByRole('textbox', { name: '资料正文' })).toHaveText('尚未保存的修改');
});

test('CLI context resets native MCP drafts, rejects stale reads, and keeps header unchanged when switching is cancelled', async ({ page }) => {
  await mockResources(page);
  await page.addInitScript(() => {
    const tools = [{ id: 'codex', name: 'Codex', interfaceFormats: [] }, { id: 'claude_code', name: 'Claude Code', interfaceFormats: [] }];
    const internals = (window as any).__TAURI_INTERNALS__; const original = internals.invoke;
    (window as any).__pendingMcpReads = [];
    internals.invoke = async (command: string, args: any) => {
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: tools.map(tool => tool.id), theme: 'system' }, tools };
      if (command === 'list_cli_adapters') return { registered: tools, managedIds: tools.map(tool => tool.id), preservedUnknown: [] };
      if (command === 'list_mcp_definitions') return [{ id: 'shared-mcp', name: 'shared-native', transport: 'stdio', command: 'old-global-codex-command', args: [], env: {}, headers: {}, url: '', version: 1 }];
      if (command === 'list_native_mcp') {
        const name = args.target.toolId === 'codex' ? 'codex-native' : 'claude-native';
        const entries = [{ name: 'shared-native', transport: 'stdio', command: name, args: [], url: '', env: {}, headers: {}, enabled: true, protectedValues: false }];
        if (args.target.toolId === 'codex') return new Promise(resolve => (window as any).__pendingMcpReads.push(() => resolve(entries)));
        return entries;
      }
      return original(command, args);
    };
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: '添加 MCP', exact: true }).click();
  await page.getByRole('tab', { name: 'Claude Code', exact: true }).click();
  await expect(page.getByRole('button', { name: /shared-native.*这个工具会使用它/ })).toBeVisible();
  await page.evaluate(() => (window as any).__pendingMcpReads.splice(0).forEach((complete: () => void) => complete()));
  await expect(page.getByRole('button', { name: /shared-native.*这个工具会使用它/ })).toHaveCount(1);
  await page.getByRole('button', { name: /shared-native.*这个工具会使用它/ }).click();
  await expect(page.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('shared-native');
  await expect(page.getByRole('textbox', { name: '命令', exact: true })).toHaveValue('claude-native');
  await page.getByRole('textbox', { name: '命令', exact: true }).fill('claude-edited-command');
  await page.getByRole('tab', { name: 'Codex', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Claude Code', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('shared-native');
  await page.locator('details').filter({ hasText: '更多选项' }).locator('summary').click();
  await page.getByRole('button', { name: '只保存到资料库' }).click();
  await page.getByRole('tab', { name: 'Codex', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: /shared-native.*这个工具会使用它/ })).toHaveCount(0);
  await page.evaluate(() => (window as any).__pendingMcpReads.splice(0).forEach((complete: () => void) => complete()));
  await expect(page.getByRole('button', { name: /shared-native.*这个工具会使用它/ })).toBeVisible();
  await page.getByRole('button', { name: /shared-native.*这个工具会使用它/ }).click();
  await expect(page.getByRole('textbox', { name: '命令', exact: true })).toHaveValue('codex-native');
  await page.getByRole('tab', { name: 'Claude Code', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Claude Code', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('tool page previews and distributes MCP with per-target result', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: '添加 MCP' }).click();
  await page.getByRole('button', { name: '添加 MCP', exact: true }).click();
  await page.getByRole('textbox', { name: '名称' }).fill('filesystem');
  await page.getByRole('textbox', { name: '命令' }).fill('npx');
  await page.locator('details').filter({ hasText: '更多选项' }).locator('summary').click();
  await page.getByRole('button', { name: '只保存到资料库' }).click();
  await page.getByText('分发到其他 CLI',{exact:true}).click();
  await page.getByRole('checkbox', { name: 'Codex' }).check();
  await page.getByRole('button', { name: '分发所选工具' }).click();
  await expect(page.getByRole('status').filter({ hasText: '已写入' })).toContainText('codex：已写入');
  const writes = await page.evaluate(() => (window as typeof window & { __resourceWrites: unknown[] }).__resourceWrites);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toEqual(expect.objectContaining({ targets: [expect.objectContaining({ previewToken: 'bound-token' })] }));
  await page.getByRole('checkbox',{name:'这个工具会使用它',exact:true}).uncheck();
  await page.getByRole('button',{name:'保存并在当前工具使用',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'已保存并在当前工具使用'})).toBeVisible();
  await page.getByRole('button',{name:'＋ 新建',exact:true}).last().click();
  await expect(page.getByRole('checkbox',{name:'这个工具会使用它',exact:true})).toBeChecked();
  await page.getByRole('button',{name:/filesystem.*npx/}).click();
  await expect(page.getByRole('checkbox',{name:'这个工具会使用它',exact:true})).not.toBeChecked();
});

test('MCP replacement shows both native entries and can be canceled', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => { (window as typeof window & { __resourceMcpConflict: boolean }).__resourceMcpConflict = true; });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: '添加 MCP' }).click();
  await page.getByRole('button', { name: '添加 MCP', exact: true }).click();
  await page.getByRole('textbox', { name: '名称' }).fill('filesystem');
  await page.getByRole('textbox', { name: '命令' }).fill('npx');
  await page.locator('details').filter({ hasText: '更多选项' }).locator('summary').click();
  await page.getByRole('button', { name: '只保存到资料库' }).click();
  await page.getByText('分发到其他 CLI',{exact:true}).click();
  await page.getByRole('checkbox', { name: 'Codex' }).check();
  await page.getByRole('button', { name: '分发所选工具' }).click();
  await expect(page.getByText('old-command')).toBeVisible();
  await expect(page.getByText('"npx"')).toBeVisible();
  await page.getByRole('button', { name: '确认分发' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  let writes = await page.evaluate(() => (window as typeof window & { __resourceWrites: unknown[] }).__resourceWrites);
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: '确认分发' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '替换并分发', exact: true }).click();
  writes = await page.evaluate(() => (window as typeof window & { __resourceWrites: unknown[] }).__resourceWrites);
  expect(writes).toEqual([expect.objectContaining({ targets: [expect.objectContaining({ allowReplace: true, previewToken: 'bound-token' })] })]);
});

test('an unfinished MCP preview cannot return after switching scope or distribute to the old scope', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: '添加 MCP' }).click();
  await page.getByRole('button', { name: '添加 MCP', exact: true }).click();
  await page.getByRole('textbox', { name: '名称' }).fill('filesystem');
  await page.getByRole('textbox', { name: '命令' }).fill('npx');
  await page.locator('details').filter({ hasText: '更多选项' }).locator('summary').click();
  await page.getByRole('button', { name: '只保存到资料库' }).click();
  await page.getByText('分发到其他 CLI',{exact:true}).click();
  await page.getByRole('checkbox', { name: 'Codex' }).check();
  await page.evaluate(() => { (window as typeof window & { __resourceDeferMcpPreview: boolean }).__resourceDeferMcpPreview = true; });
  await page.getByRole('button', { name: '分发所选工具' }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __resourcePendingPreviews: unknown[] }).__resourcePendingPreviews.length)).toBe(1);
  await page.getByLabel('配置范围').selectOption('project');
  await page.getByRole('combobox', { name: '配置项目' }).selectOption('/tmp/second-project');
  await page.evaluate(() => {
    const state = window as typeof window & { __resourceDeferMcpPreview: boolean; __resourcePendingPreviews: Array<() => void> };
    state.__resourceDeferMcpPreview = false;
    state.__resourcePendingPreviews.shift()?.();
  });
  await expect(page.getByRole('button', { name: '确认分发' })).toHaveCount(0);
  await page.getByRole('button', { name: /filesystem.*npx/ }).click();
  await page.locator('details').filter({ hasText: '更多选项' }).locator('summary').click();
  await page.getByText('分发到其他 CLI',{exact:true}).click();
  await page.getByRole('checkbox', { name: 'Codex' }).check();
  await page.getByRole('button', { name: '分发所选工具' }).click();
  const writes = await page.evaluate(() => (window as typeof window & { __resourceWrites: Array<{ targets: Array<Record<string, unknown>> }> }).__resourceWrites);
  expect(writes).toHaveLength(1);
  expect(writes[0].targets[0]).toEqual(expect.objectContaining({ scope: 'project', projectPath: '/tmp/second-project' }));
});

test('page navigation keeps an unsaved MCP definition', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: '页面' });
  await navigation.getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: '添加 MCP' }).click();
  await page.getByRole('button', { name: '添加 MCP', exact: true }).click();
  await page.getByRole('textbox', { name: '名称' }).fill('work-in-progress');
  await navigation.getByRole('button', { name: '快速开始' }).click();
  await expect(page.getByRole('heading', {name:'快速开始',level:1})).toBeVisible();
  await navigation.getByRole('button', {name:'工具与连接'}).click();
  await expect(page.getByRole('heading', { name: '工具与连接', level: 1 })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '名称' })).toHaveValue('work-in-progress');
});

test('native Skills are visible and takeover requires a before-after preview', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => {
    const state = window as typeof window & { __resourceSkillPackages: Array<Record<string, unknown>>; __resourceNativeSkills: Array<Record<string, unknown>> };
    state.__resourceSkillPackages.push({ id: 'skill-1', name: 'sample', description: 'Sample', compatibility: null, source: 'local', digest: 'new', fileCount: 1, updatedAt: 1 });
    state.__resourceNativeSkills.push({ name: 'sample', path: '/tmp/.codex/skills/sample', digest: 'old', state: 'external', detail: '原生版本', packageId: 'skill-1' });
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: '添加 Skill' }).click();
  await expect(page.getByText('当前范围',{exact:true})).toBeVisible();
  await page.getByRole('button', { name: '安装到当前范围' }).click();
  await expect(page.getByRole('group', { name: 'Skills 目标预览' })).toContainText('原生 Skills 内容不同');
  await page.getByText('SKILL.md', { exact: true }).click();
  await expect(page.getByText('old text')).toBeVisible();
  await expect(page.getByText('new text')).toBeVisible();
  await page.getByRole('button', { name: '确认接管并替换' }).click();
  await expect(page.getByRole('status').filter({ hasText: '已安装' })).toBeVisible();
  const writes = await page.evaluate(() => (window as typeof window & { __resourceWrites: Array<Record<string, unknown>> }).__resourceWrites);
  expect(writes).toContainEqual(expect.objectContaining({ previewToken: 'skill-token', allowTakeover: true }));
});

test('Skills repair remains accessible while packages load and can be rechecked', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => {
    const state = window as typeof window & { __resourceSkillPackages: Array<Record<string, unknown>>; __resourceSkillIssues: Array<Record<string, unknown>> };
    state.__resourceSkillPackages.push({ id: 'skill-1', name: 'sample', description: 'Sample', compatibility: null, source: 'local', digest: 'new', fileCount: 1, updatedAt: 1 });
    state.__resourceSkillIssues.push(
      { operationId: 'other', toolId: 'grok', scope: 'global', projectPath: null, targetPath: '/tmp/grok', backupPath: '/tmp/grok-backup', detail: 'unrelated' },
      { operationId: 'broken', toolId: 'codex', scope: 'global', projectPath: null, targetPath: '/tmp/codex', backupPath: '/tmp/codex-backup', detail: '备份内容变化' },
    );
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: '添加 Skill' }).click();
  await expect(page.getByRole('heading', { name: 'sample' })).toBeVisible();
  const repair = page.getByRole('alert').filter({ hasText: 'Skills 安装需要检查' });
  await expect(repair).toContainText('备份内容变化');
  await expect(repair).toContainText('/tmp/codex-backup');
  await expect(repair).not.toContainText('unrelated');
  await page.evaluate(() => { (window as typeof window & { __resourceSkillIssues: unknown[] }).__resourceSkillIssues.splice(0); });
  await repair.getByRole('button', { name: '重新检查恢复状态' }).click();
  await expect(repair).toHaveCount(0);
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
  await page.getByRole('tab', { name: '添加 Skill', exact: true }).click();
  await page.getByRole('button', { name: '添加 Skill', exact: true }).click();
  await expect(page.getByRole('button', { name: '导入 ZIP 文件', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '导入 ZIP 文件', exact: true }).click();
  await page.getByRole('combobox', { name: '归档中的 Skill' }).selectOption('bundle/alpha');
  await page.getByRole('button', { name: '导入所选 Skill' }).click();
  expect(await page.evaluate(() => (window as any).__resourceWrites)).toHaveLength(0);
  await page.getByRole('button', { name: '确认更新资料库包' }).click();
  await expect(page.getByRole('heading', { name: 'alpha', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__resourceWrites)).toEqual([{ command: 'import_skill_local_zip', args: { source: 'C:/fixtures/skills.zip', subdirectory: 'bundle/alpha', expectedNew: 'new-bundle', expectedExisting: 'old-bundle' } }]);
});

async function expectPrecedes(earlier: import('@playwright/test').Locator, later: import('@playwright/test').Locator) {
  await expect(earlier).toBeVisible();
  await expect(later).toBeVisible();
  const follows = await earlier.evaluate((node, other) => other instanceof Node && (node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, await later.elementHandle());
  expect(follows).toBe(true);
  const [top, bottom] = await Promise.all([earlier.boundingBox(), later.boundingBox()]);
  expect(top && bottom && top.y < bottom.y).toBe(true);
}

test('tool completion actions precede long forms without new confirmations', async ({ page }) => {
  await mockResources(page);
  await page.addInitScript(() => {
    const profile = { id: 'profile-1', tool: 'codex', name: '日常', version: 1, revision: 'rev', inheritCommon: false, files: { config: 'model = "gpt"\n' }, suppressed: {}, connection: { providerId: 'openai', interfaceFormat: 'openai_responses', baseUrl: 'https://example.invalid/v1', model: 'gpt', secretRef: null, authEnvVar: null }, nativeCredentials: {} };
    const internals = (window as any).__TAURI_INTERNALS__;
    const original = internals.invoke;
    internals.invoke = async (command: string, args: any) => {
      if (command === 'get_registered_tool_workspace') return {
        probe: { selectedPath: 'C:/codex.exe', installations: [], nativeFiles: [{ role: 'config', path: 'C:/config.toml', format: 'toml', writable: true, sensitive: false, reason: null }], nativeWrites: { state: 'supported', reason: '可写入', evidence: '' }, interfaceFormats: ['openai_responses'], providerPresets: [], dependencies: [], installUrl: 'https://example.invalid', upgradeHint: '', installCommand: null, upgradeCommand: null },
        profiles: [structuredClone(profile)], common: null, binding: null, snapshots: [], recoveryNeeded: ['tx-1'], customPath: null,
      };
      if (command === 'read_registered_native_file_for_edit') return 'model = "gpt"\n';
      if (command === 'inspect_registered_native_draft') return {};
      if (command === 'prepare_registered_native_import') return { files: args.files, inspection: { connection: null, providerId: null, model: null, reasoningEffort: null }, migratedSecret: false, nativeCredentials: {} };
      if (command === 'save_registered_native_profile') return { ...args.profile, id: args.profile.id || 'profile-1', version: (args.expectedVersion ?? 0) + 1, revision: 'saved' };
      if (command === 'apply_registered_native_profile') throw { message: '请确认接管外部修改' };
      if (command === 'compare_registered_application') return { profile, common: null, files: [{ role: 'config', format: 'toml', current: 'old', proposed: { model: 'gpt' } }] };
      if (command === 'save_registered_native_file') return { transactionId: 'tx', changedFiles: [], status: 'written_for_next_session' };
      if (command === 'list_skill_packages') return [{ id: 'skill-1', name: 'sample', description: 'Sample', compatibility: 'node', source: 'local', digest: 'new', fileCount: 1, updatedAt: 1 }];
      return original(command, args);
    };
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  const saveAndUse = page.getByRole('button', { name: '保存并给这个工具使用', exact: true });
  const remove = page.getByRole('button', { name: '删除', exact: true });
  await expect(page.getByRole('button', { name: '重试恢复', exact: true })).toBeVisible();
  await expectPrecedes(saveAndUse, page.getByRole('textbox', { name: '配置名称', exact: true }));
  await expectPrecedes(saveAndUse, page.getByRole('textbox', { name: 'API 地址', exact: true }));
  await expectPrecedes(saveAndUse, page.getByRole('textbox', { name: 'API 密钥', exact: true }));
  await expect(saveAndUse).toHaveClass(/primary/);
  await expect(remove).not.toHaveClass(/primary/);
  const [primaryBackground, secondaryBackground] = await Promise.all([
    saveAndUse.evaluate((element) => getComputedStyle(element).backgroundColor),
    remove.evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  expect(primaryBackground).not.toBe(secondaryBackground);
  await page.getByText('更多选项', { exact: true }).first().click();
  await page.getByText('高级连接选项', { exact: true }).click();
  const paid = page.getByRole('button', { name: '发送最小请求（可能计费）', exact: true });
  await expect(paid).toHaveCount(0);
  await page.getByText('更多诊断', { exact: true }).click();
  await paid.click();
  const confirmation = page.getByRole('dialog');
  await expect(confirmation).toHaveCount(1);
  await expect(confirmation).toHaveAccessibleName('发送可能计费的请求？');
  await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirmation).toHaveCount(0);
  await page.getByRole('button', { name: '仅保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '配置已保存' })).toBeVisible();
  await saveAndUse.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const conflict = page.getByRole('region', { name: '配置应用冲突' });
  await expect(conflict).toBeVisible();
  await expect(conflict.getByRole('button', { name: '使用本次配置', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '配置这个工具', exact: true })).toHaveAttribute('aria-selected', 'true');
  await remove.click();
  await expect(confirmation).toHaveCount(1);
  await expect(confirmation).toHaveAccessibleName('删除配置');
  await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '日常', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '正在使用的文件', exact: true }).click();
  await expectPrecedes(page.getByRole('button', { name: '保存到正在使用的文件', exact: true }), page.getByRole('textbox', { name: 'config 配置草稿', exact: true }));
  await page.getByRole('tab', { name: '添加 MCP', exact: true }).click();
  await page.getByRole('button', { name: '添加 MCP', exact: true }).click();
  await expect(conflict).toHaveCount(0);
  const saveMcp = page.getByRole('button', { name: '保存并在当前工具使用', exact: true });
  await expectPrecedes(saveMcp, page.getByRole('textbox', { name: '名称', exact: true }));
  await expectPrecedes(saveMcp, page.getByRole('textbox', { name: '命令', exact: true }));
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('keep-me');
  await page.getByRole('textbox', { name: '命令', exact: true }).fill('npx');
  await saveMcp.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '已保存并在当前工具使用' })).toBeVisible();
  await page.getByRole('tab', { name: '添加 Skill', exact: true }).click();
  const install = page.getByRole('button', { name: '安装到当前范围', exact: true });
  await expectPrecedes(install, page.getByRole('checkbox', { name: '启用 Skill', exact: true }));
  await expectPrecedes(install, page.getByText('更多选项', { exact: true }).last());
  await page.getByRole('tab', { name: '添加 MCP', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('keep-me');
  await page.getByRole('tab', { name: '配置这个工具', exact: true }).click();
  await expect(conflict).toBeVisible();
});
