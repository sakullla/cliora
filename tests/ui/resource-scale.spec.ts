import { expect, test, type Page } from '@playwright/test';
import { resourceExperienceFixture } from '../../scripts/capture-workflow-fixtures.mjs';

async function library(page: Page, section = 'MCP', options = {}) {
  await page.addInitScript(resourceExperienceFixture, options);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: section, exact: true }).click();
}

test('500 MCP: complete search, stable page/selection and detail return; 500 writes in bounded chunks and failed-only retry', async ({ page }) => {
  await library(page);
  const list = page.locator('[data-resource-list="library:mcp"]');
  await expect(list.locator('article')).toHaveCount(50);
  await list.getByRole('button', { name: '下一页', exact: true }).click();
  await list.getByRole('checkbox', { name: '选择 mcp-051', exact: true }).check();
  await list.getByRole('button', { name: 'mcp-051', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await expect(list.getByText('第 2 / 10 页 · 500 / 500 项')).toBeVisible();
  await expect(list.getByRole('checkbox', { name: '选择 mcp-051', exact: true })).toBeChecked();
  await list.getByRole('textbox', { name: '搜索资料' }).fill('server-499');
  await expect(list.locator('article')).toHaveCount(1);
  await expect(list.getByRole('button', { name: 'mcp-499', exact: true })).toBeVisible();
  await expect(list.getByText('已选 1 项 · 筛选外 1 项')).toBeVisible();
  await list.getByRole('textbox', { name: '搜索资料' }).fill('');
  await list.getByRole('button', { name: '选择全部筛选结果（500）', exact: true }).click();
  await list.getByRole('combobox', { name: '批量目标', exact: true }).selectOption('codex');
  await list.getByRole('button', { name: '分发 / 安装', exact: true }).click();
  await expect(list.getByText('成功 499 项，未成功 1 项', { exact: true }).filter({ visible: true })).toBeVisible();
  let evidence = await page.evaluate(() => (window as any).__resourceScale);
  expect(evidence.calls.filter((call: any) => call.command === 'run_resource_batch')).toHaveLength(10);
  expect(evidence.calls.filter((call: any) => call.command === 'preview_mcp_targets')).toHaveLength(500);
  expect(evidence.calls.filter((call: any) => call.command === 'run_resource_batch').flatMap((call: any) => call.args.operations).every((operation: any) => operation.target.previewToken && operation.target.baselineHash)).toBe(true);
  expect(evidence.writes).toHaveLength(499);
  await page.evaluate(() => { (window as any).__resourceScale.failBatch = null; });
  await list.getByRole('button', { name: '重试未成功项', exact: true }).click();
  await expect(list.getByText('成功 500 项，未成功 0 项', { exact: true }).first()).toBeVisible();
  evidence = await page.evaluate(() => (window as any).__resourceScale);
  expect(evidence.writes).toHaveLength(500);
  expect(new Set(evidence.writes.map((item: any) => item.id)).size).toBe(500);
  expect(evidence.calls.filter((call: any) => call.command === 'run_resource_batch').at(-1).args.operations).toHaveLength(1);
  expect(evidence.calls.filter((call: any) => call.command === 'preview_mcp_targets')).toHaveLength(501);
});

test('MCP batch requires preview credentials, preserves external edits and obtains fresh credentials on retry', async ({ page }) => {
  await library(page);
  const unpreviewed = await page.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke('run_resource_batch', { operationId: 'no-preview', operations: [{ action: 'mcp_apply', definitionId: 'mcp-001', target: { toolId: 'codex', scope: 'global', projectPath: null, enabled: true } }] }));
  expect(unpreviewed.items[0].status).toBe('failed');
  await page.evaluate(() => {
    const host = (window as any).__TAURI_INTERNALS__; const invoke = host.invoke; let changed = false;
    host.invoke = async (command: string, args: any) => {
      const result = await invoke(command, args);
      if (command === 'preview_mcp_targets' && !changed) { changed = true; (window as any).__resourceScale.nativeEntries[0].command = 'external-command'; }
      return result;
    };
  });
  const list = page.locator('[data-resource-list="library:mcp"]');
  await list.getByRole('checkbox', { name: '选择 mcp-001', exact: true }).check();
  await list.getByRole('combobox', { name: '批量目标', exact: true }).selectOption('codex');
  await list.getByRole('button', { name: '分发 / 安装', exact: true }).click();
  await expect(list.getByRole('button', { name: '重试未成功项', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__resourceScale.writes.length)).toBe(0);
  expect(await page.evaluate(() => (window as any).__resourceScale.nativeEntries[0].command)).toBe('external-command');
  await page.evaluate(() => { (window as any).__resourceScale.conflicts = ['mcp-001']; });
  await list.getByRole('button', { name: '重试未成功项', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('external-command');
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__resourceScale.writes.length)).toBe(0);
  await list.getByRole('button', { name: '重试未成功项', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '替换并写入', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__resourceScale.writes.length)).toBe(1);
  const calls = await page.evaluate(() => (window as any).__resourceScale.calls);
  expect(calls.filter((call: any) => call.command === 'preview_mcp_targets')).toHaveLength(3);
});

test('native paste retains committed definitions and failed target retry after refreshing the library', async ({ page }) => {
  await library(page);
  await page.evaluate(() => { (window as any).__resourceScale.failBatch = 'new-500'; });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接', exact: true }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: '粘贴 MCP 配置', exact: true }).click();
  await page.getByRole('textbox', { name: '粘贴 MCP 配置', exact: true }).fill('{"mcpServers":{"failed-target":{"command":"node","enabled":false},"successful-target":{"command":"node"}}}');
  await page.getByRole('button', { name: '校验配置', exact: true }).click();
  await page.getByRole('button', { name: '添加已校验条目', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试未成功项', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__resourceScale.definitions.length)).toBe(502);
  await page.getByText('逐项结果', { exact: true }).click();
  await expect(page.locator('li').filter({ hasText: 'failed-target' })).toContainText('已保存');
  await page.evaluate(() => { (window as any).__resourceScale.failBatch = null; });
  await page.getByRole('button', { name: '重试未成功项', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__resourceScale.writes.length)).toBe(2);
  const state = await page.evaluate(() => (window as any).__resourceScale);
  expect(state.calls.filter((call: any) => call.command === 'save_mcp_definition')).toHaveLength(2);
  expect(state.calls.filter((call: any) => call.command === 'preview_mcp_targets')).toHaveLength(3);
  expect(state.nativeEntries.find((item: any) => item.name === 'failed-target').enabled).toBe(false);
  expect(state.writes.filter((item: any) => item.id === 'new-501')).toHaveLength(1);
});

for (const surface of ['library', 'tool']) for (const fresh of [false, true]) test(`${surface} pending form save preserves later configuration edits and advances the accepted CAS version (new=${fresh})`, async ({ page }) => {
  await library(page);
  if (surface === 'tool') {
    await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接', exact: true }).click();
    await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  }
  const entryName = fresh ? 'fresh-entry' : 'mcp-001';
  await page.getByRole('button', { name: fresh ? surface === 'library' ? '新建 MCP' : '添加 MCP' : entryName, exact: true }).click();
  if (fresh) await page.getByRole('dialog').getByRole('textbox', { name: '名称', exact: true }).fill(entryName);
  await page.evaluate(() => {
    const host = (window as any).__TAURI_INTERNALS__; const invoke = host.invoke; let delayed = false;
    host.invoke = async (command: string, args: unknown) => {
      const result = await invoke(command, args);
      if (command === 'save_mcp_definition' && !delayed) { delayed = true; await new Promise<void>(resolve => { (window as any).__finishSave = resolve; }); }
      return result;
    };
  });
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '命令', exact: true }).fill('first-save');
  await dialog.locator('[data-dialog-save]').click();
  await expect.poll(() => page.evaluate(() => !!(window as any).__finishSave)).toBe(true);
  await dialog.getByRole('button', { name: '配置文本', exact: true }).click();
  const editor = dialog.getByRole('textbox', { name: '当前条目配置（格式化）', exact: true });
  await editor.fill(JSON.stringify({ mcpServers: { [entryName]: { command: 'continued-config' } } }));
  await page.evaluate(() => (window as any).__finishSave());
  await expect(editor).toContainText('continued-config');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '转入表单草稿', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '命令', exact: true })).toHaveValue('continued-config');
  await dialog.locator('[data-dialog-save]').click();
  await expect.poll(() => page.evaluate(() => (window as any).__resourceScale.calls.filter((call: any) => call.command === 'save_mcp_definition').map((call: any) => call.args.draft.expectedVersion))).toEqual(fresh ? [null, 1] : [1, 2]);
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(name => (window as any).__resourceScale.definitions.find((item: any) => item.name === name).command, entryName)).toBe('continued-config');
});

