import { expect, test } from '@playwright/test';

test('records only lists managed CLIs and scopes session reads to them', async ({ page }) => {
  await page.addInitScript(() => {
    const filters: Array<Record<string, unknown>> = [];
    Object.assign(window, {
      isTauri: true,
      __historyFilters: filters,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['claude_code'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }, { id: 'claude_code', name: 'Claude Code' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', yoloAvailable: true }, { id: 'claude_code', name: 'Claude Code', yoloAvailable: true }], managedIds: ['claude_code'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_history_prices' || command === 'refresh_history') return [];
        if (command === 'list_history_sessions') { filters.push(args.filter); return []; }
        if (command === 'get_history_usage') return { sessionCount: 0, usageSessions: 0, unknownUsageSessions: 0, partialSessions: 0, staleSessions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, inputIncludesCache: null, estimatedCost: null, currency: null, priceSources: [], models: [], byModel: [], scans: [] };
        if (command === 'get_history_scan_progress') return { running: false, toolId: '', completedSources: 0, totalSources: 0 };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        return null;
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '使用记录' }).click();
  await page.getByLabel('筛选工具').click();
  const list = page.getByRole('listbox', { name: '筛选工具' });
  await expect(list.getByRole('option')).toHaveCount(2);
  await expect(list.getByRole('option', { name: 'Claude Code' })).toBeVisible();
  await expect(list.getByRole('option', { name: 'Codex' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => {
    const filters = (window as typeof window & { __historyFilters: Array<{ tools?: string[] }> }).__historyFilters;
    return filters.length > 0 && JSON.stringify(filters[filters.length - 1].tools) === JSON.stringify(['claude_code']);
  })).toBe(true);
});

test('records keep search, show native resume command and only launch on request', async ({ page }) => {
  await page.addInitScript(() => {
    const records: Array<Record<string, any>> = [
      { id: 'record-a', toolId: 'codex', nativeId: '1111-2222', title: 'Review change', cwd: 'C:\\project', model: 'gpt-6-astra', projectId: null, startedAt: 1790668800000, updatedAt: 1790668800000, favorite: false, partial: false, stale: false, messageCount: 2, usageCount: 1 },
      { id: 'record-b', toolId: 'codex', nativeId: null, title: 'Incomplete record', cwd: null, model: null, projectId: null, startedAt: null, updatedAt: null, favorite: false, partial: true, stale: false, messageCount: 1, usageCount: 0 },
      ...Array.from({ length: 16 }, (_, index) => ({ id: `record-long-${index}`, toolId: 'codex', nativeId: null, title: `解决区域截图选择录屏没办法操作录取画面以及录屏控制栏看不到按钮只有取消 ${index}`, cwd: 'C:\\project', model: 'glm-5.3', projectId: null, startedAt: 1790668800000, updatedAt: 1790668800000 - index, favorite: false, partial: false, stale: false, messageCount: 1, usageCount: 0 })),
    ];
    const launches: Array<Record<string, unknown>> = [];
    const clipboard: string[] = [];
    const control = { delayYolo: false, pending: [] as Array<() => void> };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { clipboard.push(value); } } });
    Object.assign(window, {
      isTauri: true, __recordLaunches: launches, __recordClipboard: clipboard, __recordControl: control,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', yoloAvailable: true, interfaceFormats: [] }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects') return [{ id: 'project-new', name: 'New project', path: 'C:\\new-project', available: true, preferredTool: 'codex', lastOpened: 0, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {} }];
        if (command === 'refresh_history') return [{ toolId: 'codex', scannedAt: 1, sourceCount: 2, failedCount: 0, incomplete: false, detail: '' }];
        if (command === 'list_history_prices') return [];
        if (command === 'list_history_sessions') return records.filter((item) =>
          (!args.filter.search || item.title.toLowerCase().includes(args.filter.search.toLowerCase()))
          && (!args.filter.favoriteOnly || item.favorite));
        if (command === 'get_history_session') {
          const session = records.find((item) => item.id === args.id);
          return { session, messages: [{ id: 'm1', role: 'user', text: 'Review change', timestamp: 1790668800000 }, { id: 'm2', role: 'assistant', text: `Looks good.\n${'历史正文需要整栏滚动。'.repeat(70)}`, timestamp: 1790668801000 }], usage: [], resumeReason: session?.nativeId ? null : '原始记录没有可验证的恢复 ID' };
        }
        if (command === 'set_history_favorite') { const item = records.find((value) => value.id === args.id); if (item) item.favorite = args.favorite; return null; }
        if (command === 'set_history_project') { const item = records.find((value) => value.id === args.id); if (item) item.projectId = args.projectId; return null; }
        if (command === 'get_history_usage') return { sessionCount: 2, usageSessions: 1, unknownUsageSessions: 1, partialSessions: 1, staleSessions: 0, input: 150, output: 30, cacheRead: 60, cacheWrite: 0, inputIncludesCache: true, estimatedCost: null, currency: null, priceSources: [], models: ['gpt-6-astra'], byModel: [
          { toolId: 'codex', model: 'gpt-6-astra', sessionCount: 14, unknownUsageSessions: 0, input: 100, output: 20, cacheRead: 0, cacheWrite: 0, estimatedCost: null, currency: null },
          { toolId: 'codex', model: 'gpt-6-sol', sessionCount: 8, unknownUsageSessions: 1, input: 50, output: 10, cacheRead: 1, cacheWrite: 2, estimatedCost: null, currency: null },
          { toolId: 'codex', model: 'gpt-6-luna', sessionCount: 3, unknownUsageSessions: 0, input: 5, output: 1, cacheRead: 0, cacheWrite: 0, estimatedCost: null, currency: null },
        ], scans: [{ toolId: 'codex', scannedAt: 1, sourceCount: 2, failedCount: 0, incomplete: false, detail: '' }] };
        if (command === 'copy_history_resume_command') {
          const text = `Set-Location -LiteralPath '${records.find((item) => item.id === args.id)?.projectId ? 'C:\\new-project' : 'C:\\project'}'; & 'codex' ${args.mode === 'yolo' ? "'--yolo' " : ''}'resume' '1111-2222'`;
          if (args.mode === 'yolo' && control.delayYolo) return new Promise((resolve) => { control.pending.push(() => resolve(text)); });
          return text;
        }
        if (command === 'resume_history_session') { launches.push(args); return { toolId: 'codex', projectId: null, mode: args.mode, terminal: 'power_shell', status: 'terminal_requested' }; }
        if (command === 'get_tray_status') return { available: false, error: null };
        throw new Error(`Unexpected IPC: ${command}`);
      } },
    });
  });
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: '页面' });
  await navigation.getByRole('button', { name: '使用记录' }).click();
  await expect(page.getByRole('button', { name: /Review change/ })).toBeVisible();
  const listLayout = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('[aria-label="会话列表"] > button')];
    const boxes = buttons.map((button) => button.getBoundingClientRect());
    const overlaps = boxes.slice(1).filter((box, index) => box.top < boxes[index].bottom - 1).length;
    const title = buttons[2]?.querySelector('strong');
    const titleBox = title?.getBoundingClientRect();
    const lineHeight = title ? Number.parseFloat(getComputedStyle(title).lineHeight) : 0;
    return { count: buttons.length, overlaps, minHeight: Math.min(...boxes.map((box) => box.height)), titleLines: titleBox && lineHeight ? titleBox.height / lineHeight : 0 };
  });
  expect(listLayout.count).toBeGreaterThan(8);
  expect(listLayout.overlaps).toBe(0);
  expect(listLayout.minHeight).toBeGreaterThan(48);
  expect(listLayout.titleLines).toBeGreaterThan(1);
  expect(listLayout.titleLines).toBeLessThanOrEqual(2.05);
  const filterOrder = await page.evaluate(() => {
    const search = document.querySelector('[aria-label="搜索会话"]')?.closest('label');
    const tool = document.querySelector('[aria-label="筛选工具"]')?.closest('label');
    const favorite = [...document.querySelectorAll('label')].find((label) => label.textContent?.includes('只看收藏'));
    if (!search || !tool || !favorite) return null;
    const items = [search, tool, favorite];
    const documentOrder = items.every((item, index) => index === 0 || Boolean(items[index - 1].compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING));
    const boxes = items.map((item) => item.getBoundingClientRect());
    const visualOrder = boxes.every((box, index) => {
      if (index === 0) return true;
      const previous = boxes[index - 1];
      return Math.abs(box.top - previous.top) < 8 ? box.left >= previous.left : box.top >= previous.top;
    });
    return { documentOrder, visualOrder, orders: items.map((item) => getComputedStyle(item).order) };
  });
  expect(filterOrder).toEqual({ documentOrder: true, visualOrder: true, orders: ['0', '0', '0'] });
  await expect(page.getByLabel('原生恢复命令')).toContainText("'resume' '1111-2222'");
  const scrollSplit = await page.evaluate(() => {
    const list = document.querySelector('[aria-label="会话列表"]');
    const transcript = document.querySelector('[aria-label="会话正文"]');
    const detail = transcript?.parentElement;
    const command = document.querySelector('[aria-label="原生恢复命令"]');
    const main = document.getElementById('main');
    if (!list || !transcript || !detail || !command || !main || !(detail instanceof HTMLElement)) return null;
    const before = list.scrollTop;
    const commandTop = command.getBoundingClientRect().top;
    detail.scrollTop = detail.scrollHeight;
    const commandAfter = command.getBoundingClientRect().top;
    const scrolledAway = detail.scrollTop > 0 && commandAfter < commandTop && commandAfter < detail.getBoundingClientRect().top;
    detail.scrollTop = 0;
    transcript.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true }));
    return {
      main: getComputedStyle(main).overflowY,
      list: getComputedStyle(list).overflowY,
      detail: getComputedStyle(detail).overflowY,
      transcript: getComputedStyle(transcript).overflowY,
      chained: list.scrollTop !== before,
      scrolledAway,
    };
  });
  expect(scrollSplit).toEqual({ main: 'hidden', list: 'auto', detail: 'auto', transcript: 'visible', chained: false, scrolledAway: true });
  const resumeOutside = page.getByRole('button', { name: '在外部终端继续' });
  await expect(resumeOutside).toBeVisible();
  await expect(resumeOutside).toHaveClass(/primary/);
  const exportDetails = page.locator('details').filter({ has: page.getByText('导出与项目关联', { exact: true }) });
  await expect(exportDetails).toHaveCount(1);
  await expect(exportDetails).not.toHaveAttribute('open');
  await expect(exportDetails.getByRole('button', { name: '导出 Markdown' })).toBeHidden();
  expect(await resumeOutside.evaluate((button) => button.closest('details')?.querySelector('summary')?.textContent?.includes('导出与项目关联') ?? false)).toBe(false);
  await page.evaluate(() => { (window as typeof window & { __recordControl: { delayYolo: boolean } }).__recordControl.delayYolo = true; });
  await page.getByRole('combobox', { name: '恢复模式' }).selectOption('yolo');
  await expect(page.getByLabel('原生恢复命令')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '复制命令' })).toHaveCount(0);
  await page.getByRole('combobox', { name: '恢复模式' }).selectOption('normal');
  await page.evaluate(() => {
    const control = (window as typeof window & { __recordControl: { delayYolo: boolean; pending: Array<() => void> } }).__recordControl;
    control.delayYolo = false;
    control.pending.splice(0).forEach((resolve) => resolve());
  });
  await expect(page.getByLabel('原生恢复命令')).not.toContainText("'--yolo'");
  await page.getByRole('combobox', { name: '恢复模式' }).selectOption('yolo');
  await expect(page.getByLabel('原生恢复命令')).toContainText("'--yolo'");
  await page.getByText('导出与项目关联', { exact: true }).click();
  await page.getByRole('combobox', { name: '关联会话项目' }).selectOption('project-new');
  await expect(page.getByLabel('原生恢复命令')).toContainText('C:\\new-project');
  await page.getByRole('button', { name: '复制命令' }).click();
  expect(await page.evaluate(() => (window as typeof window & { __recordLaunches: unknown[] }).__recordLaunches)).toHaveLength(0);
  expect(await page.evaluate(() => (window as typeof window & { __recordClipboard: string[] }).__recordClipboard[0])).toContain("'--yolo'");
  await page.getByRole('button', { name: '在外部终端继续' }).click();
  expect(await page.evaluate(() => (window as typeof window & { __recordLaunches: Array<Record<string, unknown>> }).__recordLaunches)).toEqual([{ id: 'record-a', mode: 'yolo' }]);
  await page.getByRole('textbox', { name: '搜索会话' }).fill('Review');
  await navigation.getByRole('button', { name: '快速开始' }).click();
  await navigation.getByRole('button', { name: '使用记录' }).click();
  await expect(page.getByRole('textbox', { name: '搜索会话' })).toHaveValue('Review');
  await page.getByRole('tab', { name: '用量' }).click();
  const usageLayout = await page.evaluate(() => {
    const table = document.querySelector('[aria-label="按模型用量明细"]');
    const wrap = table?.parentElement;
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent === '设置估算价格');
    if (!table || !wrap || !button) return null;
    const tableBox = table.getBoundingClientRect();
    const wrapBox = wrap.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    return { wrapShowsTable: wrapBox.height >= tableBox.height - 1, buttonBelow: buttonBox.top >= wrapBox.bottom - 1, rows: table.querySelectorAll('tbody tr').length };
  });
  expect(usageLayout).toEqual({ wrapShowsTable: true, buttonBelow: true, rows: 3 });
  await expect(page.getByText('150', { exact: true })).toBeVisible();
  await expect(page.getByText('输入 token · 已知小计')).toBeVisible();
  await expect(page.getByText('估算费用', { exact: true }).locator('..').getByText('未知', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '设置估算价格' }).click();
  const priceDialog = page.getByRole('dialog', { name: '设置估算价格' });
  await expect(priceDialog.getByLabel('价格工具')).toBeVisible();
  await expect(priceDialog.getByRole('button', { name: '保存价格' })).toBeVisible();
});

