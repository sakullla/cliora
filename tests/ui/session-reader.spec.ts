import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const control = { failDetail: false, copied: [] as string[] };
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
      isTauri: true, __reader: control,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', yoloAvailable: false }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_history_prices' || command === 'refresh_history') return [];
        if (command === 'list_history_sessions') return records;
        if (command === 'get_history_session') {
          if (control.failDetail) { control.failDetail = false; throw new Error('读取暂时失败'); }
          return { session: records.find((item) => item.id === args.id), messages: args.id === 'a' ? messages : [{ ...messages[0], text: '文档正文' }], usage: [], resumeReason: null };
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
  await reader.getByRole('button', { name: '原文', exact: true }).click();
  await expect(reader.getByRole('heading', { name: '检查结果' })).toHaveCount(0);
  await expect(reader).toContainText('## 检查结果');
});

test('find navigates matching messages, questions filter preserves context and latest reaches the end', async ({ page }) => {
  const reader = page.getByLabel('会话正文');
  await reader.getByRole('textbox', { name: '查找本会话' }).fill('缓存');
  await expect(reader.getByRole('status')).toHaveText('1 / 3 条');
  await expect(reader.locator('[data-current-match]')).toHaveAttribute('data-message-id', 'm1');
  await page.keyboard.press('Enter');
  await expect(reader.locator('[data-current-match]')).toHaveAttribute('data-message-id', 'm2');
  await expect(reader.locator('mark')).toHaveCount(4);
  await reader.getByRole('button', { name: '只看提问' }).click();
  await expect(reader.locator('article')).toHaveCount(2);
  await expect(reader.getByRole('status')).toHaveText('1 / 1 条');
  await reader.getByRole('textbox', { name: '查找本会话' }).fill('不存在的词');
  await expect(reader.getByRole('status')).toHaveText('无匹配');
  await expect(reader.getByRole('button', { name: '下一条匹配' })).toBeDisabled();
  await reader.getByRole('button', { name: '清空会话内查找' }).click();
  await reader.getByRole('button', { name: '只看提问' }).click();
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