for (const field of ['protectedValues', 'unmappedFields']) for (const mode of ['form', 'batch']) test(`${mode} enable still blocks ${field} rather than discarding native configuration`, async ({ page }) => {
  await library(page);
  await page.evaluate(field => { const item = (window as any).__resourceScale.nativeEntries[0]; item.enabled = false; item[field] = field === 'protectedValues' ? true : ['future-field']; }, field);
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接', exact: true }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  if (mode === 'form') {
    await page.getByRole('button', { name: 'mcp-001', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('checkbox', { name: '启用', exact: true }).check();
    await dialog.locator('[data-dialog-save]').click();
    await expect(dialog.getByRole('alert')).toContainText(field === 'protectedValues' ? '脱敏' : 'future-field');
  } else {
    await page.getByRole('checkbox', { name: '选择 mcp-001', exact: true }).check();
    await page.getByRole('combobox', { name: '批量操作', exact: true }).selectOption('enable');
    await page.getByRole('button', { name: '启用', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试未成功项', exact: true })).toBeVisible();
  }
  const state = await page.evaluate(() => (window as any).__resourceScale);
  expect(state.calls.filter((call: any) => call.command === 'save_mcp_definition')).toHaveLength(0);
  expect(state.writes).toHaveLength(0);
  expect(state.nativeEntries[0].enabled).toBe(false);
});

for (const mode of ['form', 'batch']) test(`disabled native MCP can be explicitly enabled through ${mode} without dropping configuration`, async ({ page }) => {
  await library(page);
  await page.evaluate(() => { (window as any).__resourceScale.nativeEntries[0].enabled = false; });
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接', exact: true }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  if (mode === 'form') {
    await page.getByRole('button', { name: 'mcp-001', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '配置文本', exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: '当前条目配置（格式化）', exact: true })).toContainText('"enabled": false');
    await dialog.getByRole('button', { name: '转入表单草稿', exact: true }).click();
    const enabled = dialog.getByRole('checkbox', { name: '启用', exact: true });
    await expect(enabled).not.toBeChecked();
    await enabled.check();
    await dialog.locator('[data-dialog-save]').click();
    await expect(dialog).toHaveCount(0);
  } else {
    await page.getByRole('checkbox', { name: '选择 mcp-001', exact: true }).check();
    await page.getByRole('combobox', { name: '批量操作', exact: true }).selectOption('enable');
    await page.getByRole('button', { name: '启用', exact: true }).click();
  }
  await expect.poll(() => page.evaluate(() => (window as any).__resourceScale.nativeEntries[0].enabled)).toBe(true);
  expect(await page.evaluate(() => (window as any).__resourceScale.nativeEntries[0].args)).toEqual(['server-001.mjs']);
});

test('library paste refuses to silently discard disabled state', async ({ page }) => {
  await library(page);
  await page.getByRole('button', { name: '粘贴 MCP 配置', exact: true }).click();
  await page.getByRole('textbox', { name: '粘贴 MCP 配置', exact: true }).fill('{"mcpServers":{"disabled-entry":{"command":"node","enabled":false}}}');
  await page.getByRole('button', { name: '校验配置', exact: true }).click();
  await expect(page.getByText('资料库定义不保存启停状态。', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '添加已校验条目', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__resourceScale.calls.filter((call: any) => call.command === 'save_mcp_definition').length)).toBe(0);
});

test('500 Skills metadata stays searchable during delayed checks; one failure is isolated and package edits preserve browsing state', async ({ page }) => {
  await library(page, 'Skill', { stateDelay: 350 });
  const list = page.locator('[data-resource-list="library:skill"]');
  await expect(list.locator('article')).toHaveCount(50);
  await expect(list.locator('article').filter({ hasText: '状态读取失败' })).toBeVisible();
  await list.getByRole('textbox', { name: '搜索资料' }).fill('needle-last');
  await expect(list.locator('article')).toHaveCount(1);
  await expect(list.getByRole('button', { name: 'skill-500', exact: true })).toBeVisible();
  await list.getByRole('button', { name: 'skill-500', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'SKILL.md', exact: true }).fill('# Changed document');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(list.getByRole('textbox', { name: '搜索资料' })).toHaveValue('needle-last');
  const evidence = await page.evaluate(() => (window as any).__resourceScale);
  expect(evidence.maxActive).toBeLessThanOrEqual(1);
  expect(evidence.calls.filter((call: any) => call.command === 'resource_states').every((call: any) => call.args.requests.length <= 50)).toBe(true);
  expect(evidence.calls.filter((call: any) => call.command === 'list_skill_installations')).toHaveLength(0);
  expect(evidence.packages.find((item: any) => item.id === 'skill-500').fileCount).toBe(3);
});

test('native Skills search complete metadata on unvisited pages and MCP copies only the entry while raw source is read-only', async ({ page }) => {
  await page.addInitScript(resourceExperienceFixture, { stateDelay: 200 });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接', exact: true }).click();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  const skills = page.getByRole('region', { name: 'Skill', exact: true });
  await skills.getByRole('textbox', { name: '搜索资料' }).fill('needle-last');
  await expect(skills.getByRole('button', { name: 'skill-500', exact: true })).toBeVisible();
  await skills.getByRole('button', { name: 'skill-500', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'SKILL.md', exact: true })).toContainText('Original Markdown');
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: 'mcp-001', exact: true }).click();
  await page.getByRole('button', { name: '配置文本', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '当前条目配置（格式化）', exact: true })).toContainText('server-001.mjs');
  await page.getByRole('checkbox', { name: '原文件全文（只读，包含其他条目）', exact: true }).check();
  const raw = page.getByRole('textbox', { name: '原文件全文（只读，包含其他条目）', exact: true });
  await expect(raw).toContainText('unrelated configuration');
  await expect(raw).toHaveAttribute('contenteditable', 'false');
  const evidence = await page.evaluate(() => (window as any).__resourceScale);
  expect(evidence.calls.filter((call: any) => call.command === 'scan_native_skills')).toHaveLength(0);
});

