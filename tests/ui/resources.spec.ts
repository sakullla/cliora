import { expect, test, type Page } from '@playwright/test';
import { openCli } from './cli-switcher';

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
          const item = { ...args.draft, id: args.draft.id ?? `mcp-${definitions.length + 1}`, version: (args.draft.expectedVersion ?? 0) + 1 };
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
            ({ ...target, status: (window as typeof window & { __resourceMcpConflict: boolean }).__resourceMcpConflict ? 'conflict' : 'ready', detail: (window as typeof window & { __resourceMcpConflict: boolean }).__resourceMcpConflict ? '同名原生 MCP 未受当前资料库管理，请比较后确认' : '将创建 CLI 原生条目', path: '/tmp/config.toml', baselineHash: 'hash-empty', previewToken: 'bound-token', existing: (window as typeof window & { __resourceMcpConflict: boolean }).__resourceMcpConflict ? { command: 'old-command' } : null, proposed: { command: 'npx' } }));
          if ((window as typeof window & { __resourceDeferMcpPreview: boolean }).__resourceDeferMcpPreview) {
            return new Promise((resolve) => { pendingPreviews.push(() => resolve(response)); });
          }
          return response;
        }
        if (command === 'preview_mcp_draft') {
          const definition = { ...args.draft, id: args.draft.id ?? 'candidate-' + (definitions.length + 1), version: (args.draft.expectedVersion ?? 0) + 1 };
          const targets = args.targets.map((target: Record<string, any>) => {
            const operation = target.operation ?? 'write';
            const conflict = (window as typeof window & { __resourceMcpConflict: boolean }).__resourceMcpConflict;
            return { ...target, operation, status: conflict ? 'conflict' : 'ready', detail: operation === 'remove' ? conflict ? '原生条目已被外部修改，请比较后确认' : '将移除当前受管理的原生条目' : '将创建 CLI 原生条目', path: '/tmp/config.toml', baselineHash: operation === 'remove' ? 'hash-remove' : 'hash-empty', previewToken: operation === 'remove' ? 'bound-remove-token' : 'bound-token', existing: operation === 'remove' ? { command: conflict ? 'old-command' : 'npx' } : conflict ? { command: 'old-command' } : null, proposed: operation === 'remove' ? null : { command: args.draft.command || args.draft.url } };
          });
          const response = { draft: args.draft, definition, targets };
          if ((window as typeof window & { __resourceDeferMcpPreview: boolean }).__resourceDeferMcpPreview) {
            return new Promise((resolve) => { pendingPreviews.push(() => resolve(response)); });
          }
          return response;
        }
        if (command === 'commit_mcp_draft') {
          const definition = await (window as any).__TAURI_INTERNALS__.invoke('save_mcp_definition', { draft: args.draft });
          const targets = args.targets.length ? await (window as any).__TAURI_INTERNALS__.invoke('distribute_mcp', { definitionId: definition.id, targets: args.targets }) : [];
          return { definition, targets };
        }
        if (command === 'distribute_mcp') {
          for (const target of args.targets) {
            const key = `${args.definitionId}:${target.toolId}:${target.scope}:${target.projectPath}`;
            const row = { definitionId: args.definitionId, toolId: target.toolId, scope: target.scope, projectPath: target.projectPath ?? null, contextId: target.contextId ?? null, enabled: target.enabled };
            const index = placements.findIndex((item) => item.definitionId === row.definitionId && item.toolId === row.toolId && item.scope === row.scope && item.projectPath === row.projectPath && (item.contextId ?? null) === row.contextId);
            if (target.operation === 'remove') {
              delete managed[key];
              if (index >= 0) placements.splice(index, 1);
            } else {
              managed[key] = target.enabled;
              if (index < 0) placements.push(row); else placements[index] = row;
            }
          }
          writes.push(args);
          return args.targets.map((target: Record<string, any>) => ({ ...target, status: target.operation === 'remove' ? 'removed' : 'written', detail: 'committed', path: '/tmp/config.toml', baselineHash: 'hash-empty' }));
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
        if (command === 'list_native_skill_files') return { files: [], truncated: false };
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

function mcpEditor(page: Page, surface: 'library' | 'current CLI') {
  return surface === 'library' ? page.getByRole('dialog', { name: '新建 MCP' }) : page.getByRole('article', { name: '添加 MCP' });
}

async function openMcpPasteReview(page: Page, surface: 'library' | 'current CLI', source: string) {
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: surface === 'library' ? '资料库' : '工具与连接' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: surface === 'library' ? '新建 MCP' : '添加 MCP', exact: true }).first().click();
  const editor = mcpEditor(page, surface);
  await editor.getByRole('textbox', { name: '名称' }).fill('keep-draft');
  await editor.getByRole('button', { name: '粘贴导入' }).click();
  await editor.getByRole('textbox', { name: '粘贴 MCP JSON' }).fill(source);
  await editor.getByRole('button', { name: '解析并填入' }).click();
  return page.getByRole('dialog', { name: '审查 MCP 导入' });
}

test('MCP argument and environment fields edit with row controls, support Enter key row navigation, and keep literal values', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await startLibraryMcp(page);
  const dialog = page.getByRole('dialog');
  const args = dialog.getByRole('group', { name: '参数，每行一项' });
  const firstArg = args.getByRole('textbox', { name: '参数，每行一项 第 1 行' });
  await firstArg.fill('chrome-devtools-mcp@latest');
  await firstArg.press('Enter');
  const secondArg = args.getByRole('textbox', { name: '参数，每行一项 第 2 行' });
  await expect(secondArg).toBeFocused();
  await secondArg.fill('--stdio');
  const env = dialog.getByRole('group', { name: '环境变量' });
  const firstEnvKey = env.getByRole('textbox', { name: '环境变量 第 1 行键名' });
  await firstEnvKey.fill('MYSQL_PORT');
  await firstEnvKey.press('Enter');
  const firstEnvVal = env.getByRole('textbox', { name: '环境变量 第 1 行值' });
  await expect(firstEnvVal).toBeFocused();
  await firstEnvVal.fill('3216');
  await firstEnvVal.press('Enter');
  const secondEnvKey = env.getByRole('textbox', { name: '环境变量 第 2 行键名' });
  await expect(secondEnvKey).toBeFocused();
  await secondEnvKey.fill('MYSQL_PASSWORD');
  await env.getByRole('textbox', { name: '环境变量 第 2 行值' }).fill('local-secret');
  await dialog.getByRole('radio', { name: 'HTTP', exact: true }).click();
  await dialog.getByRole('textbox', { name: '网址' }).fill('https://example.com/mcp');
  const headers = dialog.getByRole('group', { name: '请求头' });
  await headers.getByRole('textbox', { name: '请求头 第 1 行键名' }).fill('Authorization');
  await headers.getByRole('textbox', { name: '请求头 第 1 行值' }).fill('Bearer local-secret');
  await headers.getByRole('button', { name: '添加一行' }).click();
  await headers.getByRole('textbox', { name: '请求头 第 2 行键名' }).fill('X-Team');
  await headers.getByRole('textbox', { name: '请求头 第 2 行值' }).fill('desk');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('请使用环境变量引用')).toHaveCount(0);
  const saved = await page.evaluate(() => (window as unknown as { __resourceMcpDefinitions: Array<{ args: string[]; env: Record<string, string>; headers: Record<string, string> }> }).__resourceMcpDefinitions[0]);
  expect(saved.args).toEqual(['chrome-devtools-mcp@latest', '--stdio']);
  expect(saved.env).toEqual({ MYSQL_PORT: '3216', MYSQL_PASSWORD: 'local-secret' });
  expect(saved.headers).toEqual({ Authorization: 'Bearer local-secret', 'X-Team': 'desk' });
});

test('MCP env rows reorder with buttons and the saved payload keeps that order', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await startLibraryMcp(page);
  const dialog = page.getByRole('dialog');
  const env = dialog.getByRole('group', { name: '环境变量' });
  await env.getByRole('textbox', { name: '环境变量 第 1 行键名' }).fill('Z_FOO');
  await env.getByRole('textbox', { name: '环境变量 第 1 行值' }).fill('1');
  await env.getByRole('button', { name: '添加一行' }).click();
  await env.getByRole('textbox', { name: '环境变量 第 2 行键名' }).fill('A_BAR');
  await env.getByRole('textbox', { name: '环境变量 第 2 行值' }).fill('2');
  await env.getByRole('button', { name: '上移第 2 行' }).click();
  await expect(env.getByRole('textbox', { name: '环境变量 第 1 行键名' })).toHaveValue('A_BAR');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const keys = await page.evaluate(() => Object.keys((window as unknown as { __resourceMcpDefinitions: Array<{ env: Record<string, string> }> }).__resourceMcpDefinitions[0].env));
  expect(keys).toEqual(['A_BAR', 'Z_FOO']);
});

test('MCP duplicate key rows show a visible warning', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await startLibraryMcp(page);
  const env = page.getByRole('dialog').getByRole('group', { name: '环境变量' });
  await env.getByRole('textbox', { name: '环境变量 第 1 行键名' }).fill('SAME');
  await env.getByRole('button', { name: '添加一行' }).click();
  await env.getByRole('textbox', { name: '环境变量 第 2 行键名' }).fill('SAME');
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('SAME');
});

test('paste import fills a stdio MCP from an mcpServers wrapper', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '新建 MCP', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '粘贴导入' }).click();
  await dialog.getByRole('textbox', { name: '粘贴 MCP JSON' }).fill(JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], env: { ROOT: '/tmp/root' } } } }));
  await dialog.getByRole('button', { name: '解析并填入' }).click();
  const review = page.getByRole('dialog', { name: '审查 MCP 导入' });
  await expect(review).toContainText('filesystem');
  await expect(review).toContainText('npx');
  await review.getByRole('button', { name: '预览选中的 1 项' }).click();
  await review.getByRole('button', { name: '确认导入 1 项' }).click();
  await expect(review.getByText('已保存 filesystem')).toBeVisible();
  const saved = await page.evaluate(() => (window as any).__resourceMcpDefinitions[0]);
  expect(saved.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem']);
  expect(saved.env).toEqual({ ROOT: '/tmp/root' });
});

