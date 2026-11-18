import { expect, test, type Page } from '@playwright/test';
import { installWorkspaceFixtures } from '../../scripts/capture-workspace-fixtures.mjs';
import { installPromptFixtureBridge, installRichPromptFixtures } from '../../scripts/capture-prompt-fixtures.mjs';

async function install(page: Page, remote = false) {
  await page.addInitScript((remote: boolean) => {
    const handlers: Record<string, number> = {}; const callbacks: Array<(value: unknown) => void> = [];
    if (remote) localStorage.setItem('cliora:remote-target', 'remote-a');
    const target = { id: 'remote-a', name: 'Fixture host', host: 'fixture.invalid', user: 'fixture', port: 22, enabled: true, authMethod: 'key', identityFile: null, sshConfig: null, defaultPath: '/srv', createdAt: 1, updatedAt: 1 };
    const sessions = [{ id: 's-a', toolId: 'codex', projectId: null, directory: '/work/commerce/team-0/api', running: true, mode: 'normal', exitCode: null }, { id: 's-b', toolId: 'codex', projectId: null, directory: '/work/payments/api', running: true, mode: 'normal', exitCode: null }];
    const calls: Array<{ command: string; args: unknown }> = [];
    Object.assign(window, { isTauri: true, __promptBaseCalls: calls, __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} }, __TAURI_INTERNALS__: {
      transformCallback: (callback: (value: unknown) => void) => { callbacks.push(callback); return callbacks.length - 1; },
      invoke: async (command: string, args: Record<string, any> = {}) => {
        calls.push({ command, args });
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light', remote_ssh_enabled: remote }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', launchForm: 'terminal', interfaceFormats: [], nativeConfig: { state: 'supported', reason: '' }, launch: { state: 'supported', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'get_launch_settings' || command === 'set_preferred_terminal') return { selected: 'workbench', terminals: [{ id: 'workbench', label: '工作台', available: true }], worktreeLaunch: 'direct' };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'list_remote_targets') return remote ? [target] : [];
        if (command === 'list_workbench_sessions') return remote ? [] : sessions;
        if (command === 'replay_workbench_session') return btoa('ready\r\n');
        if (command === 'plugin:event|listen') { handlers[args.event] = args.handler; return args.handler; }
        if (command === 'plugin:event|unlisten') return null;
        if (command === 'get_registered_tool_workspace') return { profiles: [], snapshots: [], recoveryNeeded: [], common: null, customPath: null, probe: { selectedPath: '/fixture/codex', installations: [{ path: '/fixture/codex', version: '0.160.0', status: 'available' }], nativeFiles: [], interfaceFormats: [], providerPresets: [], dependencies: [], nativeWrites: { state: 'supported', reason: '' }, installUrl: '', upgradeHint: '' } };
        if (command.startsWith('list_')) return [];
        return null;
      },
    } });
  }, remote);
  await page.addInitScript(installWorkspaceFixtures);
  await page.addInitScript(installPromptFixtureBridge);
  await page.addInitScript(installRichPromptFixtures);
  await page.goto('/');
  await page.evaluate(() => { (window as any).__workspaceFixture.contexts = [{ sessionId: 's-a', workspaceId: 'workspace-commerce', repositoryId: 'repo-0', hostId: 'local', directory: '/work/commerce/team-0/api' }, { sessionId: 's-b', workspaceId: 'workspace-payments', repositoryId: 'pay-api', hostId: 'local', directory: '/work/payments/api' }]; });
}
async function library(page: Page) { await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click(); return page.locator('[data-prompt-library]'); }
async function composer(page: Page) {
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工作台', exact: true }).click();
  await page.locator('[data-session-id="s-a"]').click();
  const stage = page.getByRole('region', { name: '当前会话' });
  await stage.getByRole('button', { name: '快捷输入', exact: true }).click();
  return stage.getByRole('region', { name: '多行输入与提示词投递' });
}

