import { expect, test } from '@playwright/test';

type Totals = { requests: number; usageRecords: number; unknownRequestRecords: number; sessions: number; input: number; cacheRead: number; cacheWrite: number; output: number; total: number; cost: number | null; unpricedTokens: number };
const totals = (input: number, cacheRead: number, cacheWrite: number, output: number, extra: Partial<Totals> = {}): Totals => ({
  requests: 0, usageRecords: extra.requests ?? 0, unknownRequestRecords: 0, sessions: 0, input, cacheRead, cacheWrite, output, total: input + cacheRead + cacheWrite + output, cost: null, unpricedTokens: 0, ...extra,
});
const emptyReport = () => ({
  generatedAt: 0, from: null, to: null, bucket: 'day', currency: 'USD', totals: totals(0, 0, 0, 0), previous: null, timeline: [],
  byModel: [], byTool: [], byProject: [], topSessions: [], models: [], untimedRequests: 0, duplicateRequests: 0,
  partialSessions: 0, staleSessions: 0, mixedCurrency: false, latestEventAt: null, priceSources: [], scans: [],
});
/** Today's report: 24 hourly buckets with all usage at 09:00. */
function todayReport() {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const start = midnight.getTime();
  const hour = 3_600_000;
  const sum = totals(200_000, 900_000, 50_000, 50_000, { requests: 40, sessions: 2, cost: 1.5, unpricedTokens: 260_000 });
  return {
    ...emptyReport(), generatedAt: start + 10 * hour, from: start, to: start + 24 * hour, bucket: 'hour', totals: sum,
    previous: { from: start - 24 * hour, to: start - 14 * hour, totals: totals(100_000, 800_000, 50_000, 50_000, { requests: 30, sessions: 1, cost: 1 }) },
    timeline: Array.from({ length: 24 }, (_, index) => ({ start: start + index * hour, end: start + (index + 1) * hour, totals: index === 9 ? sum : totals(0, 0, 0, 0) })),
    byModel: [
      { key: 'codex\u001fgpt-6-astra', label: 'gpt-6-astra', toolId: 'codex', model: 'gpt-6-astra', projectId: null, priced: true, totals: totals(150_000, 700_000, 50_000, 40_000, { requests: 30, sessions: 2, cost: 1.5 }) },
      { key: 'codex\u001fglm-5.3', label: 'glm-5.3', toolId: 'codex', model: 'glm-5.3', projectId: null, priced: false, totals: totals(50_000, 200_000, 0, 10_000, { requests: 10, sessions: 1, unpricedTokens: 260_000 }) },
    ],
    byTool: [{ key: 'codex', label: 'codex', toolId: 'codex', model: null, projectId: null, priced: true, totals: sum }],
    byProject: [{ key: 'dir:c:\\project', label: 'project', toolId: null, model: null, projectId: null, priced: true, totals: sum }],
    topSessions: [{ id: 'key-b', toolId: 'codex', title: 'Second session', model: 'gpt-6-astra', updatedAt: start + 9 * hour, totals: sum }],
    models: ['glm-5.3', 'gpt-6-astra'],
  };
}

