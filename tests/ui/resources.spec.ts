import { expect, test, type Page } from '@playwright/test';

async function openMcpMoreOptions(page: Page) {
  await page.locator('details[aria-label="MCP 更多选项"] > summary').click();
}

async function mockResources(page: Page) {
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

test('MCP replacement shows both native entries and can be canceled', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => { (window as typeof window & { __resourceMcpConflict: boolean }).__resourceMcpConflict = true; });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: '添加 MCP' }).click();
  await page.getByRole('button', { name: '添加 MCP', exact: true }).click();
  await page.getByRole('textbox', { name: '名称' }).fill('filesystem');
  await page.getByRole('textbox', { name: '命令' }).fill('npx');
  await openMcpMoreOptions(page);
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
  await openMcpMoreOptions(page);
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
  await openMcpMoreOptions(page);
  await page.getByText('分发到其他 CLI',{exact:true}).click();
  await page.getByRole('checkbox', { name: 'Codex' }).check();
  await page.getByRole('button', { name: '分发所选工具' }).click();
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

