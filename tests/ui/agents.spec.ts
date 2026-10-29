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

function row(page: Page, name: string) {
  return page.getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) });
}

async function setup(page: Page, holdScan = false, emptyEntries = false, supported = true, longBody = false) {
  await page.addInitScript(({ holdScan, emptyEntries, supported, longBody }) => {
    const body = longBody ? Array.from({ length: 80 }, (_, index) => `## Step ${index + 1}\n\nReview code carefully.\n`).join('\n') : 'Review code.\n';
    const entry = { id: 'fixture', name: 'reviewer', description: 'Reviews code', path: '/fixture/agents/reviewer.md', format: 'markdown', content: `---\nname: reviewer\ndescription: Reviews code\ntools: Read\ncustom: preserved\n---\n${body}`, enabled: true, readOnly: false, owner: '独立定义', detail: '' };
    const conflicted = { ...entry, id: 'conflicted', name: 'planner', description: 'Plan', path: '/fixture/opencode.json', format: 'json', content: '{"description":"Plan"}', readOnly: true, detail: 'agent 与 agents 同义并存，原生形态冲突；请在原生配置统一为一种形态后再编辑' };
    const state = { calls: [] as any[], entries: emptyEntries ? [] : [entry, { ...entry, id: 'owned', name: 'plugin-agent', owner: '插件：fixture@market', readOnly: true }, conflicted], fail: false, releaseScan: null as (() => void) | null };
    const snapshot = (target: any) => ({ target, capability: { version: '2.1.287', supported, format: 'markdown', template: entry.content, detail: supported ? '下一次委派加载' : '此版本未证实统一的原生 agent 定义格式。' }, entries: supported ? state.entries : [], baseline: 'fixture-baseline', detail: supported ? '原生定义管理' : '规则与扩展可在各自入口管理。' });
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
  }, { holdScan, emptyEntries, supported, longBody });
  await page.goto('/'); await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '工具与连接' }).click();
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  if (!holdScan && !emptyEntries && supported) await expect(page.getByText('reviewer', { exact: true })).toBeVisible();
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
  const agents = page.getByRole('region', { name: '原生 Agent 定义管理' });
  await expect(agents.getByRole('heading', { name: 'Agent 定义', exact: true })).toHaveCount(0);
  await expect(agents.getByText('全局', { exact: true })).toHaveCount(0);
  await expect(agents.getByText('Fixture account')).toBeVisible();
  await expect(row(page, 'reviewer').getByRole('button', { name: '编辑', exact: true })).toHaveCount(0);
  await expect(row(page, 'reviewer').getByRole('button', { name: '禁用', exact: true })).toHaveCount(0);
  await expect(row(page, 'reviewer').getByRole('button', { name: '删除', exact: true })).toHaveCount(0);
  await row(page, 'plugin-agent').getByRole('button').click();
  const owned = page.getByRole('article', { name: 'plugin-agent' });
  await expect(owned.getByText('请通过所属插件或组织策略管理')).toBeVisible();
  await expect(owned.getByRole('button', { name: '保存定义' })).toHaveCount(0);
  await expect(owned.getByRole('switch', { name: '启用', exact: true })).toBeDisabled();
  await expect(owned.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
  await row(page, 'reviewer').getByRole('button').click();
  const card = page.getByRole('article', { name: 'reviewer' });
  await expect(page.getByRole('list', { name: 'Agent 定义' })).toBeVisible();
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '原生 Agent 定义', exact: true });
  await expect(editor).toContainText('custom: preserved');
  await editor.fill('---\nname: reviewer\ndescription: Updated\ncustom: preserved\n---\nReview carefully.');
  await page.screenshot({ path: 'test-results/native-agents-editor.png', fullPage: true });
  await page.getByRole('button', { name: '保存定义' }).click();
  await expect(page.getByRole('list', { name: 'Agent 定义' })).toBeVisible();
  await card.getByRole('switch', { name: '启用', exact: true }).click(); await expect(card.getByRole('switch', { name: '启用', exact: true })).toHaveAttribute('aria-checked', 'false');
  await card.getByRole('switch', { name: '启用', exact: true }).click(); await expect(card.getByRole('switch', { name: '启用', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByLabel('导入原生 agent 文件').setInputFiles({ name: 'imported.md', mimeType: 'text/markdown', buffer: Buffer.from('---\nname: imported\ndescription: Imported\n---\nPrompt') });
  await expect(page.getByLabel('Agent 文件名')).toHaveValue('imported'); await page.getByRole('button', { name: '保存定义' }).click();
  await expect(row(page, 'imported')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'imported', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/native-agents.png', fullPage: true });
  await row(page, 'reviewer').getByRole('button').click();
  await page.getByRole('article', { name: 'reviewer' }).getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByText('reviewer', { exact: true })).toHaveCount(0);
  const actions = await page.evaluate(() => (window as any).agentsHarness.calls.filter((c: any) => c.command === 'operate_native_agent').map((c: any) => c.args.request.action));
  expect(actions).toEqual(['save', 'disable', 'enable', 'create', 'delete']);
});

test('external conflict preserves draft and navigating prompts before discarding', { tag: '@integration' }, async ({ page }) => {
  await setup(page);
  await row(page, 'reviewer').getByRole('button').click();
  await page.getByRole('article', { name: 'reviewer' }).getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '原生 Agent 定义', exact: true }); await editor.fill('unsaved draft');
  await page.evaluate(() => { (window as any).agentsHarness.fail = true; });
  await page.getByRole('button', { name: '保存定义' }).click(); await expect(page.getByRole('alert')).toContainText('外部修改'); await expect(editor).toContainText('unsaved draft');
  await row(page, 'planner').getByRole('button').click(); await expect(page.getByRole('dialog')).toContainText('尚未保存');
  await page.getByRole('dialog').getByRole('button', { name: '取消' }).click(); await expect(editor).toContainText('unsaved draft');
  await page.getByRole('tab', { name: '配置', exact: true }).click(); await expect(page.getByRole('dialog')).toContainText('尚未保存');
  await page.getByRole('dialog').getByRole('button', { name: '取消' }).click(); await expect(editor).toContainText('unsaved draft');
});

