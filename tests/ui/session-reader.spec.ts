import { expect, test } from '@playwright/test';

test('large session lists render progressively and keyboard End reaches the final record', { tag: '@integration' }, async ({ page }) => {
  await page.evaluate(() => {
    const records = (window as any).__readerRecords;
    for (let i = 0; i < 1000; i++) records.push({ ...records[0], id: `large-${i}`, title: `历史会话 ${i}`, updatedAt: 1700000000000 - i });
  });
  await page.getByRole('button', { name: '刷新本机记录' }).click();
  const rows = page.getByLabel('会话列表').locator('button[data-session-id]');
  await expect(rows).toHaveCount(80);
  await rows.first().focus();
  await page.keyboard.press('End');
  await expect(page.locator('[data-session-id="large-999"]')).toBeFocused();
  await expect(page.getByRole('heading', { name: '历史会话 999', exact: true })).toBeVisible();
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const control = { failDetail: false, copied: [] as string[], filters: [] as Array<Record<string, unknown>> };
    const messages = [
      { id: 'm1', role: 'user', text: '请检查缓存策略', timestamp: 1790668800000 },
      { id: 'm2', role: 'assistant', text: '## 检查结果\n\n**缓存**可以复用。\n\n```typescript\nconst cached = true;\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 缓存 | 正常 |\n\n![外部图片](https://example.test/private.png)\n\n<script>window.__unsafe = true</script>', timestamp: 1790668801000 },
      { id: 'm3', role: 'user', text: '请补充回归测试', timestamp: 1790668802000 },
      { id: 'm4', role: 'assistant', text: '缓存回归测试通过。\n' + '长消息中的内容需要保留。'.repeat(200) + '\nEND_OF_MESSAGE', timestamp: 1790668803000 },
    ];
    const records = [
      { id: 'a', toolId: 'codex', nativeId: 'a', title: '检查缓存策略', cwd: 'C:\\demo', model: 'gpt-6-astra', projectId: null, startedAt: 1790668800000, updatedAt: 1790668800000, favorite: false, partial: false, stale: false, messageCount: 4, usageCount: 1 },
      { id: 'b', toolId: 'codex', nativeId: 'b', title: '完善文档', cwd: 'C:\\demo', model: null, projectId: null, startedAt: 1790668700000, updatedAt: 1790668700000, favorite: false, partial: false, stale: false, messageCount: 20, usageCount: 0 },
    ];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { control.copied.push(value); } } });
    Object.assign(window, {
      isTauri: true, __reader: control, __readerRecords: records, __readerMessages: messages,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', yoloAvailable: false }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_history_prices' || command === 'refresh_history') return [];
        if (command === 'list_history_sessions') { control.filters.push(args.filter); return structuredClone(records); }
        if (command === 'get_history_session') {
          if (control.failDetail) { control.failDetail = false; throw new Error('读取暂时失败'); }
          return structuredClone({ session: records.find((item) => item.id === args.id), messages: args.id === 'a' ? messages : [{ ...messages[0], text: '文档正文' }], usage: [], resumeReason: null });
        }
        if (command === 'copy_history_resume_command') return `codex resume ${args.id}`;
        if (command === 'get_tray_status') return { available: false, error: null };
        return null;
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '使用记录' }).click();
  await expect(page.getByLabel('会话正文')).toBeVisible();
});

test('reader renders Markdown, copies code, expands full messages and preserves raw text', async ({ page }) => {
  const reader = page.getByLabel('会话正文');
  await expect(reader.getByRole('heading', { name: '检查结果' })).toBeVisible();
  await expect(reader.getByRole('table')).toBeVisible();
  await expect(reader.locator('img[src^="http"]')).toHaveCount(0);
  await expect(reader.getByText('图片：外部图片')).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { __unsafe?: boolean }).__unsafe)).toBeUndefined();
  await reader.getByRole('button', { name: '复制代码', exact: true }).click();
  expect(await page.evaluate(() => (window as typeof window & { __reader: { copied: string[] } }).__reader.copied)).toEqual(['const cached = true;\n']);
  await reader.getByRole('button', { name: /^展开全文/ }).click();
  await expect(reader.getByText(/END_OF_MESSAGE/)).toBeVisible();
  await reader.getByText('阅读', { exact: true }).click();
  await reader.getByRole('checkbox', { name: '显示原文', exact: true }).click();
  await expect(reader.getByRole('heading', { name: '检查结果' })).toHaveCount(0);
  await expect(reader).toContainText('## 检查结果');
});

test('find navigates matching messages, questions filter preserves context and latest reaches the end', async ({ page }) => {
  const reader = page.getByLabel('会话正文');
  await expect(reader.getByRole('textbox', { name: '查找本会话' })).toBeHidden();
  await reader.getByRole('button', { name: '查找本会话' }).click();
  await reader.getByRole('textbox', { name: '查找本会话' }).fill('缓存');
  await expect(reader.getByRole('status')).toHaveText('1 / 3 条');
  await expect(reader.locator('[data-current-match]')).toHaveAttribute('data-message-id', 'm1');
  await page.keyboard.press('Enter');
  await expect(reader.locator('[data-current-match]')).toHaveAttribute('data-message-id', 'm2');
  await expect(reader.locator('mark')).toHaveCount(4);
  await reader.getByText('阅读', { exact: true }).click();
  await reader.getByRole('checkbox', { name: '只看提问' }).click();
  await expect(reader.locator('article')).toHaveCount(2);
  await expect(reader.getByRole('status')).toHaveText('1 / 1 条');
  await reader.getByRole('textbox', { name: '查找本会话' }).fill('不存在的词');
  await expect(reader.getByRole('status')).toHaveText('无匹配');
  await expect(reader.getByRole('button', { name: '下一条匹配' })).toBeDisabled();
  await reader.getByRole('button', { name: '清空会话内查找' }).click();
  await reader.getByText('阅读', { exact: true }).click();
  await reader.getByRole('checkbox', { name: '只看提问' }).click();
  await reader.getByRole('button', { name: '最新', exact: true }).click();
  await expect(reader.locator('article').last()).toBeInViewport();
});