test('new MCP hidden by a query offers explicit locate and name sort persists; paste rejects unknown fields', async ({ page }) => {
  await library(page);
  const list = page.locator('[data-resource-list="library:mcp"]');
  await list.getByRole('combobox', { name: '资源排序', exact: true }).selectOption('name');
  await list.getByRole('textbox', { name: '搜索资料' }).fill('mcp-500');
  await page.getByRole('button', { name: '新建 MCP', exact: true }).click();
  await page.getByRole('textbox', { name: '名称', exact: true }).fill('created-item');
  await page.getByRole('textbox', { name: '命令', exact: true }).fill('node');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(list.getByRole('textbox', { name: '搜索资料' })).toHaveValue('mcp-500');
  await list.getByRole('button', { name: '查看新增项', exact: true }).click();
  await expect(list.getByRole('button', { name: 'created-item', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '粘贴 MCP 配置', exact: true }).click();
  await page.getByRole('textbox', { name: '粘贴 MCP 配置', exact: true }).fill(JSON.stringify({ mcpServers: { unsafe: { command: 'node', unknownField: true } } }));
  await page.getByRole('button', { name: '校验配置', exact: true }).click();
  await expect(page.getByText('不能转换的字段：unknownField', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '添加已校验条目', exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '资源排序', exact: true })).toHaveValue('name');
});