test('records only lists managed CLIs and scopes session reads to them', async ({ page }) => {
  await page.addInitScript((report) => {
    const filters: Array<Record<string, unknown>> = [];
    Object.assign(window, {
      isTauri: true,
      __historyFilters: filters,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['claude_code'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }, { id: 'claude_code', name: 'Claude Code' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', yoloAvailable: true }, { id: 'claude_code', name: 'Claude Code', yoloAvailable: true }], managedIds: ['claude_code'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_history_prices' || command === 'refresh_history') return [];
        if (command === 'list_history_sessions') { filters.push(args.filter); return []; }
        if (command === 'get_usage_report') return report;
        if (command === 'get_history_scan_progress') return { running: false, toolId: '', completedSources: 0, totalSources: 0 };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        return null;
      } },
    });
  }, emptyReport());
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
  await page.addInitScript((report) => {
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
      isTauri: true, __recordLaunches: launches, __recordClipboard: clipboard, __recordControl: control, __reportFilters: [] as unknown[],
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
          const messages = [
            { id: 'm1', role: 'user', text: 'Review change', timestamp: 1790668800000 },
            ...Array.from({ length: 24 }, (_, index) => ({ id: `pad-${index}`, role: 'user', text: `历史正文需要整栏滚动 ${index}`, timestamp: 1790668800000 })),
            { id: 'm2', role: 'assistant', text: `Looks good.\n${'历史正文需要整栏滚动。'.repeat(70)}`, timestamp: 1790668801000 },
          ];
          return { session, messages, usage: [], resumeReason: session?.nativeId ? null : '原始记录没有可验证的恢复 ID' };
        }
        if (command === 'set_history_favorite') { const item = records.find((value) => value.id === args.id); if (item) item.favorite = args.favorite; return null; }
        if (command === 'set_history_project') { const item = records.find((value) => value.id === args.id); if (item) item.projectId = args.projectId; return null; }
        if (command === 'get_usage_report') { (window as typeof window & { __reportFilters?: unknown[] }).__reportFilters?.push(args.filter); return report; }
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
  }, todayReport());
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
  await expect(page.getByRole('checkbox', { name: '只看收藏' })).toBeHidden();
  await page.getByText('筛选', { exact: true }).click();
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
  await expect(page.getByLabel('原生恢复命令')).toBeHidden();
  await page.getByText('筛选', { exact: true }).click();
  await page.getByText('会话选项', { exact: true }).click();
  await page.getByText('查看恢复命令', { exact: true }).click();
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
  const exportDetails = page.locator('details').filter({ has: page.getByText('会话选项', { exact: true }) });
  await expect(exportDetails).toHaveCount(1);
  await page.getByText('会话选项', { exact: true }).click();
  await expect(exportDetails).not.toHaveAttribute('open');
  await expect(exportDetails.getByRole('button', { name: '导出 Markdown' })).toBeHidden();
  expect(await resumeOutside.evaluate((button) => button.closest('details')?.querySelector('summary')?.textContent?.includes('会话选项') ?? false)).toBe(false);
  await page.getByText('会话选项', { exact: true }).click();
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
  const summary = page.getByRole('region', { name: '用量概览' });
  await expect(summary).toContainText('1.2M');
  await expect(summary).toContainText('↑ 20%');
  await expect(summary).toContainText('较昨日同时段');
  await expect(summary).toContainText('$1.50');
  await expect(summary).toContainText('22% token 未定价');
  const reportFilter = await page.evaluate(() => {
    const filters = (window as typeof window & { __reportFilters: Array<{ search: string | null; favoriteOnly: boolean }> }).__reportFilters;
    return filters[filters.length - 1];
  });
  expect(reportFilter.search).toBe('Review');
  expect(reportFilter.favoriteOnly).toBe(false);
  const ranking = page.getByRole('list', { name: '按模型用量明细' });
  await expect(ranking.getByRole('listitem')).toHaveCount(2);
  await expect(ranking.getByRole('button', { name: '定价', exact: true })).toHaveCount(1);
  await ranking.getByRole('button', { name: '定价', exact: true }).click();
  const priceDialog = page.getByRole('dialog', { name: '设置估算价格' });
  await expect(priceDialog.getByLabel('价格模型')).toHaveValue('glm-5.3');
  await expect(priceDialog.getByRole('button', { name: '保存价格' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '设置估算价格', exact: true }).click();
  await expect(priceDialog.getByLabel('价格工具')).toBeVisible();
  await expect(priceDialog.getByLabel('价格模型')).toHaveValue('');
});