test('sorting follows keyboard order and failed detail can be retried', async ({ page }) => {
  await page.getByLabel('会话排序').selectOption('messages');
  const rows = page.getByLabel('会话列表').getByRole('button');
  await expect(rows.first()).toContainText('完善文档');
  await rows.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await page.evaluate(() => { (window as typeof window & { __reader: { failDetail: boolean } }).__reader.failDetail = true; });
  await rows.first().click();
  await expect(page.getByRole('alert')).toContainText('暂时无法打开会话');
  await expect(page.getByLabel('会话正文')).toHaveCount(0);
  await page.getByRole('button', { name: '重新加载会话' }).click();
  await expect(page.getByLabel('会话正文')).toContainText('文档正文');
});

test('refresh updates the open conversation, folds injected context and keeps it searchable', async ({ page }) => {
  await page.evaluate(() => {
    const data = window as unknown as {
      __readerRecords: Array<{ title: string; messageCount: number }>;
      __readerMessages: Array<{ id: string; role: string; text: string; timestamp: number; kind?: string }>;
    };
    data.__readerRecords[0].title = '请检查缓存策略';
    data.__readerRecords[0].messageCount = 6;
    data.__readerMessages.unshift({ id: 'context', role: 'user', kind: 'project_context', text: '# AGENTS.md instructions for C:\\demo\n\n<INSTRUCTIONS>\nPROJECT_RULE_SENTINEL\n</INSTRUCTIONS>', timestamp: 1790668799000 });
    data.__readerMessages.push({ id: 'ordinary', role: 'user', text: '请修改 AGENTS.md 的文档说明', timestamp: 1790668804000 });
  });
  await page.getByRole('button', { name: '刷新本机记录' }).click();
  const reader = page.getByLabel('会话正文');
  await expect(reader).toContainText('6 条消息');
  await expect(page.getByRole('heading', { name: '请检查缓存策略', exact: true })).toBeVisible();
  await expect(page.getByLabel('会话列表').getByRole('button').first()).toContainText('请检查缓存策略');
  await expect(reader.getByText('PROJECT_RULE_SENTINEL', { exact: false })).toHaveCount(0);
  await expect(reader.getByText('请修改 AGENTS.md 的文档说明', { exact: true })).toBeVisible();
  await reader.getByRole('button', { name: '项目说明 展开' }).click();
  await expect(reader).toContainText('PROJECT_RULE_SENTINEL');
  await reader.getByRole('button', { name: '收起项目上下文' }).click();
  await reader.getByRole('button', { name: '查找本会话' }).click();
  await reader.getByRole('textbox', { name: '查找本会话' }).fill('PROJECT_RULE_SENTINEL');
  await expect(reader.locator('mark')).toHaveText('PROJECT_RULE_SENTINEL');
  await page.keyboard.press('Escape');
  await expect(reader.getByRole('textbox', { name: '查找本会话' })).toBeHidden();
  await expect(reader.getByRole('button', { name: '查找本会话' })).toBeFocused();
});

test('custom dates apply atomically, normalize reversed dates and support keyboard selection', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-02T12:00:00'));
  await page.getByText('筛选', { exact: true }).click();
  await page.getByRole('button', { name: '自定义', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '自定义时间范围' });
  await expect(dialog.locator('input[type="date"]')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '应用范围' })).toBeDisabled();
  await dialog.getByRole('button', { name: '2026-10-05', exact: true }).click();
  await dialog.getByRole('button', { name: '2026-10-02', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('已选择 4 天');
  await dialog.getByRole('button', { name: '应用范围' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __reader: { filters: Array<{ fromMs: number; toMs: number }> } }).__reader.filters.at(-1))).toMatchObject({ fromMs: new Date('2026-10-02T00:00:00').getTime(), toMs: new Date('2026-10-06T00:00:00').getTime() });
  await page.getByRole('button', { name: '自定义', exact: true }).click();
  await dialog.getByRole('button', { name: '2026-10-31', exact: true }).click();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('button', { name: '2026-11-01', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('status')).toHaveText('已选择 2 天');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('button', { name: '2026/10/02 — 2026/10/05', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 640, height: 700 });
  await page.getByRole('button', { name: '自定义', exact: true }).click();
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(640);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: '自定义', exact: true })).toBeFocused();
});

test('long conversations defer distant Markdown and render it when jumping to latest', async ({ page }) => {
  await page.evaluate(() => {
    const data = window as unknown as { __readerMessages: Array<{ id: string; role: string; text: string; timestamp: number }> };
    for (let index = 0; index < 160; index++) data.__readerMessages.push({ id: `long-${index}`, role: 'assistant', text: `## Result ${index}\n\n` + 'Performance fixture. '.repeat(100), timestamp: 1790668900000 + index * 1000 });
  });
  await page.getByRole('button', { name: '刷新本机记录' }).click();
  const reader = page.getByLabel('会话正文');
  await expect(reader).toContainText('164 条消息');
  await expect(reader.getByRole('heading', { name: 'Result 159', exact: true })).toHaveCount(0);
  await reader.getByRole('button', { name: '最新', exact: true }).click();
  await expect(reader.getByRole('heading', { name: 'Result 159', exact: true })).toBeVisible();
});
