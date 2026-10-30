import { expect, test, type Locator, type Page } from '@playwright/test';

const shortName = 'chrome-devtools-mcp';
const longName = 'long-library-mcp-name-'.repeat(5);
const summary = `npx ${'chrome-devtools-mcp@latest '.repeat(8)}`.trim();
const placedTools = Array.from({ length: 18 }, (_, index) => {
  const number = String(index + 1).padStart(2, '0');
  return { id: `cli_${number}`, name: `CLI ${number}` };
});
const extraTool = { id: 'cli_extra', name: 'CLI Extra' };
const tools = [...placedTools, extraTool];

type Line = { lines: number; width: number; height: number; scrollWidth: number; clientWidth: number; whiteSpace: string; overflowWrap: string; textOverflow: string; text: string };

async function installLibrary(page: Page, definitions: Array<Record<string, unknown>>) {
  const placements = definitions.flatMap((item) => item.id === 'mcp-chrome'
    ? placedTools.map((tool) => ({ definitionId: item.id, toolId: tool.id, scope: 'global', projectPath: null, enabled: true, contextId: null }))
    : []);
  await page.addInitScript(({ tools: toolList, definitions: definitionList, placements: placementList }) => {
    const definitions = definitionList.map((item) => ({ ...item }));
    const placements = placementList.map((item) => ({ ...item }));
    const facet = { state: 'available', reason: '' };
    const registered = toolList.map((tool) => ({ id: tool.id, name: tool.name, interfaceFormats: [], nativeConfig: facet, resources: facet }));
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: toolList.map((tool) => tool.id), theme: 'system' }, tools: registered.map((tool) => ({ ...tool, installation: 'not_checked', configuration: 'not_checked' })) };
        if (command === 'list_cli_adapters') return { registered, managedIds: toolList.map((tool) => tool.id), preservedUnknown: [] };
        if (command === 'list_projects') return [];
        if (command === 'list_accounts') return [];
        if (command === 'list_mcp_definitions') return definitions;
        if (command === 'list_mcp_placements') return placements;
        if (command === 'list_native_mcp') return [];
        if (command === 'preview_mcp_targets') return args.targets.map((target: Record<string, unknown>) => ({ ...target, status: 'ready', detail: '将创建 CLI 原生条目', path: '/tmp/config.toml', baselineHash: 'hash-empty', previewToken: 'bound-token', existing: null, proposed: { command: 'npx' } }));
        if (command === 'preview_mcp_draft') return { draft: args.draft, targets: args.targets.map((target: Record<string, unknown>) => ({ ...target, status: 'ready', detail: '将移除当前受管理的原生条目', path: '/tmp/config.toml', baselineHash: 'hash-remove', previewToken: 'bound-remove-token', existing: { command: 'npx' }, proposed: null })) };
        if (command === 'commit_mcp_draft') {
          const definition = await (window as any).__TAURI_INTERNALS__.invoke('save_mcp_definition', { draft: args.draft });
          const targets = await (window as any).__TAURI_INTERNALS__.invoke('distribute_mcp', { definitionId: definition.id, targets: args.targets });
          return { definition, targets };
        }
        if (command === 'distribute_mcp') {
          for (const target of args.targets) {
            const row = { definitionId: args.definitionId, toolId: target.toolId, scope: target.scope, projectPath: target.projectPath ?? null, enabled: target.enabled !== false, contextId: target.contextId ?? null };
            const index = placements.findIndex((item) => item.definitionId === row.definitionId && item.toolId === row.toolId && item.scope === row.scope && item.projectPath === row.projectPath);
            if (target.operation === 'remove') { if (index >= 0) placements.splice(index, 1); }
            else if (index < 0) placements.push(row); else placements[index] = row;
          }
          return args.targets.map((target: Record<string, any>) => ({ ...target, status: target.operation === 'remove' ? 'removed' : 'written', detail: 'committed', path: '/tmp/config.toml', baselineHash: 'hash-empty' }));
        }
        if (command === 'remove_native_mcp') {
          const index = placements.findIndex((item) => item.toolId === args.target.toolId && item.scope === args.target.scope && (item.projectPath ?? null) === (args.target.projectPath ?? null));
          if (index >= 0) placements.splice(index, 1);
          return null;
        }
        if (command === 'save_mcp_definition') {
          const item = { ...args.draft, id: args.draft.id ?? `mcp-${definitions.length + 1}`, version: (args.draft.expectedVersion ?? 0) + 1 };
          const index = definitions.findIndex((old) => old.id === item.id);
          if (index < 0) definitions.push(item); else definitions[index] = item;
          return item;
        }
        if (command === 'delete_mcp_definition') {
          const index = definitions.findIndex((item) => item.id === args.id && item.version === args.expectedVersion);
          if (index >= 0) definitions.splice(index, 1);
          return null;
        }
        if (command === 'get_registered_tool_workspace') return {
          probe: { selectedPath: null, installations: [], nativeFiles: [], nativeWrites: { state: 'unknown', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [], installUrl: '', upgradeHint: '', installCommand: null, upgradeCommand: null },
          profiles: [], common: null, binding: null, effectiveContextId: null, snapshots: [], recoveryNeeded: [], customPath: null,
        };
        if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'list_library_items' || command === 'list_skill_packages' || command === 'list_history_sessions' || command === 'list_portable_items') return [];
        return null;
      } },
    });
  }, { tools, definitions, placements });
}

