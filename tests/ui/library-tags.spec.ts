import { expect, test, type Page } from '@playwright/test';

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
          if (command === 'list_rule_placements') return [];
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
  await expect(savedCard.getByRole('group', { name: '发布检查 的复用操作', exact: true })).toBeVisible();
  await expect(page.locator('[data-library-context]')).toContainText('长期规则');
  await page.getByRole('button', { name: '标签筛选' }).click();
  await page.getByRole('option', { name: '写作' }).click();
  await expect(page.getByRole('button', { name: '已有规则' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发布检查' })).toHaveCount(0);
  // Ordinary reading does not reset the active filter; Escape returns to the same card title.
  const existing = page.getByRole('button', { name: '已有规则', exact: true });
  await existing.click();
  await expect(page.getByRole('dialog', { name: '修改规则' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(existing).toBeFocused();
  await expect(page.getByRole('button', { name: '标签筛选' })).toContainText('写作');
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


test('library rows lead with the title, name their source, and stay inside 640', async ({ page }) => {
  await page.addInitScript(() => {
    const library = [
      { id: 'prompt-long', kind: 'prompt', title: '超长提示词标题'.repeat(12), body: '先说明影响用户的行为，再给出具体文件和可执行的建议。'.repeat(6), category: '开发,写作,学习,复盘,发布,审查,文档,测试', projectId: null, version: 1, updatedAt: 1790758800 },
      { id: 'prompt-second', kind: 'prompt', title: '整理发布说明', body: '根据变更清单写一份简洁的发布说明。', category: '写作', projectId: null, version: 1, updatedAt: 1790672400 },
    ];
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], nativeConfig: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'list_projects' || command === 'list_rule_placements') return [];
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_mcp_definitions' || command === 'list_skill_packages') return [];
          if (command === 'list_library_items') return library.filter((item) => item.kind === args.kind);
          return null;
        },
      },
    });
  });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  const card = page.getByRole('article').filter({ hasText: '超长提示词标题' }).first();
  await expect(card).toHaveAttribute('data-source', 'global');
  // The card names where these items live, next to the result count.
  await expect(page.locator('[class*="resultNote"]').filter({ hasText: '本机资料库' })).toBeVisible();
  // Title and its actions share the first line; the summary and metadata follow it.
  expect(await card.evaluate((node) => {
    const head = node.firstElementChild as HTMLElement;
    const title = node.querySelector('[data-card-title]') as HTMLElement;
    const body = node.querySelector('p') as HTMLElement;
    const launch = [...node.querySelectorAll('button')].find((button) => (button.textContent ?? '').includes('启动会话')) as HTMLElement;
    return {
      titleInHead: head.contains(title),
      actionsInHead: head.contains(launch),
      bodyAfterHead: !!(head.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING),
      titleBeforeActions: !!(title.compareDocumentPosition(launch) & Node.DOCUMENT_POSITION_FOLLOWING),
    };
  })).toEqual({ titleInHead: true, actionsInHead: true, bodyAfterHead: true, titleBeforeActions: true });
  for (const width of [1360, 900, 640]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(card.getByRole('button', { name: '启动会话' })).toBeVisible();
    await expect(card.getByText('复盘', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), String(width)).toBeLessThanOrEqual(0);
    expect(await card.evaluate((node) => node.scrollWidth - node.clientWidth), String(width)).toBeLessThanOrEqual(1);
  }
});