test('cancelling a batch retains committed rows and stops subsequent chunks', async ({ page }) => {
  await library(page);
  await page.evaluate(() => { (window as any).__resourceScale.batchDelay = 30; (window as any).__resourceScale.failBatch = null; });
  const list = page.locator('[data-resource-list="library:mcp"]');
  await list.getByRole('button', { name: '选择全部筛选结果（500）', exact: true }).click();
  await list.getByRole('combobox', { name: '批量目标', exact: true }).selectOption('codex');
  await list.getByRole('button', { name: '分发 / 安装', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__resourceScale.writes.length)).toBeGreaterThan(0);
  await list.getByRole('button', { name: '停止后续操作', exact: true }).click();
  await expect(list.getByRole('button', { name: '重试未成功项', exact: true })).toBeVisible();
  const evidence = await page.evaluate(() => (window as any).__resourceScale);
  expect(evidence.writes.length).toBeGreaterThan(0);
  expect(evidence.writes.length).toBeLessThan(50);
  expect(evidence.calls.filter((call: any) => call.command === 'run_resource_batch')).toHaveLength(1);
});

test('500 native Skills: selection checks metadata in bounded chunks and mixed failed/operation jobs never become false successes', async ({ page }) => {
  await page.addInitScript(resourceExperienceFixture, {});
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接', exact: true }).click();
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  const list = page.getByRole('region', { name: 'Skill', exact: true });
  await list.getByRole('button', { name: '选择全部筛选结果（500）', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__resourceScale.calls.filter((call: any) => call.command === 'resource_states').some((call: any) => call.args.requests.some((item: any) => item.name === 'skill-500')))).toBe(true);
  await list.getByRole('combobox', { name: '批量操作', exact: true }).selectOption('enable');
  await list.getByRole('button', { name: '启用', exact: true }).click();
  await expect(list.getByText('成功 499 项，未成功 1 项', { exact: true }).first()).toBeVisible();
  const evidence = await page.evaluate(() => (window as any).__resourceScale);
  expect(evidence.writes).toHaveLength(499);
  expect(evidence.calls.filter((call: any) => call.command === 'run_resource_batch').length).toBeLessThanOrEqual(11);
  expect(evidence.maxActive).toBe(1);
});