test('usage dashboard splits tokens, follows rows into filters and opens heavy sessions', async ({ page }) => {
  await page.addInitScript((report) => {
    const records = [
      { id: 'key-a', toolId: 'codex', nativeId: '1111', title: 'First session', cwd: 'C:\\project', model: 'gpt-6-astra', projectId: null, startedAt: 1790668800000, updatedAt: 1790668800000, favorite: false, partial: false, stale: false, messageCount: 1, usageCount: 1 },
      { id: 'key-b', toolId: 'codex', nativeId: '2222', title: 'Second session', cwd: 'C:\\project', model: 'gpt-6-astra', projectId: null, startedAt: 1790668700000, updatedAt: 1790668700000, favorite: false, partial: false, stale: false, messageCount: 1, usageCount: 1 },
    ];
    const filters: Array<Record<string, unknown>> = [];
    Object.assign(window, {
      isTauri: true,
      __reportFilters: filters,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', yoloAvailable: false, interfaceFormats: [] }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_history_prices' || command === 'refresh_history') return [];
        if (command === 'list_history_sessions') return records.filter((item) => !args.filter.search || item.title.includes(args.filter.search));
        if (command === 'get_history_session') return { session: records.find((item) => item.id === args.id), messages: [], usage: [], resumeReason: '原始记录没有可验证的恢复 ID' };
        if (command === 'get_usage_report') { filters.push(args.filter); return report; }
        if (command === 'get_history_scan_progress') return { running: false, toolId: '', completedSources: 0, totalSources: 0 };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        return null;
      } },
    });
  }, todayReport());
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '使用记录' }).click();
  const first = page.getByRole('button', { name: /First session/ });
  const second = page.getByRole('button', { name: /Second session/ });
  await expect(first).toBeVisible();
  await first.focus();
  await page.keyboard.press('ArrowDown');
  await expect(second).toBeFocused();
  await page.keyboard.press('Home');
  await expect(first).toBeFocused();
  await page.setViewportSize({ width: 640, height: 850 });
  await first.click();
  await expect(page.getByLabel('会话列表')).toBeHidden();
  await page.getByRole('button', { name: '← 返回会话列表' }).click();
  await expect(first).toBeFocused();
  await expect(page.getByLabel('会话列表')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.getByRole('textbox', { name: '搜索会话' }).fill('First');
  await expect(second).toHaveCount(0);

  await page.getByRole('tab', { name: '用量' }).click();
  await expect(page.getByRole('radio', { name: '今天' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: '今天' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: '昨天' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Home');
  await expect(page.getByRole('radio', { name: '今天' })).toBeFocused();
  const lastFilter = () => page.evaluate(() => {
    const filters = (window as typeof window & { __reportFilters: Array<{ fromMs: number | null; toMs: number | null; model: string | null }> }).__reportFilters;
    return filters[filters.length - 1];
  });
  const midnight = await page.evaluate(() => { const date = new Date(); date.setHours(0, 0, 0, 0); return date.getTime(); });
  await expect.poll(async () => (await lastFilter())?.fromMs).toBe(midnight);
  const composition = page.getByRole('group', { name: 'token 构成' });
  await expect(composition).toContainText('新输入');
  await expect(composition).toContainText('缓存读取');
  await expect(composition).toContainText('75%');
  await expect(page.getByText('缓存命中', { exact: true }).locator('..')).toContainText('78%');

  const chart = page.getByRole('group', { name: /用量趋势/ });
  await chart.focus();
  await page.keyboard.press('Home');
  await expect(chart.getByRole('status')).toContainText('00:00–01:00');
  for (let step = 0; step < 9; step++) await page.keyboard.press('ArrowRight');
  await expect(chart.getByRole('status')).toContainText('1.2M');
  await expect(chart.getByRole('status')).not.toContainText('1,200,000');
  await expect(chart.getByRole('status')).toContainText('40 次');
  await page.getByRole('tab', { name: '费用', exact: true }).click();
  const trend = page.getByRole('region', { name: '用量趋势' });
  await expect(trend).toContainText('峰值 $1.50');
  await expect(trend).toContainText('估算费用不等于实际账单');

  await page.getByRole('list', { name: '按模型用量明细' }).getByRole('button', { name: /^gpt-6-astra/ }).click();
  await expect.poll(async () => (await lastFilter())?.model).toBe('gpt-6-astra');
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect.poll(async () => (await lastFilter())?.model).toBeNull();

  const beforeCustom = await lastFilter();
  await page.getByRole('radio', { name: '自定义', exact: true }).click();
  const dates = page.getByRole('dialog', { name: '自定义时间范围' });
  const days = dates.getByRole('button', { name: /^\d{4}-\d{2}-\d{2}$/ });
  const startDay = await days.nth(0).getAttribute('aria-label');
  const endDay = await days.nth(2).getAttribute('aria-label');
  await days.nth(0).click();
  await days.nth(2).click();
  expect(await lastFilter()).toEqual(beforeCustom);
  await dates.getByRole('button', { name: '应用范围' }).click();
  await expect(page.getByRole('radio', { name: '自定义', exact: true })).toHaveAttribute('aria-checked', 'true');
  const end = new Date(`${endDay}T00:00:00`); end.setDate(end.getDate() + 1);
  await expect.poll(lastFilter).toMatchObject({ fromMs: new Date(`${startDay}T00:00:00`).getTime(), toMs: end.getTime() });

  await page.getByRole('radio', { name: '近 7 天' }).click();
  const weekStart = await page.evaluate(() => { const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - 6); return date.getTime(); });
  await expect.poll(async () => (await lastFilter())?.fromMs).toBe(weekStart);

  await page.getByRole('list', { name: '消耗最多的会话' }).getByRole('button', { name: /Second session/ }).click();
  await expect(page.getByRole('tab', { name: /会话/ })).toHaveAttribute('aria-selected', 'true');
  await expect(second).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('textbox', { name: '搜索会话' })).toHaveValue('');
  await page.getByRole('tab', { name: '用量' }).click();
  await expect(page.getByRole('radio', { name: '近 7 天' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('tab', { name: '费用', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tablist', { name: '分布维度' }).getByRole('tab', { name: '工具', exact: true }).click();
  await page.getByRole('list', { name: '按工具用量明细' }).getByRole('button', { name: /^Codex/ }).click();
  await expect(page.getByRole('tablist', { name: '分布维度' }).getByRole('tab', { name: '工具', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('用量工具')).toContainText('Codex');
});

test('usage failure replaces stale data and can retry with the same filters', async ({ page }) => {
  await page.addInitScript((report) => {
    let failed = false;
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['codex'], theme: 'system' }, tools: [{ id: 'codex', name: 'Codex' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'codex', name: 'Codex', yoloAvailable: false }], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects' || command === 'list_history_prices' || command === 'refresh_history' || command === 'list_history_sessions') return [];
        if (command === 'get_usage_report') {
          if (args.filter.model && !failed) { failed = true; throw new Error('Read failed'); }
          return args.filter.model ? { ...report, totals: { ...report.totals, total: 940000 } } : report;
        }
        if (command === 'get_tray_status') return { available: false, error: null };
        return null;
      } },
    });
  }, todayReport());
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '使用记录' }).click();
  await page.getByRole('tab', { name: '用量' }).click();
  await expect(page.getByRole('region', { name: '用量概览' })).toContainText('1.2M');
  await page.getByRole('list', { name: '按模型用量明细' }).getByRole('button', { name: /^gpt-6-astra/ }).click();
  await expect(page.getByRole('alert')).toContainText('用量暂时没有读取成功');
  await expect(page.getByRole('region', { name: '用量概览' })).toHaveCount(0);
  await page.getByRole('button', { name: '重新加载用量' }).click();
  await expect(page.getByRole('region', { name: '用量概览' })).toContainText('940K');
  await expect(page.getByLabel('用量模型')).toContainText('gpt-6-astra');
});

