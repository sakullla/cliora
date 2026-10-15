import { expect, test } from '@playwright/test';

test('library category is edited and filtered as tags', async ({ page }) => {
  await page.addInitScript(() => {
    const library = [{ id: 'rule-1', kind: 'rule', title: '已有规则', body: '正文', category: '开发,写作', projectId: null, version: 1, updatedAt: 1 }];
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], nativeConfig: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'list_projects') return [];
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_library_items') return library.filter((item) => item.kind === args.kind);
          if (command === 'save_library_item') {
            const draft = args.draft;
            const item = { ...draft, id: draft.id ?? `item-${library.length + 1}`, version: (draft.expectedVersion ?? 0) + 1, updatedAt: 1, projectId: draft.projectId ?? null };
            const index = library.findIndex((old) => old.id === item.id);
            if (index < 0) library.push(item); else library[index] = item;
            return item;
          }
          if (command === 'read_native_rule') return { text: '', path: '' };
          return null;
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('tab', { name: '长期规则' }).click();
  const firstCard = page.getByRole('article').filter({ has: page.getByRole('button', { name: '已有规则', exact: true }) });
  await expect(firstCard.getByText('开发', { exact: true })).toBeVisible();
  await expect(firstCard.getByText('写作', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建规则' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('标题')).toBeVisible();
  await expect(dialog.getByLabel('分类')).toHaveCount(0);
  await dialog.getByRole('button', { name: '开发' }).click();
  await dialog.getByLabel('添加标签').fill('文档');
  await dialog.getByLabel('添加标签').press('Enter');
  await expect(dialog.getByRole('button', { name: '开发 ×' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '文档 ×' })).toBeVisible();
  await dialog.getByRole('button', { name: '开发 ×' }).click();
  await expect(dialog.getByRole('button', { name: '开发 ×' })).toHaveCount(0);
  await dialog.getByLabel('标题').fill('发布检查');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发布检查' })).toBeVisible();
  const savedCard = page.getByRole('article').filter({ has: page.getByRole('button', { name: '发布检查', exact: true }) });
  await expect(savedCard.getByText('文档', { exact: true })).toBeVisible();
  await expect(savedCard.getByRole('group', { name: '发布检查 的 CLI · 全局', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '标签筛选' }).click();
  await page.getByRole('option', { name: '写作' }).click();
  await expect(page.getByRole('button', { name: '已有规则' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发布检查' })).toHaveCount(0);
});

test('library search debounces native queries, clears instantly and counts hits', async ({ page }) => {
  await page.addInitScript(() => {
    const library = [
      { id: 'prompt-a', kind: 'prompt', title: 'release note', body: 'body', category: '', projectId: null, version: 1, updatedAt: 1 },
      { id: 'prompt-b', kind: 'prompt', title: 'code review', body: 'body', category: '', projectId: null, version: 1, updatedAt: 1 },
      { id: 'prompt-c', kind: 'prompt', title: 'retro list', body: 'body', category: '', projectId: null, version: 1, updatedAt: 1 },
    ];
    const searches: string[] = [];
    Object.assign(window, {
      isTauri: true,
      __librarySearches: searches,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], nativeConfig: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'list_projects') return [];
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_mcp_definitions' || command === 'list_skill_packages') return [];
          if (command === 'list_library_items') {
            if (args.kind === 'prompt') searches.push(String(args.search ?? ''));
            return library.filter((item) => item.kind === args.kind && (!args.search || item.title.includes(args.search)));
          }
          return null;
        },
      },
    });
  });
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await expect(page.getByRole('button', { name: 'release note', exact: true })).toBeVisible();
  await expect(page.getByText('命中 3 / 共 3')).toBeVisible();
  const countQueries = (value: string) => page.evaluate((needle) => {
    const queries = (window as typeof window & { __librarySearches: string[] }).__librarySearches;
    return queries.filter((item) => item === needle).length;
  }, value);
  const lastQuery = () => page.evaluate(() => (window as typeof window & { __librarySearches: string[] }).__librarySearches.at(-1));
  // Freeze the clock with a margin: pauseAt must target the future, and the fake clock can
  // sit a few milliseconds ahead of wall time when the command is processed.
  await page.clock.pauseAt(Date.now() + 1000);
  await page.getByLabel('搜索资料').pressSequentially('rev', { delay: 40 });
  // Fast typing stays inside the debounce window: no native query for any prefix.
  expect(await countQueries('r')).toBe(0);
  expect(await countQueries('re')).toBe(0);
  expect(await countQueries('rev')).toBe(0);
  await page.clock.fastForward(179);
  expect(await countQueries('rev')).toBe(0);
  await page.clock.fastForward(2);
  // All keystrokes merged into a single query with the full input; the last key was not swallowed.
  expect(await countQueries('r')).toBe(0);
  expect(await countQueries('re')).toBe(0);
  expect(await countQueries('rev')).toBe(1);
  await expect(page.getByRole('button', { name: 'release note', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'code review', exact: true })).toBeVisible();
  await expect(page.getByText('命中 1 / 共 3')).toBeVisible();
  // Re-freeze at the page's (already fast-forwarded) virtual time instead of wall time,
  // which may now be behind the fake clock; the small margin covers the round trip.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.getByRole('button', { name: '清空搜索' }).click();
  // Clearing bypasses the debounce: the full-list query runs on the next tick instead of waiting 180ms.
  await page.clock.runFor(10);
  expect(await countQueries('rev')).toBe(1);
  expect(await lastQuery()).toBe('');
  await expect(page.getByRole('button', { name: 'release note', exact: true })).toBeVisible();
  await expect(page.getByText('命中 3 / 共 3')).toBeVisible();
});