test('paste import fills an HTTP MCP and rejects unrecognizable content without touching the form', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '新建 MCP', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '名称' }).fill('keep-me');
  await dialog.getByRole('button', { name: '粘贴导入' }).click();
  await dialog.getByRole('textbox', { name: '粘贴 MCP JSON' }).fill(JSON.stringify({ url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${API_TOKEN}' } }));
  await dialog.getByRole('button', { name: '解析并填入' }).click();
  const review = page.getByRole('dialog', { name: '审查 MCP 导入' });
  await expect(review).toContainText('keep-me');
  await expect(review).toContainText('https://example.com/mcp');
  await review.getByRole('button', { name: '预览选中的 1 项' }).click();
  await review.getByRole('button', { name: '确认导入 1 项' }).click();
  await expect(review.getByText('已保存 keep-me')).toBeVisible();
  const saved = await page.evaluate(() => (window as any).__resourceMcpDefinitions[0]);
  expect(saved.headers).toEqual({ Authorization: 'Bearer ${API_TOKEN}' });
  await review.getByRole('button', { name: '返回', exact: true }).click();
  await dialog.getByRole('button', { name: '粘贴导入' }).click();
  await dialog.getByRole('textbox', { name: '粘贴 MCP JSON' }).fill('not json at all');
  await dialog.getByRole('button', { name: '解析并填入' }).click();
  await expect(dialog.getByRole('alert')).toContainText('无法识别这段内容');
  await expect(dialog.getByRole('textbox', { name: '名称' })).toHaveValue('keep-me');
  await expect(dialog.getByRole('textbox', { name: '命令' })).toHaveValue('');
});

test('paste review returns to the original source for duplicate and semantic corrections', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => {
    (window as any).__resourceMcpDefinitions.push({ id: 'mcp-existing', name: 'existing', transport: 'stdio', command: 'npx', args: [], url: '', env: {}, headers: {}, inLibrary: true, version: 1 });
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '新建 MCP', exact: true }).click();
  const source = JSON.stringify({ mcpServers: { existing: { command: 'npx' }, broken: { args: [] }, badArgs: { command: 'npx', args: ['ok', 3] } } });
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '粘贴导入' }).click();
  await dialog.getByRole('textbox', { name: '粘贴 MCP JSON' }).fill(source);
  await dialog.getByRole('button', { name: '解析并填入' }).click();
  const review = page.getByRole('dialog', { name: '审查 MCP 导入' });
  await expect(review).toContainText('重复或已存在');
  await expect(review).toContainText('请填写要运行的命令');
  await expect(review).toContainText('args 必须是仅包含字符串的数组');
  await expect(review.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await review.getByRole('button', { name: '返回', exact: true }).click();
  const paste = dialog.getByRole('textbox', { name: '粘贴 MCP JSON' });
  await expect(paste).toBeVisible();
  await expect(paste).toHaveValue(source);
  await paste.fill(JSON.stringify({ mcpServers: { corrected: { command: 'uvx' } } }));
  await dialog.getByRole('button', { name: '解析并填入' }).click();
  await expect(review.getByRole('checkbox', { name: '选择导入 corrected' })).toBeChecked();
});

for (const surface of ['library', 'current CLI'] as const) {
  test(`${surface} paste review restores the original source after backend validation rejects control characters`, async ({ page }) => {
    await mockResources(page);
    await page.addInitScript(() => {
      const win = window as any;
      const invoke = win.__TAURI_INTERNALS__.invoke;
      win.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
        if (command === 'preview_mcp_draft' && Object.values({ ...args.draft.env, ...args.draft.headers }).some(value => /[\u0000-\u001f\u007f]/.test(String(value)))) {
          throw new Error('env/headers 不能包含控制字符');
        }
        return invoke(command, args);
      };
    });
    await page.goto('/');
    const source = JSON.stringify({ mcpServers: { rejected: surface === 'library'
      ? { command: 'npx', env: { BAD: 'line\nbreak' } }
      : { url: 'https://example.test/mcp', headers: { 'X-Test': 'bad\r\nvalue' } } } });
    const review = await openMcpPasteReview(page, surface, source);
    await review.getByRole('button', { name: '预览选中的 1 项' }).click();
    await expect(review.getByRole('alert')).toContainText('env/headers 不能包含控制字符');
    await review.getByRole('button', { name: '返回', exact: true }).click();
    const editor = mcpEditor(page, surface);
    const paste = editor.getByRole('textbox', { name: '粘贴 MCP JSON' });
    await expect(paste).toBeVisible();
    await expect(paste).toHaveValue(source);
    await paste.fill(JSON.stringify({ mcpServers: { corrected: { command: 'uvx' } } }));
    await editor.getByRole('button', { name: '解析并填入' }).click();
    await expect(review.getByRole('checkbox', { name: '选择导入 corrected' })).toBeChecked();
  });

  for (const closeMethod of ['Escape', 'close button'] as const) {
    test(`${surface} batch review ${closeMethod} cancels discard without losing import state`, async ({ page }) => {
      await mockResources(page);
      await page.goto('/');
      const source = JSON.stringify({ mcpServers: { imported: { command: 'npx' } } });
      const review = await openMcpPasteReview(page, surface, source);
      const close = async () => {
        if (closeMethod === 'Escape') await review.press('Escape');
        else await review.getByRole('button', { name: '关闭' }).click();
      };
      await close();
      const confirmation = page.getByRole('dialog', { name: '放弃未保存修改？' });
      await expect(confirmation).toBeVisible();
      await confirmation.getByRole('button', { name: '取消', exact: true }).click();
      await expect(review).toBeVisible();
      await review.getByRole('button', { name: '返回', exact: true }).click();
      const editor = mcpEditor(page, surface);
      await expect(editor.getByRole('textbox', { name: '名称' })).toHaveValue('keep-draft');
      await expect(editor.getByRole('textbox', { name: '粘贴 MCP JSON' })).toHaveValue(source);
      await editor.getByRole('button', { name: '解析并填入' }).click();
      await close();
      await confirmation.getByRole('button', { name: '放弃修改', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
  }

  test(`${surface} paste review rejects non-string maps and preserves bare entry names`, async ({ page }) => {
    await mockResources(page);
    await page.goto('/');
    if (surface === 'library') {
      await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
      await page.getByRole('tab', { name: 'MCP', exact: true }).click();
      await page.getByRole('button', { name: '新建 MCP', exact: true }).click();
    } else {
      await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
      await page.getByRole('tab', { name: 'MCP', exact: true }).click();
      await page.getByRole('button', { name: '添加 MCP', exact: true }).first().click();
    }
    const dialog = mcpEditor(page, surface);
    await dialog.getByRole('button', { name: '粘贴导入' }).click();
    await dialog.getByRole('textbox', { name: '粘贴 MCP JSON' }).fill(JSON.stringify({
      local: { command: 'npx', env: { ROOT: '/tmp', PORT: 3000, ENABLED: true } },
      remote: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer token', 'X-Retry': 2 } },
      broken: 7,
    }));
    await dialog.getByRole('button', { name: '解析并填入' }).click();
    const review = page.getByRole('dialog', { name: '审查 MCP 导入' });
    await expect(review.getByText('local', { exact: true })).toBeVisible();
    await expect(review.getByText('remote', { exact: true })).toBeVisible();
    await expect(review.getByText('broken', { exact: true })).toBeVisible();
    await expect(review).toContainText('env 必须是对象，值只能是字符串。');
    await expect(review).toContainText('headers 必须是对象，值只能是字符串。');
    await expect(review).toContainText('服务器条目必须是 JSON 对象。');
    await expect(review.getByRole('checkbox', { checked: true })).toHaveCount(0);
    await expect(review.getByRole('button', { name: '预览选中的 0 项' })).toBeDisabled();
    expect(await page.evaluate(() => (window as any).__resourceMcpDefinitions)).toEqual([]);
    expect(await page.evaluate(() => (window as any).__resourceWrites)).toEqual([]);
  });
}

test('MCP card duplicates a definition under a distinct backend-valid name', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => {
    (window as unknown as { __resourceMcpDefinitions: Array<Record<string, unknown>> }).__resourceMcpDefinitions.push({ id: 'mcp-1', name: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], url: '', env: {}, headers: {}, inLibrary: true, version: 1 });
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  // Duplicate and delete live in the row menu; the menu renders in a portal.
  await page.getByRole('button', { name: 'filesystem 的更多操作' }).click();
  await page.getByRole('menuitem', { name: '创建副本' }).click();
  await expect(page.getByRole('status').filter({ hasText: '已创建副本「filesystem-copy」' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'MCP 列表' }).getByText('filesystem-copy', { exact: true })).toBeVisible();
  const copies = await page.evaluate(() => (window as unknown as { __resourceMcpDefinitions: Array<{ id: string; name: string; command: string }> }).__resourceMcpDefinitions);
  expect(copies.map((item) => item.name)).toEqual(['filesystem', 'filesystem-copy']);
  // The backend valid_name only accepts ASCII alphanumerics, '-' and '_' within 1–80 bytes.
  expect(copies[1].name).toMatch(/^[A-Za-z0-9_-]{1,80}$/);
  expect(copies[1].id).not.toBe('mcp-1');
  expect(copies[1].command).toBe('npx');
  await page.getByRole('button', { name: 'filesystem 的更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '创建副本' }).click();
  const tripled = await page.evaluate(() => (window as unknown as { __resourceMcpDefinitions: Array<{ name: string }> }).__resourceMcpDefinitions.map((item) => item.name));
  expect(tripled).toEqual(['filesystem', 'filesystem-copy', 'filesystem-copy-2']);
});

test('MCP duplicate name stays within the 80 byte backend limit when the source name is long', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => {
    (window as unknown as { __resourceMcpDefinitions: Array<Record<string, unknown>> }).__resourceMcpDefinitions.push({ id: 'mcp-1', name: 'a'.repeat(78), transport: 'stdio', command: 'npx', args: [], url: '', env: {}, headers: {}, inLibrary: true, version: 1 });
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: `${'a'.repeat(78)} 的更多操作` }).click();
  await page.getByRole('menuitem', { name: '创建副本' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __resourceMcpDefinitions: unknown[] }).__resourceMcpDefinitions.length)).toBe(2);
  const copies = await page.evaluate(() => (window as unknown as { __resourceMcpDefinitions: Array<{ name: string }> }).__resourceMcpDefinitions);
  expect(copies).toHaveLength(2);
  expect(copies[1].name).toMatch(/^[A-Za-z0-9_-]{1,80}$/);
  expect(copies[1].name.endsWith('-copy')).toBe(true);
  expect(copies[1].name).not.toBe(copies[0].name);
});

test('MCP details keep delete, duplicate, edit, and distribution actions', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => {
    (window as unknown as { __resourceMcpDefinitions: Array<Record<string, unknown>> }).__resourceMcpDefinitions.push({ id: 'mcp-1', name: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], url: '', env: {}, headers: {}, inLibrary: true, version: 1 });
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  const card = page.getByRole('list', { name: 'MCP 列表' }).getByRole('listitem').filter({ hasText: 'filesystem' });
  await expect(card.getByRole('button', { name: '修改' })).toBeVisible();
  await card.getByRole('button', { name: 'filesystem 的更多操作' }).click();
  await expect(page.getByRole('menuitem', { name: '删除' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '创建副本' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card.getByRole('group', { name: 'filesystem 的 CLI · 全局' })).toBeVisible();
  await expect(card.getByRole('button', { name: '编辑并分发' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: '复制 JSON' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: '复制命令' })).toHaveCount(0);
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
  expect(await page.evaluate(() => (window as any).__resourceMcpDefinitions)).toEqual([]);
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
  await expect(page.getByRole('checkbox', { name: 'Codex' })).toHaveAccessibleDescription('已写入');
  await page.getByRole('checkbox', { name: 'Codex' }).uncheck();
  await expect(page.getByRole('checkbox', { name: 'Codex' })).toHaveAccessibleDescription('保存时移除');
  await expect(page.getByRole('dialog').getByText('将从 Codex 移除')).toBeVisible();
  await page.getByRole('button', { name: '保存并分发' }).click();
  await page.getByRole('button', { name: '确认并分发', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '已从 Codex 移除。' })).toBeVisible();
  const writes = await page.evaluate(() => (window as typeof window & { __resourceWrites: Array<Record<string, unknown>> }).__resourceWrites);
  expect(writes).toEqual([expect.objectContaining({ targets: [expect.objectContaining({ operation: 'remove', baselineHash: 'hash-remove', previewToken: 'bound-remove-token' })] })]);
});