test('full-body prompt search is paged, scope-aware, and inserts without sending or replacing drafts', async ({ page }) => {
  await install(page);
  const pane = await composer(page); const draft = pane.getByRole('textbox', { name: /编写多行内容/ }); await draft.fill('已有草稿');
  await pane.getByRole('button', { name: '查找提示词', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '查找提示词' });
  await picker.getByRole('textbox', { name: '搜索提示词标题或完整正文' }).fill('项目 B 发布');
  await expect(picker.getByText('没有匹配的提示词', { exact: true })).toBeVisible();
  await picker.getByRole('radio', { name: '全部提示词', exact: true }).click();
  await picker.getByRole('button', { name: '项目 B 发布', exact: true }).click();
  await expect(picker).toContainText('支付系统');
  await expect(picker.locator('pre')).toHaveText('B-only-secret-scope');
  await picker.getByRole('button', { name: '插入草稿', exact: true }).click();
  await expect(draft).toHaveValue('已有草稿\nB-only-secret-scope');
  expect(await page.evaluate(() => (window as any).__promptBaseCalls.filter((call: any) => call.command === 'write_workbench_session').length)).toBe(0);
  await pane.getByRole('button', { name: '查找提示词', exact: true }).click();
  await picker.getByRole('textbox', { name: '搜索提示词标题或完整正文' }).fill('全文后段命中-119');
  const match = picker.getByRole('button', { name: '模板 119', exact: true });
  await expect(match).toBeEnabled();
  await picker.getByRole('textbox', { name: '搜索提示词标题或完整正文' }).press('ArrowDown');
  await expect(match).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(picker.locator('pre')).toContainText('全文后段命中-119');
  await page.keyboard.press('Control+Enter');
  await expect(draft).toHaveValue(/^已有草稿\nB-only-secret-scope\n[\s\S]*全文后段命中-119/);
  expect(await page.evaluate(() => (window as any).__promptBaseCalls.filter((call: any) => call.command === 'write_workbench_session').length)).toBe(0);
});

test('late prompt body reads cannot insert into a different session', async ({ page }) => {
  await install(page); const pane = await composer(page);
  await pane.getByRole('textbox', { name: /编写多行内容/ }).fill('A draft');
  await pane.getByRole('button', { name: '查找提示词', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '查找提示词' });
  await picker.getByRole('textbox', { name: '搜索提示词标题或完整正文' }).fill('通用审查');
  await page.evaluate(() => { (window as any).__promptFixture.delayNextRead = true; });
  await picker.getByRole('button', { name: '通用审查', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__promptFixture.delayedRead)).toBe('function');
  await picker.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('[data-session-id="s-b"]').click();
  const input = page.getByRole('region', { name: '当前会话' }).getByRole('textbox', { name: /编写多行内容/ }); await input.fill('B draft');
  await page.evaluate(() => (window as any).__promptFixture.delayedRead());
  await expect(input).toHaveValue('B draft');
});

test('batch import previews multiline files and retries only unfinished entries', async ({ page }) => {
  await install(page); const panel = await library(page);
  await panel.getByRole('button', { name: '批量导入', exact: true }).click();
  const input = page.getByRole('dialog', { name: '导入提示词' });
  await input.getByLabel('JSON 内容').fill(JSON.stringify([{ title: 'first', body: 'one\ntwo' }, { title: 'broken', body: 'preserved' }]));
  await page.evaluate(() => { (window as any).__promptFixture.failTitle = 'broken'; });
  await input.getByRole('button', { name: '预览导入' }).click();
  const preview = page.getByRole('dialog', { name: '确认导入内容' });
  await expect(preview.getByLabel('正文')).toHaveValue('one\ntwo');
  await preview.getByRole('button', { name: '保存所选 2 条' }).click();
  await expect(preview.getByRole('status').filter({ hasText: '已保存' })).toHaveCount(1);
  await expect(preview.getByRole('status').filter({ hasText: '失败' })).toHaveCount(1);
  await page.evaluate(() => { (window as any).__promptFixture.failTitle = ''; });
  await preview.getByRole('button', { name: '重试未完成条目' }).click();
  await expect(preview.getByRole('status').filter({ hasText: '已保存' })).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).__promptFixture.documents.local.filter((item: any) => ['first', 'broken'].includes(item.title)).length)).toBe(2);
  await preview.getByRole('button', { name: '关闭', exact: true }).click();
  await panel.getByRole('button', { name: '批量导入', exact: true }).click();
  await input.getByLabel('JSON 内容').fill('[{"title":"cancelled","body":"not saved"}]');
  await input.getByRole('button', { name: '预览导入' }).click();
  await preview.getByRole('button', { name: '关闭', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__promptFixture.documents.local.some((item: any) => item.title === 'cancelled'))).toBe(false);
});

