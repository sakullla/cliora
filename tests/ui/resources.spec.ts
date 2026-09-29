import { expect, test } from '@playwright/test';

async function mockResources(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const library: Array<Record<string, unknown>> = [];
    const definitions: Array<Record<string, unknown>> = [];
    const skillPackages: Array<Record<string, unknown>> = [];
    const nativeSkills: Array<Record<string, unknown>> = [];
    const skillIssues: Array<Record<string, unknown>> = [];
    const writes: unknown[] = [];
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
        if (command === 'list_projects') return [];
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
          writes.push(args);
          return args.targets.map((target: Record<string, unknown>) => ({ ...target, status: 'written', detail: 'committed', path: '/tmp/config.toml', baselineHash: 'hash-empty' }));
        }
        if (command === 'list_skill_packages') return skillPackages;
        if (command === 'list_skill_installations') return [];
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
  await expect(page.getByRole('button', { name: /部署检查/ })).toBeVisible();
  await page.getByRole('textbox', { name: '搜索资料' }).fill('部署');
  await page.getByRole('textbox', { name: '资料正文' }).fill('尚未保存的修改');
  await navigation.getByRole('button', { name: '快速开始' }).click();
  await navigation.getByRole('button', { name: '资料库' }).click();
  await expect(page.getByRole('textbox', { name: '搜索资料' })).toHaveValue('部署');
  await expect(page.getByRole('textbox', { name: '资料正文' })).toHaveValue('尚未保存的修改');
});

test('tool page previews and distributes MCP with per-target result', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'MCP' }).click();
  await page.getByRole('textbox', { name: '名称' }).fill('filesystem');
  await page.getByRole('textbox', { name: '命令' }).fill('npx');
  await page.getByRole('button', { name: '保存定义' }).click();
  await page.getByRole('checkbox', { name: 'Codex' }).check();
  await page.getByRole('button', { name: '预览目标' }).click();
  await expect(page.getByText('将创建 CLI 原生条目')).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '确认分发' }).click();
  await expect(page.getByRole('status').filter({ hasText: '已写入' })).toContainText('codex：已写入');
  const writes = await page.evaluate(() => (window as typeof window & { __resourceWrites: unknown[] }).__resourceWrites);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toEqual(expect.objectContaining({ targets: [expect.objectContaining({ previewToken: 'bound-token' })] }));
});

test('MCP replacement shows both native entries and can be canceled', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => { (window as typeof window & { __resourceMcpConflict: boolean }).__resourceMcpConflict = true; });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'MCP' }).click();
  await page.getByRole('textbox', { name: '名称' }).fill('filesystem');
  await page.getByRole('textbox', { name: '命令' }).fill('npx');
  await page.getByRole('button', { name: '保存定义' }).click();
  await page.getByRole('checkbox', { name: 'Codex' }).check();
  await page.getByRole('button', { name: '预览目标' }).click();
  await expect(page.getByText('old-command')).toBeVisible();
  await expect(page.getByText('"npx"')).toBeVisible();
  page.once('dialog', (dialog) => void dialog.dismiss());
  await page.getByRole('button', { name: '确认分发' }).click();
  let writes = await page.evaluate(() => (window as typeof window & { __resourceWrites: unknown[] }).__resourceWrites);
  expect(writes).toHaveLength(0);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '确认分发' }).click();
  writes = await page.evaluate(() => (window as typeof window & { __resourceWrites: unknown[] }).__resourceWrites);
  expect(writes).toEqual([expect.objectContaining({ targets: [expect.objectContaining({ allowReplace: true, previewToken: 'bound-token' })] })]);
});

test('an unfinished MCP preview cannot return after switching scope or distribute to the old scope', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'MCP' }).click();
  await page.getByRole('textbox', { name: '名称' }).fill('filesystem');
  await page.getByRole('textbox', { name: '命令' }).fill('npx');
  await page.getByRole('button', { name: '保存定义' }).click();
  await page.getByRole('checkbox', { name: 'Codex' }).check();
  await page.evaluate(() => { (window as typeof window & { __resourceDeferMcpPreview: boolean }).__resourceDeferMcpPreview = true; });
  await page.getByRole('button', { name: '预览目标' }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __resourcePendingPreviews: unknown[] }).__resourcePendingPreviews.length)).toBe(1);
  await page.getByLabel('配置范围').selectOption('project');
  await page.getByRole('textbox', { name: '项目目录' }).fill('/tmp/second-project');
  await page.getByRole('button', { name: '打开项目' }).click();
  await page.evaluate(() => {
    const state = window as typeof window & { __resourceDeferMcpPreview: boolean; __resourcePendingPreviews: Array<() => void> };
    state.__resourceDeferMcpPreview = false;
    state.__resourcePendingPreviews.shift()?.();
  });
  await expect(page.getByRole('button', { name: '确认分发' })).toHaveCount(0);
  await page.getByRole('button', { name: '预览目标' }).click();
  await expect(page.getByRole('button', { name: '确认分发' })).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '确认分发' }).click();
  const writes = await page.evaluate(() => (window as typeof window & { __resourceWrites: Array<{ targets: Array<Record<string, unknown>> }> }).__resourceWrites);
  expect(writes).toHaveLength(1);
  expect(writes[0].targets[0]).toEqual(expect.objectContaining({ scope: 'project', projectPath: '/tmp/second-project' }));
});

test('canceling navigation keeps an unsaved MCP definition', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: '页面' });
  await navigation.getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'MCP' }).click();
  await page.getByRole('textbox', { name: '名称' }).fill('work-in-progress');
  page.once('dialog', (dialog) => void dialog.dismiss());
  await navigation.getByRole('button', { name: '快速开始' }).click();
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
  await page.getByRole('tab', { name: 'Skills' }).click();
  await expect(page.getByText('原生目录 · 点击查看或导入')).toBeVisible();
  await page.getByRole('button', { name: '安装到当前 CLI' }).click();
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
  await page.getByRole('tab', { name: 'Skills' }).click();
  await expect(page.getByRole('heading', { name: 'sample' })).toBeVisible();
  const repair = page.getByRole('alert').filter({ hasText: 'Skills 安装需要检查' });
  await expect(repair).toContainText('备份内容变化');
  await expect(repair).toContainText('/tmp/codex-backup');
  await expect(repair).not.toContainText('unrelated');
  await page.evaluate(() => { (window as typeof window & { __resourceSkillIssues: unknown[] }).__resourceSkillIssues.splice(0); });
  await repair.getByRole('button', { name: '重新检查恢复状态' }).click();
  await expect(repair).toHaveCount(0);
});