test('library MCP quick write shows an unmanaged conflict diff and only writes after explicit confirmation', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => {
    const state = window as any;
    state.__resourceMcpConflict = true;
    state.__resourceMcpDefinitions.push({ id: 'mcp-1', name: 'filesystem', transport: 'stdio', command: 'npx', args: [], url: '', env: {}, headers: {}, inLibrary: true, version: 1 });
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  const marks = page.getByRole('group', { name: 'filesystem 的 CLI · 全局' });
  await marks.getByRole('button', { name: 'Codex · 未写入' }).click();
  const confirmation = page.getByRole('dialog', { name: '替换同名 MCP？' });
  await expect(confirmation).toContainText('同名原生 MCP 未受当前资料库管理，请比较后确认');
  await expect(confirmation).toContainText('old-command');
  await expect(confirmation).toContainText('"npx"');
  await expect(confirmation.getByRole('table', { name: '逐行差异' })).toBeVisible();
  await confirmation.getByRole('button', { name: '保留当前文件', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  let state = await page.evaluate(() => ({ writes: (window as any).__resourceWrites, places: (window as any).__resourceMcpPlacements, definitions: (window as any).__resourceMcpDefinitions }));
  expect(state.writes).toEqual([]);
  expect(state.places).toEqual([]);
  expect(state.definitions[0].version).toBe(1);
  await expect(marks.getByRole('button', { name: 'Codex · 未写入' })).toBeVisible();

  await marks.getByRole('button', { name: 'Codex · 未写入' }).click();
  await confirmation.getByRole('button', { name: '替换并写入', exact: true }).click();
  await expect(marks.getByRole('button', { name: 'Codex · 已生效' })).toBeVisible();
  state = await page.evaluate(() => ({ writes: (window as any).__resourceWrites, places: (window as any).__resourceMcpPlacements }));
  expect(state.writes).toEqual([expect.objectContaining({ definitionId: 'mcp-1', targets: [expect.objectContaining({ baselineHash: 'hash-empty', previewToken: 'bound-token', allowReplace: true })] })]);
  expect(state.places).toHaveLength(1);
});

test('library MCP quick write rejects an external change after preview', async ({ page }) => {
  await mockResources(page);
  await page.addInitScript(() => {
    const win = window as any;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'distribute_mcp') {
        win.__resourceQuickWriteCommit = args;
        throw new Error('MCP 候选、目标上下文或原生条目在预览后变化；请重新预览');
      }
      return invoke(command, args);
    };
  });
  await page.goto('/');
  await page.evaluate(() => {
    const state = window as any;
    state.__resourceMcpConflict = true;
    state.__resourceMcpDefinitions.push({ id: 'mcp-1', name: 'filesystem', transport: 'stdio', command: 'npx', args: [], url: '', env: {}, headers: {}, inLibrary: true, version: 1 });
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  const marks = page.getByRole('group', { name: 'filesystem 的 CLI · 全局' });
  await marks.getByRole('button', { name: 'Codex · 未写入' }).click();
  const confirmation = page.getByRole('dialog', { name: '替换同名 MCP？' });
  await confirmation.getByRole('button', { name: '替换并写入', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '原生条目在预览后变化' })).toBeVisible();
  await expect(marks.getByRole('button', { name: 'Codex · 未写入' })).toBeVisible();
  const state = await page.evaluate(() => ({ commit: (window as any).__resourceQuickWriteCommit, writes: (window as any).__resourceWrites, places: (window as any).__resourceMcpPlacements }));
  expect(state.commit).toEqual(expect.objectContaining({ definitionId: 'mcp-1', targets: [expect.objectContaining({ baselineHash: 'hash-empty', previewToken: 'bound-token', allowReplace: true })] }));
  expect(state.writes).toEqual([]);
  expect(state.places).toEqual([]);
});

test('library MCP quick removal requires preview confirmation and preserves placement on cancel', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => {
    const state = window as any;
    state.__resourceMcpDefinitions.push({ id: 'mcp-1', name: 'filesystem', transport: 'stdio', command: 'npx', args: [], url: '', env: {}, headers: {}, inLibrary: true, version: 1 });
    state.__resourceMcpPlacements.push({ definitionId: 'mcp-1', toolId: 'codex', scope: 'global', projectPath: null, enabled: true });
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  const marks = page.getByRole('group', { name: 'filesystem 的 CLI · 全局' });
  await marks.getByRole('button', { name: 'Codex · 已生效' }).click();
  const confirmation = page.getByRole('dialog', { name: '从 CLI 移除 MCP' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  let state = await page.evaluate(() => ({ writes: (window as any).__resourceWrites, places: (window as any).__resourceMcpPlacements }));
  expect(state.writes).toEqual([]);
  expect(state.places).toHaveLength(1);
  await expect(marks.getByRole('button', { name: 'Codex · 已生效' })).toBeVisible();

  await marks.getByRole('button', { name: 'Codex · 已生效' }).click();
  await confirmation.getByRole('button', { name: '移除', exact: true }).click();
  await expect(marks.getByRole('button', { name: 'Codex · 未写入' })).toBeVisible();
  state = await page.evaluate(() => ({ writes: (window as any).__resourceWrites, places: (window as any).__resourceMcpPlacements }));
  expect(state.writes).toEqual([expect.objectContaining({ targets: [expect.objectContaining({ operation: 'remove', baselineHash: 'hash-remove', previewToken: 'bound-remove-token' })] })]);
  expect(state.places).toEqual([]);
});

test('library MCP quick removal shows an external change conflict and only deletes after explicit confirmation', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => {
    const state = window as any;
    state.__resourceMcpConflict = true;
    state.__resourceMcpDefinitions.push({ id: 'mcp-1', name: 'filesystem', transport: 'stdio', command: 'npx', args: [], url: '', env: {}, headers: {}, inLibrary: true, version: 1 });
    state.__resourceMcpPlacements.push({ definitionId: 'mcp-1', toolId: 'codex', scope: 'global', projectPath: null, enabled: true });
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  const marks = page.getByRole('group', { name: 'filesystem 的 CLI · 全局' });
  await marks.getByRole('button', { name: 'Codex · 已生效' }).click();
  const confirmation = page.getByRole('dialog', { name: '从 CLI 移除 MCP' });
  await expect(confirmation).toContainText('原生条目已被外部修改，请比较后确认');
  await expect(confirmation).toContainText('old-command');
  await expect(confirmation).toContainText('null');
  await expect(confirmation.getByRole('table', { name: '逐行差异' })).toBeVisible();
  await confirmation.getByRole('button', { name: '保留当前文件', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  let state = await page.evaluate(() => ({ writes: (window as any).__resourceWrites, places: (window as any).__resourceMcpPlacements, definitions: (window as any).__resourceMcpDefinitions }));
  expect(state.writes).toEqual([]);
  expect(state.places).toHaveLength(1);
  expect(state.definitions[0].version).toBe(1);
  await expect(marks.getByRole('button', { name: 'Codex · 已生效' })).toBeVisible();

  await marks.getByRole('button', { name: 'Codex · 已生效' }).click();
  await confirmation.getByRole('button', { name: '移除', exact: true }).click();
  await expect(marks.getByRole('button', { name: 'Codex · 未写入' })).toBeVisible();
  state = await page.evaluate(() => ({ writes: (window as any).__resourceWrites, places: (window as any).__resourceMcpPlacements }));
  expect(state.writes).toEqual([expect.objectContaining({ targets: [expect.objectContaining({ operation: 'remove', baselineHash: 'hash-remove', previewToken: 'bound-remove-token', allowReplace: true })] })]);
  expect(state.places).toEqual([]);
});

test('library MCP quick removal rejects an external change after preview', async ({ page }) => {
  await mockResources(page);
  await page.addInitScript(() => {
    const win = window as any;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'preview_mcp_draft') {
        win.__resourceQuickRemovePreview = args;
        return invoke(command, args);
      }
      if (command === 'commit_mcp_draft') {
        win.__resourceQuickRemoveCommit = args;
        throw new Error('MCP 候选、目标上下文或原生条目在预览后变化；请重新预览');
      }
      return invoke(command, args);
    };
  });
  await page.goto('/');
  await page.evaluate(() => {
    const state = window as any;
    state.__resourceMcpDefinitions.push({ id: 'mcp-1', name: 'filesystem', transport: 'stdio', command: 'npx', args: [], url: '', env: {}, headers: {}, inLibrary: true, version: 1 });
    state.__resourceMcpPlacements.push({ definitionId: 'mcp-1', toolId: 'codex', scope: 'global', projectPath: null, enabled: true });
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  const marks = page.getByRole('group', { name: 'filesystem 的 CLI · 全局' });
  await marks.getByRole('button', { name: 'Codex · 已生效' }).click();
  const confirmation = page.getByRole('dialog', { name: '从 CLI 移除 MCP' });
  await confirmation.getByRole('button', { name: '移除', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '原生条目在预览后变化' })).toBeVisible();
  await expect(marks.getByRole('button', { name: 'Codex · 已生效' })).toBeVisible();
  const state = await page.evaluate(() => ({
    preview: (window as any).__resourceQuickRemovePreview,
    commit: (window as any).__resourceQuickRemoveCommit,
    writes: (window as any).__resourceWrites,
    places: (window as any).__resourceMcpPlacements,
    definitions: (window as any).__resourceMcpDefinitions,
  }));
  expect(state.preview.targets).toEqual([expect.objectContaining({ operation: 'remove', enabled: true })]);
  expect(state.commit.targets).toEqual([expect.objectContaining({ operation: 'remove', baselineHash: 'hash-remove', previewToken: 'bound-remove-token' })]);
  expect(state.writes).toEqual([]);
  expect(state.places).toHaveLength(1);
  expect(state.definitions[0].version).toBe(1);
});

test('MCP removal rejects an external change after preview without deleting the placement', async ({ page }) => {
  await mockResources(page);
  await page.addInitScript(() => {
    const win = window as any;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'preview_mcp_draft') {
        win.__resourceRemovePreview = args;
        return invoke(command, args);
      }
      if (command === 'commit_mcp_draft') {
        win.__resourceRemoveCommit = args;
        throw new Error('MCP 候选、目标上下文或原生条目在预览后变化；请重新预览');
      }
      return invoke(command, args);
    };
  });
  await page.goto('/');
  await page.evaluate(() => {
    const state = window as any;
    state.__resourceMcpDefinitions.push({ id: 'mcp-1', name: 'filesystem', transport: 'stdio', command: 'npx', args: [], url: '', env: {}, headers: {}, inLibrary: true, version: 1 });
    state.__resourceMcpPlacements.push({ definitionId: 'mcp-1', toolId: 'codex', scope: 'global', projectPath: null, enabled: true });
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '修改' }).click();
  await page.getByRole('checkbox', { name: 'Codex' }).uncheck();
  await page.getByRole('button', { name: '保存并分发' }).click();
  await expect(page.getByText('可移除', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认并分发', exact: true }).click();
  await expect(page.getByRole('region', { name: '写入到 CLI' }).getByRole('alert')).toContainText('原生条目在预览后变化');
  await expect(page.getByRole('dialog')).toBeVisible();
  const state = await page.evaluate(() => ({
    preview: (window as any).__resourceRemovePreview,
    commit: (window as any).__resourceRemoveCommit,
    writes: (window as any).__resourceWrites,
    places: (window as any).__resourceMcpPlacements,
    definitions: (window as any).__resourceMcpDefinitions,
  }));
  expect(state.preview.targets).toEqual([expect.objectContaining({ operation: 'remove', enabled: true })]);
  expect(state.commit.targets).toEqual([expect.objectContaining({ operation: 'remove', baselineHash: 'hash-remove', previewToken: 'bound-remove-token' })]);
  expect(state.writes).toEqual([]);
  expect(state.places).toHaveLength(1);
  expect(state.definitions[0].version).toBe(1);
});

for (const status of ['failed', 'unsupported'] as const) {
  test(`MCP mixed preview blocks commit when removal is ${status}`, async ({ page }) => {
    await mockResources(page);
    await page.addInitScript((blockedStatus) => {
      const win = window as any;
      const invoke = win.__TAURI_INTERNALS__.invoke;
      win.__resourceMixedCommits = 0;
      win.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
        if (command === 'list_cli_adapters') {
          const catalog = await invoke(command, args);
          return { ...catalog, registered: [...catalog.registered, { ...catalog.registered[0], id: 'claude_code', name: 'Claude Code' }], managedIds: ['codex', 'claude_code'] };
        }
        if (command === 'preview_mcp_draft') {
          const response = await invoke(command, args);
          return { ...response, targets: response.targets.map((target: any) => target.operation === 'remove' ? { ...target, status: blockedStatus, detail: `removal ${blockedStatus}` } : target) };
        }
        if (command === 'commit_mcp_draft') win.__resourceMixedCommits += 1;
        return invoke(command, args);
      };
    }, status);
    await page.goto('/');
    await page.evaluate(() => {
      const state = window as any;
      state.__resourceMcpDefinitions.push({ id: 'mcp-1', name: 'filesystem', transport: 'stdio', command: 'npx', args: [], url: '', env: {}, headers: {}, inLibrary: true, version: 1 });
      state.__resourceMcpPlacements.push({ definitionId: 'mcp-1', toolId: 'codex', scope: 'global', projectPath: null, enabled: true });
    });
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
    await page.getByRole('tab', { name: 'MCP', exact: true }).click();
    await page.getByRole('button', { name: '修改' }).click();
    await expect(page.getByRole('checkbox', { name: 'Claude Code' })).toBeEnabled();
    await page.getByRole('checkbox', { name: 'Claude Code' }).check();
    await page.getByRole('checkbox', { name: 'Codex' }).uncheck();
    await page.getByRole('button', { name: '保存并分发' }).click();
    await expect(page.getByText('可写入', { exact: true })).toBeVisible();
    await expect(page.getByText(`removal ${status}`, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '确认并分发', exact: true }).click();
    await expect(page.getByRole('region', { name: '写入到 CLI' }).getByRole('alert')).toContainText(`removal ${status}`);
    await expect(page.getByText(`removal ${status}`, { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toBeVisible();
    const state = await page.evaluate(() => ({
      commits: (window as any).__resourceMixedCommits,
      writes: (window as any).__resourceWrites,
      places: (window as any).__resourceMcpPlacements,
      definitions: (window as any).__resourceMcpDefinitions,
    }));
    expect(state.commits).toBe(0);
    expect(state.writes).toEqual([]);
    expect(state.places).toEqual([expect.objectContaining({ definitionId: 'mcp-1', toolId: 'codex' })]);
    expect(state.definitions[0].version).toBe(1);
  });
}

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
  await page.getByRole('button', { name: '确认并分发', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { __resourceWrites: Array<Record<string, unknown>> }).__resourceWrites)).toEqual([expect.objectContaining({ targets: [expect.objectContaining({ operation: 'remove', previewToken: 'bound-remove-token' })] })]);
  const status = page.getByRole('status').filter({ hasText: '已从 Codex 移除。' });
  await expect(status).toBeVisible();
  // A hovered toast pauses by design; the save button can sit where the toast appears.
  await page.mouse.move(0, 0);
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
  await page.getByRole('button', { name: '确认并分发', exact: true }).click();
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
  await page.getByRole('button', { name: '确认并分发', exact: true }).click();
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
  await page.getByRole('button', { name: '添加 Skill', exact: true }).first().click();
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
  await expect(page.getByRole('list', { name: 'MCP 列表' }).getByText('filesystem', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '修改' }).click();
  await expect(page.getByRole('dialog').getByRole('textbox', { name: '命令' })).toHaveValue('npx');
  await page.getByRole('dialog').getByRole('button', { name: '关闭' }).click();
  const library = page.getByRole('region', { name: '资料库内容' });
  await library.getByRole('tab', { name: 'Skill', exact: true }).click();
  await expect(library.getByText('alpha')).toBeVisible();
  await expect(library.getByRole('button', { name: 'Codex · 未安装' })).toBeVisible();
  await library.getByRole('button', { name: 'alpha 的更多操作' }).click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('button', { name: '删除', exact: true }).last().click();
  await expect(library.getByText('还没有 Skill')).toBeVisible();
  await library.getByRole('tab', { name: 'MCP', exact: true }).click();
  await library.getByRole('button', { name: 'filesystem 的更多操作' }).click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('button', { name: '删除', exact: true }).last().click();
  await expect(library.getByText('还没有 MCP')).toBeVisible();
});

test('saving an MCP closes the dialog and leaves the success on the page', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '添加 MCP', exact: true }).first().click();
  const editor = page.getByRole('article', { name: '添加 MCP' });
  await editor.getByRole('textbox', { name: '名称' }).fill('filesystem');
  await editor.getByRole('textbox', { name: '命令' }).fill('npx');
  await editor.getByRole('button', { name: '添加', exact: true }).click();
  await editor.getByRole('button', { name: '确认写入当前 CLI' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '已写入当前工具。' })).toBeVisible();
});