test('usage composes token segments and the session list follows arrow keys', async ({ page }) => {
  await page.addInitScript(() => {
    const records = [
      { id: 'key-a', toolId: 'codex', nativeId: '1111', title: 'First session', cwd: 'C:\\project', model: 'gpt-6-astra', projectId: null, startedAt: 1790668800000, updatedAt: 1790668800000, favorite: false, partial: false, stale: false, messageCount: 1, usageCount: 1 },
      { id: 'key-b', toolId: 'codex', nativeId: '2222', title: 'Second session', cwd: 'C:\\project', model: 'gpt-6-astra', projectId: null, startedAt: 1790668700000, updatedAt: 1790668700000, favorite: false, partial: false, stale: false, messageCount: 1, usageCount: 1 },
    ];
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', yoloAvailable: false, interfaceFormats: [] }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_history_prices' || command === 'refresh_history') return [];
        if (command === 'list_history_sessions') return records;
        if (command === 'get_history_session') return { session: records.find((item) => item.id === args.id), messages: [], usage: [], resumeReason: '原始记录没有可验证的恢复 ID' };
        if (command === 'get_history_usage') return { sessionCount: 2, usageSessions: 2, unknownUsageSessions: 0, partialSessions: 0, staleSessions: 0, input: 150, output: 30, cacheRead: 60, cacheWrite: 0, inputIncludesCache: true, estimatedCost: null, currency: null, priceSources: [], models: ['gpt-6-astra'], byModel: [], scans: [] };
        if (command === 'get_history_scan_progress') return { running: false, toolId: '', completedSources: 0, totalSources: 0 };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        return null;
      } },
    });
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '使用记录' }).click();
  const first = page.getByRole('button', { name: /First session/ });
  const second = page.getByRole('button', { name: /Second session/ });
  await expect(first).toBeVisible();
  await first.focus();
  await page.keyboard.press('ArrowDown');
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Home');
  await expect(first).toBeFocused();
  await page.getByRole('tab', { name: '用量' }).click();
  const composition = page.getByRole('group', { name: 'token 构成' });
  await expect(composition).toBeVisible();
  await expect(composition).toContainText('180 · 已知小计');
  await expect(composition).toContainText('输入');
  await expect(composition).toContainText('缓存读取');
  await expect(composition).toContainText('50.0%');
});