function mcpDefinition(id: string, name: string, commandSummary: string) {
  const [command, ...args] = commandSummary.split(' ');
  return { id, name, transport: 'stdio', command, args, url: '', env: {}, headers: {}, inLibrary: true, version: 1 };
}

async function openLibraryMcp(page: Page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await expect(page.getByRole('region', { name: '资料库 MCP' })).toBeVisible();
}

async function readLine(locator: Locator): Promise<Line> {
  return locator.evaluate((node) => {
    const style = getComputedStyle(node);
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0.5 && rect.height > 0.5);
    const box = node.getBoundingClientRect();
    return { lines: new Set(rects.map((rect) => Math.round(rect.top))).size, width: box.width, height: box.height, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, whiteSpace: style.whiteSpace, overflowWrap: style.overflowWrap, textOverflow: style.textOverflow, text: node.textContent ?? '' };
  });
}

function expectHorizontal(line: Line, label: string) {
  expect(line.lines, label).toBe(1);
  expect(line.height, label).toBeLessThan(32);
  expect(line.width, label).toBeGreaterThan(40);
  expect(line.whiteSpace, label).toContain('nowrap');
  expect(line.overflowWrap, label).not.toBe('anywhere');
}

test('library MCP details keep long text and all CLI targets without horizontal overflow', async ({ page }) => {
  await installLibrary(page, [mcpDefinition('mcp-chrome', shortName, summary), mcpDefinition('mcp-long', longName, summary)]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openLibraryMcp(page);
  const workspace = page.getByRole('region', { name: '资料库 MCP' });
  const list = page.getByRole('list', { name: 'MCP 列表' });
  const row = list.locator('li[data-mcp-id="mcp-chrome"]');
  const longRow = list.getByRole('listitem').filter({ hasText: longName });
  await expect(row.getByText('已写入 18 处')).toBeVisible();
  const marks = row.getByRole('group', { name: `${shortName} 的 CLI · 全局` });
  await expect(marks.getByRole('button')).toHaveCount(tools.length);

  const wideName = await readLine(row.locator('strong'));
  expectHorizontal(wideName, 'wide name');
  const wideSummary = await readLine(row.locator('code'));
  expectHorizontal(wideSummary, 'wide summary');
  expect(wideSummary.scrollWidth).toBeGreaterThan(wideSummary.clientWidth + 1);
  expect(wideSummary.textOverflow).toBe('ellipsis');
  const wideLong = await readLine(longRow.locator('strong'));
  expectHorizontal(wideLong, 'wide long name');
  expect(wideLong.scrollWidth).toBeGreaterThan(wideLong.clientWidth + 1);
  expect(wideLong.textOverflow).toBe('ellipsis');
  expect(await workspace.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 720, height: 900 });
  await expect(marks.getByRole('button')).toHaveCount(tools.length);
  expect(await workspace.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  expectHorizontal(await readLine(row.locator('strong')), 'narrow name');
  expectHorizontal(await readLine(longRow.locator('strong')), 'narrow long name');

  await page.setViewportSize({ width: 1280, height: 900 });
  const extra = marks.getByRole('button', { name: 'CLI Extra · 未写入' });
  await extra.click();
  await expect(marks.getByRole('button', { name: 'CLI Extra · 已生效' })).toBeVisible();
  await expect(row.getByText('已写入 19 处')).toBeVisible();
  await marks.getByRole('button', { name: 'CLI Extra · 已生效' }).click();
  const removalConfirm = page.getByRole('dialog', { name: '从 CLI 移除 MCP' });
  await removalConfirm.getByRole('button', { name: '移除', exact: true }).click();
  await expect(marks.getByRole('button', { name: 'CLI Extra · 未写入' })).toBeVisible();
  await expect(row.getByText('已写入 18 处')).toBeVisible();

  await row.getByRole('button', { name: `${shortName} 的更多操作`, exact: true }).click();
  await page.getByRole('menu', { name: `${shortName} 的更多操作` }).getByRole('menuitem', { name: '创建副本', exact: true }).click();
  await expect(list.getByRole('listitem').filter({ hasText: `${shortName}-copy` })).toBeVisible();
  await row.getByRole('button', { name: `${shortName} 的更多操作`, exact: true }).click();
  await page.getByRole('menu', { name: `${shortName} 的更多操作` }).getByRole('menuitem', { name: '删除', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '删除 MCP' });
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await row.getByRole('button', { name: '修改', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '修改 MCP' });
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(editor).toHaveCount(0);

  await page.getByRole('textbox', { name: '搜索资料' }).fill('zzz-no-such-mcp');
  await expect(workspace.getByText('没有匹配「zzz-no-such-mcp」的 MCP。')).toBeVisible();
  await workspace.getByRole('button', { name: '清除搜索' }).click();
  await expect(row).toBeVisible();
});

test('library MCP empty and no-match states stay distinct', async ({ page }) => {
  await installLibrary(page, []);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openLibraryMcp(page);
  const workspace = page.getByRole('region', { name: '资料库 MCP' });
  await expect(workspace.getByText('还没有 MCP', { exact: true })).toBeVisible();
  await expect(workspace.getByText('新建时填写连接方式，并勾选要写入的 CLI。')).toBeVisible();
  await expect(workspace.getByRole('button', { name: '新建第一个 MCP', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: '搜索资料' }).fill('zzz-no-such-mcp');
  await expect(workspace.getByText('没有匹配「zzz-no-such-mcp」的 MCP。')).toBeVisible();
  await expect(workspace.getByText('还没有 MCP', { exact: true })).toHaveCount(0);
  await workspace.getByRole('button', { name: '清除搜索' }).click();
  await expect(workspace.getByText('还没有 MCP', { exact: true })).toBeVisible();
});

test('library MCP read failures never masquerade as empty or clear placements', async ({ page }) => {
  await installLibrary(page, [mcpDefinition('mcp-chrome', shortName, summary)]);
  await page.addInitScript(() => {
    const win = window as any;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    win.__failMcpReads = true;
    win.__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      if (win.__failMcpReads && (command === 'list_mcp_definitions' || command === 'list_mcp_placements')) throw new Error('temporary library read failure');
      return invoke(command, args);
    };
  });
  await openLibraryMcp(page);
  const workspace = page.getByRole('region', { name: '资料库 MCP' });
  await expect(workspace.getByText('暂时无法读取 MCP', { exact: true })).toBeVisible();
  await expect(workspace.getByText('还没有 MCP', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as any).__failMcpReads = false; });
  await workspace.getByRole('button', { name: '重试', exact: true }).click();
  const row = page.getByRole('list', { name: 'MCP 列表' }).locator('li[data-mcp-id="mcp-chrome"]');
  await expect(row.getByText('已写入 18 处')).toBeVisible();
  await page.evaluate(() => { (window as any).__failMcpReads = true; });
  await workspace.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(workspace.getByText('MCP 列表可能已过期', { exact: true })).toBeVisible();
  await expect(row.getByText('已写入 18 处')).toBeVisible();
  await expect(row.getByRole('group', { name: `${shortName} 的 CLI · 全局` }).getByRole('button')).toHaveCount(tools.length);
  await page.evaluate(() => { (window as any).__failMcpReads = false; });
  await workspace.getByRole('button', { name: '重试', exact: true }).click();
  await expect(workspace.getByText('MCP 列表可能已过期', { exact: true })).toHaveCount(0);
});