test('an MCP write conflict stays in the dialog', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => { (window as typeof window & { __resourceMcpConflict: boolean }).__resourceMcpConflict = true; });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '添加 MCP', exact: true }).first().click();
  const editor = page.getByRole('article', { name: '添加 MCP' });
  await editor.getByRole('textbox', { name: '名称' }).fill('filesystem');
  await editor.getByRole('textbox', { name: '命令' }).fill('npx');
  await editor.getByRole('button', { name: '添加', exact: true }).click();
  await expect(editor.getByText('当前同名条目与读取时不同，请比较后选择')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '已写入当前工具。' })).toHaveCount(0);
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
  await page.getByRole('button', { name: '确认并分发', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__resourceWrites)).toEqual([expect.objectContaining({ definitionId: 'mcp-1', targets: [expect.objectContaining({ operation: 'remove', contextId: 'ctx-a', previewToken: 'bound-remove-token' })] })]);
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
  await page.getByRole('button', { name: '确认并分发', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const state = await page.evaluate(() => ({ writes: (window as any).__resourceWrites, places: (window as any).__resourceMcpPlacements }));
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].targets[0].contextId).toBe('ctx-b');
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
  await page.getByRole('button', { name: '确认并分发', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const writes = await page.evaluate(() => (window as any).__resourceWrites);
  expect(writes).toHaveLength(1);
  expect(writes[0].targets).toEqual([expect.objectContaining({ toolId: 'codex', scope: 'global', contextId: null })]);
  await page.getByRole('button', { name: '修改' }).click();
  await expect(codex).toBeEnabled(); await expect(codex).toBeChecked();
  await codex.uncheck();
  await page.getByRole('button', { name: '保存并分发' }).click();
  await page.getByRole('button', { name: '确认并分发', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const state = await page.evaluate(() => ({ writes: (window as any).__resourceWrites, places: (window as any).__resourceMcpPlacements }));
  expect(state.writes[1]).toMatchObject({ definitionId: 'mcp-broken', targets: [{ toolId: 'codex', scope: 'global', contextId: null, operation: 'remove', previewToken: 'bound-remove-token' }] });
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

test('MCP form points at an invalid name and does not save it', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await startLibraryMcp(page);
  const dialog = page.getByRole('dialog');
  const name = dialog.getByRole('textbox', { name: '名称' });
  await name.fill('my server');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toHaveAccessibleDescription(/只可用字母、数字/);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __resourceMcpDefinitions: unknown[] }).__resourceMcpDefinitions)).toHaveLength(0);
  await name.fill('my-server');
  await expect(name).not.toHaveAttribute('aria-invalid', 'true');
  await dialog.getByRole('radio', { name: 'HTTP', exact: true }).click();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '网址' })).toHaveAccessibleDescription('请填写服务地址。');
  expect(await page.evaluate(() => (window as unknown as { __resourceMcpDefinitions: unknown[] }).__resourceMcpDefinitions)).toHaveLength(0);
});

test('pasting MCP JSON into the name field fills the whole form', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '新建 MCP', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const name = dialog.getByRole('textbox', { name: '名称' });
  await name.evaluate((input, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, JSON.stringify({ mcpServers: { github: { url: 'https://api.example.test/mcp', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } }, other: { command: 'npx' } } }));
  const review = page.getByRole('dialog', { name: '审查 MCP 导入' });
  await expect(review).toContainText('github');
  await expect(review).toContainText('other');
  await review.getByRole('button', { name: '预览选中的 2 项' }).click();
  await review.getByRole('button', { name: '确认导入 2 项' }).click();
  await expect(review.getByText('已保存 github')).toBeVisible();
  await expect(review.getByText('已保存 other')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__resourceMcpDefinitions.map((item: any) => item.name))).toEqual(['github', 'other']);
});

test('literal secrets in env rows are masked until revealed; references stay readable', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await startLibraryMcp(page);
  const env = page.getByRole('dialog').getByRole('group', { name: '环境变量' });
  await env.getByRole('textbox', { name: '环境变量 第 1 行键名' }).fill('GITHUB_TOKEN');
  const value = env.getByRole('textbox', { name: '环境变量 第 1 行值' });
  await value.fill('ghp_literal');
  await expect(value).toHaveAttribute('data-masked', 'true');
  await env.getByRole('button', { name: '显示第 1 行的值' }).click();
  await expect(value).not.toHaveAttribute('data-masked', 'true');
  await value.fill('${GITHUB_TOKEN}');
  await expect(env.getByRole('button', { name: /第 1 行的值/ })).toHaveCount(0);
  await expect(value).not.toHaveAttribute('data-masked', 'true');
});

