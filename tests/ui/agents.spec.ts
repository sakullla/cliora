import { expect, test, type Page } from '@playwright/test';

test('Agent search and status filters preserve access to read-only definitions', async ({ page }) => {
  await setup(page);
  await page.getByLabel('搜索 Agent 定义').fill('no-match');
  await expect(page.getByRole('listitem')).toHaveCount(0);
  await expect(page.locator('.empty-state')).toHaveCount(0);
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(page.getByText('reviewer', { exact: true })).toBeVisible();
  await page.getByLabel('Agent 状态筛选').selectOption('readonly');
  await expect(page.getByText('reviewer', { exact: true })).toHaveCount(0);
  await expect(page.locator('.empty-state')).toHaveCount(0);
  await page.getByLabel('Agent 状态筛选').selectOption('all');
  await expect(page.getByText('reviewer', { exact: true })).toBeVisible();
});

async function setup(page: Page, holdScan = false, emptyEntries = false) {
  await page.addInitScript(({ holdScan, emptyEntries }) => {
    const entry = { id: 'fixture', name: 'reviewer', description: 'Reviews code', path: '/fixture/agents/reviewer.md', format: 'markdown', content: '---\nname: reviewer\ndescription: Reviews code\ntools: Read\ncustom: preserved\n---\nReview code.\n', enabled: true, readOnly: false, owner: '独立定义', detail: '' };
    const conflicted = { ...entry, id: 'conflicted', name: 'planner', description: 'Plan', path: '/fixture/opencode.json', format: 'json', content: '{"description":"Plan"}', readOnly: true, detail: 'agent 与 agents 同义并存，原生形态冲突；请在原生配置统一为一种形态后再编辑' };
    const state = { calls: [] as any[], entries: emptyEntries ? [] : [entry, { ...entry, id: 'owned', name: 'plugin-agent', owner: '插件：fixture@market', readOnly: true }, conflicted], fail: false, releaseScan: null as (() => void) | null };
    const snapshot = (target: any) => ({ target, capability: { version: '2.1.287', supported: true, format: 'markdown', template: entry.content, detail: '下一次委派加载' }, entries: state.entries, baseline: 'fixture-baseline', detail: '原生定义管理' });
    Object.assign(window, { isTauri: true, agentsHarness: state, __TAURI_INTERNALS__: { invoke: async (command: string, args: any) => {
      state.calls.push({ command, args });
      if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['claude_code'], theme: 'system' }, tools: [{ id: 'claude_code', name: 'Claude Code' }] };
      if (command === 'list_cli_adapters') return { registered: [{ id: 'claude_code', name: 'Claude Code', interfaceFormats: ['anthropic_messages'], login: { hint: '原生登录' } }], managedIds: ['claude_code'], preservedUnknown: [] };
      if (['list_projects', 'list_usage_queries', 'list_usage_cache'].includes(command)) return [];
      if (command === 'list_accounts') return [{ id: 'a1', toolId: 'claude_code', label: 'Fixture account', context: { id: 'ctx-fixture' }, retiredContexts: [] }];
      if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
      if (command === 'get_tray_status') return { available: false, error: null };
      if (command.startsWith('plugin:event|')) return 1;
      if (command === 'get_registered_tool_workspace') return { probe: { tool: 'claude_code', selectedPath: 'C:/claude.cmd', installations: [], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' }, interfaceFormats: ['anthropic_messages'], providerPresets: [], dependencies: [] }, profiles: [], effectiveContextId: 'ctx-fixture', binding: null, snapshots: [], common: null, customPath: null, recoveryNeeded: [] };
      if (command === 'scan_native_agents') { if (holdScan) await new Promise<void>(resolve => { state.releaseScan = resolve; }); return snapshot(args.target); }
      if (command === 'operate_native_agent') {
        const req = args.request;
        if (req.target.contextId !== 'ctx-fixture' || req.baseline !== 'fixture-baseline') throw { message: '目标或基线错误' };
        if (state.fail) throw { message: '定义已被外部修改，请重新扫描；草稿仍保留' };
        if (req.action === 'create') state.entries.push({ ...entry, id: req.name, name: req.name, content: req.content });
        if (req.action === 'save') state.entries.find(item => item.id === req.id)!.content = req.content;
        if (req.action === 'disable' || req.action === 'enable') state.entries.find(item => item.id === req.id)!.enabled = req.action === 'enable';
        if (req.action === 'delete') state.entries = state.entries.filter(item => item.id !== req.id);
        return { transactionId: 'tx-1', changedPaths: ['/fixture/agents/reviewer.md'], restorePath: '/fixture/agents/reviewer.md', detail: '已修改原生定义；现有会话加载未验证', snapshot: snapshot(req.target) };
      }
      return null;
    } } });
  }, { holdScan, emptyEntries });
  await page.goto('/'); await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  if (!holdScan && !emptyEntries) await expect(page.getByText('reviewer', { exact: true })).toBeVisible();
}