test('synonym coexistence entries stay listed with the conflict reason and no write actions', async ({ page }) => {
  await setup(page);
  await expect(row(page, 'planner').getByRole('button', { name: '禁用', exact: true })).toHaveCount(0);
  await row(page, 'planner').getByRole('button').click();
  const card = page.getByRole('article', { name: 'planner' });
  await expect(row(page, 'planner')).toBeVisible();
  await expect(card.getByText(/同义并存/).first()).toBeVisible();
  await card.getByRole('button', { name: '定义详情' }).click();
  await expect(card.getByText(/同义并存/).first()).toBeVisible();
  await expect(card.getByRole('button', { name: '保存定义' })).toHaveCount(0);
  await expect(card.getByRole('switch', { name: '启用', exact: true })).toBeDisabled();
  await expect(card.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
  const actions = await page.evaluate(() => (window as any).agentsHarness.calls.filter((c: any) => c.command === 'operate_native_agent').map((c: any) => c.args.request.action));
  expect(actions).toEqual([]);
});

test('editing keeps the list beside the document and a narrow page can return', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await setup(page);
  await page.evaluate(() => {
    const entry = (window as any).agentsHarness.entries.find((item: { id: string }) => item.id === 'fixture');
    entry.description = 'Long body ready';
    entry.content = Array.from({ length: 80 }, (_, index) => `Agent line ${index + 1} stays in the document scroller.`).join('\n');
  });
  await page.getByRole('button', { name: '重新扫描' }).click();
  await expect(page.getByText('Long body ready')).toBeVisible();
  await row(page, 'reviewer').getByRole('button').click();
  const list = page.getByRole('list', { name: 'Agent 定义' });
  const article = page.getByRole('article', { name: 'reviewer' });
  const editor = page.getByRole('textbox', { name: '原生 Agent 定义', exact: true });
  await expect(article.getByRole('region', { name: 'Agent 定义预览' })).toContainText('Agent line 1');
  await article.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(editor).toContainText('Agent line 1');
  await expect(list).toBeVisible();
  const placed = await page.evaluate(() => {
    const listNode = document.querySelector('[aria-label="Agent 定义"]') as HTMLElement;
    const articleNode = document.querySelector('article') as HTMLElement;
    const header = articleNode.querySelector('h3')!.parentElement!.getBoundingClientRect();
    const scroller = articleNode.querySelector('.cm-scroller')!.getBoundingClientRect();
    const listBox = listNode.getBoundingClientRect();
    const articleBox = articleNode.getBoundingClientRect();
    const content = document.querySelector('.content') as HTMLElement;
    return {
      sideBySide: listBox.right <= articleBox.left + 2 && articleBox.top < listBox.bottom && listBox.top < articleBox.bottom,
      editorTaller: scroller.height > header.height,
      scrollTop: content.scrollTop,
      listTop: listBox.top,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
  expect(placed.sideBySide).toBe(true);
  expect(placed.editorTaller).toBe(true);
  expect(placed.scrollTop).toBe(0);
  expect(placed.overflow).toBe(false);
  const scroller = article.locator('.cm-scroller');
  const beforeScroll = await scroller.evaluate(node => node.scrollHeight > node.clientHeight + 40 && !node.textContent?.includes('Agent line 80'));
  expect(beforeScroll).toBe(true);
  await scroller.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect.poll(() => scroller.evaluate(node => {
    const line = [...node.querySelectorAll('.cm-line')].find(item => item.textContent?.includes('Agent line 80'));
    if (!line) return 0;
    const region = node.getBoundingClientRect();
    const box = line.getBoundingClientRect();
    return Math.min(box.bottom, region.bottom) - Math.max(box.top, region.top);
  })).toBeGreaterThan(12);
  const after = await page.evaluate(() => {
    const listNode = document.querySelector('[aria-label="Agent 定义"]') as HTMLElement;
    const content = document.querySelector('.content') as HTMLElement;
    return { scrollTop: content.scrollTop, listTop: listNode.getBoundingClientRect().top };
  });
  expect(after.scrollTop).toBe(0);
  expect(Math.abs(after.listTop - placed.listTop)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 640, height: 900 });
  await expect(list).toBeHidden();
  await expect(page.getByRole('button', { name: '返回列表' })).toBeVisible();
  await expect(article.getByRole('heading', { name: 'reviewer' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
  await page.getByRole('button', { name: '返回列表' }).click();
  await expect(list).toBeVisible();
  await expect(article).toBeHidden();
});

test('narrow list can restore after the last agent in scope is deleted', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 900 });
  await setup(page);
  await page.evaluate(() => {
    const state = (window as any).agentsHarness;
    state.entries = state.entries.filter((item: { id: string }) => item.id === 'fixture');
  });
  await page.getByRole('button', { name: '重新扫描' }).click();
  await expect(page.getByRole('listitem')).toHaveCount(1);
  await row(page, 'reviewer').getByRole('button').click();
  await page.getByRole('article', { name: 'reviewer' }).getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByRole('listitem')).toHaveCount(0);
  await expect(page.locator('.empty-state')).toBeVisible();
  const restore = page.getByRole('button', { name: '恢复上次操作' });
  await expect(restore).toHaveCount(1);
  await expect(restore).toBeVisible();
  await expect(restore).toBeEnabled();
  await expect(page.locator('[data-document-shell]')).toHaveAttribute('data-view', 'list');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
  await page.setViewportSize({ width: 1360, height: 900 });
  await expect(page.getByRole('button', { name: '恢复上次操作' })).toHaveCount(1);
  await expect(restore).toBeVisible();
  await restore.click();
  await page.getByRole('dialog').getByRole('button', { name: '恢复', exact: true }).click();
  const last = await page.evaluate(() => {
    const calls = (window as any).agentsHarness.calls.filter((call: any) => call.command === 'operate_native_agent');
    return calls.at(-1).args.request;
  });
  expect(last.action).toBe('restore');
  expect(last.id).toBe('/fixture/agents/reviewer.md');
  expect(last.transactionId).toBe('tx-1');
  expect(last.baseline).toBe('fixture-baseline');
  expect(last.target.contextId).toBe('ctx-fixture');
  expect(last.name).toBe('reviewer');
  expect(last.content).toContain('custom: preserved');
  await expect(page.getByRole('button', { name: '恢复上次操作' })).toHaveCount(0);
});

test('restore stays in the document and repeats the last operation payload', async ({ page }) => {
  await setup(page);
  await row(page, 'reviewer').getByRole('button').click();
  await page.getByRole('article', { name: 'reviewer' }).getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('textbox', { name: '原生 Agent 定义', exact: true }).fill('restored draft source');
  await page.getByRole('button', { name: '保存定义' }).click();
  const restore = page.getByRole('article', { name: 'reviewer' }).getByRole('button', { name: '恢复上次操作' });
  await expect(restore).toBeVisible();
  await expect(page.getByRole('list', { name: 'Agent 定义' }).getByRole('button', { name: '恢复上次操作' })).toHaveCount(0);
  await restore.click();
  await page.getByRole('dialog').getByRole('button', { name: '恢复', exact: true }).click();
  const last = await page.evaluate(() => {
    const calls = (window as any).agentsHarness.calls.filter((call: any) => call.command === 'operate_native_agent');
    return calls.at(-1).args.request;
  });
  expect(last.action).toBe('restore');
  expect(last.id).toBe('/fixture/agents/reviewer.md');
  expect(last.transactionId).toBe('tx-1');
  expect(last.baseline).toBe('fixture-baseline');
  expect(last.target.contextId).toBe('ctx-fixture');
  expect(last.name).toBe('reviewer');
  expect(last.content).toBe('restored draft source');
});

test('an unsupported CLI is marked unavailable and does not offer writes', async ({ page }) => {
  await setup(page, false, false, false);
  const agents = page.getByRole('region', { name: '原生 Agent 定义管理' });
  await expect(agents.getByText('暂不可用')).toBeVisible();
  await expect(agents.locator('.empty-state')).toContainText('此版本未证实统一的原生 agent 定义格式。');
  await expect(agents.getByRole('button', { name: '创建定义' })).toBeDisabled();
  await expect(agents.getByRole('button', { name: '导入定义' })).toBeDisabled();
  await expect(agents.locator('.empty-state').getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('listitem')).toHaveCount(0);
});

test('the workbench reads first, edits from the header, resizes, focuses, and walks rows with arrow keys', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await setup(page);
  await row(page, 'reviewer').getByRole('button').click();
  const list = page.getByRole('list', { name: 'Agent 定义' });
  const article = page.getByRole('article', { name: 'reviewer' });
  const preview = article.getByRole('region', { name: 'Agent 定义预览' });
  // Reading shows the description, the frontmatter fields, and the body; no editor yet.
  await expect(preview).toContainText('Reviews code');
  await expect(preview.getByRole('definition').filter({ hasText: 'preserved' })).toBeVisible();
  await expect(preview).toContainText('Review code.');
  await expect(page.getByRole('textbox', { name: '原生 Agent 定义', exact: true })).toHaveCount(0);
  await preview.dblclick();
  await expect(page.getByRole('textbox', { name: '原生 Agent 定义', exact: true })).toHaveCount(0);
  await article.getByRole('button', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '原生 Agent 定义', exact: true });
  await expect(editor).toBeVisible();
  await expect(article.getByRole('button', { name: '保存定义' })).toBeDisabled();
  // Switching back to reading keeps the draft and shows it.
  await editor.fill('---\nname: reviewer\ndescription: Draft summary\n---\nDraft body');
  await article.getByRole('button', { name: '阅读', exact: true }).click();
  await expect(preview).toContainText('Draft summary');
  await expect(article.getByText('有未保存的更改')).toBeVisible();
  await expect(article.getByRole('button', { name: '保存定义' })).toBeEnabled();
  await article.getByRole('button', { name: '关闭编辑' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '放弃修改' }).click();
  await expect(preview).toContainText('Reviews code');

  const before = (await list.boundingBox())!.width;
  const separator = page.getByRole('separator', { name: /调整列表宽度/ });
  await separator.focus();
  for (let index = 0; index < 4; index += 1) await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await list.boundingBox())!.width).toBeGreaterThan(before + 40);
  expect(Number(await page.evaluate(() => localStorage.getItem('cliora:document-list-width')))).toBeGreaterThan(320);

  const narrow = (await article.boundingBox())!.width;
  await article.getByRole('button', { name: '专注：隐藏列表' }).click();
  await expect(list).toBeHidden();
  expect((await article.boundingBox())!.width).toBeGreaterThan(narrow + 200);
  await article.getByRole('button', { name: '显示列表' }).click();
  await expect(list).toBeVisible();

  await row(page, 'reviewer').getByRole('button').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('article', { name: 'plugin-agent' })).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.getByRole('article', { name: 'planner' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
});

test('opening another agent starts its document at the top', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 800 });
  await setup(page, false, false, true, true);
  await row(page, 'reviewer').getByRole('button').click();
  const reader = page.getByRole('article', { name: 'reviewer' });
  await expect(reader).toContainText('Step 80');
  // The scroll position of the element that scrolls the reader; `to` sets it first.
  const scroller = (article: ReturnType<typeof page.getByRole>, to?: number) => article.evaluate((node, value) => {
    const scrolls = (item: Element) => item.scrollHeight > item.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(item).overflowY);
    const ancestors: Element[] = [];
    for (let item = node.parentElement; item; item = item.parentElement) ancestors.push(item);
    const element = [node, ...node.querySelectorAll('*'), ...ancestors].find(scrolls) as HTMLElement | undefined;
    if (!element) return -1;
    if (value !== undefined) element.scrollTop = value;
    return element.scrollTop;
  }, to);
  await expect.poll(() => scroller(reader, 600)).toBeGreaterThan(100);
  await row(page, 'plugin-agent').getByRole('button').click();
  const next = page.getByRole('article', { name: 'plugin-agent' });
  await expect(next).toContainText('Step 80');
  await expect.poll(() => scroller(next)).toBe(0);
});