test('closing an edited library MCP asks before discarding the draft', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await startLibraryMcp(page);
  const editor = page.getByRole('dialog', { name: '新建 MCP' });
  await editor.getByRole('button', { name: '关闭' }).click();
  const confirmation = page.getByRole('dialog', { name: '放弃未保存修改？' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor.getByRole('textbox', { name: '名称' })).toHaveValue('filesystem');
  await editor.getByRole('button', { name: '关闭' }).click();
  await confirmation.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('saving an unmanaged native MCP keeps it out of the library unless asked', async ({ page }) => {
  await mockResources(page);
  await page.addInitScript(() => {
    const win = window as any;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    const entry = { name: 'native-one', transport: 'stdio', command: 'npx', args: ['-y', 'native-one'], url: '', env: {}, headers: {}, enabled: true, protectedValues: false };
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => command === 'list_native_mcp' ? [entry] : invoke(command, args);
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  const row = page.getByRole('button', { name: /native-one/ });
  await expect(row).toContainText('npx -y native-one');
  await row.click();
  await page.getByRole('article', { name: 'MCP 详情' }).getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('article', { name: '修改 MCP' });
  await expect(editor.getByRole('checkbox', { name: '同时放进资料库' })).not.toBeChecked();
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await editor.getByRole('button', { name: '确认写入当前 CLI' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  let saved = await page.evaluate(() => (window as any).__resourceMcpDefinitions);
  expect(saved).toEqual([expect.objectContaining({ name: 'native-one', inLibrary: false })]);
  await row.click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await editor.getByRole('checkbox', { name: '同时放进资料库' }).check();
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await editor.getByRole('button', { name: '确认写入当前 CLI' }).click();
  await expect(editor).toHaveCount(0);
  saved = await page.evaluate(() => (window as any).__resourceMcpDefinitions);
  expect(saved).toEqual([expect.objectContaining({ name: 'native-one', inLibrary: true })]);
  await expect(row).toContainText('资料库');
});

test('current MCP details reveal secrets explicitly and library navigation returns to the same context', async ({ page }) => {
  await mockResources(page);
  await page.addInitScript(() => {
    const win = window as any;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    const entry = { name: 'native-one', transport: 'stdio', command: 'npx', args: [], url: '', env: { API_TOKEN: 'literal-secret' }, headers: {}, enabled: true, protectedValues: false };
    win.__resourceMcpDefinitions.push({ id: 'mcp-native', name: 'native-one', transport: 'stdio', command: 'npx', args: [], url: '', env: { API_TOKEN: 'literal-secret' }, headers: {}, inLibrary: true, version: 1 });
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => command === 'list_native_mcp' ? [entry] : invoke(command, args);
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  const row = page.getByRole('button', { name: /native-one/ });
  await row.click();
  const details = page.getByRole('article', { name: 'MCP 详情' });
  await expect(details).toContainText('••••');
  await expect(details).not.toContainText('literal-secret');
  await details.getByRole('button', { name: '显示 API_TOKEN 的值' }).click();
  await expect(details).toContainText('literal-secret');
  await details.getByRole('button', { name: '在资料库中打开' }).click();
  const libraryRow = page.getByRole('list', { name: 'MCP 列表' }).getByRole('listitem').filter({ hasText: 'native-one' });
  await expect(libraryRow).toBeVisible();
  await expect(libraryRow).not.toContainText('literal-secret');
  await expect(page.getByRole('dialog', { name: '修改 MCP' })).toHaveCount(0);
  await page.getByRole('button', { name: '返回工具与连接' }).click();
  await expect(page.getByRole('tab', { name: 'MCP', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(row).toBeVisible();
});

test('current MCP details reset revealed secrets when selecting another entry', async ({ page }) => {
  await mockResources(page);
  await page.addInitScript(() => {
    const win = window as any;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    const entries = ['native-one', 'native-two'].map((name, index) => ({ name, transport: 'stdio', command: 'npx', args: [], url: '', env: { API_TOKEN: `secret-${index + 1}` }, headers: {}, enabled: true, protectedValues: false }));
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => command === 'list_native_mcp' ? entries : invoke(command, args);
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: /native-one/ }).click();
  const details = page.getByRole('article', { name: 'MCP 详情' });
  await details.getByRole('button', { name: '显示 API_TOKEN 的值' }).click();
  await expect(details).toContainText('secret-1');
  await page.getByRole('button', { name: /native-two/ }).click();
  await expect(details).not.toContainText('secret-1');
  await expect(details).not.toContainText('secret-2');
  await expect(details).toContainText('••••');
  await details.getByRole('button', { name: '显示 API_TOKEN 的值' }).click();
  await expect(details).toContainText('secret-2');
});

test('current MCP paste import preserves disabled and library choices', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '添加 MCP', exact: true }).first().click();
  const dialog = page.getByRole('article', { name: '添加 MCP' });
  await dialog.getByRole('checkbox', { name: '启用', exact: true }).uncheck();
  await dialog.getByRole('checkbox', { name: '同时放进资料库' }).check();
  await dialog.getByRole('button', { name: '粘贴导入' }).click();
  await dialog.getByRole('textbox', { name: '粘贴 MCP JSON' }).fill(JSON.stringify({ mcpServers: { filesystem: { command: 'npx' } } }));
  await dialog.getByRole('button', { name: '解析并填入' }).click();
  const review = page.getByRole('dialog', { name: '审查 MCP 导入' });
  await review.getByRole('button', { name: '预览选中的 1 项' }).click();
  await review.getByRole('button', { name: '确认导入 1 项' }).click();
  await expect(review.getByText('已保存 filesystem')).toBeVisible();
  const saved = await page.evaluate(() => (window as any).__resourceMcpDefinitions[0]);
  const writes = await page.evaluate(() => (window as any).__resourceWrites);
  expect(saved.inLibrary).toBe(true);
  expect(writes[0].targets[0].enabled).toBe(false);
});

test('canceling a current MCP candidate leaves definitions and native writes untouched', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '添加 MCP', exact: true }).first().click();
  const dialog = page.getByRole('article', { name: '添加 MCP' });
  await dialog.getByRole('textbox', { name: '名称' }).fill('candidate');
  await dialog.getByRole('textbox', { name: '命令' }).fill('npx');
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await expect(dialog.getByText('将创建 CLI 原生条目')).toBeVisible();
  await dialog.getByRole('button', { name: '返回', exact: true }).click();
  await dialog.getByRole('button', { name: '关闭' }).click();
  await page.getByRole('dialog', { name: '放弃未保存修改？' }).getByRole('button', { name: '放弃修改' }).click();
  expect(await page.evaluate(() => (window as any).__resourceMcpDefinitions)).toEqual([]);
  expect(await page.evaluate(() => (window as any).__resourceWrites)).toEqual([]);
});

test('current MCP refresh failure keeps stale entries and can be retried', async ({ page }) => {
  await mockResources(page);
  await page.addInitScript(() => {
    const win = window as any;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    win.__failNativeRefresh = false;
    win.__nativeReads = 0;
    const entry = { name: 'native-one', transport: 'stdio', command: 'npx', args: [], url: '', env: {}, headers: {}, enabled: true, protectedValues: false };
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'list_native_mcp') {
        win.__nativeReads += 1;
        if (win.__nativeReads > 1 && win.__failNativeRefresh) throw new Error('temporary native failure');
        return [entry];
      }
      return invoke(command, args);
    };
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  const row = page.getByRole('button', { name: /native-one/ });
  await expect(row).toBeVisible();
  await page.evaluate(() => { (window as any).__failNativeRefresh = true; });
  await page.getByRole('button', { name: '重新扫描' }).click();
  await expect(page.getByText('最近一次读取失败，以下列表可能已过期。')).toBeVisible();
  await expect(row).toBeVisible();
  await page.evaluate(() => { (window as any).__failNativeRefresh = false; });
  await page.getByRole('button', { name: '重新扫描' }).first().click();
  await expect(page.getByText('最近一次读取失败，以下列表可能已过期。')).toHaveCount(0);
});

test('batch import keeps mixed target results partial and retries the remaining write', async ({ page }) => {
  await mockResources(page);
  await page.addInitScript(() => {
    const win = window as any;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    win.__mixedCommitAttempts = 0;
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      const result = await invoke(command, args);
      if (command === 'commit_mcp_draft' && ++win.__mixedCommitAttempts === 1) {
        return { ...result, targets: [{ status: 'written', detail: 'committed' }, { status: 'failed', detail: 'second target failed' }] };
      }
      return result;
    };
  });
  await page.goto('/');
  await startLibraryMcp(page);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '粘贴导入' }).click();
  await dialog.getByRole('textbox', { name: '粘贴 MCP JSON' }).fill(JSON.stringify({ mcpServers: { mixed: { command: 'npx' } } }));
  await dialog.getByRole('button', { name: '解析并填入' }).click();
  const review = page.getByRole('dialog', { name: '审查 MCP 导入' });
  await review.getByRole('button', { name: '预览选中的 1 项' }).click();
  await review.getByRole('button', { name: '确认导入 1 项' }).click();
  await expect(review.getByText('部分完成，可重试')).toBeVisible();
  await expect(review.getByText('second target failed')).toBeVisible();
  await expect(review.getByRole('button', { name: '预览选中的 1 项' })).toBeEnabled();
  await review.getByRole('button', { name: '预览选中的 1 项' }).click();
  await review.getByRole('button', { name: '确认导入 1 项' }).click();
  await expect(review.getByText('已完成', { exact: true })).toBeVisible();
  await expect(review.getByText('部分完成，可重试')).toHaveCount(0);
});

test('batch import keeps per-item failures visible while later items commit', async ({ page }) => {
  await mockResources(page);
  await page.addInitScript(() => {
    const win = window as any;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'commit_mcp_draft' && args.draft.name === 'bad') throw new Error('bad item failed');
      return invoke(command, args);
    };
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '新建 MCP', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '粘贴导入' }).click();
  await dialog.getByRole('textbox', { name: '粘贴 MCP JSON' }).fill(JSON.stringify({ mcpServers: { bad: { command: 'npx' }, good: { command: 'uvx' } } }));
  await dialog.getByRole('button', { name: '解析并填入' }).click();
  const review = page.getByRole('dialog', { name: '审查 MCP 导入' });
  await review.getByRole('button', { name: '预览选中的 2 项' }).click();
  await review.getByRole('button', { name: '确认导入 2 项' }).click();
  await expect(review.getByRole('alert')).toContainText('bad item failed');
  await expect(review.getByText('已保存 good')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__resourceMcpDefinitions.map((item: any) => item.name))).toEqual(['good']);
});

test('MCP card results float as a toast and never push the card list down', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => {
    const state = window as typeof window & { __resourceMcpDefinitions: Array<Record<string, unknown>>; __resourceMcpPlacements: Array<Record<string, unknown>> };
    state.__resourceMcpDefinitions.push({ id: 'mcp-1', name: 'filesystem', transport: 'stdio', command: 'npx', args: [], url: '', env: {}, headers: {}, inLibrary: true, version: 1 });
    state.__resourceMcpPlacements.push({ definitionId: 'mcp-1', toolId: 'codex', scope: 'global', projectPath: null, enabled: true });
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  const list = page.getByLabel('MCP 列表', { exact: true });
  const documentTop = () => list.evaluate(element => element.offsetTop);
  const before = await documentTop();
  await page.getByRole('button', { name: 'Codex · 已生效' }).click();
  await page.getByRole('dialog', { name: '从 CLI 移除 MCP' }).getByRole('button', { name: '移除', exact: true }).click();
  const status = page.getByRole('region', { name: '资料库内容' }).getByRole('status').filter({ hasText: '已从 Codex 移除。' });
  await expect(status).toBeVisible();
  expect(await status.evaluate((element) => getComputedStyle(element.parentElement as Element).position)).toBe('fixed');
  expect(await documentTop()).toBe(before);
  await status.getByRole('button', { name: '关闭提示' }).click();
  await expect(status).toHaveCount(0);
});