test('library lists keep first failure, confirmed empty, no match and failed refresh apart', async ({ page }) => {
  await page.addInitScript(() => {
    const control = { fail: true, library: [] as Array<Record<string, unknown>> };
    Object.assign(window, {
      isTauri: true,
      __libraryControl: control,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], nativeConfig: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'list_projects' || command === 'list_rule_placements') return [];
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_mcp_definitions' || command === 'list_skill_packages') return [];
          if (command === 'list_library_items') {
            if (control.fail) throw { message: 'library fixture read denied' };
            return control.library.filter((item) => item.kind === args.kind && (!args.search || String(item.title).includes(args.search)));
          }
          return null;
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  const library = page.getByRole('region', { name: '资料库内容' });
  const promptTab = library.getByRole('tab', { name: /提示词/ });
  // First failure: an error with an in-place retry, never the empty library or a zero count.
  await expect(library.getByRole('heading', { name: '暂时无法读取提示词' })).toBeVisible();
  await expect(library.getByText('library fixture read denied')).toBeVisible();
  await expect(library.getByText('还没有提示词')).toHaveCount(0);
  await expect(library.getByText(/命中 \d+ \/ 共/)).toHaveCount(0);
  await expect(promptTab.locator('[data-count-state="unknown"]')).toHaveText('?');
  await page.evaluate(() => { (window as any).__libraryControl.fail = false; });
  await library.getByRole('button', { name: '重试读取' }).click();
  // A successful empty read is a confirmed empty list with its create action.
  await expect(library.getByRole('heading', { name: '还没有提示词' })).toBeVisible();
  await expect(library.getByRole('heading', { name: '暂时无法读取提示词' })).toHaveCount(0);
  await expect(promptTab.locator('[data-count-state]')).toHaveCount(0);
  await expect(promptTab).toContainText('0');
  // Rows added elsewhere appear on the next read.
  await page.evaluate(() => { (window as any).__libraryControl.library.push({ id: 'p-1', kind: 'prompt', title: 'release note', body: 'body', category: '', projectId: null, version: 1, updatedAt: 1 }); });
  await library.getByLabel('搜索资料').fill('release');
  await expect(library.getByRole('button', { name: 'release note', exact: true })).toBeVisible();
  // No match offers a direct way back to the full list.
  await library.getByLabel('搜索资料').fill('nothing');
  await expect(library.getByText('筛选结果为空，没有符合条件的提示词。请使用上方的「新建」。')).toBeVisible();
  await library.getByRole('button', { name: '清除筛选' }).click();
  await expect(library.getByLabel('搜索资料')).toHaveValue('');
  await expect(library.getByRole('button', { name: 'release note', exact: true })).toBeVisible();
  // A failed refresh keeps the rows on screen, marks them stale and retries in place.
  await page.evaluate(() => { (window as any).__libraryControl.fail = true; });
  await library.getByLabel('搜索资料').fill('rel');
  await expect(library.getByText('提示词列表刷新失败，当前显示上次成功读取的内容，可能已过期。')).toBeVisible();
  await expect(library.getByRole('button', { name: 'release note', exact: true })).toBeVisible();
  await expect(library.getByRole('heading', { name: '暂时无法读取提示词' })).toHaveCount(0);
  await expect(library.getByLabel('搜索资料')).toHaveValue('rel');
  await page.evaluate(() => { (window as any).__libraryControl.fail = false; });
  const retry = library.getByRole('button', { name: '重试读取' });
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(library.getByText('提示词列表刷新失败，当前显示上次成功读取的内容，可能已过期。')).toHaveCount(0);
  await expect(library.getByRole('button', { name: 'release note', exact: true })).toBeVisible();
  await expect(library.getByText('命中 1 / 共 1')).toBeVisible();
  // Rows of one kind never stand in for another kind while it loads or fails.
  await page.evaluate(() => { (window as any).__libraryControl.fail = true; });
  await library.getByRole('tab', { name: /长期规则/ }).click();
  await expect(library.getByRole('heading', { name: '暂时无法读取规则' })).toBeVisible();
  await expect(library.getByRole('button', { name: 'release note', exact: true })).toHaveCount(0);
});

/** One stored prompt; the first prompt read (the tab count read) fails once and the MCP count read fails until cleared. */
async function openCountLibrary(page: Page) {
  await page.addInitScript(() => {
    const control = { failPromptReads: 1, failMcp: true, fail: false, holdSkills: false, releaseSkills: null as null | (() => void), library: [{ id: 'p-1', kind: 'prompt', title: 'release note', body: 'body', category: '', projectId: null, version: 1, updatedAt: 1 }] as Array<Record<string, unknown>> };
    const seen = { skillFailure: false };
    new MutationObserver((records) => {
      for (const record of records) for (const node of Array.from(record.addedNodes)) if ((node.textContent ?? '').includes('暂时无法读取 Skill')) seen.skillFailure = true;
    }).observe(document, { childList: true, subtree: true });
    Object.assign(window, {
      isTauri: true,
      __libraryControl: control,
      __librarySeen: seen,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: Record<string, any> = {}) => {
          if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'light' }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
          if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', interfaceFormats: [], nativeConfig: { state: 'available', reason: '' }, resources: { state: 'available', reason: '' } }], managedIds: ['codex'], preservedUnknown: [] };
          if (command === 'list_projects' || command === 'list_rule_placements' || command === 'list_skill_installations') return [];
          if (command === 'get_launch_settings') return { selected: 'auto', terminals: [] };
          if (command === 'get_tray_status') return { available: false, error: null };
          if (command === 'list_mcp_definitions') { if (control.failMcp) throw { message: 'mcp count fixture denied' }; return []; }
          if (command === 'list_skill_packages') {
            if (control.holdSkills) { control.holdSkills = false; await new Promise<void>((resolve) => { control.releaseSkills = resolve; }); }
            return [{ id: 'pkg-1', name: 'code-review', description: 'Review fixture', compatibility: null, source: '/tmp/code-review', digest: 'd', fileCount: 1, updatedAt: 1, inLibrary: true }];
          }
          if (command === 'list_library_items') {
            if (args.kind === 'prompt' && control.failPromptReads > 0) { control.failPromptReads--; throw { message: 'prompt count fixture denied' }; }
            if (control.fail) throw { message: 'library fixture read denied' };
            return control.library.filter((item) => item.kind === args.kind && (!args.search || String(item.title).includes(args.search)));
          }
          return null;
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  const library = page.getByRole('region', { name: '资料库内容' });
  await expect(library.getByRole('button', { name: 'release note', exact: true })).toBeVisible();
  return { library, tabs: library.getByRole('tablist', { name: '资料类型' }) };
}

test('one failed count read marks only its own tab and a successful list read settles that tab', async ({ page }) => {
  const { tabs } = await openCountLibrary(page);
  await expect(tabs.getByRole('tab', { name: /MCP/ }).locator('[data-count-state="unknown"]')).toHaveText('?');
  await expect(tabs.getByRole('tab', { name: /长期规则/ }).locator('[data-count-state]')).toHaveCount(0);
  await expect(tabs.getByRole('tab', { name: /长期规则/ })).toContainText('0');
  await expect(tabs.getByRole('tab', { name: /Skill/ }).locator('[data-count-state]')).toHaveCount(0);
  await expect(tabs.getByRole('tab', { name: /Skill/ })).toContainText('1');
  // The prompt count read failed, but the unsearched prompt list then loaded: its badge is that list's size.
  const promptTab = tabs.getByRole('tab', { name: /提示词/ });
  await expect(promptTab.locator('[data-count-state]')).toHaveCount(0);
  await expect(promptTab).toContainText('1');
});

test('rows kept after a failed search refresh carry no hit count for the new term', async ({ page }) => {
  const { library } = await openCountLibrary(page);
  await expect(library.getByText('命中 1 / 共 1')).toBeVisible();
  await page.evaluate(() => { (window as any).__libraryControl.fail = true; });
  await library.getByLabel('搜索资料').fill('zzz-no-such-row');
  await expect(library.getByText('提示词列表刷新失败，当前显示上次成功读取的内容，可能已过期。')).toBeVisible();
  // The kept row belongs to the previous query and does not match this term.
  await expect(library.getByRole('button', { name: 'release note', exact: true })).toBeVisible();
  await expect(library.getByText(/命中 \d+ \/ 共/)).toHaveCount(0);
  await page.evaluate(() => { (window as any).__libraryControl.fail = false; });
  await library.getByRole('button', { name: '重试读取' }).click();
  await expect(library.getByText('提示词列表刷新失败，当前显示上次成功读取的内容，可能已过期。')).toHaveCount(0);
  await expect(library.getByRole('button', { name: 'release note', exact: true })).toHaveCount(0);
  await expect(library.getByText('命中 0 / 共 1')).toBeVisible();
  await expect(library.getByLabel('搜索资料')).toHaveValue('zzz-no-such-row');
});

test('the Skill section waits before its first read settles and never flashes the failure state', async ({ page }) => {
  const { library, tabs } = await openCountLibrary(page);
  await page.evaluate(() => { (window as any).__libraryControl.holdSkills = true; });
  await tabs.getByRole('tab', { name: /Skill/ }).click();
  await expect(library.getByRole('status', { name: '正在读取 Skill' })).toBeVisible();
  await page.evaluate(() => (window as any).__libraryControl.releaseSkills?.());
  await expect(library.getByRole('button', { name: 'code-review', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__librarySeen.skillFailure)).toBe(false);
});
