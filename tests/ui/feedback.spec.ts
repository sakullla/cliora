import { expect, test, type Page } from '@playwright/test';

async function install(page: Page, seed: Record<string, boolean> = {}) {
  await page.addInitScript((initial: Record<string, boolean>) => {
    const control = { copyDelay: 0, copyFails: false, launchFails: false, terminalFails: false, ruleSaveFails: false, resumeFails: false, projectsFail: false, withProject: false, renameFails: false, portableFails: false, settingsLoadFails: false, usageFails: false, librarySaveFails: false, libraryListFails: false, lastLibraryVersion: null as number | null, ...initial };
    const library = [{ id: 'prompt-1', kind: 'prompt', title: '发布检查', body: '请核对发布说明', category: '写作', projectId: null, version: 1, updatedAt: 1 }];
    let theme = 'light';
    let rule = '原规则';
    const facet = { state: 'available', reason: '' };
    const codex = { id: 'codex', name: 'Codex', interfaceFormats: [], projectModelOverride: false, yoloAvailable: true, nativeConfig: facet, launch: facet, resume: facet, resources: facet, history: facet };
    const bootstrap = () => ({ preferences: { schema_version: 1, managed_tools: ['codex'], theme, tool_icons: {} }, tools: [{ id: 'codex', name: 'Codex', installation: 'not_checked', configuration: 'not_checked' }] });
    const launchSettings = () => ({ selected: 'auto', terminals: [{ id: 'auto', label: '系统默认', available: true }, { id: 'windows_terminal', label: 'Windows Terminal', available: true }], cliMode: 'normal', projectMode: 'normal' });
    const workspace = { probe: { selectedPath: 'C:/codex.cmd', installations: [{ path: 'C:/codex.cmd', version: '1.0.0', status: 'available' }], nativeFiles: [], nativeWrites: { state: 'supported', reason: '' } }, profiles: [], binding: null, snapshots: [], recoveryNeeded: [], common: null, customPath: null };
    const session = { id: 'record-a', toolId: 'codex', nativeId: '1111', title: 'Review change', cwd: 'C:\\project', model: 'gpt', projectId: null, startedAt: 1, updatedAt: 1, favorite: false, partial: false, stale: false, messageCount: 1, usageCount: 0 };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { if (control.copyDelay) await new Promise(resolve => setTimeout(resolve, control.copyDelay)); if (control.copyFails) throw new Error('clipboard denied'); }, readText: async () => '' } });
    Object.assign(window, {
      isTauri: true,
      __statusCopy: control,
      __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, any> = {}) => {
        if (command === 'get_bootstrap') return bootstrap();
        if (command === 'set_theme') { theme = args.theme ?? theme; return bootstrap(); }
        if (command === 'list_cli_adapters') return { registered: [codex], managedIds: ['codex'], preservedUnknown: [] };
        if (command === 'list_projects') {
          if (control.projectsFail) throw { message: '项目列表读取失败', action: '可再次启动，或在设置中检查终端。' };
          if (control.withProject) return [{ id: 'p1', name: '示例项目', path: 'C:/work', available: true, preferredTool: 'codex', lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} }];
          return [];
        }
        if (command === 'rename_project') {
          if (control.renameFails) throw { message: '名称没有保存', action: '可再次点击保存名称。' };
          return { id: 'p1', name: args.name, path: 'C:/work', available: true, preferredTool: 'codex', lastOpened: 1, modelOverrides: {}, selectedProfiles: {}, appliedProfiles: {}, reapplyProfiles: {} };
        }
        if (command === 'get_launch_settings' && control.settingsLoadFails) throw { message: '无法读取终端设置', action: '请重试。' };
        if (command === 'get_launch_settings' || command === 'set_default_launch_mode') return launchSettings();
        if (command === 'set_preferred_terminal') { if (control.terminalFails) throw new Error('终端不可用'); return { ...launchSettings(), selected: args.terminal }; }
        if (command === 'get_tray_status') return { available: true, error: null };
        if (command === 'get_registered_tool_workspace') return workspace;
        if (command === 'list_library_items') {
          if (control.libraryListFails) throw { message: '资料列表读取失败', action: '可调整搜索，或点击上方的新建。' };
          return library.filter((item) => item.kind === args.kind && (!args.search || `${item.title}${item.body}${item.category}`.includes(args.search)));
        }
        if (command === 'read_native_rule') return { text: rule, path: 'C:/rules/AGENTS.md', fingerprint: 'fp' };
        if (command === 'save_native_rule') { if (control.ruleSaveFails) throw new Error('磁盘拒绝写入'); rule = args.edited; return { status: 'applied' }; }
        if (command === 'list_rule_placements') return [];
        if (command === 'sync_rule_clients') { if (control.ruleSaveFails) throw new Error('磁盘拒绝写入'); return [{ toolId: 'codex', path: 'C:/rules/AGENTS.md', status: 'written', detail: '已写入拼接后的规则', existing: '', proposed: '' }]; }
        if (command === 'save_library_item') {
          if (control.librarySaveFails) throw { message: '资料没有写入', action: '可修改后再次点击保存。' };
          const draft = args.draft ?? {};
          control.lastLibraryVersion = typeof draft.expectedVersion === 'number' ? draft.expectedVersion : null;
          const saved = { id: draft.id ?? 'prompt-new', kind: draft.kind, title: draft.title, body: draft.body, category: draft.category, projectId: draft.projectId ?? null, version: (draft.expectedVersion ?? 0) + 1, updatedAt: 2 };
          const index = library.findIndex((item) => item.id === saved.id);
          if (index < 0) library.push(saved); else library[index] = saved;
          return saved;
        }
        if (command === 'list_portable_items') {
          if (control.portableFails) throw { message: '迁移列表读取失败', action: '可先离开再回到迁移与同步重新读取。' };
          return [];
        }
        if (command === 'get_webdav_status') return { configured: false, enabled: false, endpoint: null, lastSuccess: null, lastError: null, retryAfter: null, uploaded: 0, downloaded: 0, pendingChanges: 0, conflicts: [] };
        if (command === 'launch_cli') { if (control.launchFails) throw new Error('终端没有打开'); return { toolId: args.request?.toolId, projectId: args.request?.projectId ?? null, mode: args.request?.mode ?? 'normal', terminal: 'auto', status: 'terminal_requested' }; }
        if (command === 'refresh_history') return [];
        if (command === 'get_history_scan_progress') return { running: false, toolId: '', completedSources: 0, totalSources: 0 };
        if (command === 'list_history_prices') return [];
        if (command === 'list_history_sessions') return [session];
        if (command === 'get_history_session') return { session, messages: [{ id: 'm1', role: 'user', text: 'Review change', timestamp: 1 }], usage: [], resumeReason: null };
        if (command === 'get_usage_report') {
          if (control.usageFails) throw { message: '用量读取失败', action: '可点击刷新本机记录或调整筛选。' };
          const zero = { requests: 0, usageRecords: 0, unknownRequestRecords: 0, sessions: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, cost: null, unpricedTokens: 0 };
          return { generatedAt: 0, from: null, to: null, bucket: 'day', currency: 'USD', totals: zero, previous: null, timeline: [], byModel: [], byTool: [], byProject: [], topSessions: [], models: [], untimedRequests: 0, duplicateRequests: 0, partialSessions: 0, staleSessions: 0, mixedCurrency: false, latestEventAt: null, priceSources: [], scans: [] };
        }
        if (command === 'save_history_price') return { ...args.price, updatedAt: 2 };
        if (command === 'copy_history_resume_command') return 'codex resume 1111';
        if (command === 'resume_history_session') { if (control.resumeFails) throw new Error('终端没有打开'); return { toolId: 'codex', projectId: null, mode: args.mode, terminal: 'auto', status: 'terminal_requested' }; }
        if (command === 'cancel_history_refresh') return null;
        if (command === 'plugin:event|listen' || command === 'plugin:event|unlisten') return 1;
        return null;
      } },
    });
  }, seed);
}