test('MCP empty rows show an example that cannot be mistaken for a typed value', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '新建 MCP', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const args = dialog.getByRole('group', { name: '参数，每行一项' });
  const first = args.getByRole('textbox', { name: '参数，每行一项 第 1 行' });
  await first.fill('-y');
  await args.getByRole('button', { name: '添加一行' }).click();
  const second = args.getByRole('textbox', { name: '参数，每行一项 第 2 行' });
  await expect(second).toBeFocused();
  await expect(second).toHaveValue('');
  await expect(second).toHaveAttribute('placeholder', '例如 -y');
  await dialog.getByRole('heading', { name: '新建 MCP' }).click();
  const style = (locator: typeof first) => locator.evaluate((element) => getComputedStyle(element).borderTopStyle);
  expect(await style(first)).toBe('solid');
  expect(await style(second)).toBe('dashed');
  const env = dialog.getByRole('group', { name: '环境变量' });
  await expect(env.getByRole('textbox', { name: '环境变量 第 1 行键名' })).toHaveAttribute('placeholder', '变量名，例如 API_TOKEN');
});

test('MCP workspace shows skeleton rows on first load and embeds the add entry in the empty state', async ({ page }) => {
  await mockResources(page);
  await page.addInitScript(() => {
    const win = window as any;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    win.__mcpListHolders = [];
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'list_native_mcp') return new Promise(resolve => { win.__mcpListHolders.push(() => resolve([])); });
      return invoke(command, args);
    };
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  const skeleton = page.locator('[role="status"] .skeleton-page');
  await expect(skeleton).toBeVisible();
  await expect(skeleton).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => (window as any).__mcpListHolders.forEach((release: () => void) => release()));
  const add = page.getByRole('button', { name: '添加 MCP', exact: true });
  await expect(add).toHaveCount(2);
  await add.last().click();
  const editor = page.getByRole('article', { name: '添加 MCP' });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('heading', { name: '添加 MCP' })).toBeVisible();
});

test('MCP search with no results keeps the empty-state add entry hidden', async ({ page }) => {
  await mockResources(page);
  await page.addInitScript(() => {
    const win = window as any;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    const entries = Array.from({ length: 6 }, (_, index) => ({ name: `native-${index}`, transport: 'stdio', command: 'npx', args: [], url: '', env: {}, headers: {}, enabled: true, protectedValues: false }));
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => command === 'list_native_mcp' ? entries : invoke(command, args);
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByLabel('搜索当前 CLI 的 MCP').fill('no-present');
  await expect(page.getByText('没有匹配「no-present」的 MCP。')).toBeVisible();
  await expect(page.getByRole('button', { name: '清除搜索' })).toBeVisible();
  await expect(page.getByText('这个 CLI 还没有生效的 MCP')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '添加 MCP', exact: true })).toHaveCount(1);
});

for (const state of ['external', 'read_only'] as const) {
  test(`Skill document-only inventory stays readable with a null digest (${state})`, async ({ page }) => {
    await mockResources(page);
    await page.goto('/');
    await page.evaluate((state) => {
      const win = window as any;
      win.__resourceNativeSkills.push({ name: 'document-only', path: '/tmp/skills/document-only', digest: null, state, detail: 'Native document', packageId: null });
      const original = win.__TAURI_INTERNALS__.invoke;
      win.__TAURI_INTERNALS__.invoke = async (command: string, args: Record<string, any> = {}) => {
        if (command === 'read_native_skill') return { name: 'document-only', path: args.directory, content: '# Native skill document' };
        return original(command, args);
      };
    }, state);
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
    await page.getByRole('tab', { name: 'Skill', exact: true }).click();
    const entry = page.getByRole('button', { name: /document-only/ });
    await expect(entry).toContainText(state === 'external' ? '本机目录' : '只读');
    await entry.click();
    await expect(page.getByRole('region', { name: 'SKILL.md 预览' })).toContainText('Native skill document');
    await page.getByRole('article').getByRole('button', { name: state === 'external' ? '编辑' : '源码', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'SKILL.md', exact: true });
    await expect(editor).toContainText('# Native skill document');
    await expect(editor).toHaveAttribute('contenteditable', state === 'external' ? 'true' : 'false');
  });
}

test('Skill workspace shows skeleton rows on first load and embeds the add entry in the empty state', async ({ page }) => {
  await mockResources(page);
  await page.addInitScript(() => {
    const win = window as any;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    win.__skillScanHolders = [];
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'scan_native_skills') return new Promise(resolve => { win.__skillScanHolders.push(() => resolve([])); });
      return invoke(command, args);
    };
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  const skeleton = page.locator('[role="status"] .skeleton-page');
  await expect(skeleton).toBeVisible();
  await expect(skeleton).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => (window as any).__skillScanHolders.forEach((release: () => void) => release()));
  const add = page.getByRole('button', { name: '添加 Skill', exact: true });
  await expect(add).toHaveCount(2);
  await add.last().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '添加 Skill', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '选择文件夹', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '导入 ZIP 文件', exact: true })).toBeVisible();
});

test('Skill workspace shows the scan failure inline when the empty state is caused by an error', async ({ page }) => {
  await mockResources(page);
  await page.addInitScript(() => {
    const win = window as any;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'scan_native_skills') throw { code: 'native_error', message: '读取 Skill 目录失败' };
      return invoke(command, args);
    };
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  await expect(page.getByText('这个 CLI 还没有生效的 Skill')).toHaveCount(0);
  await expect(page.getByText('Skill 列表加载失败：读取 Skill 目录失败')).toBeVisible();
  await expect(page.getByText('没有匹配的 Skill。')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '清除条件' })).toHaveCount(0);
  await expect(page.getByText('只管理用户目录下的本地插件')).toHaveCount(0);
});

test('accounts workspace shows skeleton rows on first read and a rediscover action in the empty state', async ({ page }) => {
  await mockResources(page);
  await page.addInitScript(() => {
    const win = window as any;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    win.__nativeLoginHolders = [];
    win.__accountCommands = [] as string[];
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (command === 'discover_native_logins' || command === 'list_accounts' || command === 'account_capabilities') {
        win.__accountCommands.push(command);
        if (command === 'discover_native_logins') return new Promise(resolve => { win.__nativeLoginHolders.push(() => resolve({ toolId: args.toolId, checkedAt: 1, logins: [] })); });
        return [];
      }
      return invoke(command, args);
    };
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: '账号', exact: true }).click();
  const skeleton = page.locator('section[aria-label="CLI 原生登录"] [role="status"] .skeleton-page');
  await expect(skeleton).toBeVisible();
  await expect(skeleton).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => (window as any).__nativeLoginHolders.forEach((release: () => void) => release()));
  const emptyState = page.locator('.empty-state');
  await expect(emptyState).toBeVisible();
  await expect(emptyState.getByRole('button')).toHaveCount(1);
  await emptyState.getByRole('button', { name: '重新发现登录' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__accountCommands.filter((command: string) => command === 'discover_native_logins').length)).toBe(2);
  await page.evaluate(() => (window as any).__nativeLoginHolders.forEach((release: () => void) => release()));
});