test('Grok details preserve exact token buckets and show inferred clocks and unknown calls', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const sum = totals(1234, 8000, 76, 690, { requests: 37, usageRecords: 4, unknownRequestRecords: 1, sessions: 1 });
  await page.addInitScript(({ sum, report }) => {
    const records = [
      { id: 'grok-accuracy', toolId: 'grok', nativeId: null, title: 'Token 核对示例', cwd: null, model: 'grok-fixture', projectId: null, startedAt: 1790668800000, updatedAt: 1790672400000, favorite: true, partial: true, stale: false, messageCount: 2, usageCount: 4 },
      { id: 'grok-empty', toolId: 'grok', nativeId: null, title: '没有用量的会话', cwd: null, model: null, projectId: null, startedAt: null, updatedAt: null, favorite: false, partial: false, stale: false, messageCount: 0, usageCount: 0 },
    ];
    Object.assign(window, {
      isTauri: true, __accuracyFilters: [],
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['grok'], theme: 'system' }, tools: [{ id: 'grok', name: 'Grok' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'grok', name: 'Grok', yoloAvailable: true }], managedIds: ['grok'], preservedUnknown: [] };
        if (['list_projects', 'list_history_prices', 'refresh_history'].includes(command)) return [];
        if (command === 'list_history_sessions') return records.filter((item) => (!args.filter.search || item.title.includes(args.filter.search)) && (!args.filter.favoriteOnly || item.favorite));
        if (command === 'get_history_session') {
          const session = records.find((item) => item.id === args.id)!;
          return { session, usage: [], totals: session.id === 'grok-accuracy' ? sum : { ...sum, requests: 0, usageRecords: 0, total: 0 }, resumeReason: '原始记录没有可验证的恢复 ID', messages: session.id === 'grok-accuracy' ? [
            { id: 'q', role: 'user', text: '请核对本轮 Token 用量。', timestamp: 1790668800000, timestampSource: 'native' },
            { id: 'a', role: 'assistant', text: '已保留缓存与输出的独立计数。', timestamp: 1790672400000, timestampSource: 'turn' },
          ] : [] };
        }
        if (command === 'get_usage_report') {
          (window as typeof window & { __accuracyFilters: unknown[] }).__accuracyFilters.push(args.filter);
          return report;
        }
        if (command === 'get_history_scan_progress') return { running: false, toolId: '', completedSources: 0, totalSources: 0 };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        return null;
      } },
    });
  }, { sum, report: { ...emptyReport(), totals: sum } });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '使用记录' }).click();
  await page.getByRole('button', { name: /Token 核对示例/ }).click();
  const usage = page.getByRole('region', { name: '会话 Token 用量' });
  await expect(usage).toHaveCount(0);
  const inferred = page.locator('time[title*="按轮次开始时间推断"]');
  await expect(inferred).toContainText('约');
  await expect(page.locator('[data-message-id="q"] time')).not.toContainText('约');
  await expect(page.getByText('已保留缓存与输出的独立计数。', { exact: true })).toBeVisible();
  if (process.env.HISTORY_ACCURACY_SCREENSHOTS) {
    await page.screenshot({ path: 'docs/verification/history-accuracy/grok-detail.png', fullPage: true });
  }
  await page.getByRole('button', { name: /没有用量的会话/ }).click();
  await expect(usage).toHaveCount(0);
  await page.getByRole('textbox', { name: '搜索会话' }).fill('Token');
  await page.locator('summary').filter({ hasText: /^筛选/ }).click();
  await page.getByRole('checkbox', { name: '只看收藏' }).check();
  await page.locator('summary').filter({ hasText: /^筛选/ }).click();
  await page.getByRole('tab', { name: '用量' }).click();
  const overview = page.getByRole('region', { name: '用量概览' });
  await expect(overview).toContainText('已知模型调用');
  await expect(overview).toContainText('1 条记录次数未知');
  await expect(overview).not.toContainText('每次约');
  await expect(page.getByText('筛选：搜索「Token」 · 只看收藏', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const filters = (window as typeof window & { __accuracyFilters: Array<{ search: string; favoriteOnly: boolean }> }).__accuracyFilters;
    return filters.at(-1);
  })).toMatchObject({ search: 'Token', favoriteOnly: true });
  if (process.env.HISTORY_ACCURACY_SCREENSHOTS) {
    await page.screenshot({ path: 'docs/verification/history-accuracy/grok-usage.png', fullPage: true });
  }
  await page.getByRole('tab', { name: /^会话/ }).click();
  await page.getByRole('button', { name: '清空搜索' }).click();
  await page.getByRole('button', { name: '只看收藏', exact: true }).click();
  await expect(page.getByRole('button', { name: /没有用量的会话/ })).toBeVisible();
});