test('dialog feedback keeps focus and control positions; unrelated success preserves a save error', async ({ page }) => {
  await install(page, { librarySaveFails: true });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('button', { name: '修改' }).click();
  const dialog = page.getByRole('dialog');
  const save = dialog.getByRole('button', { name: '保存', exact: true });
  const copy = dialog.getByRole('button', { name: '复制全文' });
  await expect(dialog.locator('.cm-content')).toBeVisible();
  const before = await save.boundingBox();
  await save.click();
  await expect(dialog.getByRole('alert')).toContainText('资料没有写入');
  await expect(save).toBeFocused();
  await copy.click();
  await expect(copy).toBeFocused();
  await expect(dialog.getByRole('alert')).toContainText('资料没有写入');
  await expect(dialog.getByRole('status').filter({ hasText: '完整正文已复制' })).toBeVisible();
  expect(await save.boundingBox()).toEqual(before);
  // Native dialog top layer owns the event, no duplicate is rendered underneath.
  await expect(page.locator('.feedback-item').filter({ hasText: '资料没有写入' })).toHaveCount(1);
  expect(await dialog.locator('.feedback-item').first().evaluate(node => node.closest('dialog')?.matches(':modal'))).toBe(true);
});

test('copy failures deduplicate and recovery checks the edited draft before writing', async ({ page }) => {
  await install(page, { copyFails: true });
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('button', { name: '修改' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '复制全文' }).click();
  await dialog.getByRole('button', { name: '复制全文' }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(1);
  await page.evaluate(() => { (window as unknown as { __statusCopy: { copyFails: boolean } }).__statusCopy.copyFails = false; });
  await dialog.getByRole('button', { name: '重试', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { __statusCopy: { copyFails: boolean } }).__statusCopy.copyFails = true; });
  await dialog.getByRole('button', { name: '复制全文' }).click();
  await dialog.getByLabel('标题').fill('changed after failure');
  await dialog.getByRole('button', { name: '重试', exact: true }).click();
  await expect(dialog.getByRole('alert').filter({ hasText: '操作对象已变化' })).toBeVisible();
});