test('Skill list shows writable, read-only, and plugin skills and limits actions by source', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => {
    const win = window as any;
    win.__resourceSkillPackages.push({ id: 'pkg-1', name: 'managed-one', description: 'Managed copy', fileCount: 1, digest: 'new', source: 'library', compatibility: null, inLibrary: true });
    win.__resourceNativeSkills.push(
      { name: 'managed-one', path: '/tmp/skills/managed-one', digest: 'old', state: 'managed', detail: 'Managed copy', packageId: 'pkg-1', source: 'writable', pluginName: null, pluginEnabled: null },
      { name: 'local-write', path: '/tmp/skills/local-write', digest: null, state: 'external', detail: 'Writable document', packageId: null, source: 'writable', pluginName: null, pluginEnabled: null },
      { name: 'compat-read', path: '/tmp/skills/compat-read', digest: null, state: 'read_only', detail: '兼容目录，只读', packageId: null, source: 'read_only', pluginName: null, pluginEnabled: null },
      { name: 'alpha-skill', path: '/tmp/plugins/alpha/skills/alpha-skill', digest: null, state: 'read_only', detail: 'Alpha document', packageId: null, source: 'plugin', pluginName: 'Alpha Pack', pluginEnabled: true },
      { name: 'beta-skill', path: '/tmp/plugins/alpha/skills/beta-skill', digest: null, state: 'read_only', detail: 'Beta document', packageId: null, source: 'plugin', pluginName: 'Alpha Pack', pluginEnabled: true },
      { name: 'gamma-skill', path: '/tmp/plugins/gamma/skills/gamma-skill', digest: null, state: 'read_only', detail: 'Gamma document', packageId: null, source: 'plugin', pluginName: 'Gamma Pack', pluginEnabled: false },
      { name: 'quiet-skill', path: '/tmp/plugins/quiet/skills/quiet-skill', digest: null, state: 'read_only', detail: 'Quiet document', packageId: null, source: 'plugin', pluginName: 'Quiet Pack', pluginEnabled: null },
      { name: 'bad-skill', path: '/tmp/plugins/alpha/skills/bad-skill', digest: null, state: 'unreadable', detail: 'SKILL.md 应为 UTF-8', packageId: null, source: 'plugin', pluginName: 'Alpha Pack', pluginEnabled: true },
    );
    const original = win.__TAURI_INTERNALS__.invoke;
    win.__skillWrites = [];
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: Record<string, any> = {}) => {
      if (command === 'read_native_skill') {
        if (String(args.directory).includes('bad-skill')) throw { message: 'SKILL.md 应为 UTF-8' };
        return { name: 'skill', path: args.directory, content: `# ${args.directory}` };
      }
      if (command === 'list_skill_installations') {
        return args.packageId === 'pkg-1' ? [{ packageId: 'pkg-1', toolId: 'codex', scope: 'global', projectPath: null, contextId: null, targetPath: '/tmp/skills/managed-one', state: 'update_available', digest: 'old' }] : [];
      }
      if (command === 'get_skill_enabled') return true;
      if (command === 'preview_skill_local' || command === 'import_skill_local' || command === 'save_native_skill') {
        win.__skillWrites.push(command);
        if (command === 'preview_skill_local') return { name: 'compat-read', source: args.source, digest: 'copy', existingDigest: null, fileCount: 1, changes: [], compatibility: null };
        if (command === 'import_skill_local') return { id: 'copied', name: 'compat-read', description: '', compatibility: null, source: args.source, digest: 'copy', fileCount: 1, updatedAt: 1, inLibrary: false };
        return null;
      }
      return original(command, args);
    };
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  await expect(page.getByText('这个 CLI 还没有生效的 Skill')).toHaveCount(0);
  const alpha = page.getByRole('button', { name: /alpha-skill/ });
  const beta = page.getByRole('button', { name: /beta-skill/ });
  const gamma = page.getByRole('button', { name: /gamma-skill/ });
  const quiet = page.getByRole('button', { name: /quiet-skill/ });
  const bad = page.getByRole('button', { name: /bad-skill/ });
  await expect(alpha).toContainText('插件');
  await expect(alpha).toContainText('Alpha Pack');
  await expect(alpha).toContainText('会随插件加载');
  await expect(beta).toContainText('插件');
  await expect(beta).toContainText('Alpha Pack');
  await expect(gamma).toContainText('当前不会加载');
  await expect(gamma).toContainText('Gamma Pack');
  await expect(quiet).toContainText('插件');
  await expect(quiet).toContainText('Quiet Pack');
  await expect(quiet).toContainText('只读');
  await expect(quiet).not.toContainText('当前不会加载');
  await expect(quiet).not.toContainText('会随插件加载');
  await expect(bad).toContainText('暂不可读取');
  await expect(bad).toContainText('插件');
  await expect(page.getByRole('button', { name: /compat-read/ })).toContainText('只读');
  await expect(page.getByRole('button', { name: /local-write/ })).toContainText('本机目录');

  await page.getByRole('button', { name: /managed-one/ }).click();
  const article = page.getByRole('article');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(article.getByText('有更新')).toBeVisible();
  await expect(article.getByRole('switch', { name: '启用 Skill' })).toBeVisible();
  await expect(article.getByRole('button', { name: '从当前工具移除' })).toBeVisible();
  await expect(article.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  await article.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(article.getByRole('button', { name: '保存', exact: true })).toBeVisible();

  await page.getByRole('button', { name: /local-write/ }).click();
  await article.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(article.getByRole('button', { name: '保存', exact: true })).toBeVisible();
  await expect(article.getByRole('button', { name: '放进资料库' })).toBeVisible();
  await expect(article.getByRole('textbox', { name: 'SKILL.md', exact: true })).toHaveAttribute('contenteditable', 'true');

  await page.getByRole('button', { name: /compat-read/ }).click();
  await expect(article.getByRole('button', { name: '编辑', exact: true })).toHaveCount(0);
  await article.getByRole('button', { name: '源码', exact: true }).click();
  await expect(article.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  await expect(article.getByRole('switch', { name: '启用 Skill' })).toHaveCount(0);
  await expect(article.getByRole('button', { name: '从当前工具移除' })).toHaveCount(0);
  await expect(article.getByRole('textbox', { name: 'SKILL.md', exact: true })).toHaveAttribute('contenteditable', 'false');
  await article.getByRole('button', { name: '放进资料库' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__skillWrites)).toEqual(['preview_skill_local', 'import_skill_local']);
  await expect.poll(() => page.evaluate(() => (window as any).__skillWrites.includes('save_native_skill'))).toBe(false);

  await gamma.click();
  await expect(article.getByText('Gamma Pack · 当前不会加载')).toBeVisible();
  await expect(article.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  await expect(article.getByRole('button', { name: '放进资料库' })).toHaveCount(0);
  await expect(article.getByRole('switch', { name: '启用 Skill' })).toHaveCount(0);
  await expect(article.getByRole('button', { name: '从当前工具移除' })).toHaveCount(0);
  await article.getByRole('button', { name: '源码', exact: true }).click();
  await expect(article.getByRole('textbox', { name: 'SKILL.md', exact: true })).toHaveAttribute('contenteditable', 'false');

  await quiet.click();
  await expect(article.getByText('Quiet Pack · 只读')).toBeVisible();
  await expect(article.getByText('当前不会加载')).toHaveCount(0);
  await expect(article.getByText('会随插件加载')).toHaveCount(0);

  await alpha.click();
  await expect(article.getByRole('region', { name: 'SKILL.md 预览' })).toContainText('/tmp/plugins/alpha/skills/alpha-skill');
  await bad.click();
  await expect(article.getByText('SKILL.md 应为 UTF-8')).toBeVisible();
  await expect(page.getByRole('button', { name: /alpha-skill/ })).toBeVisible();
});

test('Skill scan failure replaces an existing list instead of keeping it as complete', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => {
    const win = window as any;
    win.__resourceSkillPackages.push({ id: 'pkg-1', name: 'kept', description: 'Managed copy', fileCount: 1, digest: 'new', source: 'library', compatibility: null, inLibrary: true });
    win.__resourceNativeSkills.push({ name: 'kept', path: '/tmp/skills/kept', digest: 'old', state: 'managed', detail: '', packageId: 'pkg-1', source: 'writable', pluginName: null, pluginEnabled: null });
    win.__skillScans = 0;
    const original = win.__TAURI_INTERNALS__.invoke;
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: Record<string, any> = {}) => {
      if (command === 'scan_native_skills') {
        win.__skillScans += 1;
        if (win.__skillScans > 1) throw { message: '插件清单无法读取' };
        return win.__resourceNativeSkills;
      }
      if (command === 'set_skill_enabled') return null;
      if (command === 'get_skill_enabled') return true;
      if (command === 'list_skill_installations') return [{ packageId: 'pkg-1', toolId: 'codex', scope: 'global', projectPath: null, contextId: null, targetPath: '/tmp/skills/kept', state: 'current', digest: 'old' }];
      if (command === 'read_native_skill') return { name: 'kept', path: args.directory, content: '# kept' };
      return original(command, args);
    };
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  await page.getByRole('button', { name: /kept/ }).click();
  await page.getByRole('switch', { name: '启用 Skill' }).click();
  await expect(page.getByText('Skill 列表加载失败：插件清单无法读取')).toBeVisible();
  await expect(page.getByText('这个 CLI 还没有生效的 Skill')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /kept/ })).toHaveCount(0);
});

for (const retained of [false, true]) test(`local Skill scan failure clears ${retained ? 'a retained disabled row' : 'the previous list on page reactivation'}`, async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => {
    const win = window as any;
    const entry = { name: 'remembered', path: '/tmp/skills/remembered', digest: 'old', state: 'managed', detail: '', packageId: 'pkg-local', source: 'writable', pluginName: null, pluginEnabled: null };
    win.__resourceSkillPackages.push({ id: 'pkg-local', name: 'remembered', description: 'Managed copy', fileCount: 1, digest: 'old', source: 'library', compatibility: null, inLibrary: true });
    const state = { enabled: true, fail: false, scans: 0 };
    win.__localScanState = state;
    const original = win.__TAURI_INTERNALS__.invoke;
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: Record<string, any> = {}) => {
      if (command === 'scan_native_skills') {
        state.scans += 1;
        if (state.fail) throw { message: 'local scan unavailable' };
        return state.enabled ? [entry] : [];
      }
      if (command === 'set_skill_enabled') { state.enabled = args.enabled; return null; }
      if (command === 'get_skill_enabled') return state.enabled;
      if (command === 'list_skill_installations') return [{ packageId: 'pkg-local', toolId: 'codex', scope: 'global', projectPath: null, contextId: null, targetPath: entry.path, state: state.enabled ? 'current' : 'disabled', digest: 'old' }];
      if (command === 'read_native_skill') return { name: entry.name, path: entry.path, content: '# remembered' };
      return original(command, args);
    };
  });
  const navigation = page.getByRole('navigation', { name: '页面' });
  await navigation.getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  const row = page.getByRole('button', { name: /remembered/ });
  await expect(row).toBeVisible();
  if (retained) {
    await row.click();
    await page.getByRole('switch', { name: '启用 Skill' }).click();
    await expect(page.getByRole('switch', { name: '启用 Skill' })).not.toBeChecked();
    await expect.poll(() => page.evaluate(() => (window as any).__localScanState.scans)).toBe(2);
    await expect(row).toBeVisible();
  }
  await page.evaluate(() => { (window as any).__localScanState.fail = true; });
  if (retained) await page.getByRole('switch', { name: '启用 Skill' }).click();
  else {
    await navigation.getByRole('button', { name: '快速开始', exact: true }).click();
    await navigation.getByRole('button', { name: '工具与连接' }).click();
  }
  await expect(page.getByText('Skill 列表加载失败：local scan unavailable', { exact: true })).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(page.getByText('这个 CLI 还没有生效的 Skill')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__localScanState.scans)).toBe(retained ? 3 : 2);
});

test('Skill page without a project only asks for a project', async ({ page }) => {
  await mockResources(page);
  await page.addInitScript(() => {
    localStorage.setItem('cliora:workspace-context', JSON.stringify({ codex: { resource: 'skills', scope: 'project', projectPath: '' } }));
  });
  await page.goto('/');
  await page.evaluate(() => {
    const win = window as any;
    win.__skillScans = 0;
    const original = win.__TAURI_INTERNALS__.invoke;
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: Record<string, any> = {}) => {
      if (command === 'scan_native_skills') { win.__skillScans += 1; return []; }
      return original(command, args);
    };
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await expect(page.getByText('请先选择项目目录。')).toBeVisible();
  await expect(page.getByText('这个 CLI 还没有生效的 Skill')).toHaveCount(0);
  await expect(page.getByText('只管理用户目录下的本地插件')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__skillScans ?? 0)).toBe(0);
});

test('Skill page keeps the choose-project prompt when an earlier workspace read finishes', async ({ page }) => {
  await mockResources(page);
  await page.addInitScript(() => {
    localStorage.setItem('cliora:workspace-context', JSON.stringify({ codex: { resource: 'skills', scope: 'project', projectPath: '' } }));
    const win = window as any;
    win.__skillScans = 0;
    win.__heldReads = [];
    const original = win.__TAURI_INTERNALS__.invoke;
    const adapters = [
      { id: 'claude_code', name: 'Claude Code', interfaceFormats: [], nativeConfig: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' } },
      { id: 'codex', name: 'Codex', interfaceFormats: [], nativeConfig: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' } },
    ];
    const failedWorkspace = {
      probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '尚未安装' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null },
      profiles: [], common: null, binding: null, effectiveContextId: null, nativeContextError: '上一工具上下文失败', snapshots: [], recoveryNeeded: [], customPath: null,
    };
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: Record<string, any> = {}) => {
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['claude_code', 'codex'], theme: 'system' }, tools: adapters.map((item) => ({ id: item.id, name: item.name, installation: 'not_checked', configuration: 'not_checked' })) };
      if (command === 'list_cli_adapters') return { registered: adapters, managedIds: ['claude_code', 'codex'], preservedUnknown: [] };
      if (command === 'scan_native_skills') {
        win.__skillScans += 1;
        return [{ name: 'late-skill', path: '/tmp/skills/late-skill', digest: null, state: 'external', detail: '', packageId: null, source: 'writable', pluginName: null, pluginEnabled: null }];
      }
      if ((command === 'get_registered_tool_workspace' || command === 'get_registered_tool_context') && args.toolId === 'claude_code') {
        return new Promise((resolve) => {
          win.__heldReads.push(() => resolve(command === 'get_registered_tool_context'
            ? { effectiveContextId: null, nativeContextError: '上一工具上下文失败' }
            : failedWorkspace));
        });
      }
      return original(command, args);
    };
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__heldReads.length)).toBeGreaterThan(0);
  await openCli(page, 'Codex');
  await expect(page.getByText('请先选择项目目录。')).toBeVisible();
  await page.evaluate(async () => {
    const held = (window as any).__heldReads.splice(0) as Array<() => void>;
    held.forEach((release) => release());
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(page.getByText('请先选择项目目录。')).toBeVisible();
  await expect(page.getByText('工具上下文读取失败。')).toHaveCount(0);
  await expect(page.getByText('上一工具上下文失败')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重新读取' })).toHaveCount(0);
  await expect(page.getByText('这个 CLI 还没有生效的 Skill')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /late-skill/ })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__skillScans ?? 0)).toBe(0);
});

