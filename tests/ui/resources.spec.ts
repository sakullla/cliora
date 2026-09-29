import { expect, test } from '@playwright/test';

async function mockResources(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const library: Array<Record<string, unknown>> = [];
    const definitions: Array<Record<string, unknown>> = [];
    const writes: unknown[] = [];
    Object.assign(window, {
      isTauri: true,
      __resourceWrites: writes,
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
        if (command === 'preview_mcp_targets') return args.targets.map((target: Record<string, unknown>) =>
          ({ ...target, status: 'ready', detail: '将创建 CLI 原生条目', path: '/tmp/config.toml', baselineHash: 'hash-empty' }));
        if (command === 'distribute_mcp') {
          writes.push(args);
          return args.targets.map((target: Record<string, unknown>) => ({ ...target, status: 'written', detail: 'committed', path: '/tmp/config.toml', baselineHash: 'hash-empty' }));
        }
        if (command === 'list_skill_packages') return [];
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
