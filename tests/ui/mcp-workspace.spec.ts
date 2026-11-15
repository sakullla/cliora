import { expect, test, type Page } from '@playwright/test';
import { openCli } from './cli-switcher';

type Call = { command: string; args: any };

/** One managed CLI (Codex) with the MCP tab open. Native writes are supported and every IPC is recorded. */
async function install(page: Page, options: { failList?: boolean; external?: boolean } = {}) {
  await page.addInitScript((settings: { failList: boolean; external: boolean }) => {
    const state = {
      entries: [
        { name: 'server-one', transport: 'stdio', command: 'npx', args: ['-y', 'server-one'], cwd: '', url: '', env: {}, headers: {}, inLibrary: true, enabled: true, protectedValues: false },
        { name: 'remote-service', transport: 'http', command: '', args: [], cwd: '', url: 'https://example.test/mcp', env: {}, headers: {}, inLibrary: false, enabled: false, protectedValues: false },
        { name: 'vault', transport: 'stdio', command: 'uvx', args: ['vault'], cwd: '', url: '', env: { API_TOKEN: 'secret-token' }, headers: {}, inLibrary: false, enabled: true, protectedValues: true },
        ...(settings.external ? [{ name: 'github', transport: 'http', command: '', args: [], cwd: '', url: 'https://api.githubcopilot.com/mcp/', env: {}, headers: {}, inLibrary: false, enabled: false, protectedValues: false, source: 'Claude Code', readOnly: true, detail: '只读来源 · /home/me/.claude/mcp.json', issue: null }] : []),
      ],
      definitions: [{ id: 'mcp-1', name: 'server-one', transport: 'stdio', command: 'npx', args: ['-y', 'server-one'], cwd: '', url: '', env: {}, headers: {}, inLibrary: true, version: 3 }],
      calls: [] as Call[],
      failList: settings.failList,
      conflict: false,
    };
    Object.assign(window, { isTauri: true, __mcp: state, __TAURI_INTERNALS__: { invoke: async (command: string, args: any = {}) => {
      state.calls.push({ command, args });
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex' }] };
      if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], nativeConfig: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
      if (command === 'list_projects') return [];
      if (command === 'get_registered_tool_workspace') return {
        probe: { tool: 'codex', selectedPath: '/fixture/codex', installations: [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: [], providerPresets: [], dependencies: [] },
        profiles: [], common: null, binding: null, effectiveContextId: 'ctx-1', nativeContextError: null, snapshots: [], recoveryNeeded: [], customPath: null,
      };
      if (command === 'list_mcp_definitions') return state.definitions;
      if (command === 'list_mcp_placements') return [];
      if (command === 'get_managed_mcp_enabled') return null;
      if (command === 'list_native_mcp') {
        if (state.failList) throw new Error('codex 配置文件无法读取');
        return state.entries;
      }
      // The preview never decides the write; it only reports what the target currently holds.
      if (command === 'preview_mcp_draft') {
        const definition = { ...args.draft, id: args.draft.id ?? 'mcp-candidate', version: (args.draft.expectedVersion ?? 0) + 1 };
        const targets = args.targets.map((target: any) => ({
          ...target, operation: 'write', status: state.conflict ? 'conflict' : 'ready',
          detail: state.conflict ? '同名原生 MCP 未受当前资料库管理，请比较后确认' : '将创建 CLI 原生条目',
          path: '/fixture/codex.toml', baselineHash: state.conflict ? 'hash-old' : 'hash-new', previewToken: 'token-1',
          existing: state.conflict ? { command: 'old-command' } : null, proposed: { command: args.draft.command || args.draft.url },
        }));
        return { draft: args.draft, definition, targets };
      }
      if (command === 'commit_mcp_draft') {
        const definition = { ...args.draft, id: args.draft.id ?? 'mcp-candidate', version: (args.draft.expectedVersion ?? 0) + 1 };
        state.definitions = [...state.definitions.filter((item: any) => item.id !== definition.id), definition];
        return { definition, targets: args.targets.map((target: any) => ({ ...target, operation: 'write', status: 'written', detail: '已写入', path: '/fixture/codex.toml', baselineHash: 'hash-new', previewToken: 'token-1' })) };
      }
      if (command === 'remove_native_mcp') return null;
      if (command === 'delete_mcp_definition') return null;
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command.startsWith('plugin:event|')) return 1;
      throw new Error(`Unexpected IPC: ${command}`);
    } } });
  }, { failList: options.failList === true, external: options.external === true });
  await page.goto('/');
  await openCli(page, 'Codex');
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
}

