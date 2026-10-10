import { expect, test, type Page } from '@playwright/test';
import { resourceExperienceFixture, minimaxCodeFixture } from '../../scripts/capture-workflow-fixtures.mjs';
async function fixture(page: Page, missing = false) {
  await page.addInitScript(resourceExperienceFixture, { count: 2 });
  await page.addInitScript(minimaxCodeFixture, { missing });
  await page.goto('/');
}
test('MiniMax is a terminal tool with recoverable launch failures and icon-only configuration', async ({ page }) => {
  await fixture(page);
  const tools = page.getByLabel('管理中的工具');
  await expect(tools.getByText('MiniMax Code', { exact: true })).toBeVisible();
  await expect(tools.getByRole('button', { name: '启动目录', exact: true })).toBeVisible();
  expect(await tools.getByRole('button', { name: '编辑配置', exact: true }).innerText()).toBe('');
  await tools.getByRole('button', { name: '启动', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__minimaxCode.calls.filter((call: any) => call.command === 'launch_cli').length)).toBe(1);
  const request = await page.evaluate(() => (window as any).__minimaxCode.calls.find((call: any) => call.command === 'launch_cli').args.request);
  expect(request).toMatchObject({ toolId: 'minimax_code', directory: 'C:/fixtures/project', mode: 'normal' });
  await page.evaluate(() => { (window as any).__minimaxCode.failLaunch = true; });
  await tools.getByRole('button', { name: '启动', exact: true }).click();
  await expect(tools.getByRole('alert')).toContainText('MiniMax Code 启动失败');
  await expect(tools.getByRole('button', { name: '启动', exact: true })).toBeEnabled();
});
test('missing MiniMax is not inferred from the existing quota provider', async ({ page }) => {
  await fixture(page, true);
  const tools = page.getByLabel('管理中的工具');
  await expect(tools.getByRole('button', { name: '重新检测', exact: true })).toBeVisible();
  await expect(tools.getByRole('button', { name: '启动', exact: true })).toHaveCount(0);
});
test('MiniMax connection and settings editors use native mappings', async ({ page }) => {
  await fixture(page);
  await page.getByLabel('管理中的工具').getByRole('button', { name: '编辑配置', exact: true }).click();
  await page.getByRole('button', { name: '新建配置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: '连接与模型', exact: true })).toBeVisible();
  await dialog.getByRole('textbox', { name: '供应商 ID', exact: true }).fill('fixture');
  await dialog.getByRole('textbox', { name: '请求地址', exact: true }).fill('https://example.invalid/v1');
  await dialog.getByRole('textbox', { name: '模型', exact: true }).fill('model/example');
  await dialog.getByRole('button', { name: '更新连接草稿', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '更新连接草稿', exact: true })).toBeDisabled();
  const action = await page.evaluate(() => (window as any).__minimaxCode.calls.find((call: any) => call.command === 'edit_configuration_draft').args.action);
  expect(action).toMatchObject({ operation: 'configure_connection', target: { kind: 'connection' }, value: { providerId: 'fixture', model: 'model/example', secretRef: null } });
  await dialog.getByRole('button', { name: '常用设置', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '默认模型', exact: true })).toHaveValue('custom_provider:fixture/model/example');
});
test('MiniMax exposes read-only native skill sources and hides absent capabilities', async ({ page }) => {
  await fixture(page);
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接', exact: true }).click();
  for (const name of ['账号', 'Agent', '插件']) await expect(page.getByRole('tab', { name, exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Skill', exact: true }).click();
  const rows = page.getByRole('region', { name: 'Skill', exact: true }).locator('article');
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: '只读来源' })).toHaveCount(2);
  await rows.filter({ hasText: 'minimax_builtin Skill source' }).getByRole('button', { name: 'same-skill', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'SKILL.md', exact: true })).toHaveAttribute('contenteditable', 'false');
  await expect(page.getByRole('dialog').getByRole('button', { name: '保存', exact: true })).toBeDisabled();
});
for (const surface of ['native', 'library']) test(`MiniMax ${surface} MCP copies retain source scope`, async ({ page }) => {
  await fixture(page);
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: surface === 'native' ? '工具与连接' : '资料库', exact: true }).click();
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: 'mcp-001', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '命令', exact: true }).fill('node-edited');
  await dialog.getByRole('button', { name: '配置文本', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '当前条目配置（格式化）', exact: true })).toContainText('node-edited');
  await dialog.getByRole('button', { name: '复制为新条目', exact: true }).click();
  await dialog.getByRole('button', { name: '配置文本', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: '当前条目配置（格式化）', exact: true })).toBeVisible();
  const calls = await page.evaluate(() => (window as any).__minimaxCode.calls.filter((call: any) => call.command === 'render_mcp_draft'));
  expect(calls.length).toBe(2);
  for (const call of calls) expect(call.args.draft).toMatchObject({ referenceSource: 'minimax_code', referenceScope: 'global' });
});