test('first load shows skeleton rows with status semantics until the agent scan returns', async ({ page }) => {
  await setup(page, true);
  const skeleton = page.locator('[role="status"] .skeleton-page');
  await expect(skeleton).toBeVisible();
  await expect(skeleton).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByText('reviewer', { exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as any).agentsHarness.releaseScan());
  await expect(page.getByText('reviewer', { exact: true })).toBeVisible();
  await expect(skeleton).toHaveCount(0);
});

test('empty agent workspace offers one create action that opens the definition editor', async ({ page }) => {
  await setup(page, false, true);
  const emptyState = page.locator('.empty-state');
  await expect(emptyState).toBeVisible();
  await expect(emptyState.getByRole('button')).toHaveCount(1);
  await emptyState.getByRole('button', { name: '创建定义' }).click();
  await expect(page.getByText('新建 / 导入定义')).toBeVisible();
  await expect(page.getByLabel('Agent 文件名')).toBeVisible();
});


test('definition edit import lifecycle keeps context and package ownership', async ({ page }) => {
  await setup(page);
  const card = page.getByRole('listitem').filter({ has: page.getByText('reviewer', { exact: true }) });
  const owned = page.getByRole('listitem').filter({ has: page.getByText('plugin-agent', { exact: true }) });
  await expect(owned.getByRole('button', { name: '禁用' })).toBeDisabled();
  await expect(owned.getByRole('button', { name: '删除' })).toBeDisabled();
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '原生 Agent 定义', exact: true });
  await expect(editor).toContainText('custom: preserved');
  await editor.fill('---\nname: reviewer\ndescription: Updated\ncustom: preserved\n---\nReview carefully.');
  await page.screenshot({ path: 'test-results/native-agents-editor.png', fullPage: true });
  await page.getByRole('button', { name: '保存定义' }).click();
  await card.getByRole('button', { name: '禁用', exact: true }).click(); await expect(card.getByRole('button', { name: '启用', exact: true })).toBeVisible();
  await card.getByRole('button', { name: '启用', exact: true }).click();
  await page.getByLabel('导入原生 agent 文件').setInputFiles({ name: 'imported.md', mimeType: 'text/markdown', buffer: Buffer.from('---\nname: imported\ndescription: Imported\n---\nPrompt') });
  await expect(page.getByLabel('Agent 文件名')).toHaveValue('imported'); await page.getByRole('button', { name: '保存定义' }).click();
  await expect(page.getByText('imported', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/native-agents.png', fullPage: true });
  await card.getByRole('button', { name: '删除', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByText('reviewer', { exact: true })).toHaveCount(0);
  const actions = await page.evaluate(() => (window as any).agentsHarness.calls.filter((c: any) => c.command === 'operate_native_agent').map((c: any) => c.args.request.action));
  expect(actions).toEqual(['save', 'disable', 'enable', 'create', 'delete']);
});

test('external conflict preserves draft and navigating prompts before discarding', { tag: '@integration' }, async ({ page }) => {
  await setup(page);
  await page.getByRole('listitem').filter({ has: page.getByText('reviewer', { exact: true }) }).getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '原生 Agent 定义', exact: true }); await editor.fill('unsaved draft');
  await page.evaluate(() => { (window as any).agentsHarness.fail = true; });
  await page.getByRole('button', { name: '保存定义' }).click(); await expect(page.getByRole('alert')).toContainText('外部修改'); await expect(editor).toContainText('unsaved draft');
  await page.getByRole('tab', { name: '配置', exact: true }).click(); await expect(page.getByRole('dialog')).toContainText('尚未保存');
  await page.getByRole('dialog').getByRole('button', { name: '取消' }).click(); await expect(editor).toContainText('unsaved draft');
});

test('synonym coexistence entries stay listed with the conflict reason and no write actions', async ({ page }) => {
  await setup(page);
  const card = page.getByRole('listitem').filter({ has: page.getByText('planner', { exact: true }) });
  await expect(page.getByText('planner', { exact: true })).toBeVisible();
  await card.getByText('定义详情').click();
  await expect(card.getByText(/同义并存/)).toBeVisible();
  await expect(card.getByRole('button', { name: '禁用', exact: true })).toBeDisabled();
  await expect(card.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
  const actions = await page.evaluate(() => (window as any).agentsHarness.calls.filter((c: any) => c.command === 'operate_native_agent').map((c: any) => c.args.request.action));
  expect(actions).toEqual([]);
});