test('package CAS and clipboard failures keep the draft and show an actionable failure', async ({ page }) => {
  await library(page, 'Skill');
  await page.getByRole('button', { name: 'skill-001', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const editor = dialog.getByRole('textbox', { name: 'SKILL.md', exact: true });
  await editor.fill('# Keep this draft');
  await page.evaluate(() => {
    (window as any).__resourceScale.packages[0].digest = 'external-change';
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('clipboard denied'); } }, configurable: true });
    document.execCommand = () => false;
  });
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('External edit conflict');
  await expect(editor).toContainText('# Keep this draft');
  await dialog.getByRole('button', { name: '复制 SKILL.md', exact: true }).click();
  await expect(dialog.getByRole('alert').filter({ hasText: '复制失败' })).toBeVisible();
  await expect(dialog.getByRole('alert').filter({ hasText: 'External edit conflict' })).toBeVisible();
  await expect(editor).toContainText('# Keep this draft');
  expect(await page.evaluate(() => (window as any).__resourceScale.writes.length)).toBe(0);
});

test('multi-entry paste skips same-name definitions by default and duplication stays an unsaved independent draft', async ({ page }) => {
  await library(page);
  await page.getByRole('button', { name: '粘贴 MCP 配置', exact: true }).click();
  await page.getByRole('textbox', { name: '粘贴 MCP 配置', exact: true }).fill(JSON.stringify({ mcpServers: { 'mcp-001': { command: 'replacement' }, 'new-one': { command: 'node', args: ['new-one.mjs'] }, 'new-two': { url: 'https://example.invalid/new' } } }));
  await page.getByRole('button', { name: '校验配置', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '替换资料库同名定义（目标冲突仍需单独处理）', exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: '添加已校验条目', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__resourceScale.definitions.length)).toBe(502);
  expect(await page.evaluate(() => (window as any).__resourceScale.definitions.find((item: any) => item.id === 'mcp-001').command)).toBe('node');
  await page.locator('[data-resource-list="library:mcp"]').getByRole('button', { name: 'mcp-001', exact: true }).click();
  await page.getByRole('button', { name: '配置文本', exact: true }).click();
  await page.getByRole('button', { name: '复制为新条目', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('mcp-001-copy');
  expect(await page.evaluate(() => (window as any).__resourceScale.definitions.length)).toBe(502);
});

test('new and edited MCP forms switch through adapter-rendered drafts without saving or discarding input', async ({ page }) => {
  await library(page);
  await page.getByRole('button', { name: '新建 MCP', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('unsaved-new');
  await dialog.getByRole('textbox', { name: '命令', exact: true }).fill('node');
  await dialog.getByRole('button', { name: '配置文本', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '当前条目配置（格式化）', exact: true })).toContainText('unsaved-new');
  await dialog.getByRole('textbox', { name: '当前条目配置（格式化）', exact: true }).fill(JSON.stringify({ mcpServers: { 'unsaved-new': { command: 'edited-command', args: ['one', 'two words'] } } }));
  await dialog.getByRole('button', { name: '转入表单草稿', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '命令', exact: true })).toHaveValue('edited-command');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: 'mcp-001', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '命令', exact: true }).fill('unsaved-edit');
  await dialog.getByRole('button', { name: '配置文本', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '当前条目配置（格式化）', exact: true })).toContainText('unsaved-edit');
  await dialog.getByRole('button', { name: '转入表单草稿', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '命令', exact: true })).toHaveValue('unsaved-edit');
  const evidence = await page.evaluate(() => (window as any).__resourceScale);
  expect(evidence.definitions).toHaveLength(500);
  expect(evidence.definitions[0].command).toBe('node');
  expect(evidence.calls.filter((call: any) => ['save_mcp_definition', 'save_mcp_document', 'run_resource_batch'].includes(call.command))).toHaveLength(0);
  expect(evidence.calls.filter((call: any) => call.command === 'render_mcp_draft')).toHaveLength(2);
});