test('library MCP rows stay in name order through writes, removals and saves', async ({ page }) => {
  // The mock returns rows out of order, as a recently-updated-first list would.
  await installLibrary(page, [mcpDefinition('mcp-zeta', 'zeta', 'npx zeta'), mcpDefinition('mcp-chrome', 'Beta', 'npx beta'), mcpDefinition('mcp-alpha', 'alpha', 'npx alpha')]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openLibraryMcp(page);
  const list = page.getByRole('list', { name: 'MCP 列表' });
  const order = () => list.locator(':scope > li').evaluateAll(rows => rows.map(row => row.getAttribute('data-mcp-id')));
  const expected = ['mcp-alpha', 'mcp-chrome', 'mcp-zeta'];
  await expect.poll(order).toEqual(expected);

  const marks = list.locator('li[data-mcp-id="mcp-chrome"]').getByRole('group', { name: 'Beta 的 CLI · 全局' });
  await marks.getByRole('button', { name: 'CLI 01 · 已生效' }).click();
  await page.getByRole('dialog', { name: '从 CLI 移除 MCP' }).getByRole('button', { name: '移除', exact: true }).click();
  await expect(marks.getByRole('button', { name: 'CLI 01 · 未写入' })).toBeVisible();
  expect(await order()).toEqual(expected);
  await marks.getByRole('button', { name: 'CLI 01 · 未写入' }).click();
  await expect(marks.getByRole('button', { name: 'CLI 01 · 已生效' })).toBeVisible();
  expect(await order()).toEqual(expected);

  await list.locator('li[data-mcp-id="mcp-alpha"]').getByRole('button', { name: '修改', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '修改 MCP' });
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(await order()).toEqual(expected);
  await page.getByRole('region', { name: '资料库 MCP' }).getByRole('button', { name: '刷新', exact: true }).click();
  await expect.poll(order).toEqual(expected);
});