test('Skill filters combine name, source, and load, and a disabled skill stays listed', async ({ page }) => {
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => {
    const win = window as any;
    win.__resourceSkillPackages.push({ id: 'pkg-1', name: 'managed-one', description: 'Managed copy', fileCount: 1, digest: 'new', source: 'library', compatibility: null, inLibrary: true });
    win.__resourceNativeSkills.push(
      { name: 'managed-one', path: '/tmp/skills/managed-one', digest: 'old', state: 'managed', detail: 'Managed copy', packageId: 'pkg-1', source: 'writable', pluginName: null, pluginEnabled: null },
      { name: 'local-write', path: '/tmp/skills/local-write', digest: null, state: 'external', detail: 'Writable document', packageId: null, source: 'writable', pluginName: null, pluginEnabled: null },
      { name: 'compat-read', path: '/tmp/skills/compat-read', digest: null, state: 'read_only', detail: '兼容目录，只读', packageId: null, source: 'read_only', pluginName: null, pluginEnabled: null },
      { name: 'alpha-skill', path: '/tmp/plugins/alpha/skills/alpha-skill', digest: null, state: 'read_only', detail: 'Alpha document', packageId: null, source: 'plugin', pluginName: 'Alpha Pack', pluginEnabled: true },
      { name: 'beta-skill', path: '/tmp/plugins/alpha/skills/beta-skill', digest: null, state: 'read_only', detail: 'Beta document', packageId: null, source: 'plugin', pluginName: 'Alpha Pack', pluginEnabled: true },
      { name: 'gamma-skill', path: '/tmp/plugins/gamma/skills/gamma-skill', digest: null, state: 'read_only', detail: 'Gamma document', packageId: null, source: 'plugin', pluginName: 'Gamma Pack', pluginEnabled: false },
      { name: 'quiet-skill', path: '/tmp/plugins/quiet/skills/quiet-skill', digest: null, state: 'read_only', detail: 'Quiet document', packageId: null, source: 'plugin', pluginName: 'Quiet Pack', pluginEnabled: null },
      { name: 'bad-skill', path: '/tmp/plugins/alpha/skills/bad-skill', digest: null, state: 'unreadable', detail: 'SKILL.md 应为 UTF-8', packageId: null, source: 'plugin', pluginName: 'Alpha Pack', pluginEnabled: true },
    );
    win.__skillEnabled = true;
    const original = win.__TAURI_INTERNALS__.invoke;
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: Record<string, any> = {}) => {
      if (command === 'scan_native_skills') return win.__skillEnabled ? win.__resourceNativeSkills : win.__resourceNativeSkills.filter((item: { name: string }) => item.name !== 'managed-one');
      if (command === 'set_skill_enabled') { win.__skillEnabled = args.enabled; return null; }
      if (command === 'get_skill_enabled') return win.__skillEnabled;
      if (command === 'list_skill_installations') return [{ packageId: 'pkg-1', toolId: 'codex', scope: 'global', projectPath: null, contextId: null, targetPath: '/tmp/skills/managed-one', state: 'current', digest: 'old' }];
      if (command === 'read_native_skill') return { name: args.directory, path: args.directory, content: `# ${args.directory}` };
      return original(command, args);
    };
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  const list = page.getByRole('navigation', { name: 'Skill 列表' });
  await expect(list.getByRole('button')).toHaveCount(8);
  await expect(page.getByText('8 / 8')).toBeVisible();

  await page.getByRole('searchbox', { name: '搜索 Skill' }).fill('alpha-skill');
  await expect(list.getByRole('button')).toHaveCount(1);
  await expect(list.getByRole('button', { name: /alpha-skill/ })).toBeVisible();
  await expect(page.getByText('1 / 8')).toBeVisible();
  // The plugin name matches too: every skill from Alpha Pack.
  await page.getByRole('searchbox', { name: '搜索 Skill' }).fill('alpha');
  await expect(list.getByRole('button')).toHaveCount(3);
  await expect(list.getByRole('button', { name: /beta-skill/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /bad-skill/ })).toBeVisible();
  await expect(page.getByText('3 / 8')).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索 Skill' }).fill('Gamma Pack');
  await expect(list.getByRole('button')).toHaveCount(1);
  await expect(list.getByRole('button', { name: /gamma-skill/ })).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索 Skill' }).fill('zzz');
  await expect(page.getByText('没有匹配「zzz」的 Skill。')).toBeVisible();
  await page.getByRole('button', { name: '清除条件' }).first().click();
  await expect(list.getByRole('button')).toHaveCount(8);

  await page.getByRole('button', { name: '来源', exact: true }).click();
  await page.getByRole('option', { name: '插件', exact: true }).click();
  await expect(list.getByRole('button', { name: /quiet-skill/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /compat-read/ })).toHaveCount(0);
  await expect(page.getByText('5 / 8')).toBeVisible();
  await page.getByRole('button', { name: '来源', exact: true }).click();
  await page.getByRole('option', { name: '只读', exact: true }).click();
  await expect(list.getByRole('button', { name: /compat-read/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /quiet-skill/ })).toHaveCount(0);
  await page.getByRole('button', { name: '来源', exact: true }).click();
  await page.getByRole('option', { name: '已安装', exact: true }).click();
  await expect(list.getByRole('button', { name: /managed-one/ })).toBeVisible();
  await expect(list.getByRole('button')).toHaveCount(1);
  await page.getByRole('button', { name: '来源', exact: true }).click();
  await page.getByRole('option', { name: '本机目录', exact: true }).click();
  await expect(list.getByRole('button', { name: /local-write/ })).toBeVisible();
  await expect(list.getByRole('button')).toHaveCount(1);

  await page.getByRole('button', { name: '来源', exact: true }).click();
  await page.getByRole('option', { name: '全部来源', exact: true }).click();
  await page.getByRole('button', { name: '加载状态', exact: true }).click();
  await page.getByRole('option', { name: '当前不会加载', exact: true }).click();
  await expect(list.getByRole('button', { name: /gamma-skill/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /quiet-skill/ })).toHaveCount(0);
  await expect(list.getByRole('button', { name: /managed-one/ })).toHaveCount(0);
  await page.getByRole('button', { name: '加载状态', exact: true }).click();
  await page.getByRole('option', { name: '会加载', exact: true }).click();
  await expect(list.getByRole('button', { name: /alpha-skill/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /beta-skill/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /managed-one/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /local-write/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /bad-skill/ })).toHaveCount(0);
  await expect(list.getByRole('button', { name: /gamma-skill/ })).toHaveCount(0);
  await expect(list.getByRole('button', { name: /quiet-skill/ })).toHaveCount(0);
  await page.getByRole('button', { name: '加载状态', exact: true }).click();
  await page.getByRole('option', { name: '暂不可读取', exact: true }).click();
  await expect(list.getByRole('button')).toHaveCount(1);
  await expect(list.getByRole('button', { name: /bad-skill/ })).toContainText('SKILL.md 应为 UTF-8');

  await page.getByRole('button', { name: '来源', exact: true }).click();
  await page.getByRole('option', { name: '插件', exact: true }).click();
  await page.getByRole('button', { name: '加载状态', exact: true }).click();
  await page.getByRole('option', { name: '会加载', exact: true }).click();
  await expect(list.getByRole('button')).toHaveCount(2);
  await expect(list.getByRole('button', { name: /quiet-skill/ })).toHaveCount(0);
  await expect(list.getByRole('button', { name: /bad-skill/ })).toHaveCount(0);
  await page.getByRole('button', { name: '清除条件' }).click();

  await list.getByRole('button', { name: /managed-one/ }).click();
  const enabled = page.getByRole('article').getByRole('switch', { name: '启用 Skill' });
  await expect(enabled).toHaveAttribute('aria-checked', 'true');
  await enabled.click();
  await expect(list.getByRole('button', { name: /managed-one/ })).toBeVisible();
  await page.getByRole('button', { name: '加载状态', exact: true }).click();
  await page.getByRole('option', { name: '当前不会加载', exact: true }).click();
  await expect(list.getByRole('button', { name: /managed-one/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /gamma-skill/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /quiet-skill/ })).toHaveCount(0);
});

test('Skill document sits beside the list and confirms leaving unsaved text', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await mockResources(page);
  await page.goto('/');
  await page.evaluate(() => {
    const win = window as any;
    win.__resourceNativeSkills.push(
      { name: 'local-write', path: '/tmp/skills/local-write', digest: null, state: 'external', detail: 'Writable document', packageId: null, source: 'writable', pluginName: null, pluginEnabled: null },
      { name: 'other-skill', path: '/tmp/skills/other-skill', digest: null, state: 'external', detail: 'Another document', packageId: null, source: 'writable', pluginName: null, pluginEnabled: null },
    );
    const original = win.__TAURI_INTERNALS__.invoke;
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: Record<string, any> = {}) => {
      if (command === 'read_native_skill') return { name: 'skill', path: args.directory, content: `# ${args.directory}` };
      return original(command, args);
    };
  });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  const list = page.getByRole('navigation', { name: 'Skill 列表' });
  const row = list.getByRole('button', { name: /local-write/ });
  await row.click();
  const article = page.getByRole('article', { name: 'local-write' });
  await article.getByRole('button', { name: '编辑', exact: true }).click();
  const editor = article.getByRole('textbox', { name: 'SKILL.md', exact: true });
  await expect(editor).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Skill', exact: true }).locator('h2')).toHaveCount(0);
  await expect(row).not.toContainText('/tmp/skills/local-write');
  await expect(list.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  await expect(list.getByRole('button', { name: '从当前工具移除' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '返回列表' })).toBeHidden();
  const placed = await page.evaluate(() => {
    const listNode = document.querySelector('[aria-label="Skill 列表"]') as HTMLElement;
    const articleNode = document.querySelector('article') as HTMLElement;
    const listBox = listNode.getBoundingClientRect();
    const articleBox = articleNode.getBoundingClientRect();
    return {
      sideBySide: listBox.right <= articleBox.left + 2 && articleBox.top < listBox.bottom && listBox.top < articleBox.bottom,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
  expect(placed.sideBySide).toBe(true);
  expect(placed.overflow).toBe(false);

  await editor.fill('# /tmp/skills/local-write\n未保存');
  await expect(article.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await list.getByRole('button', { name: /other-skill/ }).click();
  const confirm = page.getByRole('dialog', { name: '放弃未保存修改？' });
  await expect(confirm.getByRole('button', { name: '放弃修改', exact: true })).toBeVisible();
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(article.getByRole('heading', { name: 'local-write', exact: true })).toBeVisible();
  await expect(editor).toContainText('未保存');
  await page.getByRole('button', { name: '添加 Skill', exact: true }).click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor).toContainText('未保存');

  await page.setViewportSize({ width: 640, height: 900 });
  await expect(list).toBeHidden();
  await expect(page.getByRole('button', { name: '返回列表' })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: '搜索 Skill' })).toBeHidden();
  await expect(article.getByRole('heading', { name: 'local-write', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回列表' }).click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor).toContainText('未保存');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
});