test('delayed form and configuration conversions preserve input typed while they are pending', async ({ page }) => {
  await library(page);
  await page.evaluate(() => {
    const host = (window as any).__TAURI_INTERNALS__; const invoke = host.invoke;
    host.invoke = async (command: string, args: unknown) => {
      if (['render_mcp_draft', 'parse_mcp_paste'].includes(command)) {
        await new Promise<void>(resolve => { (window as any).__releaseConversion = resolve; });
      }
      return invoke(command, args);
    };
  });
  await page.getByRole('button', { name: 'mcp-001', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const command = dialog.getByRole('textbox', { name: '命令', exact: true });
  await command.fill('first-draft');
  await dialog.getByRole('button', { name: '配置文本', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).__releaseConversion)).toBe(true);
  await command.fill('later-draft');
  await page.evaluate(() => { (window as any).__releaseConversion(); delete (window as any).__releaseConversion; });
  await expect(dialog.getByRole('alert').filter({ hasText: '转换期间草稿已更改' })).toBeVisible();
  await expect(command).toHaveValue('later-draft');
  await dialog.getByRole('button', { name: '配置文本', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).__releaseConversion)).toBe(true);
  await page.evaluate(() => { (window as any).__releaseConversion(); delete (window as any).__releaseConversion; });
  const config = dialog.getByRole('textbox', { name: '当前条目配置（格式化）', exact: true });
  await expect(config).toContainText('later-draft');
  await dialog.getByRole('button', { name: '转入表单草稿', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).__releaseConversion)).toBe(true);
  await config.fill('{"mcpServers":{"mcp-001":{"command":"newest-draft"}}}');
  await page.evaluate(() => { (window as any).__releaseConversion(); delete (window as any).__releaseConversion; });
  await expect(dialog.getByRole('alert').filter({ hasText: '转换期间草稿已更改' })).toBeVisible();
  await expect(config).toContainText('newest-draft');
  await dialog.getByRole('button', { name: '转入表单草稿', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).__releaseConversion)).toBe(true);
  await page.evaluate(() => (window as any).__releaseConversion());
  await expect(command).toHaveValue('newest-draft');
  expect(await page.evaluate(() => (window as any).__resourceScale.writes.length)).toBe(0);
});

test('package refresh recovery reads again without repeating a committed save or replacing later input', async ({ page }) => {
  await library(page, 'Skill');
  await page.getByRole('button', { name: 'skill-001', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const editor = dialog.getByRole('textbox', { name: 'SKILL.md', exact: true });
  await editor.fill('# Committed document');
  await page.evaluate(() => {
    const host = (window as any).__TAURI_INTERNALS__; const invoke = host.invoke; let failed = false;
    host.invoke = async (command: string, args: unknown) => {
      if (command === 'list_skill_packages' && !failed) { failed = true; throw Error('Refresh unavailable'); }
      return invoke(command, args);
    };
  });
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('部分完成');
  await dialog.getByText('详情', { exact: true }).click();
  await expect(dialog.getByText('Refresh unavailable', { exact: true })).toBeVisible();
  await editor.fill('# Continued editing after commit');
  await dialog.getByRole('button', { name: '重试', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(editor).toContainText('# Continued editing after commit');
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__resourceScale.writes.filter((item: any) => item.kind === 'skill-document').length)).toBe(1);
});

test('paste validation rejects an older result after continued typing', async ({ page }) => {
  await library(page);
  await page.evaluate(() => {
    const host = (window as any).__TAURI_INTERNALS__; const invoke = host.invoke;
    host.invoke = async (command: string, args: unknown) => {
      if (command === 'parse_mcp_paste') await new Promise<void>(resolve => { (window as any).__releasePaste = resolve; });
      return invoke(command, args);
    };
  });
  await page.getByRole('button', { name: '粘贴 MCP 配置', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '粘贴 MCP 配置', exact: true });
  await editor.fill('{"mcpServers":{"old-entry":{"command":"node"}}}');
  await page.getByRole('button', { name: '校验配置', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).__releasePaste)).toBe(true);
  await editor.fill('{"mcpServers":{"new-entry":{"command":"node"}}}');
  await page.evaluate(() => (window as any).__releasePaste());
  await expect(page.getByRole('alert').filter({ hasText: '转换期间草稿已更改' })).toBeVisible();
  await expect(editor).toContainText('new-entry');
  await expect(page.getByRole('button', { name: '添加已校验条目', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__resourceScale.definitions.length)).toBe(500);
});