test('batch classification changes scope and tags while preserving full text', async ({ page }) => {
  await install(page); const panel = await library(page);
  await panel.getByRole('textbox', { name: '搜索资料' }).fill('通用审查');
  await panel.getByLabel('选择 通用审查', { exact: true }).check();
  await panel.getByRole('button', { name: '批量归类', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '批量归类' });
  await dialog.getByRole('button', { name: '适用范围', exact: true }).click();
  await page.getByRole('option', { name: /^电商平台 项目专用/ }).click();
  await dialog.getByRole('button', { name: '应用到所选条目' }).click();
  await expect(dialog.getByRole('status')).toContainText('已保存');
  const saved = await page.evaluate(() => (window as any).__promptFixture.documents.local.find((item: any) => item.id === 'general'));
  expect(saved.body).toBe('先检查边界，再检查错误恢复。'); expect(saved.scope).toEqual({ kind: 'workspace', workspaceId: 'workspace-commerce' });
});

test('incoming batch duplicates are visible in an empty library without becoming replacement targets', async ({ page }) => {
  await install(page);
  await page.evaluate(() => {
    (window as any).__promptFixture.documents.local = [];
    // Native contract fixture; Rust tests independently exercise duplicate detection.
    const original = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
      const result = await original(command, args);
      if (command === 'preview_prompt_import') {
        const preview = result.value ?? result;
        preview.rows.forEach((row: any) => {
          row.batchMatches = preview.rows.filter((other: any) => other !== row).map((other: any) => ({ itemId: other.item.itemId, title: other.item.draft.title, sameBody: true }));
        });
      }
      return result;
    };
  });
  const panel = await library(page);
  await panel.getByRole('button', { name: '批量导入', exact: true }).click();
  const input = page.getByRole('dialog', { name: '导入提示词' });
  await input.getByLabel('JSON 内容').fill('[{"title":"same","body":"same body"},{"title":"same","body":"same body"}]');
  await input.getByRole('button', { name: '预览导入' }).click();
  const preview = page.getByRole('dialog', { name: '确认导入内容' });
  await expect(preview.getByText(/本批次同名或相同正文/)).toHaveCount(2);
  const rows = preview.locator('[data-import-item]');
  await expect(rows.nth(0).getByRole('option', { name: '替换已有条目' })).toBeDisabled();
  await expect(rows.nth(1).getByRole('option', { name: '替换已有条目' })).toBeDisabled();
  await rows.nth(1).getByRole('checkbox').uncheck();
  await expect(preview.getByText(/本批次同名或相同正文/)).toHaveCount(0);
  await rows.nth(1).getByRole('checkbox').check();
  await expect(preview.getByText(/本批次同名或相同正文/)).toHaveCount(2);
  await preview.getByLabel('标题', { exact: true }).fill('different title');
  await preview.getByLabel('正文', { exact: true }).fill('different body');
  await expect(preview.getByText(/本批次同名或相同正文/)).toHaveCount(0);
  await preview.getByLabel('正文', { exact: true }).fill('same body');
  await expect(preview.getByText(/本批次同名或相同正文/)).toHaveCount(2);
  await rows.nth(1).getByRole('combobox').selectOption('skip');
  await expect(preview.getByText(/本批次同名或相同正文/)).toHaveCount(0);
  await preview.getByRole('button', { name: '保存所选 2 条' }).click();
  await expect(preview.getByRole('status').filter({ hasText: '已保存' })).toHaveCount(1);
  await expect(preview.getByRole('status').filter({ hasText: '已跳过' })).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__promptFixture.documents.local.length)).toBe(1);
});