test('a late copy result stays in the originating context and remains reachable from the shell', async ({ page }) => {
  await install(page);
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '页面' });
  await nav.getByRole('button', { name: '资料库' }).click();
  await page.evaluate(() => { (window as unknown as { __statusCopy: { copyDelay: number } }).__statusCopy.copyDelay = 800; });
  await page.getByRole('button', { name: '复制全文' }).click();
  await nav.getByRole('button', { name: '快速开始' }).click();
  await expect(page.locator('main .feedback-item').filter({ hasText: '完整正文已复制' })).not.toBeVisible();
  await page.getByRole('button', { name: '操作消息', exact: true }).click();
  await expect(page.locator('.feedback-center-panel').getByRole('status')).toContainText('完整正文已复制');
  await expect(page.getByRole('button', { name: '操作消息', exact: true })).toHaveAttribute('aria-expanded', 'true');
});

test('hover and keyboard interaction keep success available until interaction ends', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('button', { name: '复制全文' }).click();
  const result = page.locator('.feedback-item').filter({ hasText: '完整正文已复制' });
  await result.hover();
  await page.waitForTimeout(5300);
  await expect(result).toBeVisible();
  await result.getByRole('button', { name: '忽略此消息', exact: true }).focus();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(5300);
  await expect(result).toBeVisible();
});

test('reopening an editor cannot receive a late result from its previous opening', async ({ page }) => {
  await install(page);
  await page.goto('/');
  await page.getByRole('navigation', { name: '页面' }).getByRole('button', { name: '资料库' }).click();
  await page.getByRole('button', { name: '修改' }).click();
  await page.evaluate(() => { (window as unknown as { __statusCopy: { copyDelay: number } }).__statusCopy.copyDelay = 800; });
  await page.getByRole('dialog').getByRole('button', { name: '复制全文' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '新建提示词', exact: true }).click();
  await page.waitForTimeout(1000);
  await expect(page.getByRole('dialog').getByRole('status').filter({ hasText: '完整正文已复制' })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '完整正文已复制' })).toBeVisible();
});

