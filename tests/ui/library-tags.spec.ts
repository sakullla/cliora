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
  // Focus draws one ring: on the tag field's frame, not a second one on the input inside it.
  await dialog.getByLabel('添加标签').focus();
  const rings = await dialog.getByLabel('添加标签').evaluate((input) => {
    const ring = (el: Element) => { const style = getComputedStyle(el); return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0; };
    return { input: ring(input), frame: ring(input.closest('[data-field-frame]')!) };
  });
  expect(rings).toEqual({ input: false, frame: true });
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

test('library keeps four tabs, one primary action, and every prompt card in the first screen', async ({ page }) => {
  await page.addInitScript(() => {
    const body = '检查代码变更是否正确、安全、易于维护。先说明影响用户的行为，再给出具体文件和可执行的建议。优先指出会导致故障的问题。';
    const library = [
      { id: 'prompt-1', kind: 'prompt', title: '代码审查', body, category: '开发', projectId: null, version: 1, updatedAt: 1790758800 },
      { id: 'prompt-2', kind: 'prompt', title: '整理发布说明', body, category: '写作', projectId: null, version: 1, updatedAt: 1790672400 },
      { id: 'prompt-3', kind: 'prompt', title: '排查问题', body, category: '开发', projectId: 'cliora', version: 1, updatedAt: 1790589600 },
      { id: 'prompt-4', kind: 'prompt', title: '解释一段代码', body, category: '学习', projectId: null, version: 1, updatedAt: 1790416800 },
    ];
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], nativeConfig: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'list_projects') return [{ id: 'cliora', name: 'cliora', path: '/tmp/cliora', available: true, preferredTool: 'codex', modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} }];
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_mcp_definitions' || command === 'list_skill_packages' || command === 'list_rule_placements') return [];
          if (command === 'list_library_items') return library.filter((item) => item.kind === args.kind);
          return null;
        },
      },
    });
  });
  await page.setViewportSize({ width: 1360, height: 1000 });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库', exact: true }).click();
  await expect(page.getByRole('button', { name: '代码审查', exact: true })).toBeVisible();
  const tabs = page.getByRole('tablist', { name: '资料类型' });
  await expect(tabs.getByRole('tab')).toHaveCount(4);
  const create = page.getByRole('button', { name: '新建提示词', exact: true });
  await expect(create).toHaveAttribute('data-variant', 'primary');
  const toolbar = page.locator('[data-toolbar]').filter({ has: tabs });
  await expect(toolbar.locator('[data-variant="primary"]')).toHaveCount(1);
  for (const card of await page.getByRole('article').all()) await expect(card.locator('[data-variant="primary"]')).toHaveCount(0);
  // Same first-screen rule as capture-ui --measure (02 ADR-0): the baseline 资料库 value is 4.
  const visible = await page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return 0;
    const inside = (node: Element) => {
      const box = node.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0 || box.top < 0 || box.left < 0 || box.bottom > innerHeight || box.right > innerWidth) return false;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        const clip = parent.getBoundingClientRect();
        if (box.top < clip.top - 0.5 || box.bottom > clip.bottom + 0.5 || box.left < clip.left - 0.5 || box.right > clip.right + 0.5) return false;
      }
      return true;
    };
    const nodes = new Set(main.querySelectorAll('[data-tool-row], [data-project-id], [data-profile-id], article, li, [role="row"], [role="listitem"]'));
    return [...nodes].filter(inside).length;
  });
  expect(visible).toBeGreaterThanOrEqual(4);
  await page.getByRole('tab', { name: 'MCP', exact: true }).click();
  await expect(page.getByRole('button', { name: '新建 MCP', exact: true })).toHaveAttribute('data-variant', 'primary');
  await expect(toolbar.locator('[data-variant="primary"]')).toHaveCount(1);
});