test('remote prompt edits carry both observed file baselines and retain host identity', async ({ page }) => {
  await install(page, true); const panel = await library(page);
  await panel.getByRole('button', { name: '远端审查', exact: true }).click();
  await expect(page.locator('dialog[open]')).toHaveAccessibleName('编辑提示词');

  const editor = page.getByRole('dialog', { name: '编辑提示词' });
  await editor.getByRole('textbox', { name: '资料正文', exact: true }).fill('remote updated\nbody');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const call = await page.evaluate(() => (window as any).__promptFixture.calls.find((item: any) => item.command === 'save_prompt'));
  expect(call.args.targetId).toBe('remote-a');
  expect(Object.keys(call.args.operation.expectedFiles).sort()).toEqual(['$HOME/.cliora/library.json', '$HOME/.cliora/prompts-v1.json'].sort());
  expect(await page.evaluate(() => (window as any).__promptFixture.documents.local.find((item: any) => item.id === 'general').body)).toBe('先检查边界，再检查错误恢复。');
});

test('failed prompt reads reuse a same-scope snapshot across entries but never another project scope', async ({ page }) => {
  await install(page);
  // This test exercises cache identity, not locale-dependent ranking among 120 templates.
  await page.evaluate(() => { const fixture = (window as any).__promptFixture; fixture.documents.local = fixture.documents.local.filter((item: any) => ['general', 'repo-a', 'project-b'].includes(item.id)); });
  const pane = await composer(page);
  await expect.poll(() => page.evaluate(() => (window as any).__promptFixture.calls.some((call: any) => call.command === 'query_prompts' && call.args.query.workspaceId === 'workspace-commerce' && call.args.query.repositoryId === 'repo-0'))).toBe(true);
  await expect(pane.getByRole('button', { name: 'API 回归', exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__promptFixture.failRead = true; });
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建工作台会话' });
  const place = async (search: string, option: RegExp) => {
    await dialog.getByRole('button', { name: '工作目录 / 项目', exact: true }).click();
    await page.getByRole('textbox', { name: /搜索/ }).last().fill(search);
    await page.getByRole('option', { name: option }).first().click();
  };
  await place('payment-api', /^payment-api 支付系统/);
  await expect(dialog.getByText('暂时无法读取此位置的提示词。', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'API 回归', exact: true })).toHaveCount(0);
  await expect(dialog.getByText('提示词刷新失败，当前显示上次成功读取的内容。', { exact: true })).toHaveCount(0);
  await place('team-0/api', /^api 电商平台/);
  await expect(dialog.getByText('提示词刷新失败，当前显示上次成功读取的内容。', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'API 回归', exact: true })).toBeVisible();
});

test('an empty scoped search offers the all-scope search and double-click inserts the prompt', async ({ page }) => {
  await install(page);
  const pane = await composer(page); const draft = pane.getByRole('textbox', { name: /编写多行内容/ });
  await pane.getByRole('button', { name: '查找提示词', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '查找提示词' });
  await expect(picker.getByRole('radio', { name: '电商平台 / api', exact: true })).toHaveAttribute('aria-checked', 'true');
  await picker.getByRole('textbox', { name: '搜索提示词标题或完整正文' }).fill('项目 B 发布');
  await picker.getByRole('button', { name: '在全部范围中搜索', exact: true }).click();
  await expect(picker.getByRole('radio', { name: '全部提示词', exact: true })).toHaveAttribute('aria-checked', 'true');
  await picker.getByRole('button', { name: '项目 B 发布', exact: true }).dblclick();
  await expect(picker).not.toBeVisible();
  await expect(draft).toHaveValue('B-only-secret-scope');
  expect(await page.evaluate(() => (window as any).__promptBaseCalls.filter((call: any) => call.command === 'write_workbench_session').length)).toBe(0);
});
