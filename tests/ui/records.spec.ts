import { expect, test } from '@playwright/test';

test('records keep search, show native resume command and only launch on request', async ({ page }) => {
  await page.addInitScript(() => {
    const records: Array<Record<string, any>> = [
      { id: 'record-a', toolId: 'codex', nativeId: '1111-2222', title: 'Review change', cwd: 'C:\\project', model: 'gpt-6-astra', projectId: null, startedAt: 1790668800000, updatedAt: 1790668800000, favorite: false, partial: false, stale: false, messageCount: 2, usageCount: 1 },
      { id: 'record-b', toolId: 'codex', nativeId: null, title: 'Incomplete record', cwd: null, model: null, projectId: null, startedAt: null, updatedAt: null, favorite: false, partial: true, stale: false, messageCount: 1, usageCount: 0 },
    ];
    const launches: Array<Record<string, unknown>> = [];
    const clipboard: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { clipboard.push(value); } } });
    Object.assign(window, {
      isTauri: true, __recordLaunches: launches, __recordClipboard: clipboard,
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
          return { session, messages: [{ id: 'm1', role: 'user', text: 'Review change', timestamp: 1790668800000 }, { id: 'm2', role: 'assistant', text: 'Looks good.', timestamp: 1790668801000 }], usage: [], resumeReason: session?.nativeId ? null : '原始记录没有可验证的恢复 ID' };
        }
        if (command === 'set_history_favorite') { const item = records.find((value) => value.id === args.id); if (item) item.favorite = args.favorite; return null; }
        if (command === 'set_history_project') { const item = records.find((value) => value.id === args.id); if (item) item.projectId = args.projectId; return null; }
        if (command === 'get_history_usage') return { sessionCount: 2, usageSessions: 1, unknownUsageSessions: 1, partialSessions: 1, staleSessions: 0, input: 150, output: 30, cacheRead: 60, cacheWrite: 0, inputIncludesCache: true, estimatedCost: null, currency: null, priceSources: [], scans: [{ toolId: 'codex', scannedAt: 1, sourceCount: 2, failedCount: 0, incomplete: false, detail: '' }] };
        if (command === 'copy_history_resume_command') return `Set-Location -LiteralPath '${records.find((item) => item.id === args.id)?.projectId ? 'C:\\new-project' : 'C:\\project'}'; & 'codex' ${args.mode === 'yolo' ? "'--yolo' " : ''}'resume' '1111-2222'`;
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
  await expect(page.getByLabel('原生恢复命令')).toContainText("'resume' '1111-2222'");
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
  await expect(page.getByText('150', { exact: true })).toBeVisible();
  await expect(page.getByText('未知', { exact: true })).toBeVisible();
});