test('all-time trend averages include only dated elapsed buckets for tokens and cost', async ({ page }) => {
  const hour = 3_600_000;
  const start = Date.now() - 3 * hour;
  const report = {
    ...emptyReport(), from: start, to: start + 5 * hour, bucket: 'hour',
    // 980 tokens and $96 have no date. They belong in the overview, never in a time bucket.
    totals: totals(1000, 0, 0, 0, { requests: 3, sessions: 1, cost: 100 }),
    timeline: [
      { start, end: start + hour, totals: totals(10, 0, 0, 0, { requests: 1, cost: 1 }) },
      { start: start + hour, end: start + 2 * hour, totals: totals(10, 0, 0, 0, { requests: 1, cost: 3 }) },
      { start: start + 4 * hour, end: start + 5 * hour, totals: totals(0, 0, 0, 0) },
    ],
  };
  await page.addInitScript((report) => {
    Object.assign(window, {
      isTauri: true,
      __TAURI_INTERNALS__: { invoke: async (command: string) => {
        if (command === 'get_bootstrap') return { preferences: { schema_version: 1, managed_tools: ['grok'], theme: 'system' }, tools: [{ id: 'grok', name: 'Grok' }] };
        if (command === 'list_cli_adapters') return { registered: [{ id: 'grok', name: 'Grok' }], managedIds: ['grok'], preservedUnknown: [] };
        if (['list_projects', 'list_history_prices', 'refresh_history', 'list_history_sessions'].includes(command)) return [];
        if (command === 'get_usage_report') return report;
        if (command === 'get_history_scan_progress') return { running: false, toolId: '', completedSources: 0, totalSources: 0 };
        if (command === 'get_tray_status') return { available: false, error: null };
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        return null;
      } },
    });
  }, report);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '使用记录' }).click();
  await page.getByRole('tab', { name: '用量' }).click();
  await page.getByRole('radio', { name: '全部', exact: true }).click();
  const overview = page.getByRole('region', { name: '用量概览' });
  await expect(overview).toContainText('1K');
  await expect(overview).toContainText('$100.00');
  const trend = page.getByRole('region', { name: /用量趋势/ });
  await expect(trend.getByText(/平均每小时/)).toHaveText(/平均每小时\s*10$/);
  await page.getByRole('tablist', { name: '趋势指标' }).getByRole('tab', { name: '费用', exact: true }).click();
  await expect(trend.getByText(/平均每小时/)).toHaveText(/平均每小时\s*\$2.00$/);
  await expect(overview).toContainText('$100.00');
});