const list = (page: Page) => page.getByRole('list', { name: 'MCP 服务器' });
const row = (page: Page, name: string) => page.getByRole('button', { name: `查看 ${name}` });
const card = (page: Page, name: string) => page.getByRole('article', { name });
const search = (page: Page) => page.getByRole('searchbox', { name: '搜索当前 CLI 的 MCP' });
const calls = (page: Page) => page.evaluate(() => (window as any).__mcp.calls as Call[]);
const lastCall = async (page: Page, command: string) => (await calls(page)).filter(call => call.command === command).at(-1);

test('the MCP list keeps transport, library and enabled state, searches, and opens one entry for reading', async ({ page }) => {
  await install(page);
  await expect(list(page).getByRole('listitem')).toHaveCount(3);
  const one = list(page).getByRole('listitem').filter({ hasText: 'server-one' });
  await expect(one).toContainText('npx -y server-one');
  await expect(one).toContainText('stdio');
  await expect(one).toContainText('资料库');
  await expect(one).toContainText('已启用');
  const remote = list(page).getByRole('listitem').filter({ hasText: 'remote-service' });
  await expect(remote).toContainText('HTTP');
  await expect(remote).toContainText('https://example.test/mcp');
  await expect(remote).toContainText('已停用');

  // Search narrows the rows and reports both counts; clearing it restores the list.
  await search(page).fill('vault');
  await expect(list(page).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByText('1 / 3')).toBeVisible();
  await search(page).fill('');
  await expect(list(page).getByRole('listitem')).toHaveCount(3);
  await search(page).fill('no-such-mcp');
  await expect(page.getByText('没有匹配「no-such-mcp」的 MCP。')).toBeVisible();
  await page.getByRole('button', { name: '清除搜索' }).click();
  await expect(list(page).getByRole('listitem')).toHaveCount(3);

  // A row opens the reading view of that entry instead of a dialog.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await row(page, 'server-one').click();
  const detail = card(page, 'server-one');
  await expect(detail.getByRole('region', { name: 'MCP 详情' })).toBeVisible();
  await expect(detail).toContainText('npx -y server-one');
  await expect(row(page, 'server-one')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Reading and editing share the surface; the argument fields and the write target stay available.
  await detail.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(detail.getByRole('textbox', { name: '名称' })).toHaveValue('server-one');
  await expect(detail.getByRole('textbox', { name: '参数，每行一项 第 1 行' })).toHaveValue('-y');
  const side = detail.getByRole('complementary', { name: '写入位置' });
  await expect(side).toContainText('Codex');
  await expect(side).toContainText('保存时先预览将写入的内容，确认后才落盘。');
  await expect(side.getByRole('checkbox', { name: '启用' })).toBeChecked();
  // A linked entry does not offer a second copy in the library.
  await expect(side.getByRole('checkbox', { name: '同时放进资料库' })).toHaveCount(0);

  await detail.getByRole('button', { name: '阅读', exact: true }).click();
  await expect(detail.getByRole('region', { name: 'MCP 详情' })).toBeVisible();
  await expect(detail.getByRole('textbox', { name: '名称' })).toHaveCount(0);
});

test('a draft survives the read/edit switch and leaving asks once, and cancel keeps both the draft and the entry', async ({ page }) => {
  await install(page);
  await row(page, 'server-one').click();
  const detail = card(page, 'server-one');
  await detail.getByRole('button', { name: '编辑', exact: true }).click();
  const name = detail.getByRole('textbox', { name: '名称' });
  await name.fill('server-one-edited');
  await detail.getByRole('textbox', { name: '参数，每行一项 第 1 行' }).fill('server-one@2.0.0');
  await expect(page.getByText('有未保存的更改')).toBeVisible();

  // Switching to reading keeps the draft and shows the edited values instead of the saved ones.
  await detail.getByRole('button', { name: '阅读', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const draftRegion = detail.getByRole('region', { name: 'MCP 详情' });
  await expect(draftRegion).toBeVisible();
  await expect(draftRegion.getByText('server-one-edited', { exact: true })).toBeVisible();
  await expect(draftRegion).toContainText('server-one@2.0.0');
  await expect(draftRegion).not.toContainText('-y');
  await expect(page.getByText('有未保存的更改')).toBeVisible();
  await detail.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(name).toHaveValue('server-one-edited');
  await expect(detail.getByRole('textbox', { name: '参数，每行一项 第 1 行' })).toHaveValue('server-one@2.0.0');

  // Closing the same draft asks once as well; cancelling keeps the document and its draft.
  await detail.getByRole('button', { name: '关闭详情' }).click();
  const closeConfirm = page.getByRole('dialog', { name: '放弃未保存修改？' });
  await expect(closeConfirm).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(closeConfirm).toHaveCount(0);
  await expect(name).toHaveValue('server-one-edited');

  // Switching entries asks exactly once; Escape cancels and restores the same entry with its draft.
  await row(page, 'remote-service').click();
  const confirm = page.getByRole('dialog', { name: '放弃未保存修改？' });
  await expect(confirm).toHaveCount(1);
  await expect(confirm).toContainText('MCP 草稿尚未保存，切换后会丢失修改。');
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(card(page, 'server-one')).toBeVisible();
  await expect(name).toHaveValue('server-one-edited');

  // The same switch can also be cancelled from the dialog button.
  await row(page, 'remote-service').click();
  await expect(confirm).toHaveCount(1);
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(card(page, 'server-one')).toBeVisible();
  await expect(name).toHaveValue('server-one-edited');

  // Confirming the same switch discards the draft and opens the other entry.
  await row(page, 'remote-service').click();
  await expect(confirm).toHaveCount(1);
  await confirm.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(card(page, 'remote-service')).toBeVisible();
  await expect(page.getByText('有未保存的更改')).toHaveCount(0);
  // Nothing was written while the draft was abandoned.
  expect((await calls(page)).filter(call => ['preview_mcp_draft', 'commit_mcp_draft'].includes(call.command))).toEqual([]);
});

test('saving a draft previews the current CLI target and writes only after confirmation', async ({ page }) => {
  await install(page);
  await row(page, 'server-one').click();
  const detail = card(page, 'server-one');
  await detail.getByRole('button', { name: '编辑', exact: true }).click();
  await detail.getByRole('textbox', { name: '参数，每行一项 第 1 行' }).fill('server-one@2.0.0');
  await detail.getByRole('button', { name: '保存', exact: true }).click();

  const preview = detail.getByRole('group', { name: 'MCP 写入预览' });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('确认候选内容与写入结果');
  await expect(preview).toContainText('将创建 CLI 原生条目');
  // The preview is not a write.
  expect((await calls(page)).filter(call => call.command === 'commit_mcp_draft')).toEqual([]);
  const previewCall = await lastCall(page, 'preview_mcp_draft');
  expect(previewCall.args.draft).toEqual(expect.objectContaining({ name: 'server-one', args: ['server-one@2.0.0', 'server-one'], inLibrary: true }));
  expect(previewCall.args.targets).toEqual([expect.objectContaining({ toolId: 'codex', scope: 'global', projectPath: null, contextId: 'ctx-1', enabled: true })]);

  await detail.getByRole('button', { name: '确认写入当前 CLI' }).click();
  const commit = await lastCall(page, 'commit_mcp_draft');
  expect(commit.args.draft).toEqual(expect.objectContaining({ name: 'server-one', args: ['server-one@2.0.0', 'server-one'] }));
  expect(commit.args.targets).toEqual([expect.objectContaining({ toolId: 'codex', scope: 'global', contextId: 'ctx-1', enabled: true, baselineHash: 'hash-new', previewToken: 'token-1', allowReplace: false })]);
  // The written entry returns to reading, with the saved command.
  await expect(detail.getByRole('region', { name: 'MCP 详情' })).toBeVisible();
  await expect(detail).toContainText('server-one@2.0.0');
  await expect(page.getByRole('status').filter({ hasText: '已写入当前工具。' })).toBeVisible();
});

test('a conflicting target compares both contents and needs the explicit replace confirmation', async ({ page }) => {
  await install(page);
  await page.evaluate(() => { (window as any).__mcp.conflict = true; });
  await row(page, 'server-one').click();
  const detail = card(page, 'server-one');
  await detail.getByRole('button', { name: '编辑', exact: true }).click();
  await detail.getByRole('textbox', { name: '命令' }).fill('uvx');
  await detail.getByRole('button', { name: '保存', exact: true }).click();

  const preview = detail.getByRole('group', { name: 'MCP 写入预览' });
  await expect(preview).toContainText('当前同名条目与读取时不同，请比较后选择');
  await expect(preview).toContainText('同名原生 MCP 未受当前资料库管理，请比较后确认');
  const current = preview.getByLabel('当前 MCP');
  const next = preview.getByLabel('本次 MCP 修改');
  await expect(current).toContainText('old-command');
  await expect(next).toContainText('uvx');

  const write = detail.getByRole('button', { name: '确认写入当前 CLI' });
  await expect(write).toBeDisabled();
  await preview.getByRole('checkbox', { name: '明确替换预览中显示的同名冲突条目' }).check();
  await expect(write).toBeEnabled();
  await write.click();
  const commit = await lastCall(page, 'commit_mcp_draft');
  expect(commit.args.targets).toEqual([expect.objectContaining({ toolId: 'codex', allowReplace: true, previewToken: 'token-1', baselineHash: 'hash-old' })]);
});

test('batch import keeps the paste review and previews and commits the same current-CLI target', async ({ page }) => {
  await install(page);
  await page.getByRole('button', { name: '添加 MCP', exact: true }).first().click();
  const editor = page.getByRole('article', { name: '添加 MCP' });
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: '粘贴导入' }).click();
  const source = JSON.stringify({ mcpServers: { imported: { command: 'npx', args: ['-y', 'imported'] } } });
  await editor.getByRole('textbox', { name: '粘贴 MCP JSON' }).fill(source);
  await editor.getByRole('button', { name: '解析并填入' }).click();

  const review = page.getByRole('dialog', { name: '审查 MCP 导入' });
  await expect(review).toContainText('imported');
  await review.getByRole('button', { name: '预览选中的 1 项' }).click();
  const preview = await lastCall(page, 'preview_mcp_draft');
  expect(preview.args.draft).toEqual(expect.objectContaining({ name: 'imported', args: ['-y', 'imported'] }));
  expect(preview.args.targets).toEqual([expect.objectContaining({ toolId: 'codex', scope: 'global', projectPath: null, contextId: 'ctx-1', enabled: true })]);

  await review.getByRole('button', { name: '确认导入 1 项' }).click();
  await expect(review.getByText('已保存 imported')).toBeVisible();
  const commit = await lastCall(page, 'commit_mcp_draft');
  expect(commit.args.targets).toEqual([expect.objectContaining({ toolId: 'codex', scope: 'global', contextId: 'ctx-1', enabled: true, allowReplace: false })]);
});

test('a failed CLI read keeps the failure and a retry instead of an empty list, and protected values stay masked', async ({ page }) => {
  await install(page, { failList: true });
  await expect(page.getByText('codex 配置文件无法读取')).toBeVisible();
  await expect(page.getByText('当前工具不能添加可提交的 MCP，请查看上方原因。')).toBeVisible();
  // A failed read is not an empty CLI.
  await expect(page.locator('.empty-state')).toHaveCount(0);
  await expect(list(page)).toHaveCount(0);

  await page.evaluate(() => { (window as any).__mcp.failList = false; });
  await page.getByRole('button', { name: '重新扫描' }).first().click();
  await expect(list(page).getByRole('listitem')).toHaveCount(3);

  // Protected native values are stated as such and stay masked until asked for.
  await row(page, 'vault').click();
  const detail = card(page, 'vault');
  await expect(detail).toContainText('含受保护的原生值');
  await expect(detail).not.toContainText('secret-token');
  await detail.getByRole('button', { name: '显示 API_TOKEN 的值' }).click();
  await expect(detail).toContainText('secret-token');
});

test('the list and the open entry fit at 1360, 900 and 640 without page-level horizontal overflow', async ({ page }) => {
  await install(page);
  await row(page, 'server-one').click();
  const detail = card(page, 'server-one');
  await detail.getByRole('button', { name: '编辑', exact: true }).click();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  const paneOverflow = () => page.evaluate(() => {
    const article = document.querySelector('article') as HTMLElement | null;
    return !!article && article.scrollWidth > article.clientWidth + 1;
  });

  for (const width of [1360]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(list(page)).toBeVisible();
    await expect(detail.getByRole('textbox', { name: '名称' })).toBeVisible();
    expect(await overflow()).toBe(false);
    expect(await paneOverflow()).toBe(false);
  }

  // The document pane narrows to one column before the page does; the entry stays whole.
  for (const width of [900, 640]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(list(page)).toBeHidden();
    await expect(detail.getByRole('textbox', { name: '名称' })).toBeVisible();
    await expect(detail.getByRole('complementary', { name: '写入位置' })).toBeVisible();
    expect(await overflow()).toBe(false);
    expect(await paneOverflow()).toBe(false);
  }

  // The list is one action away and fits as well.
  await page.getByRole('button', { name: '返回列表' }).click();
  await expect(list(page)).toBeVisible();
  await expect(detail).toHaveCount(0);
  expect(await overflow()).toBe(false);
});

test('the keyboard selects a row, edits and saves, and closing returns focus to that row', async ({ page }) => {
  await install(page);
  await row(page, 'server-one').focus();
  await page.keyboard.press('ArrowDown');
  await expect(card(page, 'remote-service')).toBeVisible();
  await expect(row(page, 'remote-service')).toHaveAttribute('aria-current', 'true');

  const detail = card(page, 'remote-service');
  const edit = detail.getByRole('button', { name: '编辑', exact: true });
  await edit.focus();
  await page.keyboard.press('Enter');
  await expect(detail.getByRole('textbox', { name: '网址' })).toHaveValue('https://example.test/mcp');

  // The same shortcut saves from the form and then confirms the prepared preview.
  await page.keyboard.press('Control+s');
  const preview = detail.getByRole('group', { name: 'MCP 写入预览' });
  await expect(preview).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(detail.getByRole('region', { name: 'MCP 详情' })).toBeVisible();
  const commit = await lastCall(page, 'commit_mcp_draft');
  expect(commit.args.targets).toEqual([expect.objectContaining({ toolId: 'codex', enabled: false, previewToken: 'token-1' })]);

  await detail.getByRole('button', { name: '关闭详情' }).click();
  await expect(detail).toHaveCount(0);
  await expect(row(page, 'remote-service')).toBeFocused();
});

test('an externally discovered MCP is read-only and names its source', async ({ page }) => {
  await install(page, { external: true });
  const foreign = list(page).getByRole('listitem').filter({ hasText: 'github' });
  await expect(foreign).toContainText('Claude Code');
  await expect(foreign).toContainText('已停用');
  await row(page, 'github').click();
  const detail = card(page, 'github');
  await expect(detail).toContainText('/home/me/.claude/mcp.json');
  await expect(detail.getByRole('button', { name: '编辑', exact: true })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: '从 CLI 移除' })).toHaveCount(0);
  await expect(detail.getByRole('region', { name: 'MCP 详情' })).toBeVisible();
});
